// Production (E10): projects by kind, renders with their real job state, preview players, manifest, re-render.
// The engine reports `progress` from real tool output; it is shown as a number only while the render runs.
import { api } from '../api.js';
import { h, clear, region, section, table, renderEmpty, form, action, dl, ref, badge, download, sandboxedHtml } from '../ui.js';

const KINDS = ['written', 'image', 'audio', 'video', 'interactive'];
const renderBadge = (r) => badge(r.state === 'done' ? (r.stale ? 'stale' : 'ok') : r.state === 'failed' ? 'failed' : r.state === 'blocked' ? 'blocked' : r.state === 'cancelled' ? 'unavailable' : 'stale', { label: r.state === 'running' ? `running: ${r.stage || 'started'} (${Math.round((r.progress ?? 0) * 100)}% reported by the tool)` : r.state, reasons: (r.reasons ?? []).map((x) => x.reason ?? x.message ?? JSON.stringify(x)) });

export async function render(el, ctx) {
  const id = ctx.params.get('id');
  if (id) return project(el, ctx, id);
  const kind = ctx.params.get('kind') ?? '';
  const list = region('Production projects'); const create = region('New production project'); const prov = region('Providers');
  el.append(list.el, create.el, prov.el);
  const filter = h('div', { class: 'pam-tabs', role: 'group', 'aria-label': 'Filter by kind' }, ['', ...KINDS].map((k) => h('a', { href: `/production${k ? `?kind=${k}` : ''}`, 'data-nav': true, class: 'ws-button', 'aria-current': k === kind ? 'true' : undefined }, k || 'all kinds')));
  list.body.append(filter);
  const holder = h('div', {}); list.body.append(holder);
  const reload = section(holder, () => api('production', '/v1/production/projects', { purpose: ctx.purpose, query: { kind } }), (rows, body) => {
    if (rows.length === 0) { renderEmpty(body.appendChild(h('div', {})), `No ${kind || ''} production projects`.replace('  ', ' '), 'Create one below or from an exported editorial document.'); return; }
    table(body, { caption: `Projects (${rows.length})`, rows, rowHeader: 'title', columns: [{ key: 'title', label: 'Project', render: (p) => h('a', { href: `/production?id=${p.id}`, 'data-nav': true }, p.title) }, { key: 'kind', label: 'Kind' }, { key: 'headRevision', label: 'Revision', numeric: true }, { key: 'state', label: 'State', render: (p) => badge(p.blocked ? 'blocked' : p.stale ? 'stale' : 'ok', { label: p.blocked ? 'blocked' : p.stale ? 'stale' : 'current' }) }, { key: 'ref', label: 'Reference', render: (p) => ref(p.ref) }, { key: 'updatedAt', label: 'Updated' }] });
  });
  create.body.append(form({ legend: 'Project', submit: 'Create project', fields: [{ name: 'kind', label: 'Kind', type: 'select', options: KINDS }, { name: 'title', label: 'Title', required: true }, { name: 'editorialRef', label: 'Editorial document reference (optional)' }],
    onSubmit: async (v) => { await api('production', '/v1/production/projects', { purpose: ctx.purpose, body: { kind: v.kind, title: v.title, ...(v.editorialRef ? { editorialRef: v.editorialRef } : {}) } }); void reload(); return 'Project created.'; } }));
  section(prov.body, () => api('production', '/v1/production/providers', { purpose: ctx.purpose }), (p, body) => body.append(h('pre', { tabindex: '0', text: JSON.stringify(p, null, 2) })));
}

async function project(el, ctx, id) {
  el.append(h('p', {}, h('a', { href: '/production', 'data-nav': true }, 'Back to production')));
  const head = region('Project'); const renders = region('Renders'); const player = region('Preview');
  el.append(head.el, renders.el, player.el);
  player.body.append(h('p', { class: 'ws-muted', text: 'Choose an output of a finished render to preview it.' }));
  section(head.body, async () => ({ p: await api('production', `/v1/production/projects/${id}`, { purpose: ctx.purpose }), v: await api('production', `/v1/production/projects/${id}/validate`, { purpose: ctx.purpose }).catch((e) => ({ error: e.message })) }), ({ p, v }, body) => {
    body.append(dl([['Title', p.title], ['Kind', p.kind], ['Revision', String(p.headRevision)], ['Reference', ref(p.ref)], ['Editorial source', p.editorialRef ? ref(p.editorialRef) : null], ['Validation', v.error ? `not available: ${v.error}` : v.ok ? 'valid' : (v.problems ?? []).map((x) => `${x.level}: ${x.message}`).join('; ')]]));
    body.append(h('div', { class: 'pam-toolbar' },
      ...['preview', 'final'].map((profile) => action(`Render ${profile}`, async () => { const r = await api('production', '/v1/renders', { purpose: ctx.purpose, body: { productionId: id, profile } }); setTimeout(reloadRenders, 300); return `Render ${r.state}.`; })),
      p.kind === 'interactive' ? action('Preview interactive story', async () => { const html = await api('production', `/v1/production/projects/${id}/preview`, { purpose: ctx.purpose }); clear(player.body).append(sandboxedHtml(typeof html === 'string' ? html : JSON.stringify(html), 'Interactive story preview (sandboxed)')); return 'Preview shown in a sandbox.'; }) : null));
  });
  const reloadRenders = () => section(renders.body, () => api('production', '/v1/renders', { purpose: ctx.purpose, query: { productionId: id } }), (rows, body) => {
    body.append(h('div', { class: 'pam-toolbar' }, h('button', { type: 'button', class: 'ws-button', onClick: () => reloadRenders() }, 'Refresh renders')));
    if (rows.length === 0) { renderEmpty(body.appendChild(h('div', {})), 'No renders yet', 'Request a preview or final render above.'); return; }
    table(body, { caption: `Renders (${rows.length})`, rows, columns: [{ key: 'seq', label: 'Render', numeric: true }, { key: 'profile', label: 'Profile' }, { key: 'state', label: 'State', render: renderBadge }, { key: 'error', label: 'Error' }, { key: 'createdAt', label: 'Requested' },
      { key: 'outs', label: 'Outputs', sortable: false, render: (r) => h('span', {}, ...(r.outputs ?? []).map((o) => h('button', { type: 'button', class: 'ws-button', onClick: () => play(player.body, ctx, r, o) }, `Preview ${o.name}`)), r.state === 'done' ? h('button', { type: 'button', class: 'ws-button', onClick: () => manifest(player.body, ctx, r) }, 'Manifest') : null,
        ['queued', 'running'].includes(r.state) ? action('Cancel', async () => { await api('production', `/v1/renders/${r.id}/cancel`, { purpose: ctx.purpose, body: {} }); setTimeout(reloadRenders, 300); return 'Cancelled.'; }) : null,
        ['done', 'failed', 'cancelled'].includes(r.state) ? action('Re-render', async () => { await api('production', '/v1/renders', { purpose: ctx.purpose, body: { productionId: id, profile: r.profile } }); setTimeout(reloadRenders, 300); return 'New render requested.'; }) : null) }] });
  });
  reloadRenders();
}

async function play(el, ctx, r, o) {
  clear(el);
  section(el, async () => (await api('production', `/v1/renders/${r.id}/outputs/${encodeURIComponent(o.name)}`, { purpose: ctx.purpose, raw: true })).blob(), (blob, body) => {
    const url = URL.createObjectURL(new Blob([blob], { type: o.mediaType }));
    body.append(h('h3', { text: `${o.name} (${o.mediaType}, ${o.size} bytes)` }));
    if (o.mediaType.startsWith('audio/')) body.append(h('audio', { controls: true, src: url, 'aria-label': o.name }));
    else if (o.mediaType.startsWith('video/')) body.append(h('video', { controls: true, src: url, 'aria-label': o.name }));
    else if (o.mediaType.startsWith('image/')) body.append(h('img', { src: url, alt: `Rendered output ${o.name}` }));
    else if (o.mediaType === 'text/html') void blob.text().then((t) => body.append(sandboxedHtml(t, `Rendered page ${o.name}`)));
    else if (o.mediaType.startsWith('text/') || o.mediaType.includes('json')) void blob.text().then((t) => body.append(h('pre', { tabindex: '0', text: t })));
    else body.append(h('p', { text: 'No in-page player for this type; download it instead.' }));
    body.append(h('p', {}, h('button', { type: 'button', class: 'ws-button', onClick: () => download(blob, o.name) }, `Download ${o.name}`)), h('p', { class: 'ws-muted', text: `SHA-256 ${o.sha256}` }));
  });
}
function manifest(el, ctx, r) {
  clear(el);
  section(el, () => api('production', `/v1/renders/${r.id}/manifest`, { purpose: ctx.purpose }), (m, body) => body.append(h('h3', { text: `Manifest of render ${r.seq}` }), h('pre', { tabindex: '0', text: JSON.stringify(m, null, 2) })));
}
