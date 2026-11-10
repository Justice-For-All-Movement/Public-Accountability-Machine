#!/usr/bin/env node
// Command line entry: `node src/app/main.ts <migrate|serve|worker|bootstrap-admin>`.
import { compose, provisionOrganization } from './compose.ts';
import { startServer, workerPass } from './server.ts';
import type { AppState } from './server.ts';
import { loadActions, loadExtraRoutes } from './registry.ts';

const env = process.env;
const command = process.argv[2] ?? 'serve';
const runtime = await compose(env, { actions: loadActions });
const report = (): void => { for (const e of runtime.engines.values()) console.log(`${e.id} ${e.short.padEnd(15)} ${e.available ? 'ready' : `unavailable: ${e.error}`}`); };

if (command === 'migrate') { report(); await runtime.close(); }
else if (command === 'bootstrap-admin') {
  // One-time creation of the first administrator and organization. Values come from the environment, never from argv.
  const need = (k: string): string => { const v = env[k]; if (!v) { console.error(`${k} is required`); process.exit(2); } return v; };
  const identity = runtime.get('identity');
  const login = need('PAM_ADMIN_LOGIN'), password = need('PAM_ADMIN_PASSWORD');
  const made = await identity.bootstrapFirstAdministrator({ login, password, displayName: env.PAM_ADMIN_NAME ?? 'Administrator', organization: { name: need('PAM_ORG_NAME'), ...(env.PAM_ORG_ID ? { id: env.PAM_ORG_ID } : {}), project: { name: env.PAM_PROJECT_NAME ?? 'Main project', ...(env.PAM_PROJECT_ID ? { id: env.PAM_PROJECT_ID } : {}) } }, ...(env.IDENTITY_BOOTSTRAP_TOKEN ? { bootstrapToken: env.IDENTITY_BOOTSTRAP_TOKEN } : {}) });
  const session = await identity.login({ login, password });
  const token = await identity.issueAccessToken({ refreshToken: session.refreshToken, tenantId: made.organization.id, projectId: made.project.id, purpose: 'administration' });
  const ctx = await runtime.verify(token.token, { requestId: 'bootstrap' });
  await provisionOrganization(runtime, ctx);
  await identity.logout(session.refreshToken);
  console.log(JSON.stringify({ organization: made.organization.id, project: made.project.id, administrator: made.actorId }));
  await runtime.close();
} else if (command === 'serve' || command === 'worker') {
  report();
  if (command === 'worker') {
    const state: AppState = { lastRouter: null, lastWorkerError: null, workerPasses: 0, startedAt: new Date().toISOString() };
    const id = `pam-worker-${process.pid}`;
    let stop = false; process.on('SIGTERM', () => { stop = true; }); process.on('SIGINT', () => { stop = true; });
    while (!stop) { await workerPass(runtime, state, id); if (state.lastWorkerError) console.error(state.lastWorkerError); await new Promise((r) => setTimeout(r, Number(env.PAM_WORKER_INTERVAL_MS ?? 1000))); }
    await runtime.close();
  } else {
    const app = await startServer(runtime, { port: Number(env.PORT ?? 8080), host: env.HOST ?? '127.0.0.1', worker: env.PAM_WORKER !== 'off', extraRoutes: loadExtraRoutes, ...(env.PAM_WEB_DIR ? { webDir: env.PAM_WEB_DIR } : {}) });
    console.log(`PAM listening on ${app.url}`);
    const shutdown = (): void => { void app.stop().then(() => runtime.close()).then(() => process.exit(0)); };
    process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
  }
} else { console.error(`Unknown command ${command}`); process.exit(2); }
