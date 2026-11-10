// Release (E12): candidates built from an investigation package, leak report, review, accountability decision, approval
// of an exact digest, release to a destination, receipts, distribution history, follow-ups and corrections.
import { api, appApi } from '../api.js';
import { h, clear, region, section, table, renderEmpty, form, action, dl, ref, badge, download, sandboxedHtml } from '../ui.js';

const candBadge = (c) => badge(c.state === 'leak_blocked' || c.blocked ? 'blocked' : c.stale ? 'stale' : ['withdrawn', 'superseded'].includes(c.state) ? 'unavailable' : 'ok', { label: c.state, reasons: c.staleReasons?.map((x) => (typeof x === 'string' ? x : x.reason ?? JSON.stringify(x))) });
const lines = (s) => Object.fromEntries((s ?? '').split('\n').map((l) => l.split('=')).filter((p) => p.length >= 2 && p[0].trim()).map(([k, ...v]) => [k.trim(), v.join('=').trim()]));

export async function render(el, ctx) {
  const id = ctx.params.get('id');
  if (id) return candidate(el, ctx, id);
  const cands = region('Candidates'); const build = region('Build a candidate from an investigation package'); const dist = region('Distribution history and follow-ups'); const dests = region('Destinations');
  el.append(cands.el, build.el, dist.el, dests.el);
  const reload = section(cands.body, () => api('release', '/v1/candidates', { purpose: ctx.purpose }), (rows, body) => {
    if (rows.length === 0) { renderEmpty(body.appendChild(h('div', {})), 'No candidates yet', 'Build one from an investigation package below.'); return; }
    table(body, { caption: `Candidates (${rows.length})`, rows, rowHeader: 'title', columns: [
      { key: 'title', label: 'Candidate', render: (c) => h('a', { href: `/release?id=${c.id}`, 'data-nav': true }, `${c.title} (v${c.version})`) }, { key: 'kind', label: 'Kind' }, { key: 'audience', label: 'Audience' }, { key: 'state', label: 'State', render: candBadge }, { key: 'digest', label: 'Digest' }, { key: 'createdAt', label: 'Built' }] });
  });
  section(build.body, async () => ({ investigations: await api('investigation', '/v1/investigations', { purpose: 'research' }).catch(() => []), packs: await api('release', '/v1/jurisdiction-packs', { purpose: ctx.purpose }).catch(() => []) }), ({ investigations, packs }, body) => {
    if (investigations.length === 0) { renderEmpty(body.appendChild(h('div', {})), 'No investigation packages available', 'Build a package on an investigation first (Investigations screen), or your role cannot read investigations.'); return; }
    body.append(form({ legend: 'Candidate', submit: 'Build candidate', fields: [
      { name: 'investigationId', label: 'Investigation (its latest package is used)', type: 'select', options: investigations.map((i) => ({ value: i.id, label: i.data.title })) },
      { name: 'kind', label: 'Kind', type: 'select', options: [{ value: 'chronology', label: 'Chronology' }, { value: 'evidence_bundle', label: 'Evidence bundle (index)' }, { value: 'legal_draft', label: 'Legal-support draft' }, { value: 'investigation_report', label: 'Report' }] },
      { name: 'title', label: 'Title', required: true }, { name: 'audience', label: 'Audience', required: true, value: 'internal_review', help: 'For example internal_review, legal_counsel or public.' },
      { name: 'formats', label: 'Formats', type: 'select', options: [{ value: 'html', label: 'HTML' }, { value: 'html,pdf', label: 'HTML and PDF' }] },
      { name: 'pack', label: 'Jurisdiction pack and document type (legal drafts only)', type: 'select', options: [{ value: '', label: '(none)' }, ...packs.flatMap((p) => p.documentTypes.map((d) => ({ value: `${p.id}::${d}`, label: `${p.name}: ${d}` })))] },
      { name: 'values', label: 'Values for the draft (one name=value per line)', type: 'textarea', rows: 3 },
      { name: 'protectedTerms', label: 'Protected terms that must never appear (one per line)', type: 'textarea', rows: 2 }],
      onSubmit: async (v) => {
        const pkg = await api('investigation', `/v1/investigations/${v.investigationId}/packages/latest`, { purpose: 'research' });
        const input = await appApi('/v1/release/inputs', { purpose: ctx.purpose, body: { package: { ref: pkg.ref, content: pkg.content } } });
        const [packId, documentType] = v.pack ? v.pack.split('::') : [];
        const terms = v.protectedTerms.split('\n').map((x) => x.trim()).filter(Boolean);
        const body2 = { kind: v.kind, title: v.title, audience: v.audience, formats: v.formats.split(','), ...(terms.length ? { protectedTerms: terms } : {}),
          ...(v.kind === 'evidence_bundle' ? { items: input.items } : { package: input.package }),
          ...(v.kind === 'legal_draft' ? { jurisdictionPackId: packId, documentType, values: lines(v.values) } : {}) };
        if (v.kind === 'legal_draft' && !packId) throw new Error('Choose a jurisdiction pack and document type for a legal draft.');
        const c = await api('release', '/v1/packages', { purpose: ctx.purpose, body: body2 });
        void reload();
        return `Candidate built from package version ${pkg.version}: ${c.state}${c.state === 'leak_blocked' ? ' — leak check failed; see the candidate' : ''}.`;
      } }));
  });
  const reloadDist = section(dist.body, () => api('release', '/v1/distributions', { purpose: ctx.purpose }), (rows, body) => {
    if (rows.length === 0) { renderEmpty(body.appendChild(h('div', {})), 'Nothing distributed yet', 'Every release and known copy is recorded here, with follow-ups after corrections.'); return; }
    table(body, { caption: `Distributions (${rows.length})`, rows, columns: [{ key: 'ref', label: 'Distribution' }, { key: 'recipient', label: 'Recipient' }, { key: 'kind', label: 'Kind' }, { key: 'state', label: 'State' }, { key: 'followUpStatus', label: 'Follow-up' }, { key: 'createdAt', label: 'When' },
      { key: 'fu', label: 'Record follow-up', sortable: false, render: (d) => h('span', {}, ...['notified', 'acknowledged', 'unreachable'].map((s) => action(`Mark ${s}`, async () => { await api('release', `/v1/distributions/${d.id}/follow-up`, { purpose: ctx.purpose, body: { status: s, note: 'Recorded in PAM' } }); setTimeout(reloadDist, 400); return `Follow-up: ${s}.`; }))) }] });
  });
  const reloadDest = section(dests.body, () => api('release', '/v1/destinations', { purpose: ctx.purpose }), (rows, body) => {
    if (rows.length === 0) renderEmpty(body.appendChild(h('div', {})), 'No destinations', 'Add one below (administration purpose).');
    else table(body, { caption: 'Destinations', rows, rowHeader: 'name', columns: [{ key: 'name', label: 'Name' }, { key: 'kind', label: 'Kind' }, { key: 'audiences', label: 'Audiences' }, { key: 'public', label: 'Public' }, { key: 'enabled', label: 'Enabled' }, { key: 'ref', label: 'Reference', render: (d) => ref(d.ref) }] });
    body.append(form({ legend: 'New destination', submit: 'Add destination', fields: [{ name: 'name', label: 'Name', required: true }, { name: 'kind', label: 'Kind', type: 'select', options: ['local_directory', 'signed_download', 'public_web', 'http_put', 'webhook', 'email', 'sftp'] }, { name: 'audiences', label: 'Audiences (space separated)', required: true }, { name: 'public', label: 'Public destination', type: 'checkbox' }, { name: 'config', label: 'Configuration (JSON, for example {"root":"review"})', type: 'textarea', rows: 2 }],
      onSubmit: async (v) => { await api('release', '/v1/destinations', { purpose: 'administration', body: { name: v.name, kind: v.kind, audiences: v.audiences.split(/\s+/).filter(Boolean), public: v.public, ...(v.config ? { config: JSON.parse(v.config) } : {}) } }); setTimeout(reloadDest, 0); return 'Destination added.'; } }));
  });
}

async function candidate(el, ctx, id) {
  el.append(h('p', {}, h('a', { href: '/release', 'data-nav': true }, 'Back to candidates')));
  const holder = h('div', {}); el.append(holder);
  const reload = section(holder, async () => {
    const c = await api('release', `/v1/candidates/${id}`, { purpose: ctx.purpose });
    const [approvals, decisions, releases, dests, review] = await Promise.all([api('release', `/v1/releases/${id}/approvals`, { purpose: ctx.purpose }).catch(() => []), api('release', `/v1/candidates/${id}/accountability-decisions`, { purpose: ctx.purpose }).catch(() => []), api('release', '/v1/dispatches', { purpose: ctx.purpose, query: { candidateId: id } }).catch(() => []), api('release', '/v1/destinations', { purpose: ctx.purpose }).catch(() => []), api('release', `/v1/candidates/${id}/review`, { purpose: ctx.purpose }).catch(() => [])]);
    return { c, approvals, decisions, releases, dests, review };
  }, ({ c, approvals, decisions, releases, dests, review }, body) => {
    const head = region(`${c.title} (version ${c.version})`); body.append(head.el);
    head.body.append(dl([['State', candBadge(c)], ['Kind', c.kind], ['Audience', `${c.audience} (${c.audienceClass})`], ['Digest (SHA-256 of manifest.json)', h('code', { text: c.digest ?? 'none' })], ['Reference', ref(c.ref)], ['Lineage', c.lineageId], ['Supersedes', c.supersedes], ['Superseded by', c.supersededBy]]));
    const viewer = h('div', {});
    table(head.body, { caption: 'Components', rows: c.components ?? [], columns: [{ key: 'path', label: 'Path' }, { key: 'role', label: 'Role' }, { key: 'mediaType', label: 'Type' }, { key: 'sha256', label: 'SHA-256' },
      { key: 'view', label: 'View', sortable: false, render: (x) => (/\.(html|md|json|txt|csv|vtt|srt)$/.test(x.path) ? h('button', { type: 'button', class: 'ws-button', onClick: () => showComponent(viewer, ctx, id, x.path) }, `View ${x.path}`) : h('span', { text: '—' })) }] });
    head.body.append(viewer, h('div', { class: 'pam-toolbar' },
      action('Show manifest', async () => { const m = await api('release', `/v1/candidates/${id}/manifest`, { purpose: ctx.purpose }); clear(viewer).append(h('h3', { text: 'manifest.json' }), h('pre', { tabindex: '0', text: JSON.stringify(m, null, 2) })); return 'Manifest shown.'; }),
      action('Download ZIP (private review export)', async () => { const res = await api('release', `/v1/candidates/${id}/package.zip`, { purpose: ctx.purpose, raw: true }); download(await res.blob(), `${c.title.replace(/[^A-Za-z0-9]+/g, '-')}-v${c.version}.zip`); return 'Downloaded.'; })));
    const leak = region('Leak report'); body.append(leak.el);
    leak.body.append(h('pre', { tabindex: '0', text: JSON.stringify(c.leakReport ?? {}, null, 2) }));
    const rev = region('Review'); body.append(rev.el);
    table(rev.body, { caption: 'Review events', rows: Array.isArray(review) ? review : review.events ?? [], columns: [{ key: 'at', label: 'When' }, { key: 'kind', label: 'Event' }, { key: 'outcome', label: 'Outcome' }, { key: 'actorId', label: 'By' }, { key: 'body', label: 'Note' }] });
    if (c.state === 'built') rev.body.append(form({ legend: 'Submit for review', submit: 'Submit for review', fields: [{ name: 'reviewers', label: 'Reviewer actor ids (space separated)', required: true }], onSubmit: async (v) => { await api('release', `/v1/candidates/${id}/review`, { purpose: ctx.purpose, body: { reviewers: v.reviewers.split(/\s+/).filter(Boolean) } }); setTimeout(reload, 0); return 'Submitted.'; } }));
    if (c.state === 'in_review') rev.body.append(h('div', { class: 'pam-toolbar' }, ...['accepted', 'changes_requested'].map((o) => action(o === 'accepted' ? 'Accept this exact digest' : 'Request changes', async () => { await api('release', `/v1/candidates/${id}/review/verdict`, { purpose: ctx.purpose, body: { candidateDigest: c.digest, outcome: o } }); setTimeout(reload, 400); return `Recorded: ${o}.`; }))));
    const acc = region('Accountability decision (required for public release)'); body.append(acc.el);
    table(acc.body, { caption: 'Decisions', rows: decisions, columns: [{ key: 'outcome', label: 'Outcome' }, { key: 'assessment', label: 'Assessment' }, { key: 'policy', label: 'Policy' }, { key: 'decidedBy', label: 'By' }, { key: 'decidedAt', label: 'When' }, { key: 'id', label: 'Decision id' }] });
    acc.body.append(form({ legend: 'Record a decision for this digest', submit: 'Record decision', fields: [{ name: 'outcome', label: 'Outcome', type: 'select', options: ['public_scrutiny_appropriate', 'not_appropriate'] }, { name: 'assessment', label: 'Assessment', type: 'textarea', required: true }, { name: 'noLegalRouteReason', label: 'Why no legal route exists (or describe the routes considered)' }],
      onSubmit: async (v) => { await api('release', `/v1/candidates/${id}/accountability-decisions`, { purpose: ctx.purpose, body: { candidateDigest: c.digest, outcome: v.outcome, assessment: v.assessment, ...(v.noLegalRouteReason ? { noLegalRouteReason: v.noLegalRouteReason } : {}) } }); setTimeout(reload, 0); return 'Decision recorded.'; } }));
    const appr = region('Approval and release'); body.append(appr.el);
    table(appr.body, { caption: 'Approvals', rows: approvals, columns: [{ key: 'id', label: 'Approval id' }, { key: 'state', label: 'State' }, { key: 'invalidReason', label: 'Invalid because' }, { key: 'audience', label: 'Audience' }, { key: 'destinationId', label: 'Destination' }, { key: 'expiresAt', label: 'Expires' },
      { key: 'go', label: 'Release', sortable: false, render: (a) => (a.state === 'valid' ? action('Release now', async () => { const r = await api('release', `/v1/releases/${id}/dispatch`, { purpose: ctx.purpose, body: { approvalId: a.id, audience: a.audience, destinationId: a.destinationId } }); setTimeout(reload, 600); return `Release ${r.state}${r.replayed ? ' (already released; not sent again)' : ''}.`; }) : h('span', { text: '—' })) }] });
    if (c.digest && dests.length) appr.body.append(form({ legend: 'Approve this exact digest', submit: 'Approve', fields: [{ name: 'destinationId', label: 'Destination', type: 'select', options: dests.map((d) => ({ value: d.id, label: `${d.name} (${d.kind})` })) }, { name: 'audience', label: 'Audience', required: true, value: c.audience }, { name: 'expiresAt', label: 'Approval expires at', type: 'datetime-local', required: true }, { name: 'decisionId', label: 'Accountability decision id (public releases)' }],
      onSubmit: async (v) => { await api('release', `/v1/releases/${id}/authorize`, { purpose: ctx.purpose, body: { candidateDigest: c.digest, audience: v.audience, destinationId: v.destinationId, expiresAt: new Date(v.expiresAt).toISOString(), ...(v.decisionId ? { accountabilityDecisionId: v.decisionId } : {}) }, headers: { 'idempotency-key': `approve-${id}-${v.destinationId}-${v.audience}` } }); setTimeout(reload, 0); return 'Approved.'; } }));
    else if (!dests.length) appr.body.append(h('p', { class: 'ws-muted', text: 'No destination exists yet; add one on the Release screen.' }));
    table(appr.body, { caption: 'Releases and receipts', rows: releases, columns: [{ key: 'ref', label: 'Release' }, { key: 'state', label: 'State' }, { key: 'destinationId', label: 'Destination' }, { key: 'receipt', label: 'Receipt' }, { key: 'completedAt', label: 'Completed' }] });
    const corr = region('Correction and withdrawal'); body.append(corr.el);
    corr.body.append(form({ legend: 'Issue a correction (the corrected candidate must be built with this one as superseded)', submit: 'Issue correction', fields: [{ name: 'correctedCandidateId', label: 'Corrected candidate id', required: true }, { name: 'reason', label: 'Reason', type: 'textarea', required: true }],
      onSubmit: async (v) => { const r = await api('release', '/v1/corrections', { purpose: ctx.purpose, body: { priorCandidateId: id, correctedCandidateId: v.correctedCandidateId, reason: v.reason } }); setTimeout(reload, 0); return `Correction issued; ${r.followUps?.length ?? 0} distributions need follow-up.`; } }));
    corr.body.append(form({ legend: 'Withdraw this candidate', submit: 'Request withdrawal', fields: [{ name: 'reason', label: 'Reason', required: true }, { name: 'unpublish', label: 'Also remove it from public destinations', type: 'checkbox' }],
      onSubmit: async (v) => { await api('release', `/v1/releases/${id}/withdraw`, { purpose: ctx.purpose, body: { reason: v.reason, unpublish: v.unpublish } }); setTimeout(reload, 0); return 'Withdrawal requested.'; } }));
    if (c.lineageId) section(corr.body.appendChild(h('div', {})), () => api('release', `/v1/lineages/${c.lineageId}/corrections`, { purpose: ctx.purpose }), (rows, b) => table(b, { caption: 'Corrections in this lineage', rows, emptyText: 'No corrections issued.', columns: [{ key: 'issuedAt', label: 'When' }, { key: 'reason', label: 'Reason' }, { key: 'priorCandidateId', label: 'Prior' }, { key: 'correctedCandidateId', label: 'Corrected' }] }));
  });
}

function showComponent(el, ctx, id, path) {
  clear(el);
  section(el, async () => { const res = await api('release', `/v1/candidates/${id}/component`, { purpose: ctx.purpose, query: { path }, raw: true }); return res.text(); }, (text, body) => {
    body.append(h('h3', { text: path }), path.endsWith('.html') ? sandboxedHtml(text, `Component ${path}`) : h('pre', { tabindex: '0', text }));
  });
}
