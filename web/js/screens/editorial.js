// Editorial (E09): projects, documents, a block editor where every block carries a mandatory basis label and its
// sources, revision history / diff / restore, fact-check, review and approval, generators from an investigation
// package, and export.
import { api } from '../api.js';
import { h, clear, region, section, table, renderEmpty, form, action, dl, ref, badge, uid, announce, toError } from '../ui.js';

const BASIS = ['verified_fact', 'attributed_testimony', 'allegation', 'inference', 'reconstruction', 'satire', 'invention', 'unknown_acknowledged'];
const DOC_TYPES = ['article', 'outline', 'treatment', 'book_section', 'narrative', 'lyrics', 'script', 'storyboard', 'interview_plan', 'interactive_story', 'notes'];
const GENERATORS = ['outline', 'treatment', 'narrative', 'lyrics', 'script', 'storyboard', 'interactive', 'interview_plan'];
const stateBadge = (d) => badge(d.blocked ? 'blocked' : d.stale ? 'stale' : 'ok', { label: d.state });

export async function render(el, ctx) {
  const docId = ctx.params.get('doc');
  if (docId) return editor(el, ctx, docId);
  const projects = region('Editorial projects'); const docs = region('Documents'); const gen = region('Generate a draft from an investigation package');
  el.append(projects.el, docs.el, gen.el);
  const reload = section(projects.body, () => api('editorial', '/v1/projects', { purpose: ctx.purpose }), (rows, body) => {
    if (rows.length === 0) renderEmpty(body.appendChild(h('div', {})), 'No editorial projects', 'Create one below.');
    else table(body, { caption: `Projects (${rows.length})`, rows, rowHeader: 'title', columns: [{ key: 'title', label: 'Project' }, { key: 'state', label: 'State', render: stateBadge }, { key: 'ref', label: 'Reference', render: (r) => ref(r.ref) }, { key: 'at', label: 'Updated' }] });
    body.append(form({ legend: 'New project', submit: 'Create project', fields: [
      { name: 'title', label: 'Title', required: true }, { name: 'format', label: 'Format', required: true, value: 'article', help: 'For example article, documentary, album, satire, campaign_piece.' },
      { name: 'projectKind', label: 'Kind', type: 'select', options: ['factual', 'artistic', 'satire', 'campaign'] }, { name: 'publishingIdentity', label: 'Publishing identity', required: true }, { name: 'language', label: 'Language', value: 'en', required: true },
      { name: 'investigationRefs', label: 'Investigation references (urefs, space separated)' }],
      onSubmit: async (v) => { await api('editorial', '/v1/projects', { purpose: ctx.purpose, body: { body: { title: v.title, format: v.format, projectKind: v.projectKind, publishingIdentity: v.publishingIdentity, language: v.language, credits: [], investigationRefs: v.investigationRefs.split(/\s+/).filter(Boolean) } } }); setTimeout(reload, 0); setTimeout(reloadDocs, 0); return 'Project created.'; } }));
  });
  const reloadDocs = section(docs.body, async () => ({ docs: await api('editorial', '/v1/documents', { purpose: ctx.purpose }), projects: await api('editorial', '/v1/projects', { purpose: ctx.purpose }) }), ({ docs: rows, projects: ps }, body) => {
    if (rows.length === 0) renderEmpty(body.appendChild(h('div', {})), 'No documents', ps.length ? 'Create a document below or generate one from a package.' : 'Create an editorial project first.');
    else table(body, { caption: `Documents (${rows.length})`, rows, rowHeader: 'title', columns: [{ key: 'title', label: 'Document', render: (d) => h('a', { href: `/editorial?doc=${d.id}`, 'data-nav': true }, d.title) }, { key: 'state', label: 'Review state', render: stateBadge }, { key: 'revision', label: 'Revision', numeric: true }, { key: 'ref', label: 'Reference', render: (d) => ref(d.ref) }] });
    if (ps.length) body.append(form({ legend: 'New document', submit: 'Create document', fields: [
      { name: 'editorialProjectId', label: 'Project', type: 'select', options: ps.map((p) => ({ value: p.id, label: p.title })) }, { name: 'title', label: 'Title', required: true },
      { name: 'docType', label: 'Type', type: 'select', options: DOC_TYPES }, { name: 'language', label: 'Language', value: 'en', required: true },
      { name: 'text', label: 'First block text', type: 'textarea', required: true }, { name: 'basis', label: 'Basis of the first block', type: 'select', options: [{ value: '', label: '(choose a basis: required)' }, ...BASIS], required: true },
      { name: 'sources', label: 'Sources of the first block (urefs, space separated)' }, { name: 'attribution', label: 'Attribution (who says so)' }, { name: 'disclosure', label: 'Disclosure (required for reconstruction, satire, invention)' }],
      onSubmit: async (v) => { const d = await api('editorial', '/v1/documents', { purpose: ctx.purpose, body: { body: { title: v.title, editorialProjectId: v.editorialProjectId, docType: v.docType, language: v.language, blocks: [newBlock(v)] } } }); setTimeout(reloadDocs, 0); return `Document created: ${d.title}.`; } }));
  });
  section(gen.body, async () => ({ projects: await api('editorial', '/v1/projects', { purpose: ctx.purpose }), investigations: await api('investigation', '/v1/investigations', { purpose: 'research' }).catch(() => []) }), ({ projects: ps, investigations }, body) => {
    if (!ps.length || !investigations.length) { renderEmpty(body.appendChild(h('div', {})), 'Nothing to generate from yet', 'Generators need an editorial project and an investigation with a built package.'); return; }
    body.append(form({ legend: 'Generator', submit: 'Generate draft', fields: [
      { name: 'generator', label: 'Generator', type: 'select', options: GENERATORS }, { name: 'editorialProjectId', label: 'Project', type: 'select', options: ps.map((p) => ({ value: p.id, label: p.title })) },
      { name: 'investigationId', label: 'Investigation (latest package)', type: 'select', options: investigations.map((i) => ({ value: i.id, label: i.data.title })) },
      { name: 'downgrade', label: 'Relabel unsupported facts as allegations instead of refusing', type: 'checkbox' }],
      onSubmit: async (v) => {
        const pkg = await api('investigation', `/v1/investigations/${v.investigationId}/packages/latest`, { purpose: 'research' });
        const out = await api('editorial', '/v1/generate', { purpose: ctx.purpose, body: { generator: v.generator, editorialProjectId: v.editorialProjectId, package: { ref: pkg.ref, content: pkg.content }, ...(v.downgrade ? { unsupportedFacts: 'downgrade' } : {}) } });
        setTimeout(reloadDocs, 0);
        return `Generated “${out.document.title}”; ${out.omitted.length} package items omitted${out.omitted.length ? ` (${out.omitted.map((o) => o.reason).join('; ')})` : ''}.`;
      } }));
  });
}

function newBlock(v) {
  return { id: `b${Math.random().toString(36).slice(2, 10)}`, type: 'passage', text: v.text, basis: v.basis, sources: (v.sources ?? '').split(/\s+/).filter(Boolean), ...(v.attribution ? { attribution: v.attribution } : {}), ...(v.disclosure ? { disclosure: v.disclosure } : {}), data: {} };
}

async function editor(el, ctx, id) {
  el.append(h('p', {}, h('a', { href: '/editorial', 'data-nav': true }, 'Back to editorial')));
  const holder = h('div', {}); el.append(holder);
  const reload = section(holder, () => api('editorial', `/v1/documents/${id}`, { purpose: ctx.purpose }), (d, body) => {
    const head = region(d.title); body.append(head.el);
    head.body.append(dl([['Review state', stateBadge(d)], ['Revision', `${d.revision} (current ${d.currentRevision})`], ['Type', d.body.docType], ['Reference', ref(d.ref)], ['Digest', d.digest], ['Open flags', (d.flags ?? []).length ? d.flags : 'none']]));
    head.body.append(h('div', { class: 'pam-toolbar' },
      action('Request review', async () => { await api('editorial', `/v1/documents/${id}/review`, { purpose: ctx.purpose, body: { expectedRevision: d.revision } }); setTimeout(reload, 400); return 'Review requested.'; }),
      action('Approve this revision', async () => { await api('editorial', `/v1/documents/${id}/approvals`, { purpose: ctx.purpose, body: { revision: d.revision } }); setTimeout(reload, 400); return 'Approved (bound to this revision digest).'; }),
      action('Export', async () => { const x = await api('editorial', `/v1/documents/${id}/exports`, { purpose: ctx.purpose, body: { revision: d.revision } }); clear(exportOut).append(h('h3', { text: `Export ${x.manifest.exportId}` }), h('pre', { tabindex: '0', text: x.renderings.markdown ?? JSON.stringify(x.document, null, 2) }), h('details', {}, h('summary', { text: 'Export manifest' }), h('pre', { tabindex: '0', text: JSON.stringify(x.manifest, null, 2) }))); return 'Exported.'; })));
    const exportOut = h('div', {}); head.body.append(exportOut);
    // Block editor: every block must carry a basis; sources and attribution are edited alongside the text.
    const ed = region('Blocks', 2, 'Every block needs a basis label. Verified facts need supported sources; reconstruction, satire and invention need a disclosure.'); body.append(ed.el);
    const blocks = d.body.blocks.map((b) => ({ ...b }));
    const list = h('div', {}); ed.body.append(list);
    const drawBlocks = () => { clear(list); blocks.forEach((b, i) => list.append(blockEditor(b, i, () => { blocks.splice(i, 1); drawBlocks(); }))); };
    drawBlocks();
    const status = h('p', { role: 'status', class: 'pam-form-status' }); const err = h('div', { role: 'alert', class: 'pam-form-error', hidden: true });
    ed.body.append(h('div', { class: 'pam-toolbar' },
      h('button', { type: 'button', class: 'ws-button', onClick: () => { blocks.push({ id: `b${Math.random().toString(36).slice(2, 10)}`, type: 'passage', text: '', basis: '', sources: [], data: {} }); drawBlocks(); list.lastElementChild?.querySelector('textarea')?.focus(); } }, 'Add block'),
      h('button', { type: 'button', class: 'ws-button ws-button--primary', onClick: async () => {
        err.hidden = true; status.textContent = 'Sent; waiting for the engine to answer.';
        const missing = blocks.findIndex((b) => !b.basis);
        if (missing >= 0) { status.textContent = ''; err.hidden = false; err.textContent = `Block ${missing + 1} has no basis label.`; list.children[missing]?.querySelector('select')?.focus(); return; }
        try { const saved = await api('editorial', `/v1/documents/${id}/revisions`, { purpose: ctx.purpose, body: { expectedRevision: d.revision, body: { ...d.body, blocks } } }); status.textContent = `Saved as revision ${saved.revision}.`; announce(status.textContent); setTimeout(reload, 600); }
        catch (e) { const x = toError(e); status.textContent = ''; err.hidden = false; err.textContent = `Refused: ${x.message} (${x.code})`; announce(err.textContent, 'assertive'); }
      } }, 'Save new revision')), status, err);
    const fc = region('Fact-check'); body.append(fc.el);
    section(fc.body, () => api('editorial', `/v1/documents/${id}/fact-check`, { purpose: ctx.purpose }), (f, b) => {
      const rows = f.blocks ?? f.items ?? [];
      if (!rows.length) b.append(h('pre', { tabindex: '0', text: JSON.stringify(f, null, 2) }));
      else table(b, { caption: 'Fact-check by block', rows, columns: Object.keys(rows[0]).slice(0, 7).map((k) => ({ key: k, label: k })) });
    });
    const hist = region('Revision history'); body.append(hist.el);
    section(hist.body, () => api('editorial', `/v1/documents/${id}/revisions`, { purpose: ctx.purpose }), (revs, b) => {
      const diffOut = h('div', {});
      table(b, { caption: `Revisions (${revs.length})`, rows: revs, columns: [{ key: 'revision', label: 'Revision', numeric: true }, { key: 'state', label: 'State' }, { key: 'summary', label: 'Summary' }, { key: 'actorId', label: 'By' }, { key: 'at', label: 'When' },
        { key: 'ops', label: 'Compare / restore', sortable: false, render: (r) => h('span', {},
          r.revision > 1 ? h('button', { type: 'button', class: 'ws-button', onClick: () => section(diffOut, () => api('editorial', `/v1/documents/${id}/diff`, { purpose: ctx.purpose, query: { from: r.revision - 1, to: r.revision } }), (x, db) => db.append(h('h3', { text: `Changes from ${r.revision - 1} to ${r.revision}` }), h('pre', { tabindex: '0', text: JSON.stringify(x, null, 2) }))) }, `Diff ${r.revision - 1}→${r.revision}`) : null,
          r.revision !== d.revision ? action(`Restore ${r.revision}`, async () => { await api('editorial', `/v1/documents/${id}/restore`, { purpose: ctx.purpose, body: { revision: r.revision, expectedRevision: d.revision } }); setTimeout(reload, 400); return `Revision ${r.revision} restored as a new revision.`; }) : null) }] });
      b.append(diffOut);
    });
  });
}

function blockEditor(b, i, remove) {
  const id = uid('pam-block');
  const text = h('textarea', { id: `${id}-text`, rows: 3 }); text.value = b.text ?? ''; text.addEventListener('input', () => { b.text = text.value; });
  const basis = h('select', { id: `${id}-basis`, required: true, 'aria-describedby': `${id}-basis-help` }, h('option', { value: '' }, '(choose: required)'), BASIS.map((x) => h('option', { value: x, selected: b.basis === x ? true : undefined }, x)));
  basis.addEventListener('change', () => { b.basis = basis.value; });
  const sources = h('input', { id: `${id}-src`, type: 'text' }); sources.value = (b.sources ?? []).join(' '); sources.addEventListener('input', () => { b.sources = sources.value.split(/\s+/).filter(Boolean); });
  const attr = h('input', { id: `${id}-attr`, type: 'text' }); attr.value = b.attribution ?? ''; attr.addEventListener('input', () => { b.attribution = attr.value || undefined; if (!attr.value) delete b.attribution; });
  const disc = h('input', { id: `${id}-disc`, type: 'text' }); disc.value = b.disclosure ?? ''; disc.addEventListener('input', () => { b.disclosure = disc.value || undefined; if (!disc.value) delete b.disclosure; });
  return h('fieldset', { class: 'pam-block' }, h('legend', { text: `Block ${i + 1} (${b.type})${b.generated ? ' — generated' : ''}${b.downgraded ? ` — relabelled from ${b.downgraded.from}` : ''}` }),
    h('div', { class: 'pam-field' }, h('label', { for: `${id}-text`, text: 'Text' }), text),
    h('div', { class: 'pam-field' }, h('label', { for: `${id}-basis`, text: 'Basis (required)' }), basis, h('p', { id: `${id}-basis-help`, class: 'pam-help', text: 'What the text rests on. There is no default.' })),
    h('div', { class: 'pam-field' }, h('label', { for: `${id}-src`, text: 'Sources (urefs, space separated)' }), sources, h('p', { class: 'pam-help' }, ...(b.sources ?? []).map((s) => [ref(s), ' ']))),
    h('div', { class: 'pam-field' }, h('label', { for: `${id}-attr`, text: 'Attribution' }), attr),
    h('div', { class: 'pam-field' }, h('label', { for: `${id}-disc`, text: 'Disclosure' }), disc),
    b.verification ? h('p', { class: 'ws-muted', text: `Verification at last save: ${JSON.stringify(b.verification)}` }) : null,
    h('button', { type: 'button', class: 'ws-button ws-button--danger', onClick: remove }, `Remove block ${i + 1}`));
}
