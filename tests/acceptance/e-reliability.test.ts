// Acceptance test E: reliability and resource control on real infrastructure. Worker PROCESSES (not in-process loops) are
// started, killed with SIGKILL during active work and restarted; two run concurrently. Also: expired leases, duplicate
// events, retry exhaustion after provider failure, budget exhaustion and recovery, pause/cancel across processes, and a
// database + object-store backup restored into a fresh database whose evidence integrity is then verified (and a
// corrupted object detected). Uncertain external side effects are covered by test B (ambiguous SMTP send) and the
// orchestration unit tests (crash during a started side effect).
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { cpSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import pg from 'pg';
import { REQUIRED, skipReason, withStack, ADMIN_URL } from './harness.ts';
import { compose } from '../../src/app/compose.ts';
import { routeEventsOnce } from '../../src/app/router.ts';

const skip = skipReason([...REQUIRED, 'discovery']);
// A slow controlled source: 24 records across 6 index pages, every response delayed, so a crash lands mid-collection.
let failing = false; const hits = new Map<string, number>();
const source = createServer((req, res) => {
  const url = req.url ?? '/'; hits.set(url, (hits.get(url) ?? 0) + 1);
  setTimeout(() => {
    if (failing) { res.writeHead(500).end('provider failure'); return; }
    const page = /^\/idx\/(\d+)$/.exec(url); const doc = /^\/doc\/(\d+)\.txt$/.exec(url);
    if (page) { const n = Number(page[1]); res.writeHead(200, { 'content-type': 'text/html' }).end(`<html><body>${[0, 1, 2, 3].map((i) => `<a href="/doc/${n * 4 + i}.txt">Record ${n * 4 + i}</a>`).join(' ')}${n < 5 ? `<a rel="next" href="/idx/${n + 1}">next</a>` : ''}</body></html>`); return; }
    if (doc) { res.writeHead(200, { 'content-type': 'text/plain' }).end(`Fictional council record ${doc[1]}: payment schedule entry.\n`); return; }
    res.writeHead(404).end();
  }, 120);
});
await new Promise<void>((ok) => source.listen(0, '127.0.0.1', ok));
const port = (source.address() as { port: number }).port;
after(() => { source.close(); });

test('E: restart mid-workflow, concurrent workers, leases, duplicates, retry exhaustion, budget exhaustion, pause/cancel, backup and restore', { skip, timeout: 1_200_000 }, () => withStack(async (stack) => {
  const { runtime } = stack;
  const children = new Set<ChildProcess>();
  const startWorker = (name: string): ChildProcess => {
    const child = spawn(process.execPath, ['src/app/main.ts', 'worker'], { env: { ...process.env, ...stack.env, PAM_WORKER_INTERVAL_MS: '200' }, stdio: ['ignore', 'ignore', 'pipe'] });
    child.stderr?.on('data', (d) => { const t = String(d); if (!/ExperimentalWarning|ready|unavailable:/.test(t)) process.stderr.write(`[${name}] ${t}`); });
    children.add(child); child.on('exit', () => children.delete(child)); return child;
  };
  const kill = (c: ChildProcess, signal: NodeJS.Signals = 'SIGKILL'): Promise<void> => new Promise((ok) => { if (c.exitCode !== null) { ok(); return; } c.once('exit', () => ok()); c.kill(signal); });
  const waitFor = async (cond: () => Promise<boolean>, ms: number, what: string): Promise<void> => { const end = Date.now() + ms; while (Date.now() < end) { if (await cond()) return; await new Promise((r) => setTimeout(r, 300)); } throw new Error(`timed out waiting for ${what}`); };
  try {
    const org = await stack.createOrg('Riverside Relief Watch');
    const investigator = await stack.addUser(org, 'Ines Investigator', ['investigator']);
    const research = await org.as(investigator, 'research'); const admin = await org.as(org.owner, 'administration');
    const ops = await org.as(org.owner, 'administration');
    const o = runtime.orchestration, discovery = runtime.get('discovery'), evidence = runtime.get('evidence'), resources = runtime.get('resources');
    const opCtx = { ...ops, capabilities: [...ops.capabilities, 'orchestration:write', 'orchestration:control', 'orchestration:read'] };
    const src = await discovery.createSource(research, { name: 'Council payment schedule', kind: 'html_index', baseUrl: `http://127.0.0.1:${port}/idx/0`, accessTerms: 'Public (fictional).', idempotencyKey: 'src' });
    const objective = await o.createObjective(opCtx, { title: 'Collect the payment schedule', description: 'Acquire every published record.', lane: 'primary' });

    // Budget exhaustion: the orchestrator's agents have no assigned budget, so the collection is refused BEFORE any request.
    const run1 = await o.startRun(opCtx, { objectiveId: objective.id, tasks: [{ key: 'collect', action: 'discovery.collect', input: { sourceId: src.id }, maxAttempts: 4 }] });
    const w0 = startWorker('w0');
    await waitFor(async () => (await o.getTask(opCtx, run1.tasks[0]!.id)).state === 'paused', 60_000, 'budget pause');
    const paused = await o.getTask(opCtx, run1.tasks[0]!.id);
    assert.equal(paused.pauseReason, 'budget exhausted'); assert.equal(hits.size, 0, 'nothing was fetched without budget');
    // An administrator assigns a bounded budget to PAM's service identity; the operator resumes the task.
    const svc = (await runtime.sql.query<{ orchestrator_service_id: string }>('select orchestrator_service_id from pam_app.tenants where tenant_id=$1', [org.tenantId]))[0]!.orchestrator_service_id;
    const budget = await resources.createBudget(admin, { name: 'Agent compute', level: 'agent', unit: 'compute_seconds', ceiling: 600, actorId: svc, idempotencyKey: 'agent-compute' });
    await resources.assignBudget(admin, budget.id, svc);
    await o.controlTask(opCtx, run1.tasks[0]!.id, 'resume');

    // Crash: kill the worker process with SIGKILL while the collection is running; start a new one.
    await waitFor(async () => [...hits.keys()].filter((k) => k.startsWith('/doc/')).length >= 3, 120_000, 'collection under way').catch(async (e) => { console.log('TASK', JSON.stringify(await o.getTask(opCtx, run1.tasks[0]!.id)).slice(0, 900), 'HITS', [...hits.keys()].join(',')); throw e; });
    await kill(w0);
    const fetchedAtCrash = [...hits.keys()].filter((k) => k.startsWith('/doc/')).length;
    assert.ok(fetchedAtCrash < 24, 'the crash happened mid-collection');
    const w1 = startWorker('w1'); const w2 = startWorker('w2'); // two concurrent workers from here on
    await waitFor(async () => (await o.getTask(opCtx, run1.tasks[0]!.id)).state === 'done', 300_000, 'collection to finish after restart');
    const done = await o.getTask(opCtx, run1.tasks[0]!.id);
    const runRef = (done.output as any).run as string;
    const cov = await discovery.coverage(research, { runId: runRef.split(':')[2]!.split('@')[0] });
    assert.equal(cov.acquiredBytes, 24, `every record acquired exactly once after the crash: ${JSON.stringify(cov)}`);
    const repeats = [...hits.entries()].filter(([k, n]) => k.startsWith('/doc/') && n > 1).length;
    assert.ok(repeats <= 2, `at most the requests in flight at the crash were repeated (${repeats})`);
    const committed = await resources.budgetTree(admin);
    assert.match(JSON.stringify(committed), /committed/, 'actual use was committed against the budget');
    console.log('crash recovery: fetched', fetchedAtCrash, 'before kill; repeated', repeats, '; attempts', done.attempts);

    // Concurrent workers: six processing tasks, each executed once, across two processes.
    const items = (await discovery.listItems(research, { runId: runRef.split(':')[2]!.split('@')[0], limit: 50 })) as any;
    const evRefs: string[] = [];
    for (const i of (Array.isArray(items) ? items : items.items).slice(0, 6)) { const full = await discovery.getItem(research, i.id); const a = (full.acquisitions as any[]).find((x) => x.evidenceRef); if (a) evRefs.push(a.evidenceRef); }
    await waitFor(async () => (await Promise.all(evRefs.map((r) => evidence.describe(research, r)))).every((d: any) => d?.available), 120_000, 'evidence release');
    const run2 = await o.startRun(opCtx, { objectiveId: objective.id, tasks: evRefs.map((r, i) => ({ key: `proc-${i}`, action: 'processing.process_evidence', input: { evidenceRef: r } })) });
    await waitFor(async () => (await o.getRun(opCtx, run2.id)).status === 'completed', 300_000, 'processing run');
    for (const r of evRefs) assert.equal((await runtime.get('processing').listProcessing(research, { evidenceRef: r })).length, 1, `processing of ${r} requested once`);

    // Pause and cancel apply across processes.
    const run3 = await o.startRun(opCtx, { objectiveId: objective.id, tasks: [{ key: 'gaps-a', action: 'knowledge.gaps' }, { key: 'gaps-b', action: 'knowledge.gaps', dependsOn: ['gaps-a'] }] });
    await o.setObjectiveStatus(opCtx, objective.id, 'paused', 'operator pause');
    await new Promise((r) => setTimeout(r, 2000));
    assert.ok((await o.getRun(opCtx, run3.id)).tasks.every((t: any) => t.state === 'paused'), 'no worker ran paused work');
    await o.setObjectiveStatus(opCtx, objective.id, 'active');
    await waitFor(async () => (await o.getRun(opCtx, run3.id)).status === 'completed', 60_000, 'resumed run');
    const run4 = await o.startRun(opCtx, { objectiveId: objective.id, tasks: [{ key: 'late', action: 'knowledge.gaps', input: {} }] });
    await o.controlTask(opCtx, run4.tasks[0]!.id, 'cancel', 'not needed');
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal((await o.getTask(opCtx, run4.tasks[0]!.id)).state, 'cancelled');

    // Provider failure and retry exhaustion: the source fails; the task retries, then is dead and visible as a failure.
    failing = true;
    const src2 = await discovery.createSource(research, { name: 'Failing mirror', kind: 'html_index', baseUrl: `http://127.0.0.1:${port}/idx/0`, accessTerms: 'Public (fictional).', idempotencyKey: 'src2' });
    const run5 = await o.startRun(opCtx, { objectiveId: objective.id, tasks: [{ key: 'collect-failing', action: 'discovery.collect', input: { sourceId: src2.id }, maxAttempts: 2 }] });
    await waitFor(async () => ['dead', 'done'].includes((await o.getTask(opCtx, run5.tasks[0]!.id)).state), 300_000, 'retry exhaustion');
    const dead = await o.getTask(opCtx, run5.tasks[0]!.id);
    assert.equal(dead.state, 'dead'); assert.equal(dead.attempts, 2); assert.match(dead.error ?? '', /failed|unavailable/i);
    assert.ok((await o.overview(opCtx)).failures.some((t: any) => t.id === dead.id), 'the failure is visible to operators');
    failing = false;
    await Promise.all([kill(w1, 'SIGTERM'), kill(w2, 'SIGTERM')]);

    // Duplicate events: replaying every engine feed from the start changes nothing (idempotent by event id).
    const before = JSON.stringify((await o.listTasks(opCtx, {})).map((t: any) => [t.id, t.state, t.staleReasons]));
    await runtime.sql.query(`update e00_orchestration.router_cursors set last_id='0' where engine not like 'intake:%'`);
    await routeEventsOnce(runtime); await routeEventsOnce(runtime);
    assert.equal(JSON.stringify((await o.listTasks(opCtx, {})).map((t: any) => [t.id, t.state, t.staleReasons])), before, 'replayed events had no further effect');

    // Backup and restore: pg_dump → new database; copy object storage; verify actual stored bytes against retained digests.
    const ev = await import('node:url');
    void ev;
    const dbUrl = new URL(stack.env.DATABASE_URL!); const restoreName = `${dbUrl.pathname.slice(1)}_restore`;
    const dump = execFileSync('pg_dump', ['--no-owner', '--format=custom', stack.env.DATABASE_URL!], { maxBuffer: 1 << 30 });
    const adminPool = new pg.Pool({ connectionString: ADMIN_URL, max: 1 });
    await adminPool.query(`create database ${restoreName}`);
    const restoreUrl = new URL(stack.env.DATABASE_URL!); restoreUrl.pathname = `/${restoreName}`;
    execFileSync('pg_restore', ['--no-owner', '--dbname', restoreUrl.toString()], { input: dump });
    const restoredDir = `${stack.dataDir}-restored`; cpSync(stack.dataDir, restoredDir, { recursive: true });
    const restored = await compose({ ...stack.env, DATABASE_URL: restoreUrl.toString(), PAM_DATA_DIR: restoredDir }, { migrate: false });
    try {
      const verifier = { ...(await org.as(org.owner, 'evidence_management')) };
      const v = { ...verifier, capabilities: [...verifier.capabilities, 'evidence:verify'] };
      const report = await restored.get('evidence').verifyAll(v) as any;
      assert.equal(report.ok, true, JSON.stringify(report).slice(0, 400)); assert.ok(report.checked >= 24 && report.matched === report.checked, `restored originals match their digests (${report.matched}/${report.checked})`);
      // Corrupt one stored object in the restored copy: detected, not silently accepted.
      const walk = (d: string): string[] => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
      const victim = walk(join(restoredDir, 'objects', 'evidence')).find((p) => !p.includes('.tmp-'))!;
      const bytes = readFileSync(victim); bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 0xff; writeFileSync(victim, bytes);
      const after2 = await restored.get('evidence').verifyAll(v) as any;
      assert.equal(after2.ok, false); assert.ok(after2.failed >= 1, 'the corrupted object is reported');
      console.log('backup/restore: verified', report.checked, 'objects; corruption detected', after2.failed);
    } finally { await restored.close(); await adminPool.query(`drop database if exists ${restoreName} with (force)`); await adminPool.end(); }
  } finally { for (const c of children) c.kill('SIGKILL'); }
}, { DISCOVERY_ALLOWED_PRIVATE_HOSTS: `127.0.0.1:${port}`, DISCOVERY_ALLOWED_PORTS: `80,443,${port}`, DISCOVERY_MIN_INTERVAL_MS: '10', DISCOVERY_LEASE_MS: '4000', PROCESSING_LEASE_MS: '8000', PAM_TASK_LEASE_MS: '5000' }));
