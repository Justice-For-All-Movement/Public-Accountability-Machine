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
import type { IntakeReport } from './intake.ts';

const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.map': 'application/json' };
const SECURITY_HEADERS = { 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer', 'content-security-policy': "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; frame-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'self'" };

export type AppState = { lastIntake?: IntakeReport; lastRouter: RouterReport | null; lastWorkerError: string | null; workerPasses: number; startedAt: string };

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
    ...extra(runtime),
  ];
}

const inflight = new WeakMap<Runtime, Set<Promise<unknown>>>();
/** Waits for task executions started by earlier worker passes (used on shutdown). */
export async function drainWorker(runtime: Runtime): Promise<void> { await Promise.all([...(inflight.get(runtime) ?? [])]); }
export async function workerPass(runtime: Runtime, state: AppState, worker: string): Promise<void> {
  try {
    // Task execution is not awaited: an action may follow long engine work whose jobs this same pass must keep running.
    // Concurrency stays bounded by the orchestration engine's lease accounting.
    const pending = inflight.get(runtime) ?? new Set<Promise<unknown>>(); inflight.set(runtime, pending);
    const p: Promise<unknown> = runtime.orchestration.workOnce({ worker }).catch((error: unknown) => { state.lastWorkerError = error instanceof Error ? error.message : String(error); }).finally(() => pending.delete(p));
    pending.add(p);
    for (const entry of runtime.engines.values()) if (entry.runJobs !== null) await entry.runJobs();
    const intake = await syncIntakeOnce(runtime);
    state.lastIntake = intake;
    state.lastRouter = await routeEventsOnce(runtime);
    state.lastWorkerError = null;
  } catch (error) { state.lastWorkerError = error instanceof Error ? error.message : String(error); }
  state.workerPasses++;
}

export type StartOptions = Readonly<{ port?: number; host?: string; webDir?: string; worker?: boolean; workerIntervalMs?: number; extraRoutes?: (runtime: Runtime) => Route[] }>;

export async function startServer(runtime: Runtime, options: StartOptions = {}): Promise<{ server: Server; url: string; state: AppState; stop(): Promise<void> }> {
  const state: AppState = { lastRouter: null, lastWorkerError: null, workerPasses: 0, startedAt: new Date().toISOString() };
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
      handler(req, res); return;
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
