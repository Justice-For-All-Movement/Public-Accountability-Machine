// Discovery (E04): sources, collection runs with coverage, receipts, failures and gaps, contact leads.
import { api } from '../api.js';
import { h, clear, region, section, table, renderEmpty, form, dl, ref, badge } from '../ui.js';

const KINDS = ['html_index', 'sitemap', 'feed', 'json_api', 'file_list', 'archive_import', 'search_json', 'search_opensearch'];
const REUSE = ['unknown', 'citation_only', 'licensed', 'public_domain', 'permission_granted', 'restricted'];
const listed = (body, rows, title, empty, spec) => { if (!rows.length) renderEmpty(body.appendChild(h('div', {})), title, empty); else table(body, { ...spec, rows }); };

export async function render(el, ctx) {
  const sources = region('Sources'); const add = region('Add a source'); const runs = region('Collection runs'); const coverage = h('div', { 'aria-live': 'polite' });
  const receipts = region('Acquisition receipts'); const problems = region('Failures and gaps'); const leads = region('Contact leads');
  el.append(sources.el, add.el, runs.el, coverage, receipts.el, problems.el, leads.el);
  const reloadRuns = () => section(runs.body, () => api('discovery', '/v1/collections', { purpose: ctx.purpose }), (rows, body) => listed(body, rows, 'No collection runs', 'Start a collection from a source above.', { caption: `Runs (${rows.length})`, columns: [
    { key: 'ref', label: 'Run' }, { key: 'state', label: 'State', render: (r) => badge(r.state === 'failed' || r.state === 'blocked' ? 'failed' : 'ok', { label: r.state }) }, { key: 'level', label: 'Level' }, { key: 'createdAt', label: 'Started' },
    { key: 'cov', label: 'Coverage', sortable: false, render: (r) => h('button', { type: 'button', class: 'ws-button', onClick: () => showCoverage(coverage, ctx, { runId: r.id }) }, 'Show coverage') }] }));
  const reload = section(sources.body, () => api('discovery', '/v1/sources', { purpose: ctx.purpose }), (rows, body) => {
    listed(body, rows, 'No sources', 'Add a source below.', { caption: `Sources (${rows.length})`, rowHeader: 'name', columns: [
      { key: 'name', label: 'Source' }, { key: 'kind', label: 'Kind' }, { key: 'baseUrl', label: 'Address' }, { key: 'state', label: 'State' }, { key: 'reuse', label: 'Reuse terms' }, { key: 'ref', label: 'Reference', render: (s) => ref(s.ref) },
      { key: 'cov', label: 'Coverage', sortable: false, render: (s) => h('button', { type: 'button', class: 'ws-button', onClick: () => showCoverage(coverage, ctx, { sourceId: s.id }) }, `Coverage of ${s.name}`) }] });
    if (rows.length) body.append(form({ legend: 'Start a collection', submit: 'Start collection', fields: [
      { name: 'sourceId', label: 'Source', type: 'select', options: rows.map((s) => ({ value: s.id, label: s.name })) }, { name: 'level', label: 'Level', type: 'select', options: ['links', 'metadata', 'bytes'] },
      { name: 'maxItems', label: 'Maximum items', type: 'number', min: 1 }, { name: 'questionRef', label: 'Investigation question it serves (uref, optional)' }],
      onSubmit: async (v) => { const r = await api('discovery', '/v1/collections', { purpose: ctx.purpose, body: { sourceId: v.sourceId, level: v.level, ...(v.maxItems ? { maxItems: v.maxItems } : {}), ...(v.questionRef ? { questionRef: v.questionRef } : {}) } }); reloadRuns(); return `Collection queued (${r.state}). Results appear as the worker runs it.`; } }));
  });
  add.body.append(form({ legend: 'Source', submit: 'Add source', fields: [
    { name: 'name', label: 'Name', required: true }, { name: 'kind', label: 'Kind', type: 'select', options: KINDS }, { name: 'baseUrl', label: 'Address (URL)', type: 'url', required: true },
    { name: 'accessTerms', label: 'Access terms (what the source allows)', required: true }, { name: 'reuse', label: 'Reuse terms', type: 'select', options: REUSE }],
    onSubmit: async (v) => { await api('discovery', '/v1/sources', { purpose: ctx.purpose, body: { name: v.name, kind: v.kind, baseUrl: v.baseUrl, accessTerms: v.accessTerms, reuse: v.reuse } }); void reload(); return 'Source added.'; } }));
  reloadRuns();
  section(receipts.body, () => api('discovery', '/v1/receipts', { purpose: ctx.purpose }), (rows, body) => listed(body, rows, 'No receipts', 'Each acquisition leaves a receipt with what was fetched and its digest.', { caption: `Receipts (${rows.length})`, columns: [{ key: 'ref', label: 'Receipt' }, { key: 'url', label: 'Address' }, { key: 'status', label: 'Status' }, { key: 'sha256', label: 'SHA-256' }, { key: 'evidenceRef', label: 'Evidence' }, { key: 'createdAt', label: 'When' }] }));
  section(problems.body, async () => ({ failures: await api('discovery', '/v1/failures', { purpose: ctx.purpose }), gaps: await api('discovery', '/v1/gaps', { purpose: ctx.purpose }) }), ({ failures, gaps }, body) => {
    listed(body, failures, 'No failures', 'Failed fetches are listed here and never counted as coverage.', { caption: `Failures (${failures.length})`, columns: [{ key: 'url', label: 'Address' }, { key: 'reason', label: 'Reason' }, { key: 'state', label: 'State' }, { key: 'attempts', label: 'Attempts', numeric: true }, { key: 'lastAt', label: 'Last attempt' }] });
    listed(body, gaps, 'No gaps', 'Known gaps in coverage are listed here.', { caption: `Gaps (${gaps.length})`, columns: [{ key: 'kind', label: 'Kind' }, { key: 'detail', label: 'Detail' }, { key: 'state', label: 'State' }, { key: 'ref', label: 'Reference' }] });
  });
  section(leads.body, () => api('discovery', '/v1/leads', { purpose: ctx.purpose }), (rows, body) => listed(body, rows, 'No contact leads', 'Leads to people or institutions found in collected material appear here.', { caption: `Contact leads (${rows.length})`, columns: [{ key: 'name', label: 'Name' }, { key: 'role', label: 'Role' }, { key: 'organization', label: 'Organization' }, { key: 'why', label: 'Why they may know' }, { key: 'sourceItemRef', label: 'Found in' }, { key: 'ref', label: 'Reference' }] }));
}

function showCoverage(el, ctx, q) {
  clear(el);
  section(el, () => (q.runId ? api('discovery', `/v1/collections/${q.runId}/coverage`, { purpose: ctx.purpose }) : api('discovery', `/v1/sources/${q.sourceId}/coverage`, { purpose: ctx.purpose })), (c, body) => {
    body.append(h('h2', { text: `Coverage (${c.scope})` }), dl([['Reference', ref(c.ref)], ['State', c.state], ['Discovered', String(c.discovered)], ['Link only', String(c.linkOnly)], ['Metadata acquired', String(c.acquiredMetadata)], ['Bytes acquired', String(c.acquiredBytes)], ['Unchanged', String(c.unchanged)], ['Failed', String(c.failed)], ...Object.entries(c).filter(([k]) => !['scope', 'ref', 'state', 'discovered', 'linkOnly', 'acquiredMetadata', 'acquiredBytes', 'unchanged', 'failed'].includes(k)).map(([k, v]) => [k, v])]));
  });
}
