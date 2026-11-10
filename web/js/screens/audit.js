// Audit: one timeline across engines (workspace auditTimeline), filters, and CSV/JSON export (workspace exportAudit).
import { AuditTimeline } from '/engines/workspace/web/index.js';
import { api } from '../api.js';
import { h, region, section, renderEmpty, form, download, openInspector, announce, toError } from '../ui.js';

export async function render(el, ctx) {
  const filters = region('Filters'); const tl = region('Timeline');
  el.append(filters.el, tl.el);
  const q = { subject: ctx.params.get('subject') ?? '', engines: ctx.params.get('engines') ?? '', after: ctx.params.get('after') ?? '' };
  filters.body.append(form({ legend: 'Query', submit: 'Apply', resetOnSuccess: false, fields: [
    { name: 'subject', label: 'Object reference (uref)', value: q.subject }, { name: 'engines', label: 'Engines (for example E05,E07; empty = all)', value: q.engines }, { name: 'after', label: 'After (ISO time)', value: q.after }],
    onSubmit: async (v) => { ctx.navigate(`/audit?${new URLSearchParams(Object.entries(v).filter(([, x]) => x))}`); return 'Applied.'; } }));
  let cursors = null; let records = []; let handle = null;
  const load = (more = false) => section(tl.body, () => api('workspace', '/v1/audit-timeline', { purpose: ctx.purpose, query: { subject: q.subject, engines: q.engines, after: q.after, limit: 200, ...(more && cursors ? { cursors: Object.entries(cursors).map(([k, v]) => `${k}:${v}`).join(',') } : {}) } }), (t, body) => {
    records = more ? [...records, ...t.records] : t.records; cursors = t.cursors;
    if (records.length === 0) { renderEmpty(body.appendChild(h('div', {})), 'No audit records', 'Nothing matches, or nothing has happened yet that your role may see.'); }
    const holder = h('div', {}); body.append(holder);
    if (handle) handle.destroy();
    handle = AuditTimeline(holder, { records, engines: t.engines, truncated: t.truncated, height: 480, onNavigate: openInspector,
      onLoadMore: t.truncated || Object.keys(t.cursors ?? {}).length ? () => load(true) : undefined,
      onExport: async (format) => {
        try {
          const res = await api('workspace', '/v1/audit-timeline/export', { purpose: ctx.purpose, query: { format, subject: q.subject, engines: q.engines, after: q.after }, raw: true });
          const name = /filename="?([^";]+)/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? `audit.${format}`;
          download(await res.blob(), name);
          announce(`Exported ${res.headers.get('x-export-records') ?? ''} records as ${format.toUpperCase()} (SHA-256 ${res.headers.get('x-export-sha256') ?? 'not reported'}).`);
        } catch (e) { const x = toError(e); announce(`Export refused: ${x.message} (${x.code})`, 'assertive'); }
      } });
  });
  load();
}
