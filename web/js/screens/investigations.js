// Investigations (E08): list/open, question tree, explanations, attempts log, findings with checklist submit/review,
// closure check, package build and viewing (HTML only in a sandboxed iframe; Markdown as text).
import { api } from '../api.js';
import { h, clear, region, section, table, renderEmpty, form, action, dl, ref, badge, sandboxedHtml } from '../ui.js';

const CHECKS = ['primary_source_checked', 'independence_by_source_family', 'counter_evidence_searched', 'alternative_explanations_addressed', 'subject_response_sought', 'dates_identities_confirmed'];
const recBadge = (r) => badge(r.blocked ? 'blocked' : r.stale ? 'stale' : 'ok', { label: r.state, reasons: (r.staleReasons ?? []).map((x) => (typeof x === 'string' ? x : x.reason ?? JSON.stringify(x))) });
const sourcesOf = (text) => (text ?? '').split(/[\s,]+/).filter(Boolean).map((r) => ({ ref: r, selector: 'whole' }));

export async function render(el, ctx) {
  const id = ctx.params.get('id');
  if (id) return detail(el, ctx, id);
  const list = region('Investigations'); const open = region('Open an investigation');
  el.append(list.el, open.el);
  const reload = section(list.body, () => api('investigation', '/v1/investigations', { purpose: ctx.purpose }), (rows, body) => {
    if (rows.length === 0) { renderEmpty(body.appendChild(h('div', {})), 'No investigations yet', 'Open one below, or from an intake case.'); return; }
    table(body, { caption: `Investigations (${rows.length})`, rows, rowHeader: 'title', columns: [
      { key: 'title', label: 'Investigation', render: (r) => h('a', { href: `/investigations?id=${r.id}`, 'data-nav': true }, r.data.title) },
      { key: 'state', label: 'State', render: recBadge }, { key: 'origin', label: 'Origin', render: (r) => ref(r.data.originRef) }, { key: 'ref', label: 'Reference', render: (r) => ref(r.ref) }, { key: 'updatedAt', label: 'Updated' }] });
  });
  open.body.append(form({ legend: 'Investigation', submit: 'Open investigation', fields: [
    { name: 'title', label: 'Title', required: true }, { name: 'originRef', label: 'Origin reference (uref of the intake case, evidence or claim it starts from)', required: true },
    { name: 'scopeStatement', label: 'Scope statement', type: 'textarea', required: true },
    { name: 'summary', label: 'Original account (summary)', type: 'textarea', required: true },
    { name: 'label', label: 'Label of the original account', type: 'select', options: ['allegation', 'attributed_testimony'] }],
    onSubmit: async (v) => { const r = await api('investigation', '/v1/investigations', { purpose: ctx.purpose, body: { title: v.title, originRef: v.originRef, scopeStatement: v.scopeStatement, originalAccount: { summary: v.summary, label: v.label } } }); void reload(); return `Opened ${r.data.title}.`; } }));
}

async function detail(el, ctx, id) {
  el.append(h('p', {}, h('a', { href: '/investigations', 'data-nav': true }, 'Back to all investigations')));
  const holder = h('div', {}); el.append(holder);
  const reload = section(holder, () => api('investigation', `/v1/investigations/${id}/overview`, { purpose: ctx.purpose }), (o, body) => {
    const inv = o.investigation;
    const head = region(inv.data.title); body.append(head.el);
    head.body.append(dl([['State', recBadge(inv)], ['Reference', ref(inv.ref)], ['Origin', ref(inv.data.originRef)], ['Scope', inv.data.scopeStatement], ['Original account', `${inv.data.originalAccount?.summary ?? ''} (${inv.data.originalAccount?.label ?? 'unlabelled'}; inclusion does not assert truth)`]]));
    questions(body, ctx, o, reload); hypotheses(body, ctx, o, reload); attempts(body, ctx, o, reload); findings(body, ctx, o, reload); closure(body, ctx, o, reload);
  });
}

function questions(body, ctx, o, reload) {
  const r = region('Question tree'); body.append(r.el);
  const kids = new Map();
  for (const q of o.questions) { const p = q.data.parentId ?? null; if (!kids.has(p)) kids.set(p, []); kids.get(p).push(q); }
  const tree = (parent) => { const qs = kids.get(parent) ?? []; if (qs.length === 0) return null; return h('ul', {}, qs.map((q) => h('li', {}, h('span', { text: `${q.data.text} ` }), recBadge(q), h('span', { class: 'ws-muted', text: ` ${q.data.material ? 'material' : 'not material'}${q.data.answer ? ` · answer: ${q.data.answer}` : ''} ` }), ref(q.ref, 'inspect'), tree(q.id)))); };
  if (o.questions.length === 0) renderEmpty(r.body.appendChild(h('div', {})), 'No questions yet', 'Add the first question below.');
  else r.body.append(tree(null) ?? h('p', { text: 'No root questions.' }));
  r.body.append(form({ legend: 'Add a question', submit: 'Add question', fields: [
    { name: 'text', label: 'Question', required: true }, { name: 'material', label: 'Material to the investigation', type: 'checkbox', value: true },
    { name: 'whyMaterial', label: 'Why it is material', help: 'Required when material.' },
    { name: 'parentId', label: 'Parent question', type: 'select', options: [{ value: '', label: '(top level)' }, ...o.questions.map((q) => ({ value: q.id, label: q.data.text }))] }],
    onSubmit: async (v) => { await api('investigation', `/v1/investigations/${o.investigation.id}/questions`, { purpose: ctx.purpose, body: { text: v.text, material: v.material, ...(v.whyMaterial ? { whyMaterial: v.whyMaterial } : {}), ...(v.parentId ? { parentId: v.parentId } : {}) } }); setTimeout(reload, 0); return 'Question added.'; } }));
}

function hypotheses(body, ctx, o, reload) {
  const r = region('Explanations (hypotheses)'); body.append(r.el);
  table(r.body, { caption: 'Explanations considered', rows: o.hypotheses, columns: [{ key: 'explanation', label: 'Explanation', render: (x) => h('span', { text: x.data.explanation }) }, { key: 'state', label: 'Status', render: recBadge }, { key: 'q', label: 'Question', render: (x) => h('span', { text: o.questions.find((q) => q.id === x.data.questionId)?.data.text ?? '' }) }, { key: 'ref', label: 'Reference', render: (x) => ref(x.ref) }] });
  if (o.questions.length) r.body.append(form({ legend: 'Add an explanation', submit: 'Add explanation', fields: [
    { name: 'questionId', label: 'Question', type: 'select', required: true, options: o.questions.map((q) => ({ value: q.id, label: q.data.text })) },
    { name: 'explanation', label: 'Explanation', type: 'textarea', required: true }, { name: 'contraryTest', label: 'What would show it is wrong' }],
    onSubmit: async (v) => { await api('investigation', `/v1/questions/${v.questionId}/hypotheses`, { purpose: ctx.purpose, body: { explanation: v.explanation, ...(v.contraryTest ? { contraryTest: v.contraryTest } : {}) } }); setTimeout(reload, 0); return 'Explanation added.'; } }));
}

function attempts(body, ctx, o, reload) {
  const r = region('Attempts log', 2, 'Every search, request and contact is logged, including what was not obtained.'); body.append(r.el);
  table(r.body, { caption: `Attempts (${o.attempts.length})`, rows: o.attempts, columns: [{ key: 'seq', label: 'Seq', numeric: true }, { key: 'at', label: 'When' }, { key: 'kind', label: 'Kind' }, { key: 'target', label: 'Target' }, { key: 'method', label: 'Method' }, { key: 'outcome', label: 'Outcome' }, { key: 'detail', label: 'Detail' }, { key: 'lane', label: 'Lane' }] });
  r.body.append(form({ legend: 'Record an attempt', submit: 'Record attempt', fields: [
    { name: 'kind', label: 'Kind', type: 'select', options: ['search', 'acquisition', 'contact', 'processing', 'knowledge', 'verification', 'other'] },
    { name: 'target', label: 'Target', required: true }, { name: 'method', label: 'Method', required: true },
    { name: 'outcome', label: 'Outcome', type: 'select', options: ['succeeded', 'partial', 'zero_result', 'failed', 'refused', 'access_restricted', 'unavailable', 'uncertain', 'cancelled'] },
    { name: 'detail', label: 'Detail', help: 'Required when nothing was obtained.' },
    { name: 'questionId', label: 'Question', type: 'select', options: [{ value: '', label: '(none)' }, ...o.questions.map((q) => ({ value: q.id, label: q.data.text }))] }],
    onSubmit: async (v) => { await api('investigation', `/v1/investigations/${o.investigation.id}/attempts`, { purpose: ctx.purpose, body: { kind: v.kind, target: v.target, method: v.method, outcome: v.outcome, ...(v.detail ? { detail: v.detail } : {}), ...(v.questionId ? { questionId: v.questionId } : {}) } }); setTimeout(reload, 0); return 'Attempt recorded.'; } }));
}

function findings(body, ctx, o, reload) {
  const r = region('Findings'); body.append(r.el);
  table(r.body, { caption: `Findings (${o.findings.length})`, rows: o.findings, columns: [
    { key: 'statement', label: 'Statement', render: (f) => h('span', { text: f.data.statement }) }, { key: 'state', label: 'State', render: recBadge },
    { key: 'label', label: 'Label / classification', render: (f) => h('span', { text: `${f.data.label} / ${f.data.classification}` }) },
    { key: 'confidence', label: 'Confidence', render: (f) => h('span', { text: `${f.data.confidence?.level ?? ''}: ${f.data.confidence?.basis ?? ''}` }) },
    { key: 'actions', label: 'Actions', sortable: false, render: (f) => h('div', {},
      ['draft', 'returned'].includes(f.state) ? action('Submit for review', async () => { await api('investigation', `/v1/findings/${f.id}/submit`, { purpose: ctx.purpose, body: {} }); setTimeout(reload, 800); return 'Submitted for review.'; }) : null,
      f.state === 'in_review' ? action('Approve', async () => { await api('investigation', `/v1/findings/${f.id}/review`, { purpose: 'editorial', body: { decision: 'approve' } }); setTimeout(reload, 800); return 'Approved.'; }) : null,
      f.state === 'in_review' ? action('Return', async () => { await api('investigation', `/v1/findings/${f.id}/review`, { purpose: 'editorial', body: { decision: 'return', notes: 'Returned from the review screen' } }); setTimeout(reload, 800); return 'Returned to the author.'; }) : null,
      ref(f.ref, 'inspect')) }] });
  if (!o.questions.length) return;
  r.body.append(form({ legend: 'Draft a finding (submission checks the checklist, limitations and sources)', submit: 'Create draft finding', fields: [
    { name: 'statement', label: 'Statement', type: 'textarea', required: true },
    { name: 'label', label: 'Label', type: 'select', options: ['allegation', 'attributed_testimony', 'verified_fact', 'inference', 'unknown'] },
    { name: 'classification', label: 'Classification', type: 'select', options: ['established', 'disputed', 'unknown', 'refuted'] },
    { name: 'questionId', label: 'Question it answers', type: 'select', required: true, options: o.questions.map((q) => ({ value: q.id, label: q.data.text })) },
    { name: 'supporting', label: 'Supporting sources (urefs pinned to a revision, space separated)' },
    { name: 'contradicting', label: 'Contradicting sources (urefs, space separated)' },
    { name: 'limitations', label: 'Limitations (one per line)', type: 'textarea', required: true },
    { name: 'level', label: 'Confidence', type: 'select', options: ['well_supported', 'probable', 'possible', 'uncertain'] }, { name: 'basis', label: 'Basis of the confidence', required: true },
    ...CHECKS.map((c) => ({ name: c, label: `Checklist: ${c.replaceAll('_', ' ')}`, type: 'select', options: ['done', 'not_done', 'not_applicable'] })),
    { name: 'note', label: 'Checklist note (required for not done / not applicable items)' }],
    onSubmit: async (v) => {
      const checklist = Object.fromEntries(CHECKS.map((c) => [c, { status: v[c], note: v.note || (v[c] === 'done' ? 'Done.' : '') }]));
      await api('investigation', `/v1/investigations/${o.investigation.id}/findings`, { purpose: ctx.purpose, body: { statement: v.statement, label: v.label, classification: v.classification, questionIds: [v.questionId], supporting: sourcesOf(v.supporting), contradicting: sourcesOf(v.contradicting), limitations: v.limitations.split('\n').map((x) => x.trim()).filter(Boolean), confidence: { level: v.level, basis: v.basis }, checklist } });
      setTimeout(reload, 0); return 'Draft finding created.';
    } }));
}

function closure(body, ctx, o, reload) {
  const r = region('Closure and packages'); body.append(r.el);
  const c = o.closure;
  r.body.append(h('p', { text: c.ready ? 'Closure check: ready (no blockers).' : `Closure check: not ready — ${c.blockers.length} blocker(s).` }));
  if (c.blockers.length) table(r.body, { caption: 'Blockers', rows: c.blockers, columns: [{ key: 'code', label: 'Code' }, { key: 'message', label: 'Message' }, { key: 'ref', label: 'Object' }] });
  if ((c.warnings ?? []).length) table(r.body, { caption: 'Warnings', rows: c.warnings.map((w) => (typeof w === 'string' ? { message: w } : w)), columns: [{ key: 'code', label: 'Code' }, { key: 'message', label: 'Message' }, { key: 'ref', label: 'Object' }] });
  const viewer = h('div', {});
  r.body.append(h('div', { class: 'pam-toolbar' }, action('Build package', async () => { const p = await api('investigation', `/v1/investigations/${o.investigation.id}/packages`, { purpose: ctx.purpose, body: {} }); setTimeout(reload, 800); return `Package version ${p.version} built (digest ${p.digest}).`; })));
  table(r.body, { caption: `Packages (${o.packages.length})`, rows: o.packages, emptyText: 'No package built yet.', columns: [
    { key: 'version', label: 'Version', numeric: true }, { key: 'builtAt', label: 'Built' }, { key: 'digest', label: 'Digest' },
    { key: 'state', label: 'State', render: (p) => badge(p.blocked ? 'blocked' : p.stale ? 'stale' : 'ok', { label: p.blocked ? 'blocked' : p.stale ? 'stale' : p.current ? 'current' : 'superseded' }) },
    { key: 'view', label: 'View', sortable: false, render: (p) => h('span', {},
      h('button', { type: 'button', class: 'ws-button', onClick: () => showPackage(viewer, ctx, o.investigation.id, p.version, 'html') }, `View version ${p.version}`), ' ',
      h('button', { type: 'button', class: 'ws-button', onClick: () => showPackage(viewer, ctx, o.investigation.id, p.version, 'markdown') }, `Markdown of version ${p.version}`)) }] });
  r.body.append(viewer);
}

function showPackage(el, ctx, id, version, format) {
  clear(el);
  section(el, () => api('investigation', `/v1/investigations/${id}/packages/${version}`, { purpose: ctx.purpose, query: { format } }), (text, body) => {
    const content = typeof text === 'string' ? text : JSON.stringify(text, null, 2);
    body.append(h('h3', { text: `Package version ${version} (${format})` }));
    // The rendering is engine-escaped and script-free, but it is still shown only in a sandbox without scripts.
    body.append(format === 'html' ? sandboxedHtml(content, `Investigation package version ${version}`) : h('pre', { tabindex: '0', text: content }));
  });
}
