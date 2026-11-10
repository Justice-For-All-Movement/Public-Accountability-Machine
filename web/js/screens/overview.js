// Overview: engine status, orchestration overview, budget summary.
import { api, appApi } from '../api.js';
import { h, region, section, table, listOrEmpty, renderEmpty, dl, badge } from '../ui.js';

export function flattenBudgets(nodes, depth = 0, out = []) {
  for (const n of Array.isArray(nodes) ? nodes : []) { out.push({ ...n, depth }); flattenBudgets(n.children, depth + 1, out); }
  return out;
}
const minutes = (ms) => `${(Number(ms) / 60000).toFixed(1)} min`;

export async function render(el, ctx) {
  const engines = region('Engines'); const orch = region('Orchestration'); const budgets = region('Budgets');
  el.append(engines.el, orch.el, budgets.el);
  section(engines.body, async () => ({ status: await appApi('/v1/status'), overview: await api('workspace', '/v1/overview', { purpose: ctx.purpose }).catch((e) => ({ error: e })) }), ({ status, overview }, body) => {
    const detail = new Map((overview.engines ?? []).map((e) => [e.engine, e]));
    table(body, { caption: 'Engine availability in this deployment', rows: status.engines, columns: [
      { key: 'id', label: 'Engine' }, { key: 'short', label: 'Name' },
      { key: 'available', label: 'State', render: (r) => { const d = detail.get(r.id); const s = !r.available ? 'unavailable' : d?.status === 'degraded' ? 'stale' : 'ok'; return badge(s, { label: !r.available ? 'unavailable' : d?.status ?? 'running', reasons: d?.reason ? [d.reason] : [] }); } },
      { key: 'counts', label: 'Reported counts', sortable: false, render: (r) => { const c = detail.get(r.id)?.counts; return c && Object.keys(c).length > 0 ? h('span', { text: Object.entries(c).map(([k, v]) => `${k}: ${v}`).join(', ') }) : h('span', { class: 'ws-muted', text: '—' }); } },
    ] });
    if (overview.error) body.append(h('p', { class: 'ws-notice ws-notice--warn', text: `Workspace overview unavailable: ${overview.error.message}` }));
  });
  section(orch.body, () => api('orchestration', '/v1/overview', { purpose: ctx.purpose }), (o, body) => {
    const totalTasks = Object.values(o.tasks ?? {}).reduce((a, b) => a + Number(b), 0);
    body.append(dl([
      ['Objectives by status', Object.keys(o.objectives ?? {}).length ? Object.entries(o.objectives).map(([k, v]) => `${k}: ${v}`).join(', ') : 'none'],
      ['Tasks by state', totalTasks ? Object.entries(o.tasks).map(([k, v]) => `${k}: ${v}`).join(', ') : 'none'],
      ['Running now', String(o.running?.length ?? 0)], ['Failures', String(o.failures?.length ?? 0)], ['Awaiting approval', String(o.awaitingApproval?.length ?? 0)], ['Stale tasks', String(o.stale ?? 0)],
    ]));
    const taskCols = [{ key: 'ref', label: 'Task' }, { key: 'title', label: 'Title' }, { key: 'state', label: 'State' }, { key: 'lane', label: 'Lane' }, { key: 'error', label: 'Error' }];
    for (const [key, caption] of [['running', 'Running tasks'], ['failures', 'Failures'], ['awaitingApproval', 'Awaiting approval']]) if ((o[key] ?? []).length > 0) table(body, { caption, rows: o[key], columns: taskCols });
    const lanes = Object.entries(o.activeMsByLane ?? {}).map(([lane, ms]) => ({ lane, ms, active: minutes(ms) }));
    if (lanes.length > 0) table(body, { caption: 'Measured active time by research lane', rows: lanes, columns: [{ key: 'lane', label: 'Lane' }, { key: 'active', label: 'Active time' }] });
    if (totalTasks === 0) renderEmpty(body.appendChild(h('div', {})), 'No orchestration work yet', 'Create an objective and start a run under Objectives & agents.');
  });
  section(budgets.body, () => api('resources', '/v1/budgets', { purpose: ctx.purpose }), (tree, body) => {
    listOrEmpty(body, flattenBudgets(tree), 'No budgets', 'Budgets are created under Resources.', { caption: 'Budgets', columns: [
      { key: 'name', label: 'Budget', render: (r) => h('span', { text: `${'— '.repeat(r.depth)}${r.name}` }) }, { key: 'unit', label: 'Unit' }, { key: 'ceiling', label: 'Ceiling', numeric: true },
      { key: 'reserved', label: 'Reserved', numeric: true }, { key: 'committed', label: 'Committed', numeric: true }, { key: 'available', label: 'Available', numeric: true }, { key: 'state', label: 'State' }] });
  });
}
