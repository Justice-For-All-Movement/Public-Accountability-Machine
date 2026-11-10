// Starts the real Secure Intake application (E02) from ./engines/intake for an acceptance run: its own disposable
// database, its migrations, the built Next.js server, its background worker with the real clamscan binary and a locally
// authored signature, and a provisioned tenant with the example reporting form. Nothing here imitates the intake engine.
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';

export const INTAKE_DIR = new URL('../../engines/intake', import.meta.url).pathname;
// The intake engine's documented integration preset (src/modules/integration/presets.ts). Deliberately WITHOUT
// submission:view_protected: PAM never reads protected participant fields.
export const INTAKE_SERVICE_SCOPES = ["application:manage","application:view","audit:view","case:assign","case:create","case:update","case:view","correspondence:manage","correspondence:view","deadline:operate","deadline:view","document:view","event:view","form:view","identity:manage","note:create_internal","note:view","referral:manage","referral:view","review:view","submission:create","submission:view"];
export const MALWARE_MARKER = 'PAM-ACCEPTANCE-MALWARE-MARKER';
export function intakeSkip(): string | false {
  if (!existsSync(join(INTAKE_DIR, '.next', 'BUILD_ID'))) return 'intake engine is not built under ./engines/intake (npm ci && npm run build there)';
  if (!existsSync(join(INTAKE_DIR, 'node_modules', '.bin', 'tsx'))) return 'intake engine dependencies are not installed';
  return false;
}
const freePort = (): Promise<number> => new Promise((ok, fail) => { const s = createServer(); s.on('error', fail); s.listen(0, '127.0.0.1', () => { const a = s.address(); s.close(() => ok(typeof a === 'object' && a ? a.port : 0)); }); });
const run = (cmd: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> => new Promise((ok, fail) => { const c = spawn(cmd, args, { cwd: INTAKE_DIR, env, stdio: ['ignore', 'ignore', 'inherit'] }); c.on('exit', (code) => (code === 0 ? ok() : fail(new Error(`${cmd} ${args.join(' ')} exited ${code}`)))); c.on('error', fail); });

export type IntakeApp = { origin: string; apiBase: string; slug: string; token: string; tokenB: string; slugB: string; workDir: string;
  api(token: string, method: string, path: string, body?: unknown): Promise<{ status: number; body: any }>; close(): Promise<void> };

export async function startIntake(adminUrl: string): Promise<IntakeApp> {
  const name = `pam_intake_${randomBytes(5).toString('hex')}`;
  const admin = new pg.Pool({ connectionString: adminUrl, max: 1 });
  await admin.query(`create database ${name}`);
  const url = new URL(adminUrl); url.pathname = `/${name}`;
  const workDir = await mkdtemp(join(tmpdir(), 'pam-intake-'));
  const signatures = join(workDir, 'signatures'); await mkdir(signatures);
  await writeFile(join(signatures, 'acceptance.ndb'), `Pam.Acceptance.Marker:0:*:${Buffer.from(MALWARE_MARKER).toString('hex')}\n`);
  const port = await freePort(); const platformToken = randomBytes(36).toString('base64url');
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'production', DATABASE_URL: url.toString(), APP_BASE_URL: `http://127.0.0.1:${port}`,
    PROTECTED_DATA_ENCRYPTION_KEY: randomBytes(32).toString('hex'), WEBHOOK_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
    PLATFORM_API_TOKEN_SHA256: createHash('sha256').update(platformToken).digest('hex'), DOCUMENT_STORAGE_DRIVER: 'local', DOCUMENT_STORAGE_ROOT: join(workDir, 'documents'),
    MALWARE_SCANNER_DRIVER: 'clamscan', CLAMSCAN_DATABASE_DIR: signatures, BACKGROUND_JOB_POLL_MS: '200', AUTH_LOGIN_FAILURE_LIMIT: '50', API_DEFAULT_RATE_LIMIT_PER_MINUTE: '5000' };
  const children: ChildProcess[] = [];
  const close = async (): Promise<void> => {
    for (const c of children) c.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 400)); for (const c of children) c.kill('SIGKILL');
    await admin.query(`drop database if exists ${name} with (force)`).catch(() => undefined); await admin.end();
    await rm(workDir, { recursive: true, force: true });
  };
  try {
    await run(join(INTAKE_DIR, 'node_modules', '.bin', 'drizzle-kit'), ['migrate'], env);
    children.push(spawn(process.execPath, [join(INTAKE_DIR, 'node_modules/next/dist/bin/next'), 'start', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: INTAKE_DIR, env, stdio: ['ignore', 'ignore', 'inherit'] }));
    children.push(spawn(join(INTAKE_DIR, 'node_modules', '.bin', 'tsx'), ['scripts/run-worker.ts'], { cwd: INTAKE_DIR, env, stdio: ['ignore', 'ignore', 'inherit'] }));
    const origin = `http://127.0.0.1:${port}`;
    for (const deadline = Date.now() + 90_000; ;) {
      try { if ((await fetch(`${origin}/api/ready`)).ok) break; } catch { /* starting */ }
      if (Date.now() > deadline) throw new Error('intake application did not become ready');
      await new Promise((r) => setTimeout(r, 300));
    }
    const apiBase = `${origin}/api/v1`;
    const api = async (token: string, method: string, path: string, body?: unknown) => {
      const r = await fetch(`${apiBase}${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const text = await r.text(); let parsed: any = text; try { parsed = JSON.parse(text); } catch { /* text */ }
      return { status: r.status, body: parsed };
    };
    const manifest = JSON.parse(readFileSync(join(INTAKE_DIR, 'examples', 'reporting-manifest.example.json'), 'utf8'));
    const provision = async (slug: string): Promise<string> => {
      const org = await api(platformToken, 'POST', '/platform/organizations', { slug, name: `Intake ${slug}` });
      if (org.status !== 201) throw new Error(`provision ${slug}: ${JSON.stringify(org.body)}`);
      const client = await api(platformToken, 'POST', `/platform/organizations/${slug}/api-clients`, { name: 'pam', permissions: INTAKE_SERVICE_SCOPES });
      if (client.status !== 201) throw new Error(`api client ${slug}: ${JSON.stringify(client.body)}`);
      const applied = await api(client.body.data.token, 'POST', '/application/manifest', manifest);
      if (applied.status !== 200) throw new Error(`manifest ${slug}: ${JSON.stringify(applied.body).slice(0, 400)}`);
      return client.body.data.token as string;
    };
    const token = await provision('riverside-watch'); const tokenB = await provision('harbour-records');
    return { origin, apiBase, slug: 'riverside-watch', token, slugB: 'harbour-records', tokenB, workDir, api, close };
  } catch (error) { await close(); throw error; }
}
