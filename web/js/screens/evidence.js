// Evidence (E05): list, upload, quarantine state, viewer, provenance and custody, integrity, redaction, export.
import { api } from '../api.js';
import { h, clear, region, section, table, renderEmpty, form, action, dl, badge, ref, b64, bytesFromB64, download, announce, openInspector } from '../ui.js';

const STATE = { quarantined: ['stale', 'quarantined (being checked; not yet available)'], released: ['ok', 'available'], blocked: ['blocked', 'blocked'] };
export const evidenceBadge = (row) => { const [s, label] = STATE[row.state] ?? ['unavailable', row.state ?? 'unknown']; return badge(s, { label, reasons: row.bytesState && row.bytesState !== 'present' ? [`bytes ${row.bytesState}`] : [] }); };

export async function render(el, ctx) {
  const selected = ctx.params.get('ref');
  if (selected) return detail(el, ctx, selected);
  const upload = region('Add evidence', 2, 'Files are accepted into quarantine, checked, and then become available. Nothing is shown as available before the engine says so.');
  const list = region('Evidence items');
  el.append(upload.el, list.el);
  let polls = 0; let timer = null;
  const reload = section(list.body, () => api('evidence', '/v1/evidence', { purpose: ctx.purpose }), (items, body) => {
    if (timer) { clearTimeout(timer); timer = null; }
    body.append(h('div', { class: 'pam-toolbar' }, h('button', { type: 'button', class: 'ws-button', onClick: () => reload() }, 'Refresh list')));
    if (items.length === 0) { renderEmpty(body.appendChild(h('div', {})), 'No evidence yet', 'Upload a file above to add the first item.'); return; }
    table(body, { caption: `Evidence items (${items.length})`, rows: items, rowHeader: 'filename', columns: [
      { key: 'filename', label: 'File', render: (r) => h('a', { href: `/evidence?ref=${encodeURIComponent(r.evidenceRef ?? r.ref)}`, 'data-nav': true }, r.title || r.filename) },
      { key: 'state', label: 'State', render: evidenceBadge },
      { key: 'mediaType', label: 'Type' }, { key: 'size', label: 'Bytes', numeric: true }, { key: 'revision', label: 'Revision', numeric: true },
      { key: 'ref', label: 'Reference', render: (r) => ref(r.ref) }, { key: 'createdAt', label: 'Added' }] });
    // While anything is still quarantined, re-read the real state a limited number of times.
    if (items.some((i) => i.state === 'quarantined') && polls < 60 && document.contains(body)) { polls++; timer = setTimeout(() => { if (document.contains(body)) void reload(); }, 2000); }
  });
  upload.body.append(form({ legend: 'Upload a file', submit: 'Upload', fields: [
    { name: 'file', label: 'File', type: 'file', required: true },
    { name: 'origin', label: 'Where it came from', required: true, help: 'Describe the source of the file (who supplied it, how, when). Stored with the item as provenance.' },
    { name: 'owner', label: 'Original owner (optional)', help: 'Who held the file before it was supplied, if known.' },
    { name: 'compartment', label: 'Compartment (optional)', help: 'Restricts the item to members of that compartment.' }],
    onSubmit: async (v) => {
      const file = v.file;
      const out = await api('evidence', '/v1/evidence/accept', { purpose: ctx.purpose, body: { contentBase64: await b64(file), mediaType: file.type || 'application/octet-stream', filename: file.name, origin: { kind: 'manual_import', description: v.origin, ...(v.owner ? { originalOwner: v.owner } : {}), via: 'pam-web' }, ...(v.compartment ? { compartment: v.compartment } : {}), idempotencyKey: `upload-${file.name}-${file.size}-${file.lastModified}` } });
      polls = 0; void reload();
      return `Accepted ${out.filename} as ${out.ref}; ${out.available ? 'available' : 'in quarantine until checks finish'}.`;
    } }));
}

async function detail(el, ctx, evRef) {
  el.append(h('p', {}, h('a', { href: '/evidence', 'data-nav': true }, 'Back to all evidence')));
  const head = region('Item'); const viewer = region('Viewer'); const prov = region('Provenance and custody'); const actions = region('Actions');
  el.append(head.el, viewer.el, actions.el, prov.el);
  section(head.body, () => api('evidence', '/v1/evidence/describe', { purpose: ctx.purpose, query: { ref: evRef } }), (d, body) => {
    body.append(dl([['Title', d.title || d.filename], ['State', evidenceBadge(d)], ['Reference', ref(d.ref)], ['Item', ref(d.evidenceRef)], ['Media type', d.mediaType], ['Size (bytes)', String(d.size)], ['SHA-256', h('code', { text: d.sha256 })], ['Kind', d.kind], ['Compartment', d.compartment], ['Authenticity', d.authenticity], ['What the digest means', d.digestMeaning], ['Scan', d.scan], ['Stale', d.stale ? `yes: ${(d.staleReasons ?? []).join('; ')}` : 'no'], ['Added', d.createdAt]]));
    body.append(h('button', { type: 'button', class: 'ws-button', onClick: () => openInspector(d.ref) }, 'Open in inspector'));
    renderViewer(viewer.body, ctx, d, 1);
    renderActions(actions.body, ctx, d);
    provenance(prov.body, ctx, d);
  });
}

function provenance(el, ctx, d) {
  section(el, () => api('evidence', `/v1/provenance/${d.evidenceId}`, { purpose: ctx.purpose }), (p, body) => {
    body.append(dl([['Custody chain', p.custodyChainValid ? 'intact (hash chain verified)' : 'BROKEN — the custody hash chain does not verify'], ['Authenticity', p.authenticity], ['Gaps', (p.gaps ?? []).length === 0 ? 'none recorded' : p.gaps]]));
    table(body, { caption: 'Versions', rows: p.versions ?? [], columns: [{ key: 'revision', label: 'Revision', numeric: true }, { key: 'ref', label: 'Reference' }, { key: 'state', label: 'State' }, { key: 'cause', label: 'Cause' }, { key: 'sha256', label: 'SHA-256' }, { key: 'createdAt', label: 'Added' }] });
    table(body, { caption: 'Acquisitions', rows: (p.acquisitions ?? []).map((a) => ({ detail: a })), columns: [{ key: 'detail', label: 'Acquisition record' }] });
    table(body, { caption: 'Custody log', rows: p.custody ?? [], columns: [{ key: 'seq', label: 'Seq', numeric: true }, { key: 'at', label: 'When' }, { key: 'action', label: 'Action' }, { key: 'actorId', label: 'Actor' }, { key: 'purpose', label: 'Purpose' }, { key: 'detail', label: 'Detail' }] });
    if ((p.derivatives ?? []).length) table(body, { caption: 'Derivatives (for example redactions)', rows: p.derivatives.map((x) => ({ detail: x })), columns: [{ key: 'detail', label: 'Derivative' }] });
    if ((p.integrityChecks ?? []).length) table(body, { caption: 'Integrity checks', rows: p.integrityChecks.map((x) => ({ detail: x })), columns: [{ key: 'detail', label: 'Check' }] });
  });
}

export function renderViewer(body, ctx, d, page) {
  clear(body);
  if (d.state !== 'released') { body.append(h('p', { class: 'ws-notice ws-notice--warn', text: `The content is not viewable while the item is ${d.state}.` })); return; }
  const out = h('div', { class: 'pam-viewer', 'aria-live': 'polite' });
  body.append(out);
  section(out, () => api('evidence', '/v1/evidence/view', { purpose: ctx.purpose, body: { ref: d.ref, page } }), async (v, holder) => {
    holder.append(h('p', { class: 'ws-muted', text: `Authenticity: ${v.authenticity}. ${v.digestMeaning ?? ''}` }));
    if (v.kind === 'text') holder.append(h('pre', { tabindex: '0', class: 'pam-viewer__text', 'aria-label': `Text of ${d.filename}`, text: v.text }));
    else if (v.kind === 'image' || v.kind === 'pdf_page') {
      const url = URL.createObjectURL(new Blob([bytesFromB64(v.imageBase64)], { type: v.imageMediaType ?? 'image/png' }));
      holder.append(h('img', { src: url, alt: v.kind === 'pdf_page' ? `Page ${v.page} of ${v.pageCount} of ${d.filename}` : `Image ${d.filename}`, width: v.widthPx, height: v.heightPx }));
      if (v.kind === 'pdf_page') {
        holder.append(h('div', { class: 'pam-toolbar' },
          h('button', { type: 'button', class: 'ws-button', disabled: v.page <= 1 ? true : undefined, onClick: () => renderViewer(body, ctx, d, v.page - 1) }, 'Previous page'),
          h('span', { text: `Page ${v.page} of ${v.pageCount}` }),
          h('button', { type: 'button', class: 'ws-button', disabled: v.page >= v.pageCount ? true : undefined, onClick: () => renderViewer(body, ctx, d, v.page + 1) }, 'Next page')));
        const words = (v.words ?? []).map((w) => w.text ?? w.word ?? '').join(' ');
        if (words) holder.append(h('details', {}, h('summary', { text: 'Text on this page' }), h('pre', { tabindex: '0', text: words })));
      }
    } else if (v.kind === 'media') {
      // Media plays from the engine's content route, fetched with the access token and handed to the player as a blob.
      const res = await api('evidence', '/v1/evidence/content', { purpose: ctx.purpose, query: { ref: d.ref }, raw: true });
      const url = URL.createObjectURL(await res.blob());
      holder.append(h(d.mediaType.startsWith('video/') ? 'video' : 'audio', { controls: true, src: url, 'aria-label': `Playback of ${d.filename}` }), h('p', { class: 'ws-muted', text: `Duration: ${v.durationMs === null ? 'unknown' : `${Math.round(v.durationMs / 1000)} s`}` }));
    } else holder.append(h('p', { class: 'ws-notice', text: `No viewer for this content: ${v.reason ?? v.kind}` }));
  }, 'Rendering the view…');
}

function renderActions(body, ctx, d) {
  const verifyOut = h('div', {});
  body.append(h('div', { class: 'pam-toolbar' },
    action('Verify integrity', async () => {
      const r = await api('evidence', `/v1/evidence/${d.evidenceId}/verify`, { purpose: ctx.purpose, body: { revision: d.revision } });
      clear(verifyOut).append(dl([['Result', r.status], ['Meaning', r.meaning], ['Observed SHA-256', r.observedSha256], ['Checked', r.checkedAt]]));
      return `Integrity: ${r.status}.`;
    }),
    action('Export package (download)', async () => {
      const res = await api('evidence', '/v1/packages', { purpose: 'evidence_management', body: { refs: [d.ref], includeOriginals: true, reason: 'Exported from the PAM application' }, raw: true });
      const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? 'evidence-package.zip';
      download(await res.blob(), name);
      return `Package downloaded (${name}; SHA-256 ${res.headers.get('x-package-sha256') ?? 'not reported'}).`;
    })), verifyOut);
  const isText = d.mediaType.startsWith('text/') || d.mediaType.includes('json');
  body.append(form({ legend: 'Redact (creates a new derivative; the original is unchanged)', submit: 'Create redacted copy',
    fields: isText
      ? [{ name: 'start', label: 'First character to remove (0-based)', type: 'number', required: true, min: 0 }, { name: 'end', label: 'End (exclusive)', type: 'number', required: true, min: 1 }, { name: 'reason', label: 'Reason', required: true }]
      : [{ name: 'page', label: 'Page (PDF only)', type: 'number', value: '1', min: 1 }, { name: 'x', label: 'Left edge (0 to 1)', type: 'number', step: 'any', required: true }, { name: 'y', label: 'Top edge (0 to 1)', type: 'number', step: 'any', required: true }, { name: 'w', label: 'Width (0 to 1)', type: 'number', step: 'any', required: true }, { name: 'hgt', label: 'Height (0 to 1)', type: 'number', step: 'any', required: true }, { name: 'reason', label: 'Reason', required: true }],
    onSubmit: async (v) => {
      const input = isText ? { textRanges: [{ start: v.start, end: v.end }] } : { regions: [{ ...(d.mediaType === 'application/pdf' ? { page: v.page ?? 1 } : {}), x: v.x, y: v.y, w: v.w, h: v.hgt }] };
      const out = await api('evidence', '/v1/evidence/redactions', { purpose: ctx.purpose, body: { ref: d.ref, reason: v.reason, ...input } });
      announce('Redacted derivative created.');
      return `Redacted copy created: ${out.derivative.ref}.`;
    } }));
}
