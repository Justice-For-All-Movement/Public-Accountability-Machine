// Overview: engine status, orchestration overview, budget summary.
import { api, appApi } from '../api.js';
import { h, region, section, table, listOrEmpty, renderEmpty, dl, badge, ref, action } from '../ui.js';

export function flattenBudgets(nodes, depth = 0, out = []) {
  for (const n of Array.isArray(nodes) ? nodes : []) { out.push({ ...n, depth }); flattenBudgets(n.children, depth + 1, out); }
  return out;
}
const minutes = (ms) => `${(Number(ms) / 60000).toFixed(1)} min`;

export async function render(el, ctx) {
  const attention = region('Needs attention', 2, 'Items that became stale, blocked, failed, uncertain or unanswered, or need a review. Only items you are allowed to see are listed. Acknowledging hides an item for you; it changes nothing in the engines.');
  const engines = region('Engines'); const orch = region('Orchestration'); const budgets = region('Budgets');
  el.append(attention.el, engines.el, orch.el, budgets.el);
  const reloadAlerts = section(attention.body, () => appApi('/v1/alerts', { purpose: ctx.purpose }), (out, body) => {
    const label = (t) => t.replace(/^[a-z]+\./, '').replaceAll('_', ' ');
    listOrEmpty(body, out.items, 'Nothing needs attention', 'Nothing is stale, blocked, failed, uncertain or unanswered in this project.', { caption: `Needs attention (as of ${new Date(out.generatedAt).toLocaleString()})`, columns: [
      { key: 'at', label: 'When', render: (r) => h('time', { datetime: r.at, text: new Date(r.at).toLocaleString() }) },
      { key: 'type', label: 'What happened', render: (r) => h('span', { text: label(r.type) }) },
      { key: 'subject', label: 'Item', sortable: false, render: (r) => ref(r.subject, r.title || r.subject) },
      { key: 'state', label: 'Now', render: (r) => h('span', { text: [r.state, r.stillStale ? 'still stale' : null, r.stillBlocked ? 'still blocked' : null].filter(Boolean).join(', ') }) },
      { key: 'eventKey', label: 'Acknowledge', sortable: false, render: (r) => action('Acknowledge', async () => { await appApi('/v1/alerts/acknowledge', { purpose: ctx.purpose, body: { eventKeys: [r.eventKey] } }); queueMicrotask(reloadAlerts); return 'Acknowledged.'; }) },
    ] });
  });
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
