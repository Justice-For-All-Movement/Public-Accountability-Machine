// Resources (E13): budget tree (reserved / committed / available), incidents, lane allocation against target, usage, invoices.
import { api } from '../api.js';
import { h, region, section, table, renderEmpty, form, badge } from '../ui.js';
import { flattenBudgets } from './overview.js';

const pct = (bps) => `${(Number(bps) / 100).toFixed(1)}%`;
const listed = (body, rows, title, empty, spec) => { if (!rows.length) renderEmpty(body.appendChild(h('div', {})), title, empty); else table(body, { ...spec, rows }); };

export async function render(el, ctx) {
  const budgets = region('Budgets'); const lanes = region('Research lanes: measured effort against target', 2, 'Lanes are measured by effort, never by outcome quotas.'); const usage = region('Usage');
  const incidents = region('Incidents'); const invoices = region('Invoices');
  el.append(budgets.el, lanes.el, usage.el, incidents.el, invoices.el);
  const reload = section(budgets.body, () => api('resources', '/v1/budgets', { purpose: ctx.purpose }), (tree, body) => {
    const rows = flattenBudgets(tree);
    listed(body, rows, 'No budgets', 'Create the first budget below.', { caption: `Budget tree (${rows.length})`, rowHeader: 'name', columns: [
      { key: 'name', label: 'Budget', render: (r) => h('span', { text: `${'— '.repeat(r.depth)}${r.name}` }) }, { key: 'level', label: 'Level' }, { key: 'unit', label: 'Unit' }, { key: 'period', label: 'Period' },
      { key: 'ceiling', label: 'Ceiling', numeric: true }, { key: 'reserved', label: 'Reserved', numeric: true }, { key: 'committed', label: 'Committed', numeric: true }, { key: 'available', label: 'Available', numeric: true },
      { key: 'usedBps', label: 'Used', numeric: true, render: (r) => h('span', { text: pct(r.usedBps) }) }, { key: 'state', label: 'State', render: (r) => badge(r.state === 'active' ? 'ok' : 'blocked', { label: r.state, reasons: r.stateReason ? [r.stateReason] : [] }) },
      { key: 'forecast', label: 'Forecast', render: (r) => h('span', { text: r.forecast ? `${r.forecast.projected} projected (linear)${r.forecast.exceedsCeiling ? ' — exceeds ceiling' : ''}` : '—' }) }] });
    body.append(form({ legend: 'New budget', submit: 'Create budget', fields: [
      { name: 'name', label: 'Name', required: true }, { name: 'level', label: 'Level', type: 'select', options: ['organization', 'project', 'objective', 'run', 'agent', 'lane'] },
      { name: 'unit', label: 'Unit', required: true, help: 'For example tokens_out, compute_seconds, messages, EUR.' }, { name: 'ceiling', label: 'Ceiling', type: 'number', min: 0, required: true },
      { name: 'period', label: 'Period', type: 'select', options: ['one_off', 'monthly'] }, { name: 'parentId', label: 'Parent budget', type: 'select', options: [{ value: '', label: '(none)' }, ...rows.map((r) => ({ value: r.id, label: r.name }))] }, { name: 'lane', label: 'Lane (for lane budgets)' }],
      onSubmit: async (v) => { await api('resources', '/v1/budgets', { purpose: ctx.purpose, body: { name: v.name, level: v.level, unit: v.unit, ceiling: v.ceiling, period: v.period, ...(v.parentId ? { parentId: v.parentId } : {}), ...(v.lane ? { lane: v.lane } : {}) } }); setTimeout(reload, 0); return 'Budget created.'; } }));
  });
  section(lanes.body, () => api('resources', '/v1/lanes/report', { purpose: ctx.purpose }), (r, body) => {
    listed(body, r.lanes ?? [], 'No lane policy or recorded work', 'Set a lane policy and run tasks with a lane to see measured effort.', { caption: `Lane allocation (measure: ${r.measure}; ${r.withinTolerance ? 'within' : 'outside'} tolerance of ${pct(r.driftToleranceBps)})`, rowHeader: 'name', columns: [
      { key: 'name', label: 'Lane' }, { key: 'targetShareBps', label: 'Target share', numeric: true, render: (l) => h('span', { text: pct(l.targetShareBps) }) },
      { key: 'actual', label: 'Actual share', numeric: true, render: (l) => h('span', { text: pct(l.actualShareBps?.[r.measure] ?? Object.values(l.actualShareBps ?? {})[0] ?? 0) }) },
      { key: 'activeSeconds', label: 'Active seconds', numeric: true }, { key: 'workRecords', label: 'Work records', numeric: true }, { key: 'configured', label: 'In policy' }] });
    if ((r.underAllocated ?? []).length || (r.overAllocated ?? []).length) body.append(h('p', { text: `Under target: ${(r.underAllocated ?? []).join(', ') || 'none'}. Over target: ${(r.overAllocated ?? []).join(', ') || 'none'}.` }));
  });
  section(usage.body, () => api('resources', '/v1/usage/report', { purpose: ctx.purpose, query: { groupBy: 'lane' } }), (r, body) => {
    const rows = r.groups ?? r.rows ?? [];
    listed(body, rows, 'No usage recorded', 'Model calls, processing, rendering and messaging are metered here when recorded.', { caption: 'Usage by lane', columns: Object.keys(rows[0] ?? { key: '' }).slice(0, 8).map((k) => ({ key: k, label: k })) });
    if ((r.unpricedMeters ?? []).length) body.append(h('p', { class: 'ws-notice ws-notice--warn', text: `Unpriced meters (costs not guessed): ${r.unpricedMeters.join(', ')}` }));
  });
  section(incidents.body, () => api('resources', '/v1/incidents', { purpose: ctx.purpose }), (rows, body) => listed(body, rows, 'No incidents', 'Overages and budget problems are recorded here.', { caption: `Incidents (${rows.length})`, columns: [{ key: 'kind', label: 'Kind' }, { key: 'detail', label: 'Detail' }, { key: 'budgetId', label: 'Budget' }, { key: 'open', label: 'Open' }, { key: 'createdAt', label: 'When' }] }));
  section(invoices.body, () => api('resources', '/v1/invoices', { purpose: ctx.purpose }), (rows, body) => listed(body, Array.isArray(rows) ? rows : rows.items ?? [], 'No invoices', 'Invoices issued by the organization appear here.', { caption: 'Invoices', columns: [{ key: 'number', label: 'Number' }, { key: 'customer', label: 'Customer' }, { key: 'state', label: 'State' }, { key: 'totalMinor', label: 'Total (minor units)', numeric: true }, { key: 'currency', label: 'Currency' }, { key: 'issuedAt', label: 'Issued' }] }));
}
