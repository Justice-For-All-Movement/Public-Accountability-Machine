// Acceptance harness: starts the real composed application (real PostgreSQL database created for the run, real object
// storage on disk, real engines from ./engines) and gives tests authenticated contexts obtained the way a user gets them:
// password login → purpose-scoped access token → verified ServiceContext.
import { existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { withDisposableDatabase } from '../../src/service-kit.ts';
import type { ServiceContext } from '../../src/service-kit.ts';
import { alignRoleCatalog, compose, provisionOrganization } from '../../src/app/compose.ts';
import type { Runtime } from '../../src/app/compose.ts';
import { workerPass } from '../../src/app/server.ts';
import type { AppState } from '../../src/app/server.ts';
import { loadActions } from '../../src/app/registry.ts';

export const ADMIN_URL = process.env.TEST_DATABASE_URL ?? '';
export const REQUIRED = ['identity', 'consent', 'resources', 'evidence', 'processing', 'knowledge', 'investigation', 'release'];
export function skipReason(required: readonly string[] = REQUIRED): string | false {
  if (ADMIN_URL === '') return 'TEST_DATABASE_URL is not set; acceptance test not executed';
  const missing = required.filter((s) => !existsSync(new URL(`../../engines/${s}/src/engine/index.ts`, import.meta.url)));
  return missing.length > 0 ? `engines not installed under ./engines: ${missing.join(', ')} (run npm run engines:link)` : false;
}

export type Person = { login: string; password: string; actorId: string; refreshToken: string };
export type Org = { tenantId: string; projectId: string; owner: Person; as(person: Person, purpose: string): Promise<ServiceContext>;
  /** Context for a durable agent identity: a short-lived token carrying exactly the listed capabilities, or a refusal. */
  asAgent(agentId: string, purpose: string, capabilities: string[]): Promise<ServiceContext> };
export type Stack = { runtime: Runtime; state: AppState; dataDir: string; url: string;
  createOrg(name: string): Promise<Org>;
  addUser(org: Org, name: string, roles: string[]): Promise<Person>;
  /** Runs worker passes (orchestration tasks, engine jobs, event router) until `done` returns true or the deadline passes. */
  settle(done?: () => Promise<boolean>, timeoutMs?: number): Promise<void>;
};

export async function withStack(fn: (stack: Stack) => Promise<void>, extraEnv: Record<string, string> = {}): Promise<void> {
  await withDisposableDatabase(pg, ADMIN_URL, async (url) => {
    const dataDir = await mkdtemp(join(tmpdir(), 'pam-acceptance-'));
    const env = { DATABASE_URL: url, PAM_DATA_DIR: dataDir, PAM_ENGINES_DIR: new URL('../../engines', import.meta.url).pathname,
      IDENTITY_KEY_ENCRYPTION_KEY: randomBytes(32).toString('base64'), EVIDENCE_MASTER_KEY: randomBytes(32).toString('base64'),
      // No antivirus signature database is reachable in this environment; the documented explicit policy is used and recorded on every item.
      EVIDENCE_SCAN_POLICY: 'structural_only',
      // Fictional example jurisdiction pack shipped with the release engine; real packs are private deployment data.
      PAM_JURISDICTION_PACKS_DIR: new URL('../../engines/release/examples/jurisdiction-packs', import.meta.url).pathname, ...extraEnv };
    const runtime = await compose(env, { actions: loadActions });
    const state: AppState = { lastRouter: null, lastWorkerError: null, workerPasses: 0, startedAt: new Date().toISOString() };
    const identity = runtime.get('identity');
    let first = true;
    const password = (): string => randomBytes(18).toString('base64');
    const signIn = async (login: string, pw: string, actorId: string): Promise<Person> => ({ login, password: pw, actorId, refreshToken: (await identity.login({ login, password: pw }) as { refreshToken: string }).refreshToken });
    const ctxFor = async (tenantId: string, projectId: string, person: Person, purpose: string): Promise<ServiceContext> => {
      const issued = await identity.issueAccessToken({ refreshToken: person.refreshToken, tenantId, projectId, purpose }) as { token: string };
      return runtime.verify(issued.token, { requestId: `t-${randomBytes(4).toString('hex')}` });
    };
    let platformAdmin: { person: Person; tenantId: string; projectId: string } | null = null;
    const stack: Stack = {
      runtime, state, dataDir, url,
      async createOrg(name) {
        const login = `owner-${randomBytes(3).toString('hex')}@example.org`; const pw = password();
        let tenantId: string, projectId: string, actorId: string;
        if (first) {
          const made = await identity.bootstrapFirstAdministrator({ login, password: pw, displayName: `${name} owner`, organization: { name, project: { name: 'Main project' } } }) as { organization: { id: string }; project: { id: string }; actorId: string };
          tenantId = made.organization.id; projectId = made.project.id; actorId = made.actorId; first = false;
        } else {
          const p = platformAdmin as NonNullable<typeof platformAdmin>;
          const made = await identity.createOrganization(await ctxFor(p.tenantId, p.projectId, p.person, 'administration'), { name, project: { name: 'Main project' }, owner: { login, password: pw, displayName: `${name} owner` } }) as { organization: { id: string }; project: { id: string }; ownerActorId: string };
          tenantId = made.organization.id; projectId = made.project.id; actorId = made.ownerActorId;
        }
        const owner = await signIn(login, pw, actorId);
        if (platformAdmin === null) platformAdmin = { person: owner, tenantId, projectId };
        await provisionOrganization(runtime, await ctxFor(tenantId, projectId, owner, 'administration'));
        while (await alignRoleCatalog(runtime, await ctxFor(tenantId, projectId, owner, 'administration'))) { /* one catalog change per fresh token */ }
        return { tenantId, projectId, owner, as: (person, purpose) => ctxFor(tenantId, projectId, person, purpose),
          asAgent: async (agentId, purpose, capabilities) => {
            const issued = await identity.issueAgentToken(await ctxFor(tenantId, projectId, owner, 'administration'), { agentId, purpose, capabilities, ttlSeconds: 600 }) as { token: string };
            return runtime.verify(issued.token, { requestId: `a-${randomBytes(4).toString('hex')}` });
          } };
      },
      async addUser(org, name, roles) {
        const login = `${name.toLowerCase().replaceAll(/[^a-z]/g, '')}-${randomBytes(3).toString('hex')}@example.org`; const pw = password();
        const admin = await org.as(org.owner, 'administration');
        const user = await identity.createUser(admin, { login, password: pw, displayName: name }) as { id?: string; actor?: { id: string } };
        const actorId = user.id ?? (user.actor as { id: string }).id;
        await identity.setMembership(admin, { actorId, projectId: org.projectId, roles });
        return signIn(login, pw, actorId);
      },
      async settle(done, timeoutMs = 120_000) {
        const deadline = Date.now() + timeoutMs;
        for (let quiet = 0; Date.now() < deadline;) {
          await workerPass(runtime, state, 'acceptance-worker');
          if (state.lastWorkerError !== null) throw new Error(`worker pass failed: ${state.lastWorkerError}`);
          if (done !== undefined) { if (await done()) return; }
          else if ((state.lastRouter?.events ?? 0) === 0) { if (++quiet >= 3) return; } else quiet = 0;
          await new Promise((r) => setTimeout(r, 150));
        }
        if (done !== undefined) throw new Error('settle: condition not reached before the deadline');
      },
    };
    try { await fn(stack); } finally { await runtime.close(); }
  });
}
