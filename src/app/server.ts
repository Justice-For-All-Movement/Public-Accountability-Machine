// PAM application server: one HTTP origin for the browser application, a gateway to every engine's own API
// (`/api/e/<engine>/v1/...`, authenticated by Identity-issued bearer tokens and enforced inside each engine),
// PAM application routes (`/api/app/...`) and the background worker loop.
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { DomainError } from '../contracts.ts';
import type { Json } from '../contracts.ts';
import { createHttpHandler, requireCapability } from '../service-kit.ts';
import type { Route } from '../service-kit.ts';
import { routes as orchestrationRoutes } from '../orchestration/index.ts';
import { APP_SCHEMA, alignRoleCatalog, provisionOrganization } from './compose.ts';
import type { Runtime } from './compose.ts';
import { routeEventsOnce } from './router.ts';
import { toEvidenceItems, toReleasePackage } from './adapters.ts';
import type { RouterReport } from './router.ts';
import { intakeLinks, syncIntakeOnce } from './intake.ts';
import { closeInterruptedActionRuns, gatewayCheck, researchRoutes } from './research.ts';
import { sealedRoutes } from './sealed.ts';
import { sealPendingMailOnce, sealedMailRoutes } from './sealed-mail.ts';
import type { IntakeReport } from './intake.ts';

const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.map': 'application/json' };
const SECURITY_HEADERS = { 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer', 'content-security-policy': "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; frame-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'self'" };

export type AppState = { lastIntake?: IntakeReport; lastSealedMail?: { attempted: number; erased: number; error?: string }; lastHousekeeping?: { at: string; licencesExpiringNotified: number; conversationsWithoutResponse: number; errors: string[] }; lastRouter: RouterReport | null; lastWorkerError: string | null; workerPasses: number; startedAt: string };

export function appRoutes(runtime: Runtime, state: AppState, extra: (runtime: Runtime) => Route[] = () => []): Route[] {
  return [
    // Public: which engines are running. Names and availability only; no data.
    { method: 'GET', path: '/v1/status', public: true, handler: async () => {
      const identity = runtime.maybe('identity');
      // intakeUrl: public address of the separate intake application (staff UI and participant form), if configured.
      return { name: 'Public Accountability Machine', startedAt: state.startedAt, intakeUrl: runtime.env.PAM_INTAKE_PUBLIC_URL ?? null,
        bootstrapped: identity === null ? null : await identity.isBootstrapped(),
        engines: [{ id: 'E00', short: 'orchestration', available: true, error: null }, ...[...runtime.engines.values()].map((e) => ({ id: e.id, short: e.short, available: e.available, error: e.available ? null : 'unavailable' }))] } as unknown as Json;
    } },
    // Detailed health for operators (errors may name configuration, so it needs a capability).
    { method: 'GET', path: '/v1/health', handler: async (r) => {
      requireCapability(r.ctx, 'orchestration:read');
      const engines = await Promise.all([...runtime.engines.values()].map(async (e) => ({ id: e.id, short: e.short, available: e.available, error: e.error, health: e.engine === null ? null : await e.engine.health().catch((error: unknown) => ({ ok: false, detail: { error: String(error) } })) })));
      return { orchestration: await runtime.orchestration.health(), engines, worker: { passes: state.workerPasses, lastError: state.lastWorkerError, lastRouter: state.lastRouter, lastIntake: state.lastIntake ?? null } } as unknown as Json;
    } },
    // Needs attention: stale/blocked/failed/uncertain/no-response/review items recorded by the event router. Each item is
    // shown only when the owning engine lets THIS caller inspect its subject; hidden material is neither listed nor counted.
    { method: 'GET', path: '/v1/alerts', handler: async (r) => {
      requireCapability(r.ctx, 'workspace:read');
      const all = r.query.get('all') === '1';
      const rows = await runtime.sql.query<{ event_key: string; engine: string; type: string; subject: string; at: Date; acked: Date | null }>(
        `select a.event_key, a.engine, a.type, a.subject, a.at, k.at as acked from ${APP_SCHEMA}.alerts a left join ${APP_SCHEMA}.alert_acks k on k.tenant_id=a.tenant_id and k.actor_id=$3 and k.event_key=a.event_key
         where a.tenant_id=$1 and a.project_id=$2 ${all ? '' : 'and k.at is null'} order by a.at desc limit 300`, [r.ctx.tenantId, r.ctx.projectId, r.ctx.actor.id]);
      const byId = new Map([...runtime.engines.values()].map((e) => [e.id, e]));
      const seen = new Map<string, { title: string; state: string; stale: boolean; blocked: boolean } | null>();
      const items: Json[] = [];
      for (const row of rows) {
        const owner = byId.get(row.subject.split(':')[0] ?? '');
        if (!seen.has(row.subject)) {
          let view: { title: string; state: string; stale: boolean; blocked: boolean } | null = null;
          try { const i = owner?.engine === null || owner === undefined ? null : await owner.engine.inspect(r.ctx, row.subject) as { title: string; state: string; stale: boolean; blocked: boolean } | null; view = i === null ? null : { title: i.title, state: i.state, stale: i.stale, blocked: i.blocked }; }
          catch { view = null; }
          seen.set(row.subject, view);
        }
        const view = seen.get(row.subject);
        if (view === null || view === undefined) continue;
        items.push({ eventKey: row.event_key, engine: row.engine, type: row.type, subject: row.subject, at: row.at.toISOString(), acknowledgedAt: row.acked === null ? null : row.acked.toISOString(), title: view.title, state: view.state, stillStale: view.stale, stillBlocked: view.blocked });
        if (items.length >= 100) break;
      }
      return { items, generatedAt: new Date().toISOString() } as unknown as Json;
    } },
    { method: 'POST', path: '/v1/alerts/acknowledge', handler: async (r) => {
      requireCapability(r.ctx, 'workspace:read');
      const keys = (r.body as { eventKeys?: unknown } | null)?.eventKeys;
      if (!Array.isArray(keys) || keys.length === 0 || keys.length > 200 || !keys.every((k) => typeof k === 'string' && k.length <= 200)) throw new DomainError('invalid_input', 'eventKeys must list 1 to 200 alert keys');
      await runtime.sql.query(`insert into ${APP_SCHEMA}.alert_acks (tenant_id, actor_id, event_key, at) select $1, $2, a.event_key, now() from ${APP_SCHEMA}.alerts a where a.tenant_id=$1 and a.project_id=$3 and a.event_key = any($4::text[]) on conflict do nothing`,
        [r.ctx.tenantId, r.ctx.actor.id, r.ctx.projectId, keys]);
      return { acknowledged: keys.length };
    } },
    // Creates PAM's own service identity in the caller's organization so workers and the event router can act there.
    { method: 'POST', path: '/v1/provision', handler: async (r) => { requireCapability(r.ctx, 'identity:admin'); return (await provisionOrganization(runtime, r.ctx)) as unknown as Json; } },
    // Run after /v1/provision with a fresh token, repeatedly until `again` is false.
    { method: 'POST', path: '/v1/provision/roles', handler: async (r) => { requireCapability(r.ctx, 'identity:admin'); return { again: await alignRoleCatalog(runtime, r.ctx) }; } },
    // Intake cases linked to investigations the caller can see (read-only aggregation for the Intake & cases screen).
    { method: 'GET', path: '/v1/intake/links', handler: async (r) => {
      requireCapability(r.ctx, 'investigation:read');
      const investigation = runtime.maybe('investigation');
      const configured = intakeLinks(runtime.env).has(r.ctx.tenantId);
      if (investigation === null) throw new DomainError('unavailable', 'The investigation engine is not running');
      const visible = new Map(((await investigation.listInvestigations(r.ctx, {})) as { ref: string; id: string; state: string; data: { title: string } }[]).map((i) => [i.ref.split('@')[0], i]));
      const rows = await runtime.sql.query<{ intake_kind: string; intake_id: string; pam_ref: string; created_at: Date }>(`select intake_kind, intake_id, pam_ref, created_at from ${APP_SCHEMA}.intake_links where tenant_id=$1 order by created_at desc limit 500`, [r.ctx.tenantId]);
      const links = rows.filter((x) => visible.has(x.pam_ref.split('@')[0])).map((x) => { const inv = visible.get(x.pam_ref.split('@')[0]) as { id: string; state: string; data: { title: string } }; return { intakeKind: x.intake_kind, intakeId: x.intake_id, ref: x.pam_ref, investigationId: inv.id, title: inv.data.title, state: inv.state, linkedAt: x.created_at.toISOString() }; });
      return { configured, intakeUrl: runtime.env.PAM_INTAKE_PUBLIC_URL ?? null, links } as unknown as Json;
    } },
    // Pure conversion of an investigation package (E08, fetched by the caller with its own token) into release builder
    // input (E12): the same mapping the orchestration actions use. Reads and writes nothing.
    { method: 'POST', path: '/v1/release/inputs', handler: async (r) => {
      requireCapability(r.ctx, 'release:read');
      const body = r.body as { package?: { ref?: unknown; content?: unknown } } | null;
      if (body === null || typeof body !== 'object' || body.package === undefined || typeof body.package.ref !== 'string' || body.package.content === null || typeof body.package.content !== 'object') throw new DomainError('invalid_input', 'package { ref, content } is required');
      const pkg = { ref: body.package.ref, content: body.package.content as Json };
      return { package: toReleasePackage(pkg), items: toEvidenceItems(pkg) } as unknown as Json;
    } },
    // Research record standard: tool register, research runs, the record of a project (src/app/research.ts).
    ...researchRoutes(runtime),
    // Sealed records: encrypted in the browser; the server holds ciphertext, code names and commitments (src/app/sealed.ts).
    ...sealedRoutes(runtime),
    // Sealed mailboxes: which mailboxes seal inbound mail on arrival (src/app/sealed-mail.ts).
    ...sealedMailRoutes(runtime),
    ...extra(runtime),
  ];
}

const inflight = new WeakMap<Runtime, Set<Promise<unknown>>>();
const engineInflight = new WeakMap<Runtime, Map<string, Set<Promise<unknown>>>>();
const engineErrors = new WeakMap<Runtime, string>();
/** Waits for task executions and engine job passes started by earlier worker passes (used on shutdown). */
export async function drainWorker(runtime: Runtime): Promise<void> { await Promise.all([...(inflight.get(runtime) ?? []), ...[...(engineInflight.get(runtime)?.values() ?? [])].flatMap((x) => [...x])]); }
const lastHousekeeping = new WeakMap<Runtime, number>();
/**
 * Periodic duties engines leave to their host (E13 licence expiry notices, E03 no-response outcomes). Runs at most once per
 * PAM_HOUSEKEEPING_INTERVAL_MS (default one hour) under PAM's service identity, for every project of every provisioned
 * organization. A failure in one project is recorded and does not stop the others.
 */
async function housekeeping(runtime: Runtime, state: AppState): Promise<void> {
  const every = Number(runtime.env.PAM_HOUSEKEEPING_INTERVAL_MS ?? 3_600_000);
  const last = lastHousekeeping.get(runtime) ?? 0;
  if (Date.now() - last < every) return;
  lastHousekeeping.set(runtime, Date.now());
  const resources = runtime.maybe('resources'); const identity = runtime.maybe('identity'); const correspondence = runtime.maybe('correspondence');
  if (resources === null || identity === null) return;
  const tenants = await runtime.sql.query<{ tenant_id: string; home_project_id: string }>(`select tenant_id, home_project_id from ${APP_SCHEMA}.tenants`);
  let expiring = 0, noResponse = 0; const errors: string[] = [];
  for (const t of tenants) {
    try {
      const home = await runtime.serviceContext({ tenantId: t.tenant_id, projectId: t.home_project_id });
      const projects = await identity.listProjects(home) as { id: string }[];
      for (const p of projects) {
        try {
          const base = await runtime.serviceContext({ tenantId: t.tenant_id, projectId: p.id });
          expiring += ((await resources.checkLicenseExpiry({ ...base, capabilities: ['resources:write', 'resources:read'] }, {})) as { expiring: string[] }).expiring.length;
          // E03: record "no response" on sent inquiries left unanswered (an investigation outcome, not a failure).
          if (correspondence !== null) noResponse += ((await correspondence.sweepNoResponse({ ...base, capabilities: ['correspondence:write', 'correspondence:read'] }, { afterDays: Number(runtime.env.PAM_NO_RESPONSE_DAYS ?? 21) })) as { marked: string[] }).marked.length;
        } catch (error) { errors.push(`${t.tenant_id}/${p.id}: ${error instanceof Error ? error.message : String(error)}`); }
      }
    } catch (error) { errors.push(`${t.tenant_id}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  state.lastHousekeeping = { at: new Date().toISOString(), licencesExpiringNotified: expiring, conversationsWithoutResponse: noResponse, errors: errors.slice(0, 20) };
}

export async function workerPass(runtime: Runtime, state: AppState, worker: string): Promise<void> {
  try {
    // Task execution is not awaited: an action may follow long engine work whose jobs this same pass must keep running.
    // Concurrency stays bounded by the orchestration engine's lease accounting.
    const pending = inflight.get(runtime) ?? new Set<Promise<unknown>>(); inflight.set(runtime, pending);
    const p: Promise<unknown> = runtime.orchestration.workOnce({ worker }).catch((error: unknown) => { state.lastWorkerError = error instanceof Error ? error.message : String(error); }).finally(() => pending.delete(p));
    pending.add(p);
    // Each engine's job runner runs independently of the others: a long job in one engine (a discovery collection run
    // fetching hundreds of pages, say) must not hold up search, processing or agent work in the rest. At most one pass
    // per engine is in flight; drainWorker waits for them on shutdown.
    // Up to PAM_ENGINE_JOB_CONCURRENCY passes per engine (default 4) may be in flight, so a long job (a collection run
    // fetching hundreds of pages at a polite rate) does not hold up that engine's short jobs (single searches) either.
    // Jobs are leased individually by the engines, so concurrent passes never run the same job.
    const limit = Math.max(1, Number(runtime.env.PAM_ENGINE_JOB_CONCURRENCY ?? 4));
    const engineRuns = engineInflight.get(runtime) ?? new Map<string, Set<Promise<unknown>>>(); engineInflight.set(runtime, engineRuns);
    for (const entry of runtime.engines.values()) {
      if (entry.runJobs === null) continue;
      const running = engineRuns.get(entry.short) ?? new Set<Promise<unknown>>(); engineRuns.set(entry.short, running);
      if (running.size >= limit) continue;
      const job: Promise<unknown> = entry.runJobs().catch((error: unknown) => { engineErrors.set(runtime, `${entry.short}: ${error instanceof Error ? error.message : String(error)}`); }).finally(() => running.delete(job));
      running.add(job);
    }
    const intake = await syncIntakeOnce(runtime);
    state.lastIntake = intake;
    state.lastRouter = await routeEventsOnce(runtime);
    // Sealed mailboxes: retry messages waiting for a sealing key or whose sealing or erasure failed earlier.
    try { state.lastSealedMail = await sealPendingMailOnce(runtime); } catch (error) { state.lastSealedMail = { attempted: 0, erased: 0, error: error instanceof Error ? error.message : String(error) }; }
    await housekeeping(runtime, state);
    // An engine job pass that failed since the last pass is reported now (it ran outside this pass).
    state.lastWorkerError = engineErrors.get(runtime) ?? null; engineErrors.delete(runtime);
  } catch (error) { state.lastWorkerError = error instanceof Error ? error.message : String(error); }
  state.workerPasses++;
}

export type StartOptions = Readonly<{ port?: number; host?: string; webDir?: string; worker?: boolean; workerIntervalMs?: number; extraRoutes?: (runtime: Runtime) => Route[] }>;

export async function startServer(runtime: Runtime, options: StartOptions = {}): Promise<{ server: Server; url: string; state: AppState; stop(): Promise<void> }> {
  const state: AppState = { lastRouter: null, lastWorkerError: null, workerPasses: 0, startedAt: new Date().toISOString() };
  // Research runs of actions that the previous process left open can never finish: close them as interrupted.
  const closed = await closeInterruptedActionRuns(runtime, new Date(state.startedAt)).catch(() => 0);
  if (closed > 0) console.log(JSON.stringify({ level: 'info', message: 'closed interrupted action runs', count: closed }));
  const onError = (error: unknown, info: { requestId: string; method: string; path: string }): void => { console.error(JSON.stringify({ level: 'error', requestId: info.requestId, method: info.method, path: info.path, error: error instanceof Error ? error.message : String(error) })); };
  const handlers = new Map<string, (req: IncomingMessage, res: ServerResponse) => void>();
  for (const entry of runtime.engines.values()) if (entry.engine !== null) handlers.set(entry.short, createHttpHandler({ name: entry.short, version: entry.engine.manifest.version, routes: entry.routes, verify: runtime.verify, health: () => (entry.engine as NonNullable<typeof entry.engine>).health(), onError }));
  handlers.set('orchestration', createHttpHandler({ name: 'orchestration', version: runtime.orchestration.manifest.version, routes: orchestrationRoutes(runtime.orchestration), verify: runtime.verify, onError }));
  const app = createHttpHandler({ name: 'pam', version: '0.1.0', routes: appRoutes(runtime, state, options.extraRoutes), verify: runtime.verify, onError });
  const webDir = resolve(options.webDir ?? './web');
  // Browser component library of the workspace engine (E14), served read-only from its installed copy.
  const workspaceWebDir = resolve(runtime.env.PAM_ENGINES_DIR ?? './engines', 'workspace', 'web');

  const serveStatic = async (req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> => {
    let base = webDir; let path = pathname;
    if (pathname.startsWith('/engines/workspace/web/')) { base = workspaceWebDir; path = pathname.slice('/engines/workspace/web'.length); }
    let rel = normalize(decodeURIComponent(path)).replace(/^([/\\])+/, '');
    if (rel === '' || !extname(rel)) { if (base !== webDir) { res.writeHead(404).end(); return; } rel = 'index.html'; } // client-side routes fall back to the application shell
    const full = join(base, rel);
    if (!full.startsWith(base + sep)) { res.writeHead(404).end(); return; }
    try {
      const st = await stat(full);
      if (!st.isFile()) throw new Error('not a file');
      res.writeHead(200, { 'content-type': MIME[extname(full)] ?? 'application/octet-stream', 'content-length': String(st.size), 'cache-control': 'no-cache', ...SECURITY_HEADERS });
      if (req.method === 'HEAD') res.end(); else createReadStream(full).pipe(res);
    } catch { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS }).end('Not found'); }
  };

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://pam.invalid');
    const engineMatch = /^\/api\/e\/([a-z]+)(\/.*)$/.exec(url.pathname);
    if (engineMatch !== null) {
      const handler = handlers.get(engineMatch[1] as string);
      if (handler === undefined) { res.writeHead(503, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify({ error: { code: 'unavailable', message: `The ${engineMatch[1]} engine is not running in this deployment` } })); return; }
      req.url = `${engineMatch[2]}${url.search}`;
      // Research record standard: writes are journalled, and writes outside the application need an open research run.
      void gatewayCheck(runtime, engineMatch[1] as string, req, res, engineMatch[2] as string)
        .then((go) => { if (go) handler(req, res); })
        .catch((error: unknown) => { onError(error, { requestId: 'gateway', method: req.method ?? '', path: url.pathname }); if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify({ error: { code: 'internal', message: 'The research record check failed; nothing was changed' } })); });
      return;
    }
    if (url.pathname.startsWith('/api/app/')) { req.url = `${url.pathname.slice('/api/app'.length)}${url.search}`; app(req, res); return; }
    if (url.pathname === '/healthz') { req.url = '/healthz'; app(req, res); return; }
    if (url.pathname.startsWith('/api/')) { res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify({ error: { code: 'not_found', message: 'Not found' } })); return; }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
    void serveStatic(req, res, url.pathname);
  });
  await new Promise<void>((ok, fail) => { server.once('error', fail); server.listen(options.port ?? 8080, options.host ?? '127.0.0.1', ok); });
  const address = server.address() as { port: number };

  let timer: NodeJS.Timeout | null = null; let running = false; let stopped = false;
  if (options.worker !== false) {
    const worker = `pam-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    const tick = (): void => { if (running || stopped) return; running = true; void workerPass(runtime, state, worker).finally(() => { running = false; }); };
    timer = setInterval(tick, options.workerIntervalMs ?? 1000);
  }
  return { server, url: `http://${options.host ?? '127.0.0.1'}:${address.port}`, state,
    async stop() { stopped = true; if (timer !== null) clearInterval(timer); for (let i = 0; i < 200 && running; i++) await new Promise((r) => setTimeout(r, 25)); await Promise.race([drainWorker(runtime), new Promise((r) => setTimeout(r, 5000))]); await new Promise<void>((ok) => server.close(() => ok())); } };
}
export { DomainError };
