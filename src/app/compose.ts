// Composes the engines into one runtime. Each engine keeps its own schema and is reached only through its service
// interface (`createEngine` / `routes`). Engines are loaded from ./engines/<short> (see scripts/bootstrap-engines.mjs);
// an engine that is absent or fails to start is reported as unavailable and everything else keeps working.
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { DomainError } from '../contracts.ts';
import type { Json, Scope } from '../contracts.ts';
import { FsObjectStore, S3ObjectStore, pgSql } from '../service-kit.ts';
import type { AuthorizationPort, BudgetPort, EvidencePort, ObjectStore, Route, ServiceContext, Sql, StandardEngine, TokenVerifier, UseDecisionPort } from '../service-kit.ts';
import * as orchestrationModule from '../orchestration/index.ts';
import * as adapters from './adapters.ts';
import type { OrchestrationEngine } from '../orchestration/index.ts';

export type Env = Readonly<Record<string, string | undefined>>;
// Engines are loaded dynamically; their precise types live in their own repositories.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyEngine = StandardEngine & Record<string, any>;
export type EngineEntry = Readonly<{
  id: string; short: string; available: boolean; error: string | null;
  engine: AnyEngine | null; routes: readonly Route[]; runJobs: (() => Promise<number>) | null;
}>;
export const ENGINE_ORDER: readonly (readonly [string, string])[] = [
  ['E01', 'identity'], ['E11', 'consent'], ['E13', 'resources'], ['E05', 'evidence'], ['E06', 'processing'], ['E04', 'discovery'], ['E07', 'knowledge'],
  ['E03', 'correspondence'], ['E08', 'investigation'], ['E09', 'editorial'], ['E10', 'production'], ['E12', 'release'], ['E14', 'workspace'],
];

export type Runtime = Readonly<{
  env: Env; sql: Sql; engines: ReadonlyMap<string, EngineEntry>; orchestration: OrchestrationEngine;
  verify: TokenVerifier;
  /** Authorized context for PAM's own service identity in one organization and project. Fails closed if not provisioned. */
  serviceContext(scope: Scope, purpose?: string): Promise<ServiceContext>;
  get(short: string): AnyEngine;
  maybe(short: string): AnyEngine | null;
  close(): Promise<void>;
}>;

function objectsFor(env: Env, short: string): ObjectStore {
  if ((env.OBJECT_STORE ?? 'fs') === 's3') {
    for (const k of ['S3_ENDPOINT', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY']) if (!env[k]) throw new DomainError('invalid_config', `${k} is required for OBJECT_STORE=s3`);
    return new S3ObjectStore({ endpoint: env.S3_ENDPOINT as string, region: env.S3_REGION ?? 'us-east-1', bucket: env.S3_BUCKET as string, accessKeyId: env.S3_ACCESS_KEY_ID as string, secretAccessKey: env.S3_SECRET_ACCESS_KEY as string, prefix: `${env.S3_PREFIX ?? ''}${short}/` });
  }
  return new FsObjectStore(join(resolve(env.PAM_DATA_DIR ?? './data'), 'objects', short));
}
const key32 = (value: string | undefined, name: string): Uint8Array => {
  const bytes = Buffer.from(value ?? '', 'base64');
  if (bytes.byteLength !== 32) throw new DomainError('invalid_config', `${name} must be 32 bytes, base64-encoded`);
  return new Uint8Array(bytes);
};

/**
 * Every engine vendors its own copy of contracts.ts, so each has a distinct DomainError class and a plain `instanceof`
 * fails across engines (an engine's `forbidden` would surface as an internal error in another engine or the gateway).
 * The host makes the check structural for each copy it loads: any Error named DomainError with a string code matches.
 */
export function unifyDomainError(cls: unknown): void {
  if (typeof cls !== 'function' || Object.hasOwn(cls, Symbol.hasInstance)) return;
  Object.defineProperty(cls, Symbol.hasInstance, { value(this: unknown, v: unknown): boolean {
    if (this !== cls) return Function.prototype[Symbol.hasInstance].call(this, v);
    return v instanceof Error && v.name === 'DomainError' && typeof (v as { code?: unknown }).code === 'string';
  } });
}
unifyDomainError(DomainError);

const WORKER = `pam-${process.pid}`;
/** Engines name and parameterise their job pass differently; this is the one place that knows how. */
function jobRunner(short: string, engine: AnyEngine): (() => Promise<number>) | null {
  const stringArg = ['consent', 'resources', 'release'].includes(short);
  const fn = [engine.runJobsOnce, engine.runJobs, engine.runWorkerOnce].find((f) => typeof f === 'function') ?? null;
  if (fn === null) return null;
  return async () => Number(await (stringArg ? fn.call(engine, WORKER) : fn.call(engine, { worker: WORKER })) ?? 0);
}

export const APP_SCHEMA = 'pam_app';
export async function migrateApp(sql: Sql): Promise<void> {
  await sql.query(`create schema if not exists ${APP_SCHEMA}`);
  await sql.query(`create table if not exists ${APP_SCHEMA}.tenants (tenant_id text primary key, orchestrator_service_id text not null, home_project_id text not null, provisioned_at timestamptz not null default now())`);
  await sql.query(`create table if not exists ${APP_SCHEMA}.settings (tenant_id text not null, project_id text not null, key text not null, value jsonb not null, updated_by text not null, updated_at timestamptz not null default now(), primary key (tenant_id, project_id, key))`);
}

export async function compose(env: Env, options: { actions?: (runtime: Runtime) => Record<string, orchestrationModule.ActionDefinition>; migrate?: boolean } = {}): Promise<Runtime> {
  if (!env.DATABASE_URL) throw new DomainError('invalid_config', 'DATABASE_URL is required');
  const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: Number(env.DATABASE_POOL_MAX ?? 20) });
  const sql = pgSql(pool);
  const enginesDir = resolve(env.PAM_ENGINES_DIR ?? './engines');
  const entries = new Map<string, EngineEntry>();
  const doMigrate = options.migrate !== false;
  if (doMigrate) { await migrateApp(sql); await orchestrationModule.migrate(sql); await sql.query(`create table if not exists ${APP_SCHEMA}.intake_links (tenant_id text not null, intake_kind text not null, intake_id text not null, pam_ref text not null, created_at timestamptz not null default now(), primary key (tenant_id, intake_kind, intake_id))`); }

  const maybe = (short: string): AnyEngine | null => entries.get(short)?.engine ?? null;
  const runtimeRef: { current: Runtime | null } = { current: null };
  const serviceContextRef: { fn: (scope: Scope, purpose?: string) => Promise<ServiceContext> } = { fn: async () => { throw new DomainError('unavailable', 'Service identity is not ready'); } };
  // Ports are resolved lazily so engines can be constructed in any order and absent engines fail closed at call time.
  const port = <T extends object>(short: string, describe: string): T => new Proxy({}, {
    get: (_t, prop) => (...args: unknown[]) => {
      const engine = maybe(short);
      if (engine === null || typeof engine[prop as string] !== 'function') return Promise.reject(new DomainError('unavailable', `${describe} is unavailable (${short} engine not running)`));
      return engine[prop as string](...args);
    },
  }) as T;
  const authorization = port<AuthorizationPort>('identity', 'Authorization');
  // Use decisions are about the subject and the intended use, not about who asks: engines consult E11 under PAM's service
  // identity (scoped to the caller's organization and project), so ordinary users need no consent-engine capability and
  // cannot influence the outcome. The requesting actor stays on the calling engine's own audit record.
  const consentPort = port<UseDecisionPort>('consent', 'Use decisions');
  const useDecisions: UseDecisionPort = { decide: async (ctx, request) => consentPort.decide({ ...(await serviceContextRef.fn({ tenantId: ctx.tenantId, projectId: ctx.projectId })), requestId: ctx.requestId }, request) };
  const evidence = port<EvidencePort>('evidence', 'Evidence storage');
  // Budget calls run with PAM's service capabilities (ordinary callers and agents hold no `resources:spend`) but keep the
  // ORIGINAL actor, because E13 decides by the actor's explicit budget assignment: an agent with no assigned budget is
  // refused. Engines' unit names are normalised to the resource engine's vocabulary here.
  const budgetEngine = port<BudgetPort>('resources', 'Budget');
  const UNIT: Record<string, string> = { message: 'messages', token: 'tokens_out', compute_second: 'compute_seconds', render_second: 'render_seconds' };
  const asSpender = async (ctx: ServiceContext): Promise<ServiceContext> => ({ ...(await serviceContextRef.fn({ tenantId: ctx.tenantId, projectId: ctx.projectId })), actor: ctx.actor, requestId: ctx.requestId, capabilities: ['resources:spend', 'resources:read', 'resources:write'] });
  const budget: BudgetPort = {
    reserve: async (ctx, request) => budgetEngine.reserve(await asSpender(ctx), { ...request, unit: UNIT[request.unit] ?? request.unit }),
    commit: async (ctx, id, actual) => budgetEngine.commit(await asSpender(ctx), id, actual),
    release: async (ctx, id, reason) => budgetEngine.release(await asSpender(ctx), id, reason),
  };

  // Per-engine construction. Keys in `ports` use the names each engine documents in its docs/ENGINE_API.md.
  const factories: Record<string, (mod: Record<string, any>) => unknown> = { // eslint-disable-line @typescript-eslint/no-explicit-any
    identity: (m) => m.createEngine({ sql, config: { issuer: env.IDENTITY_ISSUER ?? 'pam-identity', ...(env.IDENTITY_KEY_ENCRYPTION_KEY ? { keyEncryptionKey: env.IDENTITY_KEY_ENCRYPTION_KEY } : {}), ...(env.IDENTITY_BOOTSTRAP_TOKEN ? { bootstrapToken: env.IDENTITY_BOOTSTRAP_TOKEN } : {}) } }),
    consent: (m) => m.createEngine({ sql, ports: { authorization } }),
    evidence: (m) => m.createEngine({ sql, objects: objectsFor(env, 'evidence'), ports: { useDecisions, authorization, ...(env.CLAMAV_DATABASE_DIR ? { scanner: new m.ClamScanner({ databaseDir: env.CLAMAV_DATABASE_DIR, ...(env.CLAMSCAN_BINARY ? { binary: env.CLAMSCAN_BINARY } : {}) }) } : {}) },
      config: { ...(env.EVIDENCE_MASTER_KEY ? { encryption: { currentKeyVersion: env.EVIDENCE_MASTER_KEY_VERSION ?? 'v1', keys: { [env.EVIDENCE_MASTER_KEY_VERSION ?? 'v1']: key32(env.EVIDENCE_MASTER_KEY, 'EVIDENCE_MASTER_KEY') } } } : {}), ...(env.EVIDENCE_SCAN_POLICY === 'structural_only' ? { scanPolicy: 'structural_only' } : {}) } }),
  };
  factories.resources = (m) => m.createEngine({ sql, objects: objectsFor(env, 'resources'), ports: { authorization }, config: { ...(env.ALLOW_LIVE_PAYMENTS === '1' ? { allowLivePayments: true } : {}) } });
  const need = (short: string): AnyEngine => { const e = maybe(short); if (e === null) throw new DomainError('unavailable', `${short} engine is unavailable`); return e; };
  if (env.PAM_DATA_DIR) mkdirSync(join(resolve(env.PAM_DATA_DIR), 'tmp', 'processing'), { recursive: true });
  factories.processing = (m) => m.createEngine({ sql, objects: objectsFor(env, 'processing'), ports: { evidence, useDecisions, authorization, budget },
    config: { ...(env.PAM_DATA_DIR ? { tempRoot: join(resolve(env.PAM_DATA_DIR), 'tmp', 'processing') } : {}), ...(env.WHISPER_BINARY && env.WHISPER_MODEL ? { asr: { whisper: { kind: env.WHISPER_KIND ?? 'whisper.cpp', binary: env.WHISPER_BINARY, model: env.WHISPER_MODEL } } } : {}) } });
  factories.knowledge = (m) => m.createEngine({ sql, ports: { evidence, useDecision: useDecisions, authorization } });
  factories.investigation = (m) => m.createEngine({ sql, objects: objectsFor(env, 'investigation'), ports: {
    evidence: adapters.investigationEvidencePort(need), processing: adapters.investigationProcessingPort(need), knowledge: adapters.investigationKnowledgePort(need),
    discovery: adapters.investigationDiscoveryPort(need),
    // The correspondence port drafts through the project's default mailbox (setting `correspondence.defaultMailbox`). It never sends.
    correspondence: new Proxy({}, { get: (_t, method) => async (ctx: ServiceContext, ...rest: unknown[]) => {
      const row = (await sql.query<{ value: string }>(`select value #>> '{}' as value from ${APP_SCHEMA}.settings where tenant_id=$1 and project_id=$2 and key='correspondence.defaultMailbox'`, [ctx.tenantId, ctx.projectId]))[0];
      if (row === undefined) throw new DomainError('unavailable', 'No default mailbox is configured for this project');
      const mod = await import(pathToFileURL(join(enginesDir, 'correspondence', 'src', 'engine', 'index.ts')).href) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
      return mod.correspondencePort(need('correspondence'), { mailboxId: row.value })[method as string](ctx, ...rest);
    } }),
    budget, authorization } });
  factories.discovery = (m) => m.createEngine({ sql, objects: objectsFor(env, 'discovery'), ports: { evidence, authorization, useDecision: useDecisions },
    config: { userAgent: env.DISCOVERY_USER_AGENT ?? 'PAM-Research/0.1 (automated research assistant)', allowedPrivateHosts: (env.DISCOVERY_ALLOWED_PRIVATE_HOSTS ?? '').split(',').filter(Boolean),
      ...(env.DISCOVERY_ALLOWED_PORTS ? { allowedPorts: env.DISCOVERY_ALLOWED_PORTS.split(',').map(Number) } : {}), ...(env.DISCOVERY_CREDENTIAL_KEY ? { credentialKey: env.DISCOVERY_CREDENTIAL_KEY } : {}), ...(env.DISCOVERY_MIN_INTERVAL_MS ? { defaultMinIntervalMs: Number(env.DISCOVERY_MIN_INTERVAL_MS) } : {}) } });
  factories.correspondence = (m) => m.createEngine({ sql, objects: objectsFor(env, 'correspondence'), ports: { authorization, budget, evidence, useDecision: useDecisions },
    config: { ...(env.CORRESPONDENCE_SECRET_KEY ? { secretKey: env.CORRESPONDENCE_SECRET_KEY } : {}), provider: { allowPrivateHosts: env.CORRESPONDENCE_ALLOW_PRIVATE_HOSTS === '1', allowInsecureTls: env.CORRESPONDENCE_ALLOW_INSECURE_TLS === '1' }, ...(env.CORRESPONDENCE_RECONCILE_DELAY_MS ? { reconcileDelayMs: Number(env.CORRESPONDENCE_RECONCILE_DELAY_MS) } : {}) } });
  factories.editorial = (m) => m.createEngine({ sql, objects: objectsFor(env, 'editorial'), ports: { knowledge: adapters.editorialKnowledgePort(need), useDecisions, authorization } });
  // E14 aggregates the other engines through their standard surfaces, always with the CALLER's context.
  const ENGINE_IDS: Record<string, string> = Object.fromEntries(ENGINE_ORDER.map(([id, short]) => [id, short]));
  const engineMap = new Proxy({} as Record<string, unknown>, {
    ownKeys: () => ['E00', ...ENGINE_ORDER.map(([id]) => id).filter((id) => id !== 'E14' && maybe(ENGINE_IDS[id] as string) !== null)],
    getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
    get: (_t, id) => (id === 'E00' ? runtimeRef.current?.orchestration : typeof id === 'string' && ENGINE_IDS[id] !== undefined ? maybe(ENGINE_IDS[id] as string) ?? undefined : undefined),
    has: (_t, id) => id === 'E00' || (typeof id === 'string' && ENGINE_IDS[id] !== undefined && maybe(ENGINE_IDS[id] as string) !== null),
  });
  factories.workspace = (m) => m.createEngine({ sql, ports: { engines: engineMap, controls: { E00: orchestrationControls(() => runtimeRef.current) } } });
  factories.release = (m) => {
    // Jurisdiction packs are deployment data: every *.json file in PAM_JURISDICTION_PACKS_DIR.
    const dir = env.PAM_JURISDICTION_PACKS_DIR; const packs = dir && existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8'))) : [];
    const root = join(resolve(env.PAM_DATA_DIR ?? './data'), 'destinations'); mkdirSync(root, { recursive: true });
    return m.createEngine({ sql, objects: objectsFor(env, 'release'), ports: { useDecision: useDecisions, authorization, evidence,
      useRegister: { recordUse: async (ctx: ServiceContext, input: unknown) => need('consent').recordUse({ ...(await serviceContext({ tenantId: ctx.tenantId, projectId: ctx.projectId })), requestId: ctx.requestId }, input) } },
      config: { jurisdictionPacks: packs, destinations: { roots: [root, ...(env.RELEASE_DESTINATION_ROOTS ? env.RELEASE_DESTINATION_ROOTS.split(':') : [])], ...(env.RELEASE_DOWNLOAD_SECRET ? { downloadSecret: env.RELEASE_DOWNLOAD_SECRET } : {}), ...(env.PAM_PUBLIC_URL ? { publicBaseUrl: `${env.PAM_PUBLIC_URL}/api/e/release` } : {}) },
        ...(env.RELEASE_ACCOUNTABILITY_POLICY ? { accountabilityPolicy: env.RELEASE_ACCOUNTABILITY_POLICY } : {}) } });
  };
  const generic = (short: string) => (m: Record<string, any>): unknown => m.createEngine({ sql, objects: objectsFor(env, short), ports: { authorization, useDecisions, evidence, budget }, config: {} }); // eslint-disable-line @typescript-eslint/no-explicit-any

  for (const [id, short] of ENGINE_ORDER) {
    const entryPath = join(enginesDir, short, 'src', 'engine', 'index.ts');
    if (!existsSync(entryPath)) { entries.set(short, { id, short, available: false, error: 'engine service layer is not installed', engine: null, routes: [], runJobs: null }); continue; }
    try {
      const contractsPath = join(enginesDir, short, 'src', 'contracts.ts');
      if (existsSync(contractsPath)) unifyDomainError((await import(pathToFileURL(contractsPath).href) as { DomainError?: unknown }).DomainError);
      const mod = await import(pathToFileURL(entryPath).href) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
      if (doMigrate) await mod.migrate(sql);
      const engine = (factories[short] ?? generic(short))(mod) as AnyEngine;
      entries.set(short, { id, short, available: true, error: null, engine, routes: mod.routes(engine) as Route[], runJobs: jobRunner(short, engine) });
    } catch (error) {
      entries.set(short, { id, short, available: false, error: error instanceof Error ? error.message : String(error), engine: null, routes: [], runJobs: null });
    }
  }

  const identity = maybe('identity');
  const verify: TokenVerifier = identity === null
    ? async () => { throw new DomainError('unauthenticated', 'Identity engine is unavailable'); }
    : identity.verifier() as TokenVerifier;
  const cache = new Map<string, { ctx: ServiceContext; until: number }>();
  const serviceContext = async (scope: Scope, purpose = 'operations'): Promise<ServiceContext> => {
    const key = `${scope.tenantId}\u0000${scope.projectId}\u0000${purpose}`;
    const hit = cache.get(key);
    if (hit !== undefined && hit.until > Date.now()) return { ...hit.ctx, requestId: `svc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, now: new Date().toISOString() };
    if (identity === null) throw new DomainError('unavailable', 'Identity engine is unavailable');
    const row = (await sql.query<{ orchestrator_service_id: string }>(`select orchestrator_service_id from ${APP_SCHEMA}.tenants where tenant_id=$1`, [scope.tenantId]))[0];
    if (row === undefined) throw new DomainError('forbidden', 'Organization is not provisioned for orchestration');
    const issued = await identity.host.issueServiceToken({ tenantId: scope.tenantId, serviceId: row.orchestrator_service_id, projectId: scope.projectId, purpose, ttlSeconds: 300 }) as { token: string };
    const ctx = await verify(issued.token, { requestId: 'svc' });
    cache.set(key, { ctx, until: Date.now() + 120_000 });
    return ctx;
  };

  serviceContextRef.fn = serviceContext;
  const orchestration = orchestrationModule.createEngine({
    sql,
    ports: {
      authorization, budget,
      agentContext: {
        // Agents act under PAM's service identity narrowed to the organization and project of the task. Authority never
        // comes from task input. (Per-agent least-privilege tokens are issued by actions that need them.)
        contextFor: ({ scope, requestId }) => serviceContext(scope).then((ctx) => ({ ...ctx, requestId })),
      },
      // Actual effort per research lane is recorded in E13 (measured work, never outcome quotas).
      work: { recordWork: async (ctx, work) => {
        const r = maybe('resources'); if (r === null || work.lane === null) return;
        await r.recordWork(ctx, { lane: work.lane, task: work.taskRef, objective: work.objectiveRef, startedAt: work.startedAt, endedAt: work.endedAt, activeSeconds: Math.max(1, Math.round(work.activeMs / 1000)), actorId: ctx.actor.id, actorKind: ctx.actor.kind, idempotencyKey: `work-${work.taskRef}-${work.endedAt}` });
      } },
    },
    config: { maxConcurrency: Number(env.PAM_MAX_CONCURRENCY ?? 4), leaseMs: Number(env.PAM_TASK_LEASE_MS ?? 120_000) },
  });

  const runtime: Runtime = {
    env, sql, engines: entries, orchestration, verify, serviceContext, maybe,
    get(short) { const e = maybe(short); if (e === null) throw new DomainError('unavailable', `${short} engine is unavailable: ${entries.get(short)?.error ?? 'not installed'}`); return e; },
    async close() { await pool.end(); },
  };
  runtimeRef.current = runtime;
  for (const [name, def] of Object.entries(options.actions?.(runtime) ?? {})) orchestration.registerAction(name, def);
  return runtime;
}

export async function setSetting(runtime: Runtime, ctx: ServiceContext, key: string, value: unknown): Promise<void> {
  await runtime.sql.query(`insert into ${APP_SCHEMA}.settings (tenant_id, project_id, key, value, updated_by) values ($1,$2,$3,$4::jsonb,$5) on conflict (tenant_id, project_id, key) do update set value=excluded.value, updated_by=excluded.updated_by, updated_at=now()`, [ctx.tenantId, ctx.projectId, key, JSON.stringify(value), ctx.actor.id]);
}
export async function getSetting<T = unknown>(runtime: Runtime, scope: Scope, key: string): Promise<T | null> {
  return ((await runtime.sql.query<{ value: T }>(`select value from ${APP_SCHEMA}.settings where tenant_id=$1 and project_id=$2 and key=$3`, [scope.tenantId, scope.projectId, key]))[0]?.value) ?? null;
}

/** Creates PAM's orchestrator service identity in an organization. Requires a human administrator context for that organization. */
export async function provisionOrganization(runtime: Runtime, ctx: ServiceContext): Promise<{ tenantId: string; serviceId: string; created: boolean }> {
  const existing = (await runtime.sql.query<{ orchestrator_service_id: string }>(`select orchestrator_service_id from ${APP_SCHEMA}.tenants where tenant_id=$1`, [ctx.tenantId]))[0];
  if (existing !== undefined) return { tenantId: ctx.tenantId, serviceId: existing.orchestrator_service_id, created: false };
  const identity = runtime.get('identity');
  const made = await identity.createServiceIdentity(ctx, { name: 'pam-orchestrator', description: 'PAM orchestration workers and event router', projectId: '*', roles: ['service_orchestrator'] }) as { service: { id: string } };
  await runtime.sql.query(`insert into ${APP_SCHEMA}.tenants (tenant_id, orchestrator_service_id, home_project_id) values ($1,$2,$3) on conflict (tenant_id) do nothing`, [ctx.tenantId, made.service.id, ctx.projectId]);
  // The seeded `administration` purpose covers identity, orchestration, workspace and resources only. A PAM deployment
  // also administers the other engines (mailboxes, sources, policies, destinations, sending grants), so that purpose is
  // extended here (last: changing a purpose invalidates the caller's current token), as organization data, with each engine's exact admin and grant capabilities plus read access.
  const purposes = await identity.listPurposes(ctx) as { name: string; description: string; capabilities: string[] }[];
  const administration = purposes.find((p) => p.name === 'administration');
  if (administration !== undefined) {
    const extra = ['orchestration', ...ENGINE_ORDER.map(([, short]) => short), 'intake'].flatMap((e) => [`${e}:admin`, `${e}:grant`, `${e}:read`]);
    const capabilities = [...new Set([...administration.capabilities, ...extra])];
    if (capabilities.length !== administration.capabilities.length) await identity.definePurpose(ctx, { name: 'administration', description: administration.description, capabilities });
  }
  return { tenantId: ctx.tenantId, serviceId: made.service.id, created: true };
}

/**
 * Aligns the organization's seeded role catalog with the capability names the engines actually use. Call with a FRESH
 * administrator context after provisionOrganization (each catalog change invalidates the caller's current token).
 * Returns true when another call with a fresh context is needed.
 */
export async function alignRoleCatalog(runtime: Runtime, ctx: ServiceContext): Promise<boolean> {
  const identity = runtime.get('identity');
  const roles = await identity.listRoles(ctx) as { name: string; description: string; capabilities: string[]; actorKinds: string[] }[];
  // The correspondence engine names drafting `correspondence:write`; the seeded drafting agent only holds `correspondence:draft`.
  const wanted: Record<string, string[]> = { agent_drafter: ['correspondence:write'] };
  for (const [name, add] of Object.entries(wanted)) {
    const role = roles.find((r) => r.name === name);
    if (role === undefined || add.every((c) => role.capabilities.includes(c))) continue;
    await identity.defineRole(ctx, { name, description: role.description, capabilities: [...role.capabilities, ...add], actorKinds: role.actorKinds });
    return true;
  }
  return false;
}

/** Operator controls on orchestration objects, offered through the workspace. Each control re-checks the caller's own capability in E00. */
export function orchestrationControls(current: () => Runtime | null) {
  const taskControls = [
    { id: 'pause', label: 'Pause', capability: 'orchestration:control', dangerous: false, input: { type: 'object', properties: { reason: { type: 'string' } } } },
    { id: 'resume', label: 'Resume', capability: 'orchestration:control', dangerous: false, input: { type: 'object', properties: {} } },
    { id: 'cancel', label: 'Cancel', capability: 'orchestration:control', dangerous: true, input: { type: 'object', properties: { reason: { type: 'string' } } } },
    { id: 'retry', label: 'Retry', capability: 'orchestration:control', dangerous: false, input: { type: 'object', properties: {} } },
    { id: 'reassign', label: 'Reassign', capability: 'orchestration:control', dangerous: false, input: { type: 'object', required: ['agentId'], properties: { agentId: { type: 'string', description: 'Agent id, or empty to unassign' } } } },
    { id: 'approve', label: 'Approve', capability: 'orchestration:approve', dangerous: false, input: { type: 'object', properties: { reason: { type: 'string' } } } },
    { id: 'reject', label: 'Reject', capability: 'orchestration:approve', dangerous: true, input: { type: 'object', properties: { reason: { type: 'string' } } } },
  ];
  const objectiveControls = [
    { id: 'objective_pause', label: 'Pause objective', capability: 'orchestration:control', dangerous: false, input: { type: 'object', properties: { reason: { type: 'string' } } } },
    { id: 'objective_resume', label: 'Resume objective', capability: 'orchestration:control', dangerous: false, input: { type: 'object', properties: {} } },
    { id: 'objective_cancel', label: 'Cancel objective', capability: 'orchestration:control', dangerous: true, input: { type: 'object', properties: { reason: { type: 'string' } } } },
  ];
  const kindOf = (ref: string): string => ref.split(':')[1] ?? '';
  const idOf = (ref: string): string => (ref.split(':')[2] ?? '').split('@')[0] ?? '';
  return {
    async controlsFor(ctx: ServiceContext, ref: string) {
      const kind = kindOf(ref);
      const specs = kind === 'task' ? taskControls : kind === 'objective' ? objectiveControls : [];
      return specs.filter((c) => ctx.capabilities.includes(c.capability) || ctx.capabilities.includes('orchestration:*') && !['orchestration:approve'].includes(c.capability));
    },
    async invoke(ctx: ServiceContext, ref: string, controlId: string, input: Record<string, unknown>) {
      const rt = current(); if (rt === null) throw new DomainError('unavailable', 'Orchestration is not running');
      const o = rt.orchestration; const id = idOf(ref); const reason = typeof input?.reason === 'string' ? input.reason : '';
      switch (controlId) {
        case 'pause': case 'resume': case 'cancel': case 'retry': return o.controlTask(ctx, id, controlId, reason) as unknown as Json;
        case 'reassign': return o.reassignTask(ctx, id, typeof input?.agentId === 'string' && input.agentId !== '' ? input.agentId : null) as unknown as Json;
        case 'approve': case 'reject': return o.decideTask(ctx, id, controlId, reason) as unknown as Json;
        case 'objective_pause': return o.setObjectiveStatus(ctx, id, 'paused', reason) as unknown as Json;
        case 'objective_resume': return o.setObjectiveStatus(ctx, id, 'active', reason) as unknown as Json;
        case 'objective_cancel': return o.setObjectiveStatus(ctx, id, 'cancelled', reason) as unknown as Json;
        default: throw new DomainError('not_found', 'Unknown control');
      }
    },
  };
}
