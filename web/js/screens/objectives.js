// Objectives, runs, task board and agents (E00 orchestration). Task and objective controls go through the workspace
// control surface (E14), which records every attempt and outcome.
import { TaskBoard, ControlBar } from '/engines/workspace/web/index.js';
import { api } from '../api.js';
import { h, clear, region, section, table, renderEmpty, form, dl, ref, announce, renderError } from '../ui.js';

const list = (s) => (s ?? '').split(',').map((x) => x.trim()).filter(Boolean);
export const taskDisplayState = (t) => (t.state === 'dead' || t.sideEffect === 'uncertain' ? 'failed' : t.stale ? 'stale' : 'ok');

export async function render(el, ctx) {
  const id = ctx.params.get('id');
  if (id) return objectiveDetail(el, ctx, id);
  const objectives = region('Objectives'); const create = region('New objective'); const agents = region('Agents'); const createAgent = region('New agent');
  el.append(objectives.el, create.el, agents.el, createAgent.el);
  const reload = section(objectives.body, () => api('orchestration', '/v1/objectives', { purpose: ctx.purpose }), (rows, body) => {
    if (rows.length === 0) { renderEmpty(body.appendChild(h('div', {})), 'No objectives yet', 'Create the first objective below.'); return; }
    table(body, { caption: `Objectives (${rows.length})`, rows, rowHeader: 'title', columns: [
      { key: 'title', label: 'Objective', render: (r) => h('a', { href: `/objectives?id=${r.id}`, 'data-nav': true }, r.title) },
      { key: 'status', label: 'Status' }, { key: 'lane', label: 'Lane' }, { key: 'policy', label: 'Policy' }, { key: 'ref', label: 'Reference', render: (r) => ref(r.ref) }, { key: 'createdAt', label: 'Created' }] });
  });
  create.body.append(form({ legend: 'Objective', submit: 'Create objective', fields: [
    { name: 'title', label: 'Title', required: true }, { name: 'description', label: 'Description', type: 'textarea', required: true },
    { name: 'lane', label: 'Research lane', help: 'Effort is measured per lane (never outcome quotas).' },
    { name: 'allowedActions', label: 'Allowed actions (comma separated; empty = any registered action)' },
    { name: 'approvalRequired', label: 'Actions that need human approval (comma separated)' },
    { name: 'maxTasks', label: 'Maximum number of tasks', type: 'number', min: 1 },
    { name: 'autoAcceptProposals', label: 'Accept tasks proposed by agents without review', type: 'checkbox' }],
    onSubmit: async (v) => {
      const policy = { ...(list(v.allowedActions).length ? { allowedActions: list(v.allowedActions) } : {}), ...(list(v.approvalRequired).length ? { approvalRequired: list(v.approvalRequired) } : {}), ...(v.maxTasks ? { maxTasks: v.maxTasks } : {}), ...(v.autoAcceptProposals ? { autoAcceptProposals: true } : {}) };
      const o = await api('orchestration', '/v1/objectives', { purpose: ctx.purpose, body: { title: v.title, description: v.description, ...(v.lane ? { lane: v.lane } : {}), policy } });
      void reload();
      return `Objective created: ${o.title}.`;
    } }));
  const reloadAgents = section(agents.body, () => api('orchestration', '/v1/agents', { purpose: ctx.purpose }), (rows, body) => {
    if (rows.length === 0) { renderEmpty(body.appendChild(h('div', {})), 'No agents yet', 'An agent needs an identity agent (Administration) and a role.'); return; }
    const memory = h('div', {});
    table(body, { caption: `Agents (${rows.length})`, rows, rowHeader: 'name', columns: [{ key: 'name', label: 'Agent' }, { key: 'role', label: 'Role' }, { key: 'status', label: 'Status' }, { key: 'maxConcurrent', label: 'Max concurrent', numeric: true }, { key: 'identityActorId', label: 'Identity actor' },
      { key: 'memory', label: 'Memory', sortable: false, render: (r) => h('button', { type: 'button', class: 'ws-button', onClick: () => showMemory(memory, ctx, r) }, `Show memory of ${r.name}`) }] });
    body.append(memory);
  });
  createAgent.body.append(h('div', {}, await agentForm(ctx, () => reloadAgents())));
}

async function agentForm(ctx, done) {
  let identities = [];
  try { identities = await api('identity', '/v1/agents', { purpose: ctx.purpose }); } catch { identities = []; }
  return form({ legend: 'Agent', submit: 'Create agent', fields: [
    { name: 'name', label: 'Name', required: true }, { name: 'role', label: 'Role on the task board (for example researcher)', required: true },
    identities.length > 0 ? { name: 'identityActorId', label: 'Identity agent', type: 'select', required: true, options: identities.map((a) => ({ value: a.id, label: `${a.displayName ?? a.name ?? a.id}` })) }
      : { name: 'identityActorId', label: 'Identity agent id', required: true, help: 'No identity agents are visible to you; create one under Administration.' },
    { name: 'maxConcurrent', label: 'Maximum concurrent tasks', type: 'number', min: 1, value: '1' }],
    onSubmit: async (v) => { const a = await api('orchestration', '/v1/agents', { purpose: ctx.purpose, body: { name: v.name, role: v.role, identityActorId: v.identityActorId, ...(v.maxConcurrent ? { maxConcurrent: v.maxConcurrent } : {}) } }); done(); return `Agent created: ${a.name}.`; } });
}

function showMemory(el, ctx, agent) {
  clear(el);
  const r = region(`Memory of ${agent.name}`, 3); el.append(r.el);
  section(r.body, () => api('orchestration', `/v1/agents/${agent.id}/memory`, { purpose: ctx.purpose }), (rows, body) => {
    if (rows.length === 0) { renderEmpty(body.appendChild(h('div', {})), 'No memory entries', 'The agent has not recorded notes or work yet.'); return; }
    table(body, { caption: `Memory entries (${rows.length})`, rows, columns: [{ key: 'kind', label: 'Kind' }, { key: 'key', label: 'Key' }, { key: 'content', label: 'Content' }, { key: 'sources', label: 'Sources' }, { key: 'createdAt', label: 'Recorded' }] });
  });
  r.el.querySelector('h3').setAttribute('tabindex', '-1'); r.el.querySelector('h3').focus();
}

async function objectiveDetail(el, ctx, id) {
  el.append(h('p', {}, h('a', { href: '/objectives', 'data-nav': true }, 'Back to all objectives')));
  const head = region('Objective'); const board = region('Task board'); const runs = region('Runs'); const start = region('Start a run');
  el.append(head.el, board.el, start.el, runs.el);
  let reloadBoard = () => {};
  section(head.body, () => api('orchestration', `/v1/objectives/${id}`, { purpose: ctx.purpose }), (o, body) => {
    const obj = o.objective ?? o;
    body.append(dl([['Title', obj.title], ['Description', obj.description], ['Status', obj.status], ['Lane', obj.lane], ['Policy', obj.policy], ['Reference', ref(obj.ref)]]));
    const holder = h('div', {}); body.append(holder);
    void controlsFor(ctx, [obj.ref]).then((c) => ControlBar(holder, { ref: obj.ref, controls: c[obj.ref] ?? [], label: 'Objective controls', onInvoke: invoker(ctx, () => { reloadBoard(); }) })).catch((e) => renderError(holder, e));
    body.append(form({ legend: 'Add a directive for the agents', submit: 'Add directive', fields: [{ name: 'body', label: 'Directive', type: 'textarea', required: true }], onSubmit: async (v) => { await api('orchestration', `/v1/objectives/${id}/directives`, { purpose: ctx.purpose, body: { body: v.body } }); return 'Directive recorded.'; } }));
  });
  const boardHolder = h('div', {}); board.body.append(boardHolder);
  let boardHandle = null; let focusRef = null;
  reloadBoard = (refToFocus = null) => { focusRef = refToFocus; return section(boardHolder, async () => {
    const tasks = await api('orchestration', '/v1/tasks', { purpose: ctx.purpose, query: { objectiveId: id } });
    return { tasks, controls: await controlsFor(ctx, tasks.map((t) => t.ref)) };
  }, ({ tasks, controls }, body) => {
    if (boardHandle) boardHandle.destroy();
    body.append(h('div', { class: 'pam-toolbar' }, h('button', { type: 'button', class: 'ws-button', onClick: () => reloadBoard() }, 'Refresh board')));
    if (tasks.length === 0) { renderEmpty(body.appendChild(h('div', {})), 'No tasks yet', 'Start a run below.'); return; }
    const byKey = new Map(); for (const t of tasks) { byKey.set(`${t.runId}:${t.key}`, t); byKey.set(t.id, t); }
    const edges = tasks.flatMap((t) => t.dependsOn.map((d) => byKey.get(`${t.runId}:${d}`) ?? byKey.get(d)).filter(Boolean).map((dep) => ({ from: t.ref, to: dep.ref, relation: 'source' })));
    const items = tasks.map((t) => ({ ref: t.ref, title: `${t.title} (${t.action})`, state: taskDisplayState(t), engineState: t.state, staleReasons: [...(t.staleReasons ?? []), ...(t.pauseReason ? [t.pauseReason] : []), ...(t.error ? [t.error] : [])] }));
    const holder = h('div', {}); body.append(holder);
    boardHandle = TaskBoard(holder, { items, edges, controlsByRef: controls, headingLevel: 3, onSelect: (r) => import('../ui.js').then((m) => m.openInspector(r)), onInvoke: invoker(ctx, (r) => reloadBoard(r)) });
    // After a control, keep keyboard focus on the same task in its new column.
    if (focusRef) { const card = [...holder.querySelectorAll('.ws-card')].find((c) => c.dataset.ref === focusRef); card?.querySelector('.ws-link')?.focus(); focusRef = null; }
  }); };
  reloadBoard();
  const reloadRuns = section(runs.body, () => api('orchestration', '/v1/runs', { purpose: ctx.purpose, query: { objectiveId: id } }), (rows, body) => {
    if (rows.length === 0) { renderEmpty(body.appendChild(h('div', {})), 'No runs yet', 'Start a run from a workflow or with ad-hoc tasks.'); return; }
    table(body, { caption: `Runs (${rows.length})`, rows, columns: [{ key: 'ref', label: 'Run' }, { key: 'status', label: 'Status' }, { key: 'workflowKey', label: 'Workflow' }, { key: 'lane', label: 'Lane' }, { key: 'startedAt', label: 'Started' }, { key: 'finishedAt', label: 'Finished' }] });
  });
  const [workflows, actions] = await Promise.all([api('orchestration', '/v1/workflows', { purpose: ctx.purpose }).catch(() => []), api('orchestration', '/v1/actions', { purpose: ctx.purpose }).catch(() => [])]);
  start.body.append(h('p', { class: 'pam-intro', text: actions.length === 0 ? 'No actions are registered in this deployment, so no task can run yet.' : `Registered actions: ${actions.map((a) => a.name).join(', ')}.` }));
  start.body.append(form({ legend: 'Run', submit: 'Start run', fields: [
    { name: 'workflowKey', label: 'Workflow', type: 'select', options: [{ value: '', label: '(none: ad-hoc tasks below)' }, ...workflows.map((w) => ({ value: w.key, label: `${w.title || w.key} (v${w.version})` }))] },
    { name: 'tasks', label: 'Ad-hoc tasks, one per line: key, action, keys it depends on (space separated)', type: 'textarea', rows: 4, placeholder: 'collect, discovery.collect\nreview, knowledge.review, collect', help: actions.length ? `Actions: ${actions.map((a) => a.name).join(', ')}` : undefined },
    { name: 'lane', label: 'Lane (optional; defaults to the objective lane)' }],
    onSubmit: async (v) => {
      const tasks = v.tasks.split('\n').map((l) => l.trim()).filter(Boolean).map((line) => { const [key, action, deps] = line.split(',').map((x) => (x ?? '').trim()); return { key, title: key, action, ...(deps ? { dependsOn: deps.split(/\s+/).filter(Boolean) } : {}) }; });
      if (!v.workflowKey && tasks.length === 0) throw new Error('Choose a workflow or enter at least one task.');
      const run = await api('orchestration', '/v1/runs', { purpose: ctx.purpose, body: { objectiveId: id, ...(v.workflowKey ? { workflowKey: v.workflowKey } : { tasks }), ...(v.lane ? { lane: v.lane } : {}) } });
      void reloadRuns(); reloadBoard();
      return `Run started with ${run.tasks?.length ?? 0} tasks.`;
    } }));
}

async function controlsFor(ctx, refs) {
  const out = {};
  await Promise.all(refs.map(async (r) => { const c = await api('workspace', '/v1/controls', { purpose: ctx.purpose, query: { ref: r } }); out[r] = c.controls ?? []; }));
  return out;
}
function invoker(ctx, after) {
  return async (r, controlId, input, { confirm }) => {
    const out = await api('workspace', '/v1/controls/invoke', { purpose: ctx.purpose, body: { ref: r, controlId, input, confirm } });
    announce(`${controlId}: ${out.outcome}.`);
    setTimeout(() => after(r), 50);
    return out;
  };
}
