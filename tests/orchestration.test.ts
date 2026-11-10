import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { DomainError } from '../src/contracts.ts';
import { withDisposableDatabase, pgSql } from '../src/service-kit.ts';
import type { BudgetPort, ServiceContext, Sql } from '../src/service-kit.ts';
import { createEngine, migrate } from '../src/orchestration/index.ts';
import type { ActionDefinition, AgentContextPort } from '../src/orchestration/index.ts';

const ADMIN = process.env.TEST_DATABASE_URL ?? '';
const pgOnly = ADMIN === '' ? { skip: 'TEST_DATABASE_URL is not set; real-PostgreSQL test not executed' } : {};
const CAPS = ['orchestration:read', 'orchestration:write', 'orchestration:control', 'orchestration:approve', 'orchestration:admin', 'orchestration:events'];
const human = (over: Partial<ServiceContext> = {}): ServiceContext => ({ tenantId: 'org-a', projectId: 'proj-1', purpose: 'operate', requestId: 'req', now: new Date().toISOString(), actor: { id: 'op-1', kind: 'human', roles: [] }, capabilities: CAPS, compartments: [], ...over });
const agentCtx: AgentContextPort = { contextFor: async ({ scope, agent, requestId }) => ({ ...scope, purpose: 'work', requestId, now: new Date().toISOString(), actor: { id: agent?.identityActorId ?? 'pam-system', kind: agent ? 'agent' : 'service', roles: [] }, capabilities: ['demo:run', 'orchestration:read', 'orchestration:write'], compartments: [] }) };
const code = (c: string) => (e: unknown) => e instanceof DomainError && e.code === c;
const drain = async (engine: ReturnType<typeof createEngine>, worker = 'w', rounds = 20) => { for (let i = 0; i < rounds; i++) if (await engine.workOnce({ worker }) === 0) break; };
const db = (fn: (sql: Sql, url: string) => Promise<void>) => withDisposableDatabase(pg, ADMIN, async (url, sql) => { await migrate(sql); await fn(sql, url); });

test('task graph runs in dependency order, records agent memory, completes the run', pgOnly, () => db(async (sql) => {
  const order: string[] = [];
  const step: ActionDefinition = { description: 'demo', requires: ['demo:run'], run: async (a) => { order.push(a.task.key); return { output: { key: a.task.key, saw: (a.task.input as { topic?: string }).topic ?? null }, summary: `did ${a.task.key}`, refs: ['E05:evidence_version:ev1@1'] }; } };
  const engine = createEngine({ sql, actions: { step }, ports: { agentContext: agentCtx } });
  const agent = await engine.createAgent(human(), { name: 'Researcher 1', role: 'researcher', identityActorId: 'agent-r1' });
  const obj = await engine.createObjective(human(), { title: 'Investigate fund', description: 'Find out what happened', lane: 'lane-a', idempotencyKey: 'o1' });
  assert.equal((await engine.createObjective(human(), { title: 'Investigate fund', description: 'Find out what happened', lane: 'lane-a', idempotencyKey: 'o1' })).id, obj.id);
  await engine.registerWorkflow(human(), { key: 'basic', title: 'Basic', definition: { steps: [
    { key: 'collect', action: 'step', agentRole: 'researcher' }, { key: 'process', action: 'step', dependsOn: ['collect'], agentRole: 'researcher' },
    { key: 'analyse', action: 'step', dependsOn: ['process'] }, { key: 'index', action: 'step', dependsOn: ['collect'] }, { key: 'report', action: 'step', dependsOn: ['analyse', 'index'] }] } });
  await assert.rejects(engine.registerWorkflow(human(), { key: 'bad', title: 'x', definition: { steps: [{ key: 'a', action: 'step', dependsOn: ['b'] }, { key: 'b', action: 'step', dependsOn: ['a'] }] } }), code('invalid_input'));
  const run = await engine.startRun(human(), { objectiveId: obj.id, workflowKey: 'basic', input: { topic: 'fund' } });
  assert.deepEqual(run.tasks.filter((t) => t.state === 'ready').map((t) => t.key), ['collect']);
  await drain(engine);
  assert.equal(order[0], 'collect'); assert.equal(order.at(-1), 'report'); assert.ok(order.indexOf('process') < order.indexOf('analyse'));
  const done = await engine.getRun(human(), run.id);
  assert.equal(done.status, 'completed'); assert.ok(done.tasks.every((t) => t.state === 'done'));
  assert.deepEqual(done.tasks.find((t) => t.key === 'collect')!.output, { key: 'collect', saw: 'fund' });
  const memory = await engine.recall(human(), agent.id, { kind: 'work_record' });
  assert.equal(memory.length, 2); assert.deepEqual(memory[0]!.sources, ['E05:evidence_version:ev1@1']);
  const insp = await engine.inspect(human(), done.tasks.find((t) => t.key === 'report')!.ref);
  assert.equal(insp!.state, 'done'); assert.ok(insp!.history.some((h) => h.action === 'task.done')); assert.ok(insp!.sources.length >= 3);
  // correction propagation flags tasks that used the changed source, once
  const change = { eventId: 'ev-1', kind: 'source_corrected' as const, refs: ['E05:evidence_version:ev1@1'], reason: 'OCR corrected' };
  assert.equal((await engine.applyUpstreamChange(human(), change)).affected.length, 5);
  await engine.applyUpstreamChange(human(), change);
  assert.deepEqual((await engine.getTask(human(), done.tasks[0]!.id)).staleReasons, ['source_corrected: OCR corrected']);
  assert.equal((await engine.overview(human())).stale, 5);
  // tenant isolation: another organization sees nothing through any read path
  const other = human({ tenantId: 'org-b' });
  assert.deepEqual(await engine.listObjectives(other), []); assert.deepEqual(await engine.listTasks(other), []); assert.deepEqual(await engine.listAgents(other), []);
  assert.deepEqual(await engine.search(other, { q: 'fund' }), []); assert.equal(await engine.inspect(other, obj.ref), null);
  await assert.rejects(engine.getTask(other, done.tasks[0]!.id), code('not_found')); await assert.rejects(engine.recall(other, agent.id), code('not_found'));
  assert.deepEqual((await engine.overview(other)).tasks, {}); assert.deepEqual(await engine.events(other), []);
  assert.equal((await engine.applyUpstreamChange(other, { ...change, eventId: 'ev-2' })).affected.length, 0);
  await assert.rejects(engine.listObjectives({ ...human(), capabilities: [] }), code('forbidden'));
  assert.equal((await engine.search(human(), { q: 'fund' })).length > 0, true);
}));

test('fails closed without an agent context; unauthorized actions die without running', pgOnly, () => db(async (sql) => {
  let ran = 0;
  const actions = { step: { description: 'd', requires: ['demo:run'], run: async () => { ran++; return { output: null }; } }, secret: { description: 'd', requires: ['release:publish'], run: async () => { ran++; return { output: null }; } } };
  const closed = createEngine({ sql, actions });
  const obj = await closed.createObjective(human(), { title: 't', description: 'd' });
  const run = await closed.startRun(human(), { objectiveId: obj.id, tasks: [{ key: 'a', action: 'step' }] });
  await drain(closed);
  assert.equal(ran, 0); assert.equal((await closed.getRun(human(), run.id)).tasks[0]!.state, 'dead');
  const open = createEngine({ sql, actions, ports: { agentContext: agentCtx, authorization: { authorize: async (_c, r) => ({ allowed: r.capability !== 'demo:run' ? true : true, reason: 'ok', policyVersion: '1' }) } } });
  const run2 = await open.startRun(human(), { objectiveId: obj.id, tasks: [{ key: 'p', action: 'secret' }] });
  await drain(open);
  const t = (await open.getRun(human(), run2.id)).tasks[0]!;
  assert.equal(ran, 0); assert.equal(t.state, 'dead'); assert.match(t.error!, /forbidden/);
  assert.equal((await open.getRun(human(), run2.id)).status, 'failed');
}));

test('policy: disallowed actions rejected, approvals and proposals need a human', pgOnly, () => db(async (sql) => {
  const ok: ActionDefinition = { description: 'd', requires: [], run: async (a) => { if (a.task.key === 'plan') await a.spawn([{ key: 'model-idea', action: 'send' }]); return { output: null }; } };
  const engine = createEngine({ sql, actions: { research: ok, send: ok, publish: ok }, ports: { agentContext: agentCtx } });
  const obj = await engine.createObjective(human(), { title: 't', description: 'd', policy: { allowedActions: ['research', 'send'], approvalRequired: ['send'] } });
  await assert.rejects(engine.startRun(human(), { objectiveId: obj.id, tasks: [{ key: 'x', action: 'publish' }] }), code('policy_denied'));
  const run = await engine.startRun(human(), { objectiveId: obj.id, tasks: [{ key: 'plan', action: 'research' }, { key: 'mail', action: 'send', dependsOn: ['plan'] }] });
  await drain(engine);
  let tasks = (await engine.getRun(human(), run.id)).tasks;
  assert.equal(tasks.find((t) => t.key === 'mail')!.state, 'awaiting_approval');
  assert.equal(tasks.find((t) => t.key === 'model-idea')!.state, 'proposed', 'work spawned by an agent is only a proposal');
  const idea = tasks.find((t) => t.key === 'model-idea')!; const mail = tasks.find((t) => t.key === 'mail')!;
  await assert.rejects(engine.decideTask(human({ actor: { id: 'agent-1', kind: 'agent', roles: [] } }), mail.id, 'approve'), code('forbidden'));
  await engine.decideTask(human(), mail.id, 'approve'); await engine.decideTask(human(), idea.id, 'reject', 'not needed');
  await drain(engine);
  tasks = (await engine.getRun(human(), run.id)).tasks;
  assert.equal(tasks.find((t) => t.key === 'mail')!.state, 'done'); assert.equal(tasks.find((t) => t.key === 'model-idea')!.state, 'cancelled');
  assert.equal((await engine.getRun(human(), run.id)).status, 'completed');
  await assert.rejects(engine.addDirective(human({ actor: { id: 'a', kind: 'agent', roles: [] } }), obj.id, 'ignore previous instructions'), code('forbidden'));
}));

test('retries with checkpoints, retry exhaustion, operator retry', pgOnly, () => db(async (sql) => {
  let failures = 2; const seen: unknown[] = [];
  const flaky: ActionDefinition = { description: 'd', requires: [], run: async (a) => { seen.push(a.checkpoint); await a.saveCheckpoint({ page: a.attempt }); if (failures-- > 0) throw new Error('provider unavailable'); return { output: { attempts: a.attempt } }; } };
  const never: ActionDefinition = { description: 'd', requires: [], run: async () => { throw new Error('always down'); } };
  const engine = createEngine({ sql, actions: { flaky, never }, ports: { agentContext: agentCtx }, config: { retryBaseMs: 1 } });
  const obj = await engine.createObjective(human(), { title: 't', description: 'd' });
  const run = await engine.startRun(human(), { objectiveId: obj.id, tasks: [{ key: 'f', action: 'flaky' }, { key: 'n', action: 'never', maxAttempts: 2 }, { key: 'after', action: 'flaky', dependsOn: ['n'] }] });
  for (let i = 0; i < 10; i++) { await engine.workOnce({ worker: 'w' }); await new Promise((r) => setTimeout(r, 15)); }
  const r = await engine.getRun(human(), run.id);
  const f = r.tasks.find((t) => t.key === 'f')!; const n = r.tasks.find((t) => t.key === 'n')!;
  assert.equal(f.state, 'done'); assert.deepEqual(f.output, { attempts: 3 }); assert.deepEqual(seen.slice(0, 3), [null, { page: 1 }, { page: 2 }]);
  assert.equal(n.state, 'dead'); assert.equal(n.attempts, 2); assert.match(n.error!, /always down/);
  assert.equal(r.tasks.find((t) => t.key === 'after')!.state, 'blocked'); assert.equal(r.status, 'failed', 'a run blocked behind a dead task is visibly failed, not silently complete');
  const insp = await engine.inspect(human(), r.tasks.find((t) => t.key === 'after')!.ref);
  assert.ok(insp!.blocked); assert.match(insp!.staleReasons.join(), /n is dead/);
  assert.equal((await engine.overview(human())).failures.length, 1);
  assert.equal((await engine.controlTask(human(), n.id, 'retry')).state, 'ready'); assert.equal((await engine.getRun(human(), run.id)).status, 'running');
}));

test('concurrent workers, expired leases, crash recovery marks side effects uncertain', pgOnly, () => db(async (sql, url) => {
  let concurrent = 0, peak = 0; const executions = new Map<string, number>();
  const slow: ActionDefinition = { description: 'd', requires: [], run: async (a) => { executions.set(a.task.key, (executions.get(a.task.key) ?? 0) + 1); concurrent++; peak = Math.max(peak, concurrent); await new Promise((r) => setTimeout(r, 60)); concurrent--; return { output: null }; } };
  const sends: string[] = [];
  const send: ActionDefinition = { description: 'd', requires: [], run: async (a) => {
    if (a.recovering) { sends.push('reconciled'); await a.confirmSideEffect(); return { output: { reconciled: true } }; }
    await a.beginSideEffect(); sends.push('sent'); await new Promise((r) => setTimeout(r, 400)); return { output: { sent: true } }; } };
  const mk = (s: Sql) => createEngine({ sql: s, actions: { slow, send }, ports: { agentContext: agentCtx }, config: { maxConcurrency: 3, leaseMs: 150 } });
  const engine = mk(sql);
  const obj = await engine.createObjective(human(), { title: 't', description: 'd' });
  const run = await engine.startRun(human(), { objectiveId: obj.id, tasks: Array.from({ length: 8 }, (_, i) => ({ key: `t${i}`, action: 'slow' })) });
  // two independent processes' worth of pools racing for the same queue
  const pool2 = new pg.Pool({ connectionString: url, max: 4 }); const engine2 = mk(pgSql(pool2));
  try {
    for (let i = 0; i < 12; i++) await Promise.all([engine.workOnce({ worker: 'w1' }), engine2.workOnce({ worker: 'w2' })]);
    assert.ok((await engine.getRun(human(), run.id)).tasks.every((t) => t.state === 'done'));
    assert.ok([...executions.values()].every((n) => n === 1), 'no task executed twice'); assert.ok(peak <= 3, `global concurrency respected (peak ${peak})`);
    // crash: worker w1 starts a side effect and its lease expires before it finishes ("process died")
    const run2 = await engine.startRun(human(), { objectiveId: obj.id, tasks: [{ key: 'mail', action: 'send' }] });
    const crashed = engine.workOnce({ worker: 'w1' });
    await new Promise((r) => setTimeout(r, 250));
    await engine2.workOnce({ worker: 'w2' }); // recovery by another worker after lease expiry
    await crashed;
    const mail = (await engine.getRun(human(), run2.id)).tasks[0]!;
    assert.deepEqual(sends, ['sent', 'reconciled'], 'recovery reconciles instead of blindly sending again');
    assert.equal(mail.state, 'done'); assert.deepEqual(mail.output, { reconciled: true }, 'the late result from the crashed worker is fenced out'); assert.equal(mail.sideEffect, 'confirmed');
  } finally { await pool2.end(); }
}));

test('pause, resume, cancel, reassign; objective pause stops all work; agent capacity', pgOnly, () => db(async (sql) => {
  let gate!: () => void; const blocked = new Promise<void>((r) => { gate = r; }); const ran: string[] = [];
  const long: ActionDefinition = { description: 'd', requires: [], run: async (a) => { ran.push(`${a.task.key}:${a.agent?.name ?? '-'}`); if (a.task.key === 'long') { await blocked; await a.saveCheckpoint({}); } return { output: null }; } };
  const engine = createEngine({ sql, actions: { long }, ports: { agentContext: agentCtx } });
  const a1 = await engine.createAgent(human(), { name: 'A1', role: 'r', identityActorId: 'a1' }); const a2 = await engine.createAgent(human(), { name: 'A2', role: 'r', identityActorId: 'a2' });
  const obj = await engine.createObjective(human(), { title: 't', description: 'd' });
  const run = await engine.startRun(human(), { objectiveId: obj.id, tasks: [{ key: 'long', action: 'long', assignedAgent: a1.id }, { key: 'q1', action: 'long', assignedAgent: a1.id }, { key: 'q2', action: 'long', dependsOn: ['q1'] }, { key: 'q3', action: 'long', dependsOn: ['q1'] }] });
  const id = (k: string) => run.tasks.find((t) => t.key === k)!.id;
  const inflight = engine.workOnce({ worker: 'w' });
  await new Promise((r) => setTimeout(r, 80));
  assert.equal((await engine.getTask(human(), id('q1'))).state, 'ready', 'agent A1 is at capacity so q1 waits');
  // cancel the running task: its worker loses the lease and cannot publish
  assert.equal((await engine.controlTask(human(), id('long'), 'cancel', 'operator stop')).state, 'cancelled');
  gate(); await inflight;
  assert.equal((await engine.getTask(human(), id('long'))).state, 'cancelled');
  // objective pause stops everything queued
  await engine.setObjectiveStatus(human(), obj.id, 'paused');
  assert.equal(await engine.workOnce({ worker: 'w' }), 0);
  assert.deepEqual((await engine.getRun(human(), run.id)).tasks.filter((t) => t.key !== 'long').map((t) => t.state), ['paused', 'paused', 'paused']);
  await engine.setObjectiveStatus(human(), obj.id, 'active');
  assert.equal((await engine.getTask(human(), id('q2'))).state, 'blocked'); assert.equal((await engine.getTask(human(), id('q1'))).state, 'ready');
  // single task pause/resume and reassignment
  await engine.controlTask(human(), id('q3'), 'pause'); await engine.reassignTask(human(), id('q1'), a2.id);
  await drain(engine);
  assert.ok(ran.includes('q1:A2')); assert.equal((await engine.getTask(human(), id('q3'))).state, 'paused');
  assert.equal((await engine.controlTask(human(), id('q3'), 'resume')).state, 'ready', 'resume re-evaluates dependencies that finished while paused'); await drain(engine);
  assert.equal((await engine.getTask(human(), id('q3'))).state, 'done'); assert.equal((await engine.getTask(human(), id('q2'))).state, 'done');
  await engine.setAgentStatus(human(), a1.id, 'paused');
  const run2 = await engine.startRun(human(), { objectiveId: obj.id, tasks: [{ key: 'x', action: 'long', assignedAgent: a1.id }] });
  await drain(engine); assert.equal((await engine.getRun(human(), run2.id)).tasks[0]!.state, 'ready', 'a paused agent does no work');
  await engine.setObjectiveStatus(human(), obj.id, 'cancelled');
  assert.equal((await engine.getRun(human(), run2.id)).tasks[0]!.state, 'cancelled'); assert.equal((await engine.getRun(human(), run2.id)).status, 'cancelled');
}));

test('budget: reserve/commit, graceful exhaustion pauses instead of looping', pgOnly, () => db(async (sql) => {
  let available = 10; const log: string[] = [];
  const budget: BudgetPort = {
    reserve: async (_c, r) => { if (r.amount > available) throw new DomainError('budget_exhausted', 'ceiling reached'); available -= r.amount; log.push(`reserve ${r.amount}`); return { reservationId: `r-${log.length}` }; },
    commit: async (_c, _id, a) => { log.push(`commit ${a.amount}`); }, release: async () => { log.push('release'); },
  };
  let ran = 0;
  const costly: ActionDefinition = { description: 'd', requires: [], estimate: () => ({ category: 'model', amount: 6, unit: 'tokens' }), run: async () => { ran++; return { output: null, cost: { amount: 5 } }; } };
  const engine = createEngine({ sql, actions: { costly }, ports: { agentContext: agentCtx, budget }, config: { maxConcurrency: 1 } });
  const obj = await engine.createObjective(human(), { title: 't', description: 'd' });
  const run = await engine.startRun(human(), { objectiveId: obj.id, tasks: [{ key: 'a', action: 'costly' }, { key: 'b', action: 'costly', dependsOn: ['a'] }] });
  await drain(engine);
  const tasks = (await engine.getRun(human(), run.id)).tasks; const b = tasks.find((t) => t.key === 'b')!;
  assert.equal(ran, 1); assert.deepEqual(log, ['reserve 6', 'commit 5']);
  assert.equal(b.state, 'paused'); assert.equal(b.pauseReason, 'budget exhausted'); assert.equal(b.attempts, 0);
  assert.equal(await engine.workOnce({ worker: 'w' }), 0, 'exhausted work is not retried in a loop');
  assert.ok((await engine.events(human())).some((e) => e.type === 'orchestration.budget_exhausted'));
  available = 100; await engine.controlTask(human(), b.id, 'resume'); await drain(engine);
  assert.equal((await engine.getRun(human(), run.id)).status, 'completed');
}));
