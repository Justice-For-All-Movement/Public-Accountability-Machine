// E00 — PAM orchestration engine: objectives, directives, workflows, task graphs, persistent agents with project memory,
// runs, checkpoints, leases, retries, pause/resume/cancel/reassign, budgets and crash recovery.
// Models may propose work; this engine's server-side policy decides what is authorized to run.
import { randomUUID } from 'node:crypto';
import { DomainError, invariant, nonempty } from '../contracts.ts';
import type { Json, Scope } from '../contracts.ts';
import {
  SERVICE_KIT_VERSION, appendAudit, emitEvent, idempotent, listAudit, readEvents, requireCapability, runMigrations,
  standardRoutes, uref, parseUref, urefMatches,
} from '../service-kit.ts';
import type {
  AuditRecord, AuthorizationPort, BudgetPort, EngineEvent, EngineManifestV1, Inspection, Migration, Route, SearchHit,
  ServiceContext, Sql, StandardEngine, UpstreamChange,
} from '../service-kit.ts';

export const SCHEMA = 'e00_orchestration';
const S = SCHEMA;
export const manifest: EngineManifestV1 = {
  id: 'E00', name: 'orchestration', version: '0.1.0', kit: SERVICE_KIT_VERSION,
  capabilities: ['orchestration:read', 'orchestration:write', 'orchestration:control', 'orchestration:approve', 'orchestration:admin', 'orchestration:events'],
  emits: ['orchestration.objective_created', 'orchestration.objective_status_changed', 'orchestration.run_started', 'orchestration.run_finished', 'orchestration.task_done', 'orchestration.task_failed', 'orchestration.task_dead', 'orchestration.task_paused', 'orchestration.task_awaiting_approval', 'orchestration.task_stale', 'orchestration.budget_exhausted'],
  consumes: ['*'],
};

export const migrations: readonly Migration[] = [{ id: '001_orchestration', sql: `
create table {s}.objectives (
  id uuid primary key, tenant_id text not null, project_id text not null,
  title text not null, description text not null, lane text, policy jsonb not null default '{}',
  status text not null default 'active' check (status in ('active','paused','completed','cancelled')),
  subject text, created_by text not null, created_at timestamptz not null, updated_at timestamptz not null
);
create index objectives_scope on {s}.objectives (tenant_id, project_id, created_at desc);
create table {s}.directives (
  id uuid primary key, tenant_id text not null, project_id text not null, objective_id uuid not null references {s}.objectives(id),
  body text not null, actor_id text not null, at timestamptz not null
);
create table {s}.workflows (
  tenant_id text not null, project_id text not null, key text not null, version int not null,
  title text not null, definition jsonb not null, created_by text not null, created_at timestamptz not null,
  primary key (tenant_id, project_id, key, version)
);
create table {s}.agents (
  id uuid primary key, tenant_id text not null, project_id text not null,
  name text not null, role text not null, identity_actor_id text not null,
  status text not null default 'active' check (status in ('active','paused','retired')),
  max_concurrent int not null default 1, config jsonb not null default '{}',
  created_by text not null, created_at timestamptz not null, updated_at timestamptz not null,
  unique (tenant_id, project_id, name)
);
create table {s}.agent_memory (
  id uuid primary key, tenant_id text not null, project_id text not null, agent_id uuid not null references {s}.agents(id),
  kind text not null check (kind in ('note','work_record','fact_ref')), key text not null, content jsonb not null,
  sources text[] not null default '{}', task_id uuid, created_at timestamptz not null,
  search tsvector generated always as (to_tsvector('simple', key || ' ' || (content::text))) stored
);
create index agent_memory_agent on {s}.agent_memory (agent_id, created_at desc);
create index agent_memory_search on {s}.agent_memory using gin (search);
create table {s}.runs (
  id uuid primary key, tenant_id text not null, project_id text not null, objective_id uuid not null references {s}.objectives(id),
  workflow_key text, workflow_version int, input jsonb not null default '{}', lane text,
  status text not null default 'running' check (status in ('running','paused','completed','failed','cancelled')),
  started_by text not null, started_at timestamptz not null, finished_at timestamptz
);
create index runs_objective on {s}.runs (objective_id, started_at desc);
create table {s}.tasks (
  id uuid primary key, tenant_id text not null, project_id text not null,
  objective_id uuid not null references {s}.objectives(id), run_id uuid not null references {s}.runs(id),
  key text not null, title text not null, action text not null, input jsonb not null default '{}',
  depends_on text[] not null default '{}', agent_role text, assigned_agent uuid references {s}.agents(id), lane text,
  state text not null check (state in ('proposed','awaiting_approval','blocked','ready','leased','done','dead','cancelled','paused')),
  paused_from text, pause_reason text,
  attempts int not null default 0, max_attempts int not null default 3,
  run_at timestamptz not null, lease_owner text, lease_until timestamptz, generation int not null default 0,
  side_effect text not null default 'none' check (side_effect in ('none','started','uncertain','confirmed')),
  checkpoint jsonb, output jsonb, summary text, error text, stale boolean not null default false, stale_reasons text[] not null default '{}',
  refs text[] not null default '{}', cost jsonb not null default '{}', active_ms bigint not null default 0,
  proposed_by text, decided_by text, created_by text not null, created_at timestamptz not null, updated_at timestamptz not null,
  started_at timestamptz, finished_at timestamptz,
  unique (run_id, key)
);
create index tasks_ready on {s}.tasks (state, run_at);
create index tasks_scope on {s}.tasks (tenant_id, project_id, objective_id);
create index tasks_refs on {s}.tasks using gin (refs);
create table {s}.router_cursors (engine text primary key, last_id text not null, updated_at timestamptz not null default now());
create table {s}.applied_changes (tenant_id text not null, event_id text not null, primary key (tenant_id, event_id));
` }];
export function migrate(sql: Sql): Promise<string[]> { return runMigrations(sql, SCHEMA, migrations); }

// ───────────────────────────── Types ─────────────────────────────
export type ObjectiveStatus = 'active' | 'paused' | 'completed' | 'cancelled';
export type TaskState = 'proposed' | 'awaiting_approval' | 'blocked' | 'ready' | 'leased' | 'done' | 'dead' | 'cancelled' | 'paused';
export type Objective = Readonly<{ id: string; ref: string; title: string; description: string; lane: string | null; policy: ObjectivePolicy; status: ObjectiveStatus; subject: string | null; createdBy: string; createdAt: string; updatedAt: string }>;
/** Server-side policy for an objective. Actions outside `allowedActions` can never run; those in `approvalRequired` wait for a human. */
export type ObjectivePolicy = Readonly<{ allowedActions?: readonly string[]; approvalRequired?: readonly string[]; autoAcceptProposals?: boolean; maxTasks?: number }>;
export type WorkflowStep = Readonly<{ key: string; title?: string; action: string; input?: Json; dependsOn?: readonly string[]; agentRole?: string; maxAttempts?: number; lane?: string }>;
export type WorkflowDefinition = Readonly<{ steps: readonly WorkflowStep[] }>;
export type Workflow = Readonly<{ key: string; version: number; title: string; definition: WorkflowDefinition; createdAt: string }>;
export type Agent = Readonly<{ id: string; ref: string; name: string; role: string; identityActorId: string; status: 'active' | 'paused' | 'retired'; maxConcurrent: number; config: Json; createdAt: string }>;
export type MemoryEntry = Readonly<{ id: string; agentId: string; kind: 'note' | 'work_record' | 'fact_ref'; key: string; content: Json; sources: readonly string[]; taskId: string | null; createdAt: string }>;
export type Run = Readonly<{ id: string; ref: string; objectiveId: string; workflowKey: string | null; workflowVersion: number | null; input: Json; lane: string | null; status: 'running' | 'paused' | 'completed' | 'failed' | 'cancelled'; startedBy: string; startedAt: string; finishedAt: string | null }>;
export type Task = Readonly<{
  id: string; ref: string; tenantId: string; projectId: string; objectiveId: string; runId: string; key: string; title: string; action: string; input: Json;
  dependsOn: readonly string[]; agentRole: string | null; assignedAgent: string | null; lane: string | null; state: TaskState;
  pauseReason: string | null; attempts: number; maxAttempts: number; runAt: string; leaseOwner: string | null; leaseUntil: string | null; generation: number;
  sideEffect: 'none' | 'started' | 'uncertain' | 'confirmed'; checkpoint: Json | null; output: Json | null; summary: string | null; error: string | null;
  stale: boolean; staleReasons: readonly string[]; refs: readonly string[]; cost: Json; activeMs: number; proposedBy: string | null; decidedBy: string | null;
  createdBy: string; createdAt: string; updatedAt: string; startedAt: string | null; finishedAt: string | null;
}>;
export type NewTask = Readonly<{ key: string; title?: string; action: string; input?: Json; dependsOn?: readonly string[]; agentRole?: string; assignedAgent?: string; maxAttempts?: number; lane?: string; refs?: readonly string[] }>;

/** What an action receives. Everything it does is on behalf of `ctx` (the agent's or system actor's authorized context). */
export type ActionContext = Readonly<{
  ctx: ServiceContext; task: Task; agent: Agent | null; attempt: number;
  /** True when an earlier attempt began an external side effect whose outcome is unknown: reconcile, do not repeat blindly. */
  recovering: boolean;
  checkpoint: Json | null;
  /** Persists progress and renews the lease. Throws `lease_lost` when the task was paused, cancelled, reassigned or re-leased. */
  saveCheckpoint(data: Json): Promise<void>;
  /** Call immediately before an external side effect; recorded durably so a crash leaves the task `uncertain`, not silently retried. */
  beginSideEffect(): Promise<void>;
  confirmSideEffect(): Promise<void>;
  /** Adds tasks to the same run (dynamic task graph). Subject to the objective's policy. */
  spawn(tasks: readonly NewTask[]): Promise<void>;
  remember(entry: { kind: MemoryEntry['kind']; key: string; content: Json; sources?: readonly string[] }): Promise<void>;
  recall(query: { q?: string; kind?: MemoryEntry['kind']; limit?: number }): Promise<MemoryEntry[]>;
}>;
export type ActionResult = Readonly<{ output: Json; summary?: string; refs?: readonly string[]; cost?: Readonly<{ amount: number; detail?: Json }> }>;
export type ActionDefinition = Readonly<{
  description: string;
  /** Capabilities the executing context must hold; re-checked through the AuthorizationPort just before execution. */
  requires: readonly string[];
  /** When present, budget is reserved before the action runs and committed afterwards. */
  estimate?: (input: Json) => Readonly<{ category: string; amount: number; unit: string }>;
  run(action: ActionContext): Promise<ActionResult>;
}>;

/** Supplies the authorized context an agent (or the system worker) acts under. Implemented by the host using E01. */
export interface AgentContextPort {
  contextFor(input: { scope: Scope; agent: Agent | null; purpose: string; requestId: string; taskRef: string }): Promise<ServiceContext>;
}
/** Records actual work per research lane (E13). */
export interface WorkRecorderPort {
  recordWork(ctx: ServiceContext, work: { taskRef: string; objectiveRef: string; lane: string | null; agentRef: string | null; startedAt: string; endedAt: string; activeMs: number }): Promise<void>;
}
export type OrchestrationDeps = Readonly<{
  sql: Sql;
  actions?: Readonly<Record<string, ActionDefinition>>;
  ports?: Readonly<{ agentContext?: AgentContextPort; authorization?: AuthorizationPort; budget?: BudgetPort; work?: WorkRecorderPort }>;
  config?: Readonly<{ maxConcurrency?: number; leaseMs?: number; retryBaseMs?: number;
    /** Standalone mode only: without an AgentContextPort, run tasks under the creating actor's stored capability list. */
    standaloneContexts?: boolean }>;
}>;

const iso = (v: unknown): string => new Date(v as Date).toISOString();
const isoN = (v: unknown): string | null => (v === null || v === undefined ? null : iso(v));
const TASK_COLS = `id, tenant_id, project_id, objective_id, run_id, key, title, action, input, depends_on, agent_role, assigned_agent, lane, state, pause_reason, attempts, max_attempts, run_at, lease_owner, lease_until, generation, side_effect, checkpoint, output, summary, error, stale, stale_reasons, refs, cost, active_ms, proposed_by, decided_by, created_by, created_at, updated_at, started_at, finished_at`;
function toTask(r: Record<string, unknown>): Task {
  return { id: r.id as string, ref: uref('E00', 'task', r.id as string), tenantId: r.tenant_id as string, projectId: r.project_id as string, objectiveId: r.objective_id as string, runId: r.run_id as string, key: r.key as string, title: r.title as string, action: r.action as string, input: r.input as Json, dependsOn: r.depends_on as string[], agentRole: (r.agent_role as string | null) ?? null, assignedAgent: (r.assigned_agent as string | null) ?? null, lane: (r.lane as string | null) ?? null, state: r.state as TaskState, pauseReason: (r.pause_reason as string | null) ?? null, attempts: r.attempts as number, maxAttempts: r.max_attempts as number, runAt: iso(r.run_at), leaseOwner: (r.lease_owner as string | null) ?? null, leaseUntil: isoN(r.lease_until), generation: r.generation as number, sideEffect: r.side_effect as Task['sideEffect'], checkpoint: (r.checkpoint as Json | null) ?? null, output: (r.output as Json | null) ?? null, summary: (r.summary as string | null) ?? null, error: (r.error as string | null) ?? null, stale: r.stale as boolean, staleReasons: r.stale_reasons as string[], refs: r.refs as string[], cost: r.cost as Json, activeMs: Number(r.active_ms), proposedBy: (r.proposed_by as string | null) ?? null, decidedBy: (r.decided_by as string | null) ?? null, createdBy: r.created_by as string, createdAt: iso(r.created_at), updatedAt: iso(r.updated_at), startedAt: isoN(r.started_at), finishedAt: isoN(r.finished_at) };
}
function toObjective(r: Record<string, unknown>): Objective {
  return { id: r.id as string, ref: uref('E00', 'objective', r.id as string), title: r.title as string, description: r.description as string, lane: (r.lane as string | null) ?? null, policy: r.policy as ObjectivePolicy, status: r.status as ObjectiveStatus, subject: (r.subject as string | null) ?? null, createdBy: r.created_by as string, createdAt: iso(r.created_at), updatedAt: iso(r.updated_at) };
}
function toAgent(r: Record<string, unknown>): Agent {
  return { id: r.id as string, ref: uref('E00', 'agent', r.id as string), name: r.name as string, role: r.role as string, identityActorId: r.identity_actor_id as string, status: r.status as Agent['status'], maxConcurrent: r.max_concurrent as number, config: r.config as Json, createdAt: iso(r.created_at) };
}
function toRun(r: Record<string, unknown>): Run {
  return { id: r.id as string, ref: uref('E00', 'run', r.id as string), objectiveId: r.objective_id as string, workflowKey: (r.workflow_key as string | null) ?? null, workflowVersion: (r.workflow_version as number | null) ?? null, input: r.input as Json, lane: (r.lane as string | null) ?? null, status: r.status as Run['status'], startedBy: r.started_by as string, startedAt: iso(r.started_at), finishedAt: isoN(r.finished_at) };
}
function toMemory(r: Record<string, unknown>): MemoryEntry {
  return { id: r.id as string, agentId: r.agent_id as string, kind: r.kind as MemoryEntry['kind'], key: r.key as string, content: r.content as Json, sources: r.sources as string[], taskId: (r.task_id as string | null) ?? null, createdAt: iso(r.created_at) };
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuid = (v: string): string => { if (!UUID.test(v)) throw new DomainError('not_found', 'Not found'); return v; };
const KEY = /^[a-z0-9][a-z0-9._-]{0,79}$/;

export type OrchestrationEngine = ReturnType<typeof createEngine>;

export function createEngine(deps: OrchestrationDeps) {
  const { sql } = deps;
  const actions: Record<string, ActionDefinition> = { ...(deps.actions ?? {}) };
  const ports = deps.ports ?? {};
  const maxConcurrency = deps.config?.maxConcurrency ?? 4;
  const leaseMs = deps.config?.leaseMs ?? 60_000;
  const retryBaseMs = deps.config?.retryBaseMs ?? 2_000;
  const scopeArgs = (ctx: Scope): [string, string] => [ctx.tenantId, ctx.projectId];

  async function loadObjective(q: Sql, ctx: Scope, id: string, lock = false): Promise<Objective> {
    const r = (await q.query(`select * from ${S}.objectives where id=$1 and tenant_id=$2 and project_id=$3${lock ? ' for update' : ''}`, [uuid(id), ...scopeArgs(ctx)]))[0];
    invariant(r !== undefined, 'not_found', 'Not found');
    return toObjective(r);
  }
  async function loadTask(q: Sql, ctx: Scope, id: string, lock = false): Promise<Task> {
    const r = (await q.query(`select ${TASK_COLS} from ${S}.tasks where id=$1 and tenant_id=$2 and project_id=$3${lock ? ' for update' : ''}`, [uuid(id), ...scopeArgs(ctx)]))[0];
    invariant(r !== undefined, 'not_found', 'Not found');
    return toTask(r);
  }
  async function loadAgent(q: Sql, ctx: Scope, id: string): Promise<Agent> {
    const r = (await q.query(`select * from ${S}.agents where id=$1 and tenant_id=$2 and project_id=$3`, [uuid(id), ...scopeArgs(ctx)]))[0];
    invariant(r !== undefined, 'not_found', 'Not found');
    return toAgent(r);
  }
  /** Promotes blocked tasks whose dependencies are all done, and finishes runs with nothing left to do. */
  async function settleRun(tx: Sql, runId: string, ctx: ServiceContext): Promise<void> {
    await tx.query(`update ${S}.tasks t set state='ready', updated_at=$2 where t.run_id=$1 and t.state='blocked'
      and not exists (select 1 from unnest(t.depends_on) d(key) left join ${S}.tasks p on p.run_id=t.run_id and p.key=d.key where p.id is null or p.state <> 'done')`, [runId, ctx.now]);
    const counts = (await tx.query<{ open: string; dead: string; total: string }>(`select count(*) filter (where state in ('proposed','awaiting_approval','blocked','ready','leased','paused')) as open, count(*) filter (where state='dead') as dead, count(*) as total from ${S}.tasks where run_id=$1`, [runId]))[0] as { open: string; dead: string; total: string };
    // A run whose remaining tasks are all blocked behind a dead or cancelled dependency cannot progress: it is failed, visibly.
    const stuck = (await tx.query<{ n: string }>(`select count(*) as n from ${S}.tasks t where t.run_id=$1 and t.state in ('ready','leased','paused','proposed','awaiting_approval')`, [runId]))[0] as { n: string };
    const run = (await tx.query(`select * from ${S}.runs where id=$1 for update`, [runId]))[0];
    if (run === undefined || run.status !== 'running') return;
    let status: Run['status'] | null = null;
    if (Number(counts.total) > 0 && Number(counts.open) === 0) status = Number(counts.dead) > 0 ? 'failed' : 'completed';
    else if (Number(stuck.n) === 0 && Number(counts.open) > 0 && Number(counts.dead) > 0) status = 'failed';
    if (status !== null) {
      await tx.query(`update ${S}.runs set status=$2, finished_at=$3 where id=$1`, [runId, status, ctx.now]);
      await emitEvent(tx, S, ctx, 'orchestration.run_finished', uref('E00', 'run', runId), { status });
    }
  }
  function validateNewTasks(tasks: readonly NewTask[], existingKeys: ReadonlySet<string>): void {
    const keys = new Set(existingKeys);
    for (const t of tasks) {
      invariant(typeof t.key === 'string' && KEY.test(t.key), 'invalid_input', `Invalid task key ${String(t.key)}`);
      invariant(!keys.has(t.key), 'conflict', `Duplicate task key ${t.key}`);
      keys.add(t.key); nonempty(t.action, 'action', 120);
    }
    for (const t of tasks) for (const d of t.dependsOn ?? []) invariant(keys.has(d) && d !== t.key, 'invalid_input', `Task ${t.key} depends on unknown task ${d}`);
    // New tasks may only depend on existing tasks or each other; reject cycles among the new set.
    const graph = new Map(tasks.map((t) => [t.key, (t.dependsOn ?? []).filter((d) => !existingKeys.has(d))]));
    const seen = new Map<string, number>();
    const visit = (k: string): void => {
      const mark = seen.get(k); if (mark === 2) return; invariant(mark !== 1, 'invalid_input', 'Task dependencies contain a cycle');
      seen.set(k, 1); for (const d of graph.get(k) ?? []) visit(d); seen.set(k, 2);
    };
    for (const k of graph.keys()) visit(k);
  }
  async function insertTasks(tx: Sql, ctx: ServiceContext, objective: Objective, run: Run, tasks: readonly NewTask[], mode: 'authorized' | 'proposed'): Promise<Task[]> {
    const existing = new Set((await tx.query<{ key: string }>(`select key from ${S}.tasks where run_id=$1`, [run.id])).map((r) => r.key));
    validateNewTasks(tasks, existing);
    const policy = objective.policy;
    if (policy.maxTasks !== undefined) {
      const n = Number(((await tx.query<{ n: string }>(`select count(*) as n from ${S}.tasks where objective_id=$1`, [objective.id]))[0] as { n: string }).n);
      invariant(n + tasks.length <= policy.maxTasks, 'policy_denied', 'Objective task ceiling reached');
    }
    const out: Task[] = [];
    for (const t of tasks) {
      if (!Object.hasOwn(actions, t.action)) throw new DomainError('invalid_input', `Unknown action ${t.action}`);
      if (policy.allowedActions !== undefined && !policy.allowedActions.includes(t.action)) throw new DomainError('policy_denied', `Action ${t.action} is not allowed for this objective`);
      if (t.assignedAgent !== undefined) await loadAgent(tx, ctx, t.assignedAgent);
      const needsApproval = policy.approvalRequired?.includes(t.action) === true;
      const state: TaskState = mode === 'proposed' && policy.autoAcceptProposals !== true ? 'proposed'
        : needsApproval ? 'awaiting_approval'
        : (t.dependsOn ?? []).length > 0 ? 'blocked' : 'ready';
      const id = randomUUID();
      const row = (await tx.query(`insert into ${S}.tasks (id, tenant_id, project_id, objective_id, run_id, key, title, action, input, depends_on, agent_role, assigned_agent, lane, state, max_attempts, run_at, refs, proposed_by, created_by, created_at, updated_at)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$16,$16) returning ${TASK_COLS}`,
        [id, ctx.tenantId, ctx.projectId, objective.id, run.id, t.key, t.title ?? t.key, t.action, JSON.stringify(t.input ?? {}), [...(t.dependsOn ?? [])], t.agentRole ?? null, t.assignedAgent ?? null, t.lane ?? run.lane ?? objective.lane, state, t.maxAttempts ?? 3, ctx.now, [...(t.refs ?? [])], mode === 'proposed' ? ctx.actor.id : null, ctx.actor.id]))[0] as Record<string, unknown>;
      out.push(toTask(row));
      if (state === 'awaiting_approval') await emitEvent(tx, S, ctx, 'orchestration.task_awaiting_approval', uref('E00', 'task', id), { action: t.action });
    }
    await settleRun(tx, run.id, ctx);
    return out;
  }
  async function loadRun(q: Sql, ctx: Scope, id: string, lock = false): Promise<Run> {
    const r = (await q.query(`select * from ${S}.runs where id=$1 and tenant_id=$2 and project_id=$3${lock ? ' for update' : ''}`, [uuid(id), ...scopeArgs(ctx)]))[0];
    invariant(r !== undefined, 'not_found', 'Not found');
    return toRun(r);
  }
  /** Pauses or cancels every open task matching a filter; resume restores the prior state. */
  async function bulkControl(tx: Sql, ctx: ServiceContext, where: string, params: unknown[], action: 'pause' | 'resume' | 'cancel', reason: string): Promise<number> {
    const n = params.length;
    if (action === 'pause') return (await tx.query(`update ${S}.tasks set paused_from=case when state='leased' then 'ready' else state end, state='paused', pause_reason=$${n + 1}, lease_owner=null, lease_until=null, updated_at=$${n + 2} where ${where} and state in ('blocked','ready','leased','awaiting_approval','proposed') returning id`, [...params, reason, ctx.now])).length;
    if (action === 'cancel') return (await tx.query(`update ${S}.tasks set state='cancelled', pause_reason=$${n + 1}, lease_owner=null, lease_until=null, finished_at=$${n + 2}, updated_at=$${n + 2} where ${where} and state in ('blocked','ready','leased','awaiting_approval','proposed','paused') returning id`, [...params, reason, ctx.now])).length;
    return (await tx.query(`update ${S}.tasks set state=coalesce(paused_from,'blocked'), paused_from=null, pause_reason=null, updated_at=$${n + 1} where ${where} and state='paused' returning id`, [...params, ctx.now])).length;
  }

  const engine = {
    manifest,
    registerAction(name: string, definition: ActionDefinition): void { invariant(/^[a-z0-9][a-z0-9._:-]{0,119}$/.test(name), 'invalid_input', 'Invalid action name'); actions[name] = definition; },
    listActions(ctx: ServiceContext): { name: string; description: string; requires: readonly string[] }[] {
      requireCapability(ctx, 'orchestration:read');
      return Object.entries(actions).map(([name, a]) => ({ name, description: a.description, requires: a.requires })).sort((a, b) => a.name.localeCompare(b.name));
    },

    // ── Objectives and directives ──
    async createObjective(ctx: ServiceContext, input: { title: string; description: string; lane?: string; policy?: ObjectivePolicy; subject?: string; idempotencyKey?: string }): Promise<Objective> {
      requireCapability(ctx, 'orchestration:write');
      nonempty(input.title, 'title', 300); nonempty(input.description, 'description', 20000);
      if (input.subject !== undefined) parseUref(input.subject);
      return sql.tx((tx) => idempotent(tx, S, ctx, input.idempotencyKey, input, async () => {
        const id = randomUUID();
        const r = (await tx.query(`insert into ${S}.objectives (id, tenant_id, project_id, title, description, lane, policy, subject, created_by, created_at, updated_at) values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$10) returning *`,
          [id, ctx.tenantId, ctx.projectId, input.title, input.description, input.lane ?? null, JSON.stringify(input.policy ?? {}), input.subject ?? null, ctx.actor.id, ctx.now]))[0] as Record<string, unknown>;
        await appendAudit(tx, S, ctx, 'objective.created', uref('E00', 'objective', id), { title: input.title, lane: input.lane ?? null });
        await emitEvent(tx, S, ctx, 'orchestration.objective_created', uref('E00', 'objective', id), {});
        return toObjective(r) as unknown as Json;
      })) as unknown as Promise<Objective>;
    },
    async getObjective(ctx: ServiceContext, id: string): Promise<Objective & { directives: { id: string; body: string; actorId: string; at: string }[] }> {
      requireCapability(ctx, 'orchestration:read');
      const o = await loadObjective(sql, ctx, id);
      const d = await sql.query(`select id, body, actor_id, at from ${S}.directives where objective_id=$1 order by at`, [o.id]);
      return { ...o, directives: d.map((r) => ({ id: r.id as string, body: r.body as string, actorId: r.actor_id as string, at: iso(r.at) })) };
    },
    async listObjectives(ctx: ServiceContext, options: { status?: ObjectiveStatus; limit?: number } = {}): Promise<Objective[]> {
      requireCapability(ctx, 'orchestration:read');
      return (await sql.query(`select * from ${S}.objectives where tenant_id=$1 and project_id=$2 and ($3::text is null or status=$3) order by created_at desc limit ${Math.min(options.limit ?? 100, 500)}`, [...scopeArgs(ctx), options.status ?? null])).map(toObjective);
    },
    /** Operator instruction appended to an objective; visible to agents as data on their next task. */
    async addDirective(ctx: ServiceContext, objectiveId: string, body: string): Promise<void> {
      requireCapability(ctx, 'orchestration:control'); nonempty(body, 'directive', 10000);
      invariant(ctx.actor.kind === 'human', 'forbidden', 'Directives are issued by human operators');
      await sql.tx(async (tx) => {
        const o = await loadObjective(tx, ctx, objectiveId, true);
        const id = randomUUID();
        await tx.query(`insert into ${S}.directives (id, tenant_id, project_id, objective_id, body, actor_id, at) values ($1,$2,$3,$4,$5,$6,$7)`, [id, ctx.tenantId, ctx.projectId, o.id, body, ctx.actor.id, ctx.now]);
        await appendAudit(tx, S, ctx, 'objective.directive_added', o.ref, { directiveId: id });
      });
    },
    /** Pause, resume, cancel or complete an objective and all of its open work. */
    async setObjectiveStatus(ctx: ServiceContext, objectiveId: string, status: ObjectiveStatus, reason = ''): Promise<Objective> {
      requireCapability(ctx, 'orchestration:control');
      return sql.tx(async (tx) => {
        const o = await loadObjective(tx, ctx, objectiveId, true);
        const allowed: Record<ObjectiveStatus, ObjectiveStatus[]> = { active: ['paused', 'completed', 'cancelled'], paused: ['active', 'cancelled'], completed: ['active'], cancelled: [] };
        invariant(allowed[o.status].includes(status), 'invalid_state', `Objective is ${o.status}`);
        const why = reason || `objective ${status} by operator`;
        if (status === 'paused') { await bulkControl(tx, ctx, 'objective_id=$1', [o.id], 'pause', why); await tx.query(`update ${S}.runs set status='paused' where objective_id=$1 and status='running'`, [o.id]); }
        if (status === 'cancelled') { await bulkControl(tx, ctx, 'objective_id=$1', [o.id], 'cancel', why); await tx.query(`update ${S}.runs set status='cancelled', finished_at=$2 where objective_id=$1 and status in ('running','paused')`, [o.id, ctx.now]); }
        if (status === 'active' && o.status === 'paused') {
          await tx.query(`update ${S}.runs set status='running' where objective_id=$1 and status='paused'`, [o.id]);
          await bulkControl(tx, ctx, 'objective_id=$1', [o.id], 'resume', '');
          for (const r of await tx.query<{ id: string }>(`select id from ${S}.runs where objective_id=$1 and status='running'`, [o.id])) await settleRun(tx, r.id, ctx);
        }
        const r = (await tx.query(`update ${S}.objectives set status=$2, updated_at=$3 where id=$1 returning *`, [o.id, status, ctx.now]))[0] as Record<string, unknown>;
        await appendAudit(tx, S, ctx, 'objective.status_changed', o.ref, { from: o.status, to: status, reason });
        await emitEvent(tx, S, ctx, 'orchestration.objective_status_changed', o.ref, { from: o.status, to: status });
        return toObjective(r);
      });
    },

    // ── Workflow definitions ──
    async registerWorkflow(ctx: ServiceContext, input: { key: string; title: string; definition: WorkflowDefinition }): Promise<Workflow> {
      requireCapability(ctx, 'orchestration:admin');
      invariant(KEY.test(input.key), 'invalid_input', 'Invalid workflow key'); nonempty(input.title, 'title', 300);
      invariant(Array.isArray(input.definition?.steps) && input.definition.steps.length > 0 && input.definition.steps.length <= 500, 'invalid_input', 'Workflow needs 1–500 steps');
      validateNewTasks(input.definition.steps, new Set());
      for (const s of input.definition.steps) invariant(Object.hasOwn(actions, s.action), 'invalid_input', `Unknown action ${s.action}`);
      return sql.tx(async (tx) => {
        await tx.query('select pg_advisory_xact_lock(hashtext($1))', [`e00-wf:${ctx.tenantId}:${ctx.projectId}:${input.key}`]);
        const last = (await tx.query<{ v: number | null }>(`select max(version) as v from ${S}.workflows where tenant_id=$1 and project_id=$2 and key=$3`, [...scopeArgs(ctx), input.key]))[0];
        const version = (last?.v ?? 0) + 1;
        await tx.query(`insert into ${S}.workflows (tenant_id, project_id, key, version, title, definition, created_by, created_at) values ($1,$2,$3,$4,$5,$6::jsonb,$7,$8)`, [...scopeArgs(ctx), input.key, version, input.title, JSON.stringify(input.definition), ctx.actor.id, ctx.now]);
        await appendAudit(tx, S, ctx, 'workflow.registered', uref('E00', 'workflow', input.key, version), {});
        return { key: input.key, version, title: input.title, definition: input.definition, createdAt: ctx.now };
      });
    },
    async listWorkflows(ctx: ServiceContext): Promise<Workflow[]> {
      requireCapability(ctx, 'orchestration:read');
      return (await sql.query(`select distinct on (key) key, version, title, definition, created_at from ${S}.workflows where tenant_id=$1 and project_id=$2 order by key, version desc`, scopeArgs(ctx)))
        .map((r) => ({ key: r.key as string, version: r.version as number, title: r.title as string, definition: r.definition as WorkflowDefinition, createdAt: iso(r.created_at) }));
    },

    // ── Persistent agents and authorized project memory ──
    async createAgent(ctx: ServiceContext, input: { name: string; role: string; identityActorId: string; maxConcurrent?: number; config?: Json }): Promise<Agent> {
      requireCapability(ctx, 'orchestration:admin');
      nonempty(input.name, 'name', 120); nonempty(input.role, 'role', 120); nonempty(input.identityActorId, 'identityActorId', 200);
      return sql.tx(async (tx) => {
        const id = randomUUID();
        const rows = await tx.query(`insert into ${S}.agents (id, tenant_id, project_id, name, role, identity_actor_id, max_concurrent, config, created_by, created_at, updated_at) values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$10) on conflict (tenant_id, project_id, name) do nothing returning *`,
          [id, ...scopeArgs(ctx), input.name, input.role, input.identityActorId, Math.min(Math.max(input.maxConcurrent ?? 1, 1), 32), JSON.stringify(input.config ?? {}), ctx.actor.id, ctx.now]);
        invariant(rows[0] !== undefined, 'conflict', 'An agent with this name already exists');
        await appendAudit(tx, S, ctx, 'agent.created', uref('E00', 'agent', id), { name: input.name, role: input.role });
        return toAgent(rows[0]);
      });
    },
    async setAgentStatus(ctx: ServiceContext, agentId: string, status: Agent['status']): Promise<Agent> {
      requireCapability(ctx, 'orchestration:control');
      return sql.tx(async (tx) => {
        const a = await loadAgent(tx, ctx, agentId);
        invariant(a.status !== 'retired', 'invalid_state', 'Agent is retired');
        const r = (await tx.query(`update ${S}.agents set status=$2, updated_at=$3 where id=$1 returning *`, [a.id, status, ctx.now]))[0] as Record<string, unknown>;
        // A paused or retired agent's running work is released for reassignment rather than left leased.
        if (status !== 'active') await tx.query(`update ${S}.tasks set state='ready', lease_owner=null, lease_until=null, updated_at=$2 where assigned_agent=$1 and state='leased'`, [a.id, ctx.now]);
        await appendAudit(tx, S, ctx, 'agent.status_changed', a.ref, { from: a.status, to: status });
        return toAgent(r);
      });
    },
    async listAgents(ctx: ServiceContext): Promise<(Agent & { running: number; completed: number })[]> {
      requireCapability(ctx, 'orchestration:read');
      return (await sql.query(`select a.*, (select count(*) from ${S}.tasks t where t.assigned_agent=a.id and t.state='leased') as running, (select count(*) from ${S}.tasks t where t.assigned_agent=a.id and t.state='done') as completed from ${S}.agents a where a.tenant_id=$1 and a.project_id=$2 order by a.name`, scopeArgs(ctx)))
        .map((r) => ({ ...toAgent(r), running: Number(r.running), completed: Number(r.completed) }));
    },
    async remember(ctx: ServiceContext, agentId: string, entry: { kind: MemoryEntry['kind']; key: string; content: Json; sources?: readonly string[]; taskId?: string }): Promise<MemoryEntry> {
      requireCapability(ctx, 'orchestration:write'); nonempty(entry.key, 'key', 300);
      for (const s of entry.sources ?? []) parseUref(s);
      const a = await loadAgent(sql, ctx, agentId);
      const r = (await sql.query(`insert into ${S}.agent_memory (id, tenant_id, project_id, agent_id, kind, key, content, sources, task_id, created_at) values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10) returning *`,
        [randomUUID(), ...scopeArgs(ctx), a.id, entry.kind, entry.key, JSON.stringify(entry.content), [...(entry.sources ?? [])], entry.taskId ?? null, ctx.now]))[0] as Record<string, unknown>;
      return toMemory(r);
    },
    /** Memory is project-scoped: an agent never recalls another project's or organization's records. */
    async recall(ctx: ServiceContext, agentId: string, query: { q?: string; kind?: MemoryEntry['kind']; limit?: number } = {}): Promise<MemoryEntry[]> {
      requireCapability(ctx, 'orchestration:read');
      const a = await loadAgent(sql, ctx, agentId);
      return (await sql.query(`select * from ${S}.agent_memory where agent_id=$1 and tenant_id=$2 and project_id=$3 and ($4::text is null or kind=$4) and ($5::text is null or search @@ plainto_tsquery('simple', $5)) order by created_at desc limit ${Math.min(query.limit ?? 50, 500)}`,
        [a.id, ...scopeArgs(ctx), query.kind ?? null, query.q ?? null])).map(toMemory);
    },

    // ── Runs and task graphs ──
    async startRun(ctx: ServiceContext, input: { objectiveId: string; workflowKey?: string; tasks?: readonly NewTask[]; input?: Json; lane?: string; idempotencyKey?: string }): Promise<Run & { tasks: Task[] }> {
      requireCapability(ctx, 'orchestration:write');
      invariant((input.workflowKey === undefined) !== (input.tasks === undefined), 'invalid_input', 'Provide either workflowKey or tasks');
      return sql.tx((tx) => idempotent(tx, S, ctx, input.idempotencyKey, input, async () => {
        const o = await loadObjective(tx, ctx, input.objectiveId, true);
        invariant(o.status === 'active', 'invalid_state', `Objective is ${o.status}`);
        let steps: readonly NewTask[]; let version: number | null = null;
        if (input.workflowKey !== undefined) {
          const wf = (await tx.query(`select version, definition from ${S}.workflows where tenant_id=$1 and project_id=$2 and key=$3 order by version desc limit 1`, [...scopeArgs(ctx), input.workflowKey]))[0];
          invariant(wf !== undefined, 'not_found', 'Workflow not found');
          version = wf.version as number;
          // Workflow step inputs are merged over the run input so steps see the run's parameters.
          steps = (wf.definition as WorkflowDefinition).steps.map((s) => ({ ...s, input: { ...((input.input ?? {}) as Record<string, Json>), ...((s.input ?? {}) as Record<string, Json>) } }));
        } else steps = input.tasks as readonly NewTask[];
        const runId = randomUUID();
        const row = (await tx.query(`insert into ${S}.runs (id, tenant_id, project_id, objective_id, workflow_key, workflow_version, input, lane, started_by, started_at) values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10) returning *`,
          [runId, ...scopeArgs(ctx), o.id, input.workflowKey ?? null, version, JSON.stringify(input.input ?? {}), input.lane ?? o.lane, ctx.actor.id, ctx.now]))[0] as Record<string, unknown>;
        const run = toRun(row);
        const tasks = await insertTasks(tx, ctx, o, run, steps, 'authorized');
        await appendAudit(tx, S, ctx, 'run.started', run.ref, { objective: o.ref, tasks: tasks.length });
        await emitEvent(tx, S, ctx, 'orchestration.run_started', run.ref, { objective: o.ref });
        const fresh = (await tx.query(`select ${TASK_COLS} from ${S}.tasks where run_id=$1 order by created_at, key`, [runId])).map(toTask);
        return { ...run, tasks: fresh } as unknown as Json;
      })) as unknown as Promise<Run & { tasks: Task[] }>;
    },
    async addTasks(ctx: ServiceContext, runId: string, tasks: readonly NewTask[]): Promise<Task[]> {
      requireCapability(ctx, 'orchestration:write');
      return sql.tx(async (tx) => {
        const run = await loadRun(tx, ctx, runId, true);
        invariant(run.status === 'running' || run.status === 'completed', 'invalid_state', `Run is ${run.status}`);
        if (run.status === 'completed') await tx.query(`update ${S}.runs set status='running', finished_at=null where id=$1`, [run.id]);
        const o = await loadObjective(tx, ctx, run.objectiveId);
        const out = await insertTasks(tx, ctx, o, { ...run, status: 'running' }, tasks, 'authorized');
        await appendAudit(tx, S, ctx, 'run.tasks_added', run.ref, { keys: tasks.map((t) => t.key) });
        return out;
      });
    },
    /** Work suggested by a model or agent. It is stored as a proposal and cannot run until policy or a human accepts it. */
    async proposeTasks(ctx: ServiceContext, runId: string, tasks: readonly NewTask[]): Promise<Task[]> {
      requireCapability(ctx, 'orchestration:write');
      return sql.tx(async (tx) => {
        const run = await loadRun(tx, ctx, runId, true);
        invariant(run.status === 'running', 'invalid_state', `Run is ${run.status}`);
        const o = await loadObjective(tx, ctx, run.objectiveId);
        const out = await insertTasks(tx, ctx, o, run, tasks, 'proposed');
        await appendAudit(tx, S, ctx, 'run.tasks_proposed', run.ref, { keys: tasks.map((t) => t.key) });
        return out;
      });
    },
    /** A human accepts or rejects a proposed task or one awaiting approval. Agents and services cannot decide. */
    async decideTask(ctx: ServiceContext, taskId: string, decision: 'approve' | 'reject', reason = ''): Promise<Task> {
      requireCapability(ctx, 'orchestration:approve');
      invariant(ctx.actor.kind === 'human', 'forbidden', 'Only a human operator can approve or reject work');
      return sql.tx(async (tx) => {
        const t = await loadTask(tx, ctx, taskId, true);
        invariant(t.state === 'proposed' || t.state === 'awaiting_approval', 'invalid_state', `Task is ${t.state}`);
        const o = await loadObjective(tx, ctx, t.objectiveId);
        // Accepting a proposal still honours approvalRequired: it moves to awaiting_approval unless this decision is that approval.
        const next: TaskState = decision === 'reject' ? 'cancelled' : (t.dependsOn.length > 0 ? 'blocked' : 'ready');
        void o;
        const r = (await tx.query(`update ${S}.tasks set state=$2::text, decided_by=$3, pause_reason=$4, updated_at=$5::timestamptz, finished_at=case when $2::text='cancelled' then $5::timestamptz else null end where id=$1 returning ${TASK_COLS}`, [t.id, next, ctx.actor.id, decision === 'reject' ? (reason || 'rejected') : null, ctx.now]))[0] as Record<string, unknown>;
        await appendAudit(tx, S, ctx, `task.${decision}d`, t.ref, { reason });
        await settleRun(tx, t.runId, ctx);
        return loadTask(tx, ctx, (r.id as string));
      });
    },
    async getTask(ctx: ServiceContext, id: string): Promise<Task> { requireCapability(ctx, 'orchestration:read'); return loadTask(sql, ctx, id); },
    async getRun(ctx: ServiceContext, id: string): Promise<Run & { tasks: Task[] }> {
      requireCapability(ctx, 'orchestration:read');
      const run = await loadRun(sql, ctx, id);
      return { ...run, tasks: (await sql.query(`select ${TASK_COLS} from ${S}.tasks where run_id=$1 order by created_at, key`, [run.id])).map(toTask) };
    },
    async listRuns(ctx: ServiceContext, options: { objectiveId?: string; limit?: number } = {}): Promise<Run[]> {
      requireCapability(ctx, 'orchestration:read');
      return (await sql.query(`select * from ${S}.runs where tenant_id=$1 and project_id=$2 and ($3::uuid is null or objective_id=$3) order by started_at desc limit ${Math.min(options.limit ?? 100, 500)}`, [...scopeArgs(ctx), options.objectiveId === undefined ? null : uuid(options.objectiveId)])).map(toRun);
    },
    async listTasks(ctx: ServiceContext, options: { objectiveId?: string; runId?: string; states?: readonly TaskState[]; agentId?: string; limit?: number } = {}): Promise<Task[]> {
      requireCapability(ctx, 'orchestration:read');
      return (await sql.query(`select ${TASK_COLS} from ${S}.tasks where tenant_id=$1 and project_id=$2 and ($3::uuid is null or objective_id=$3) and ($4::uuid is null or run_id=$4) and ($5::text[] is null or state = any($5)) and ($6::uuid is null or assigned_agent=$6) order by created_at desc, key limit ${Math.min(options.limit ?? 200, 1000)}`,
        [...scopeArgs(ctx), options.objectiveId === undefined ? null : uuid(options.objectiveId), options.runId === undefined ? null : uuid(options.runId), options.states === undefined ? null : [...options.states], options.agentId === undefined ? null : uuid(options.agentId)])).map(toTask);
    },
    /** Operator controls on one task. A leased task that is paused/cancelled loses its lease: its worker cannot publish a result. */
    async controlTask(ctx: ServiceContext, taskId: string, action: 'pause' | 'resume' | 'cancel' | 'retry', reason = ''): Promise<Task> {
      requireCapability(ctx, 'orchestration:control');
      return sql.tx(async (tx) => {
        const t = await loadTask(tx, ctx, taskId, true);
        if (action === 'retry') {
          invariant(t.state === 'dead' || t.state === 'cancelled', 'invalid_state', `Task is ${t.state}`);
          // An uncertain side effect stays marked so the action reconciles instead of repeating.
          await tx.query(`update ${S}.tasks set state=$2, attempts=0, error=null, run_at=$3, finished_at=null, pause_reason=null, updated_at=$3 where id=$1`, [t.id, t.dependsOn.length > 0 ? 'blocked' : 'ready', ctx.now]);
          const run = await loadRun(tx, ctx, t.runId, true);
          if (run.status === 'failed' || run.status === 'completed') await tx.query(`update ${S}.runs set status='running', finished_at=null where id=$1`, [run.id]);
        } else {
          const n = await bulkControl(tx, ctx, 'id=$1', [t.id], action, reason || `${action} by operator`);
          invariant(n === 1, 'invalid_state', `Task in state ${t.state} cannot ${action}`);
          if (action === 'pause') await emitEvent(tx, S, ctx, 'orchestration.task_paused', t.ref, { reason });
        }
        await appendAudit(tx, S, ctx, `task.${action}`, t.ref, { reason, from: t.state });
        await settleRun(tx, t.runId, ctx);
        return loadTask(tx, ctx, t.id);
      });
    },
    /** Moves a task to another agent. If it was running, the previous worker's lease is revoked. */
    async reassignTask(ctx: ServiceContext, taskId: string, agentId: string | null): Promise<Task> {
      requireCapability(ctx, 'orchestration:control');
      return sql.tx(async (tx) => {
        const t = await loadTask(tx, ctx, taskId, true);
        invariant(!['done', 'dead', 'cancelled'].includes(t.state), 'invalid_state', `Task is ${t.state}`);
        if (agentId !== null) { const a = await loadAgent(tx, ctx, agentId); invariant(a.status === 'active', 'invalid_state', `Agent is ${a.status}`); }
        await tx.query(`update ${S}.tasks set assigned_agent=$2, state=case when state='leased' then 'ready' else state end, lease_owner=null, lease_until=null, updated_at=$3 where id=$1`, [t.id, agentId, ctx.now]);
        await appendAudit(tx, S, ctx, 'task.reassigned', t.ref, { from: t.assignedAgent, to: agentId });
        return loadTask(tx, ctx, t.id);
      });
    },

    // ── Execution ──
    /**
     * Leases and executes ready tasks once. Safe to call from many workers and processes: leasing is serialized, bounded by
     * global and per-agent concurrency, and results are fenced by lease generation. Returns the number of tasks attempted.
     */
    async workOnce(options: { worker: string; limit?: number; now?: Date } = { worker: 'worker' }): Promise<number> {
      const now = options.now ?? new Date();
      const leased = await sql.tx(async (tx) => {
        await tx.query('select pg_advisory_xact_lock(hashtext($1))', ['e00-lease']);
        const at = now.toISOString();
        // Crash recovery: an expired lease returns to the queue; a side effect that had started becomes `uncertain`.
        await tx.query(`update ${S}.tasks set state=case when attempts >= max_attempts then 'dead' else 'ready' end, side_effect=case when side_effect='started' then 'uncertain' else side_effect end,
          error=case when attempts >= max_attempts then coalesce(error,'lease expired after final attempt') else error end, finished_at=case when attempts >= max_attempts then $1::timestamptz else null end,
          lease_owner=null, lease_until=null, updated_at=$1 where state='leased' and lease_until < $1`, [at]);
        const running = Number(((await tx.query<{ n: string }>(`select count(*) as n from ${S}.tasks where state='leased'`))[0] as { n: string }).n);
        const capacity = Math.min(options.limit ?? maxConcurrency, maxConcurrency - running);
        if (capacity <= 0) return [];
        const candidates = await tx.query(`select t.id, t.tenant_id, t.project_id, t.agent_role, t.assigned_agent from ${S}.tasks t join ${S}.objectives o on o.id=t.objective_id join ${S}.runs r on r.id=t.run_id
          where t.state='ready' and t.run_at <= $1 and o.status='active' and r.status='running' order by t.run_at, t.created_at limit 200 for update of t skip locked`, [at]);
        const picked: string[] = [];
        const load = new Map<string, number>();
        for (const c of candidates) {
          if (picked.length >= capacity) break;
          let agentId = c.assigned_agent as string | null;
          if (agentId === null && c.agent_role !== null) {
            // Choose the least-loaded active agent with the required role in this project.
            const agents = await tx.query(`select a.id, a.max_concurrent, (select count(*) from ${S}.tasks x where x.assigned_agent=a.id and x.state='leased') as running from ${S}.agents a where a.tenant_id=$1 and a.project_id=$2 and a.role=$3 and a.status='active' order by a.name`, [c.tenant_id, c.project_id, c.agent_role]);
            const free = agents.map((a) => ({ id: a.id as string, room: (a.max_concurrent as number) - Number(a.running) - (load.get(a.id as string) ?? 0) })).filter((a) => a.room > 0).sort((a, b) => b.room - a.room)[0];
            if (free === undefined) continue; // no capacity for this role right now; the task stays ready
            agentId = free.id;
          } else if (agentId !== null) {
            const a = (await tx.query(`select status, max_concurrent, (select count(*) from ${S}.tasks x where x.assigned_agent=a.id and x.state='leased') as running from ${S}.agents a where a.id=$1`, [agentId]))[0];
            if (a === undefined || a.status !== 'active' || Number(a.running) + (load.get(agentId) ?? 0) >= (a.max_concurrent as number)) continue;
          }
          if (agentId !== null) load.set(agentId, (load.get(agentId) ?? 0) + 1);
          await tx.query(`update ${S}.tasks set state='leased', assigned_agent=$2, lease_owner=$3, lease_until=$4, attempts=attempts+1, generation=generation+1, started_at=coalesce(started_at,$5), updated_at=$5 where id=$1`,
            [c.id, agentId, options.worker, new Date(now.getTime() + leaseMs).toISOString(), at]);
          picked.push(c.id as string);
        }
        return picked.length === 0 ? [] : (await tx.query(`select ${TASK_COLS} from ${S}.tasks where id = any($1::uuid[])`, [picked])).map(toTask);
      });
      await Promise.all(leased.map((task) => executeTask(task, options.worker)));
      return leased.length;
    },

    // ── Operator overview ──
    async overview(ctx: ServiceContext): Promise<{ objectives: Record<string, number>; tasks: Record<string, number>; running: Task[]; failures: Task[]; awaitingApproval: Task[]; stale: number; activeMsByLane: Record<string, number> }> {
      requireCapability(ctx, 'orchestration:read');
      const count = async (table: string, col: string): Promise<Record<string, number>> => Object.fromEntries((await sql.query(`select ${col} as k, count(*) as n from ${S}.${table} where tenant_id=$1 and project_id=$2 group by 1`, scopeArgs(ctx))).map((r) => [r.k as string, Number(r.n)]));
      const pick = async (where: string): Promise<Task[]> => (await sql.query(`select ${TASK_COLS} from ${S}.tasks where tenant_id=$1 and project_id=$2 and ${where} order by updated_at desc limit 50`, scopeArgs(ctx))).map(toTask);
      const lanes = await sql.query(`select coalesce(lane,'(none)') as lane, sum(active_ms) as ms from ${S}.tasks where tenant_id=$1 and project_id=$2 group by 1`, scopeArgs(ctx));
      const stale = (await sql.query<{ n: string }>(`select count(*) as n from ${S}.tasks where tenant_id=$1 and project_id=$2 and stale`, scopeArgs(ctx)))[0] as { n: string };
      return { objectives: await count('objectives', 'status'), tasks: await count('tasks', 'state'), running: await pick(`state='leased'`), failures: await pick(`state='dead' or (state='paused' and pause_reason like 'budget%') or side_effect='uncertain'`), awaitingApproval: await pick(`state in ('awaiting_approval','proposed')`), stale: Number(stale.n), activeMsByLane: Object.fromEntries(lanes.map((r) => [r.lane as string, Number(r.ms)])) };
    },

    // ── Event router cursors (the host reads other engines' feeds and delivers upstream changes) ──
    async routerCursor(engineId: string): Promise<string> {
      return ((await sql.query<{ last_id: string }>(`select last_id from ${S}.router_cursors where engine=$1`, [engineId]))[0]?.last_id) ?? '0';
    },
    async advanceRouterCursor(engineId: string, lastId: string): Promise<void> {
      await sql.query(`insert into ${S}.router_cursors (engine, last_id) values ($1,$2) on conflict (engine) do update set last_id=excluded.last_id, updated_at=now() where ${S}.router_cursors.last_id::bigint < excluded.last_id::bigint`, [engineId, lastId]);
    },

    // ── Standard surface ──
    async inspect(ctx: ServiceContext, ref: string): Promise<Inspection | null> {
      requireCapability(ctx, 'orchestration:read');
      let parsed; try { parsed = parseUref(ref); } catch { return null; }
      if (parsed.engine !== 'E00') return null;
      const history = async (): Promise<Inspection['history']> => (await listAudit(sql, S, ctx, { subject: `E00:${parsed.kind}:${parsed.id}`, limit: 200 })).map((a) => ({ at: a.at, actorId: a.actorId, action: a.action, detail: a.detail }));
      try {
        if (parsed.kind === 'task') {
          const t = await loadTask(sql, ctx, parsed.id);
          const deps = t.dependsOn.length === 0 ? [] : (await sql.query(`select id, key, state from ${S}.tasks where run_id=$1 and key = any($2)`, [t.runId, [...t.dependsOn]]));
          const dependents = await sql.query(`select id from ${S}.tasks where run_id=$1 and $2 = any(depends_on)`, [t.runId, t.key]);
          const blockedBy = deps.filter((d) => d.state === 'dead' || d.state === 'cancelled').map((d) => `${d.key as string} is ${d.state as string}`);
          return { ref: t.ref, kind: 'task', title: t.title, state: t.state, stale: t.stale, blocked: t.state === 'blocked' && blockedBy.length > 0 || t.sideEffect === 'uncertain', staleReasons: [...t.staleReasons, ...blockedBy, ...(t.sideEffect === 'uncertain' ? ['an external side effect has an unknown outcome and awaits reconciliation'] : []), ...(t.pauseReason === null ? [] : [t.pauseReason])],
            versions: [], sources: [uref('E00', 'run', t.runId), uref('E00', 'objective', t.objectiveId), ...deps.map((d) => uref('E00', 'task', d.id as string)), ...t.refs], dependents: dependents.map((d) => uref('E00', 'task', d.id as string)), permissions: [], decisions: t.decidedBy === null ? [] : [{ decidedBy: t.decidedBy }], history: await history(), data: t as unknown as Json };
        }
        if (parsed.kind === 'objective') {
          const o = await engine.getObjective(ctx, parsed.id);
          const runs = await sql.query(`select id from ${S}.runs where objective_id=$1`, [o.id]);
          return { ref: o.ref, kind: 'objective', title: o.title, state: o.status, stale: false, blocked: false, staleReasons: [], versions: [], sources: o.subject === null ? [] : [o.subject], dependents: runs.map((r) => uref('E00', 'run', r.id as string)), permissions: [], decisions: o.directives as unknown as Json[], history: await history(), data: o as unknown as Json };
        }
        if (parsed.kind === 'run') {
          const r = await engine.getRun(ctx, parsed.id);
          return { ref: r.ref, kind: 'run', title: r.workflowKey ?? 'ad-hoc run', state: r.status, stale: r.tasks.some((t) => t.stale), blocked: false, staleReasons: [], versions: [], sources: [uref('E00', 'objective', r.objectiveId)], dependents: r.tasks.map((t) => t.ref), permissions: [], decisions: [], history: await history(), data: { ...r, tasks: r.tasks.map((t) => ({ ref: t.ref, key: t.key, state: t.state, dependsOn: t.dependsOn })) } as unknown as Json };
        }
        if (parsed.kind === 'agent') {
          const a = await loadAgent(sql, ctx, parsed.id);
          const work = await sql.query(`select id from ${S}.tasks where assigned_agent=$1 order by updated_at desc limit 100`, [a.id]);
          return { ref: a.ref, kind: 'agent', title: a.name, state: a.status, stale: false, blocked: false, staleReasons: [], versions: [], sources: [], dependents: work.map((w) => uref('E00', 'task', w.id as string)), permissions: [], decisions: [], history: await history(), data: a as unknown as Json };
        }
      } catch (error) { if (error instanceof DomainError && error.code === 'not_found') return null; throw error; }
      return null;
    },
    async search(ctx: ServiceContext, query: { q: string; limit?: number }): Promise<SearchHit[]> {
      requireCapability(ctx, 'orchestration:read');
      const like = `%${query.q.replaceAll(/[%_\\]/g, (m) => `\\${m}`)}%`; const limit = Math.min(query.limit ?? 20, 100);
      const o = await sql.query(`select id, title, description, status from ${S}.objectives where tenant_id=$1 and project_id=$2 and (title ilike $3 or description ilike $3) limit ${limit}`, [...scopeArgs(ctx), like]);
      const t = await sql.query(`select id, title, summary, state from ${S}.tasks where tenant_id=$1 and project_id=$2 and (title ilike $3 or summary ilike $3) limit ${limit}`, [...scopeArgs(ctx), like]);
      return [...o.map((r) => ({ ref: uref('E00', 'objective', r.id as string), kind: 'objective', title: r.title as string, snippet: (r.description as string).slice(0, 200), state: r.status as string })),
        ...t.map((r) => ({ ref: uref('E00', 'task', r.id as string), kind: 'task', title: r.title as string, snippet: ((r.summary as string | null) ?? '').slice(0, 200), state: r.state as string }))].slice(0, limit);
    },
    async audit(ctx: ServiceContext, options: { after?: string; limit?: number; subject?: string } = {}): Promise<AuditRecord[]> { requireCapability(ctx, 'orchestration:read'); return listAudit(sql, S, ctx, options); },
    async events(ctx: ServiceContext, options: { after?: string; limit?: number } = {}): Promise<EngineEvent[]> { requireCapability(ctx, 'orchestration:events'); return readEvents(sql, S, { ...options, tenantId: ctx.tenantId }); },
    /** Tasks whose inputs or outputs reference a changed object are flagged stale (never rewritten), so operators can re-run them. */
    async applyUpstreamChange(ctx: ServiceContext, change: UpstreamChange): Promise<{ affected: string[] }> {
      requireCapability(ctx, 'orchestration:write');
      return sql.tx(async (tx) => {
        const first = await tx.query(`insert into ${S}.applied_changes (tenant_id, event_id) values ($1,$2) on conflict do nothing returning event_id`, [ctx.tenantId, change.eventId]);
        const bare = change.refs.map((r) => { const p = parseUref(r); return `${p.engine}:${p.kind}:${p.id}`; });
        const rows = await tx.query(`select id, refs, stale_reasons from ${S}.tasks where tenant_id=$1 and project_id=$2 and exists (select 1 from unnest(refs) x where split_part(x,'@',1) = any($3))`, [...scopeArgs(ctx), bare]);
        const affected = rows.filter((r) => (r.refs as string[]).some((x) => change.refs.some((c) => urefMatches(c, x))));
        if (first.length === 0) return { affected: affected.map((r) => uref('E00', 'task', r.id as string)) };
        for (const r of affected) {
          const reason = `${change.kind}: ${change.reason}`;
          await tx.query(`update ${S}.tasks set stale=true, stale_reasons=array_append(stale_reasons, $2), updated_at=$3 where id=$1`, [r.id, reason, ctx.now]);
          await emitEvent(tx, S, ctx, 'orchestration.task_stale', uref('E00', 'task', r.id as string), { reason, cause: change.eventId });
        }
        return { affected: affected.map((r) => uref('E00', 'task', r.id as string)) };
      });
    },
    async health(): Promise<{ ok: boolean; detail: Json }> {
      try { const r = (await sql.query<{ n: string }>(`select count(*) as n from ${S}.tasks where state='leased'`))[0] as { n: string }; return { ok: true, detail: { running: Number(r.n), maxConcurrency, actions: Object.keys(actions).length } }; }
      catch (error) { return { ok: false, detail: { error: error instanceof Error ? error.message : 'unavailable' } }; }
    },
  };

  /** Finishes a leased task only if this worker still holds the same lease generation. */
  async function finish(task: Task, worker: string, set: string, params: unknown[], after: (tx: Sql, ctx: ServiceContext) => Promise<void>, ctx: ServiceContext): Promise<boolean> {
    return sql.tx(async (tx) => {
      const rows = await tx.query(`update ${S}.tasks set ${set}, lease_owner=null, lease_until=null, updated_at=now() where id=$1 and state='leased' and lease_owner=$2 and generation=$3 returning id`, [task.id, worker, task.generation, ...params]);
      if (rows.length === 0) return false;
      await after(tx, ctx);
      await settleRun(tx, task.runId, ctx);
      return true;
    });
  }

  async function executeTask(task: Task, worker: string): Promise<void> {
    const started = Date.now();
    const scope: Scope = { tenantId: task.tenantId, projectId: task.projectId };
    const requestId = `task-${task.id}-${task.generation}`;
    const fallback: ServiceContext = { ...scope, purpose: 'orchestration', requestId, now: new Date().toISOString(), actor: { id: 'pam-orchestrator', kind: 'service', roles: [] }, capabilities: [], compartments: [] };
    let ctx = fallback;
    let reservation: string | null = null;
    const held = (): Promise<Record<string, unknown>[]> => sql.query(`select 1 from ${S}.tasks where id=$1 and state='leased' and lease_owner=$2 and generation=$3`, [task.id, worker, task.generation]);
    try {
      const definition = actions[task.action];
      if (definition === undefined) throw new DomainError('invalid_input', `Unknown action ${task.action}`);
      const agent = task.assignedAgent === null ? null : await loadAgent(sql, scope, task.assignedAgent);
      // Authority comes from identity, never from task input or model output. Without a context port the engine fails closed.
      if (ports.agentContext !== undefined) ctx = await ports.agentContext.contextFor({ scope, agent, purpose: `orchestration:${task.action}`, requestId, taskRef: task.ref });
      else if (deps.config?.standaloneContexts === true) ctx = { ...fallback, actor: agent === null ? fallback.actor : { id: agent.identityActorId, kind: 'agent', roles: [agent.role] }, capabilities: [...new Set(Object.values(actions).flatMap((a) => a.requires))].concat(['orchestration:read', 'orchestration:write']) };
      else throw new DomainError('forbidden', 'No agent context port is configured; refusing to execute');
      for (const capability of definition.requires) {
        requireCapability(ctx, capability);
        if (ports.authorization !== undefined) {
          const decision = await ports.authorization.authorize(ctx, { capability, resource: task.ref });
          if (!decision.allowed) throw new DomainError('forbidden', `Not authorized for ${capability}: ${decision.reason}`);
        }
      }
      const estimate = definition.estimate?.(task.input);
      if (estimate !== undefined && ports.budget !== undefined) reservation = (await ports.budget.reserve(ctx, { ...estimate, subject: task.ref, idempotencyKey: `e00-task-${task.id}-${task.generation}` })).reservationId;
      const runCtx = ctx;
      const actionContext: ActionContext = {
        ctx: runCtx, task, agent, attempt: task.attempts, recovering: task.sideEffect === 'uncertain', checkpoint: task.checkpoint,
        async saveCheckpoint(data) {
          const rows = await sql.query(`update ${S}.tasks set checkpoint=$4::jsonb, lease_until=$5, updated_at=now() where id=$1 and state='leased' and lease_owner=$2 and generation=$3 returning id`, [task.id, worker, task.generation, JSON.stringify(data), new Date(Date.now() + leaseMs).toISOString()]);
          if (rows.length === 0) throw new DomainError('lease_lost', 'Task was paused, cancelled, reassigned or re-leased');
        },
        async beginSideEffect() {
          const rows = await sql.query(`update ${S}.tasks set side_effect='started', updated_at=now() where id=$1 and state='leased' and lease_owner=$2 and generation=$3 returning id`, [task.id, worker, task.generation]);
          if (rows.length === 0) throw new DomainError('lease_lost', 'Task was paused, cancelled, reassigned or re-leased');
        },
        async confirmSideEffect() { await sql.query(`update ${S}.tasks set side_effect='confirmed', updated_at=now() where id=$1 and generation=$2`, [task.id, task.generation]); },
        async spawn(tasks) {
          if ((await held()).length === 0) throw new DomainError('lease_lost', 'Task was paused, cancelled, reassigned or re-leased');
          await sql.tx(async (tx) => { const run = await loadRun(tx, scope, task.runId, true); const o = await loadObjective(tx, scope, task.objectiveId); await insertTasks(tx, runCtx, o, run, tasks, runCtx.actor.kind === 'human' ? 'authorized' : 'proposed'); });
        },
        async remember(entry) { if (agent !== null) await engine.remember({ ...runCtx, capabilities: [...runCtx.capabilities, 'orchestration:write'] }, agent.id, { ...entry, taskId: task.id }); },
        async recall(query) { return agent === null ? [] : engine.recall({ ...runCtx, capabilities: [...runCtx.capabilities, 'orchestration:read'] }, agent.id, query); },
      };
      const result = await definition.run(actionContext);
      const activeMs = Date.now() - started;
      if (reservation !== null && ports.budget !== undefined) { await ports.budget.commit(ctx, reservation, { amount: result.cost?.amount ?? estimate?.amount ?? 0, ...(result.cost?.detail === undefined ? {} : { detail: result.cost.detail }) }); reservation = null; }
      const published = await finish(task, worker, `state='done', output=$4::jsonb, summary=$5, refs=(select array(select distinct unnest(refs || $6::text[]))), cost=$7::jsonb, active_ms=active_ms+$8, error=null, side_effect=case when side_effect='started' then 'confirmed' else side_effect end, finished_at=now()`,
        [JSON.stringify(result.output ?? null), result.summary ?? null, [...(result.refs ?? [])], JSON.stringify(result.cost ?? {}), activeMs], async (tx, c) => {
          await appendAudit(tx, S, c, 'task.done', task.ref, { attempt: task.attempts, activeMs });
          await emitEvent(tx, S, c, 'orchestration.task_done', task.ref, { action: task.action });
          if (agent !== null) await tx.query(`insert into ${S}.agent_memory (id, tenant_id, project_id, agent_id, kind, key, content, sources, task_id, created_at) values ($1,$2,$3,$4,'work_record',$5,$6::jsonb,$7,$8,now())`,
            [randomUUID(), task.tenantId, task.projectId, agent.id, `${task.action}: ${task.title}`, JSON.stringify({ summary: result.summary ?? null, action: task.action }), [...(result.refs ?? [])], task.id]);
        }, { ...ctx, now: new Date().toISOString() });
      if (published && ports.work !== undefined) {
        try { await ports.work.recordWork(ctx, { taskRef: task.ref, objectiveRef: uref('E00', 'objective', task.objectiveId), lane: task.lane, agentRef: agent?.ref ?? null, startedAt: new Date(started).toISOString(), endedAt: new Date().toISOString(), activeMs }); } catch { /* accounting failure must not undo completed work; it is visible as missing effort data */ }
      }
    } catch (error) {
      const activeMs = Date.now() - started;
      const now = { ...ctx, now: new Date().toISOString() };
      if (reservation !== null && ports.budget !== undefined) { try { await ports.budget.release(ctx, reservation, 'task did not complete'); } catch { /* reservation expires on its own */ } }
      if (error instanceof DomainError && error.code === 'lease_lost') return;
      const code = error instanceof DomainError ? error.code : 'error';
      const message = (error instanceof DomainError ? `${error.code}: ${error.message}` : error instanceof Error ? error.message : String(error)).slice(0, 2000);
      if (code === 'budget_exhausted') {
        // Graceful exhaustion: the task waits, visibly, for an operator to raise the budget or cancel. It is not retried in a loop.
        await finish(task, worker, `state='paused', paused_from='ready', pause_reason=$4, error=$5, attempts=greatest(attempts-1,0), active_ms=active_ms+$6`, [`budget exhausted`, message, activeMs], async (tx, c) => {
          await appendAudit(tx, S, c, 'task.paused_budget', task.ref, {}); await emitEvent(tx, S, c, 'orchestration.budget_exhausted', task.ref, { action: task.action });
        }, now);
        return;
      }
      const permanent = ['forbidden', 'unauthenticated', 'invalid_input', 'not_found', 'policy_denied', 'consent_denied', 'grant_invalid'].includes(code);
      if (permanent || task.attempts >= task.maxAttempts) {
        await finish(task, worker, `state='dead', error=$4, active_ms=active_ms+$5, side_effect=case when side_effect='started' then 'uncertain' else side_effect end, finished_at=now()`, [message, activeMs], async (tx, c) => {
          await appendAudit(tx, S, c, 'task.dead', task.ref, { attempt: task.attempts, code }); await emitEvent(tx, S, c, 'orchestration.task_dead', task.ref, { action: task.action, code });
        }, now);
      } else {
        const delay = Math.min(retryBaseMs * 2 ** (task.attempts - 1), 30 * 60_000);
        await finish(task, worker, `state='ready', error=$4, run_at=$5, active_ms=active_ms+$6, side_effect=case when side_effect='started' then 'uncertain' else side_effect end`, [message, new Date(Date.now() + delay).toISOString(), activeMs], async (tx, c) => {
          await appendAudit(tx, S, c, 'task.failed', task.ref, { attempt: task.attempts, code }); await emitEvent(tx, S, c, 'orchestration.task_failed', task.ref, { action: task.action, code, retryInMs: delay });
        }, now);
      }
    }
  }

  return engine satisfies StandardEngine & Record<string, unknown>;
}

export function routes(engine: OrchestrationEngine): Route[] {
  const b = <T>(body: unknown): T => { invariant(body !== null && typeof body === 'object', 'invalid_input', 'JSON body required'); return body as T; };
  return [
    ...standardRoutes(engine),
    { method: 'GET', path: '/v1/overview', handler: async (r) => (await engine.overview(r.ctx)) as unknown as Json },
    { method: 'GET', path: '/v1/actions', handler: async (r) => engine.listActions(r.ctx) as unknown as Json },
    { method: 'GET', path: '/v1/objectives', handler: async (r) => (await engine.listObjectives(r.ctx)) as unknown as Json },
    { method: 'POST', path: '/v1/objectives', handler: async (r) => (await engine.createObjective(r.ctx, b(r.body))) as unknown as Json },
    { method: 'GET', path: '/v1/objectives/:id', handler: async (r) => (await engine.getObjective(r.ctx, r.params.id as string)) as unknown as Json },
    { method: 'POST', path: '/v1/objectives/:id/directives', handler: async (r) => { await engine.addDirective(r.ctx, r.params.id as string, b<{ body: string }>(r.body).body); return {}; } },
    { method: 'POST', path: '/v1/objectives/:id/status', handler: async (r) => { const x = b<{ status: ObjectiveStatus; reason?: string }>(r.body); return (await engine.setObjectiveStatus(r.ctx, r.params.id as string, x.status, x.reason)) as unknown as Json; } },
    { method: 'GET', path: '/v1/workflows', handler: async (r) => (await engine.listWorkflows(r.ctx)) as unknown as Json },
    { method: 'POST', path: '/v1/workflows', handler: async (r) => (await engine.registerWorkflow(r.ctx, b(r.body))) as unknown as Json },
    { method: 'GET', path: '/v1/agents', handler: async (r) => (await engine.listAgents(r.ctx)) as unknown as Json },
    { method: 'POST', path: '/v1/agents', handler: async (r) => (await engine.createAgent(r.ctx, b(r.body))) as unknown as Json },
    { method: 'POST', path: '/v1/agents/:id/status', handler: async (r) => (await engine.setAgentStatus(r.ctx, r.params.id as string, b<{ status: Agent['status'] }>(r.body).status)) as unknown as Json },
    { method: 'GET', path: '/v1/agents/:id/memory', handler: async (r) => { const q = r.query.get('q'); return (await engine.recall(r.ctx, r.params.id as string, q === null ? {} : { q })) as unknown as Json; } },
    { method: 'GET', path: '/v1/runs', handler: async (r) => { const o = r.query.get('objectiveId'); return (await engine.listRuns(r.ctx, o === null ? {} : { objectiveId: o })) as unknown as Json; } },
    { method: 'POST', path: '/v1/runs', handler: async (r) => (await engine.startRun(r.ctx, b(r.body))) as unknown as Json },
    { method: 'GET', path: '/v1/runs/:id', handler: async (r) => (await engine.getRun(r.ctx, r.params.id as string)) as unknown as Json },
    { method: 'POST', path: '/v1/runs/:id/tasks', handler: async (r) => { const x = b<{ tasks: NewTask[]; proposed?: boolean }>(r.body); return (await (x.proposed === true ? engine.proposeTasks(r.ctx, r.params.id as string, x.tasks) : engine.addTasks(r.ctx, r.params.id as string, x.tasks))) as unknown as Json; } },
    { method: 'GET', path: '/v1/tasks', handler: async (r) => { const o = r.query.get('objectiveId'); const run = r.query.get('runId'); const s = r.query.get('states'); return (await engine.listTasks(r.ctx, { ...(o === null ? {} : { objectiveId: o }), ...(run === null ? {} : { runId: run }), ...(s === null ? {} : { states: s.split(',') as TaskState[] }) })) as unknown as Json; } },
    { method: 'GET', path: '/v1/tasks/:id', handler: async (r) => (await engine.getTask(r.ctx, r.params.id as string)) as unknown as Json },
    { method: 'POST', path: '/v1/tasks/:id/control', handler: async (r) => { const x = b<{ action: 'pause' | 'resume' | 'cancel' | 'retry'; reason?: string }>(r.body); return (await engine.controlTask(r.ctx, r.params.id as string, x.action, x.reason)) as unknown as Json; } },
    { method: 'POST', path: '/v1/tasks/:id/decision', handler: async (r) => { const x = b<{ decision: 'approve' | 'reject'; reason?: string }>(r.body); return (await engine.decideTask(r.ctx, r.params.id as string, x.decision, x.reason)) as unknown as Json; } },
    { method: 'POST', path: '/v1/tasks/:id/assignment', handler: async (r) => (await engine.reassignTask(r.ctx, r.params.id as string, b<{ agentId: string | null }>(r.body).agentId)) as unknown as Json },
  ];
}
