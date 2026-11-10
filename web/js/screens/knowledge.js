// Knowledge (E07): claims with four independent assessment tracks, evidence links, proposals review, research gaps,
// chronology and the evidence graph (as a table and plain text). No scores: only recorded assessments are shown.
import { api } from '../api.js';
import { h, region, section, table, renderEmpty, form, action, dl, ref, badge } from '../ui.js';

const statusBadge = (r) => badge(r.blocked ? 'blocked' : r.stale || r.status === 'needs_reverification' ? 'stale' : 'ok', { label: r.status ?? r.state });
const TRACKS = { factual: ['unassessed', 'supported', 'contested', 'refuted', 'unresolvable'], source_type: null, procedural: null, editorial: ['not_reviewed', 'approved', 'approved_with_conditions', 'rejected', 'withdrawn'] };

export async function render(el, ctx) {
  const claimId = ctx.params.get('claim');
  if (claimId) return claimDetail(el, ctx, claimId);
  const claims = region('Claims'); const create = region('New claim'); const proposals = region('Proposals awaiting review'); const gaps = region('Research gaps'); const chron = region('Chronology');
  el.append(claims.el, create.el, proposals.el, gaps.el, chron.el);
  const reload = section(claims.body, () => api('knowledge', '/v1/records/claim', { purpose: ctx.purpose }), (rows, body) => {
    if (rows.length === 0) { renderEmpty(body.appendChild(h('div', {})), 'No claims yet', 'Create a claim below or accept a proposal.'); return; }
    table(body, { caption: `Claims (${rows.length})`, rows, rowHeader: 'text', columns: [
      { key: 'text', label: 'Claim', render: (r) => h('a', { href: `/knowledge?claim=${r.id}`, 'data-nav': true }, r.text) }, { key: 'claimType', label: 'Type' }, { key: 'status', label: 'Status', render: statusBadge }, { key: 'ref', label: 'Reference', render: (r) => ref(r.ref) }, { key: 'updatedAt', label: 'Updated' }] });
  });
  create.body.append(form({ legend: 'Claim', submit: 'Create claim', fields: [
    { name: 'text', label: 'Claim text', type: 'textarea', required: true },
    { name: 'claimType', label: 'Type', type: 'select', options: ['allegation', 'attributed_statement', 'observation', 'inference', 'reconstruction_note'] }],
    onSubmit: async (v) => { await api('knowledge', '/v1/claims', { purpose: ctx.purpose, body: { text: v.text, claimType: v.claimType } }); void reload(); return 'Claim created (unassessed).'; } }));
  const reloadProposals = section(proposals.body, () => api('knowledge', '/v1/records/proposal', { purpose: ctx.purpose, query: { state: 'proposed' } }), (rows, body) => {
    if (rows.length === 0) { renderEmpty(body.appendChild(h('div', {})), 'No proposals waiting', 'Proposals from agents, extraction or replies appear here for human review.'); return; }
    table(body, { caption: `Proposals (${rows.length})`, rows, columns: [{ key: 'ref', label: 'Proposal', render: (r) => ref(r.ref) }, { key: 'proposalKind', label: 'Kind', render: (r) => h('span', { text: r.proposalKind ?? r.type ?? r.itemKind ?? '' }) }, { key: 'item', label: 'Proposed content', render: (r) => h('code', { class: 'pam-json', text: JSON.stringify(r.item ?? r.payload ?? {}) }) }, { key: 'origin', label: 'Origin' },
      { key: 'decide', label: 'Decision', sortable: false, render: (r) => h('span', {},
        action('Accept', async () => { await api('knowledge', `/v1/proposals/${r.id}/review`, { purpose: ctx.purpose, body: { decision: 'accept', reason: 'Accepted after review in PAM', expectedRevision: r.revision } }); setTimeout(reloadProposals, 600); return 'Accepted.'; }),
        action('Reject', async () => { await api('knowledge', `/v1/proposals/${r.id}/review`, { purpose: ctx.purpose, body: { decision: 'reject', reason: 'Rejected after review in PAM', expectedRevision: r.revision } }); setTimeout(reloadProposals, 600); return 'Rejected.'; })) }] });
  });
  section(gaps.body, () => api('knowledge', '/v1/research-gaps', { purpose: ctx.purpose }), (g, body) => {
    const rows = (g.gaps ?? []).flatMap((c) => c.gaps.map((x) => ({ claim: c.claim, title: c.title, status: c.status, gap: x.gap, detail: x.detail })));
    if (rows.length === 0) { renderEmpty(body.appendChild(h('div', {})), 'No research gaps', g.notice ?? 'No claims with open gaps.'); return; }
    table(body, { caption: `Research gaps (${rows.length})`, rows, rowHeader: 'title', columns: [{ key: 'title', label: 'Claim' }, { key: 'gap', label: 'Gap' }, { key: 'detail', label: 'Detail' }, { key: 'claim', label: 'Reference' }] });
    if (g.notice) body.append(h('p', { class: 'ws-muted', text: g.notice }));
  });
  section(chron.body, () => api('knowledge', '/v1/chronology', { purpose: ctx.purpose }), (c, body) => {
    if ((c.entries ?? []).length === 0) { renderEmpty(body.appendChild(h('div', {})), 'No dated events', 'Events recorded in the knowledge base appear here in time order.'); return; }
    table(body, { caption: 'Chronology', rows: c.entries.map((e) => ({ ...e, when: typeof e.time === 'object' ? `${e.time?.earliest ?? ''}${e.time?.latest && e.time.latest !== e.time.earliest ? ` – ${e.time.latest}` : ''}` : e.time })), rowHeader: 'title', columns: [{ key: 'when', label: 'When' }, { key: 'title', label: 'Event' }, { key: 'label', label: 'Label' }, { key: 'labelBasis', label: 'Basis' }, { key: 'uncertainty', label: 'Uncertainty' }, { key: 'event', label: 'Reference' }] });
    if (c.notice) body.append(h('p', { class: 'ws-muted', text: c.notice }));
  });
}

async function claimDetail(el, ctx, id) {
  el.append(h('p', {}, h('a', { href: '/knowledge', 'data-nav': true }, 'Back to knowledge')));
  const holder = h('div', {}); el.append(holder);
  const reload = section(holder, () => api('knowledge', `/v1/claims/${id}`, { purpose: ctx.purpose }), (c, body) => {
    const head = region('Claim'); body.append(head.el);
    head.body.append(dl([['Text', c.text], ['Type', c.claimType], ['Status', statusBadge(c)], ['Reference', ref(c.ref)], ['Flags', (c.flags ?? []).length ? c.flags : 'none']]));
    const tracks = region('Assessment tracks', 2, 'Each dimension is recorded independently; none is derived from another and there is no score.'); body.append(tracks.el);
    const a = c.assessments ?? {};
    table(tracks.body, { caption: 'Current assessment per dimension', rows: ['factual', 'source_type', 'procedural', 'editorial'].map((d) => ({ dimension: d, value: a[d]?.value ?? 'not recorded', rationale: a[d]?.rationale ?? '', basis: a[d]?.basis ?? '', at: a[d]?.at ?? '' })), columns: [{ key: 'dimension', label: 'Dimension' }, { key: 'value', label: 'Current value' }, { key: 'rationale', label: 'Rationale' }, { key: 'basis', label: 'Basis' }, { key: 'at', label: 'Recorded' }] });
    if ((a.pendingProposals ?? []).length) table(tracks.body, { caption: 'Pending assessment proposals', rows: a.pendingProposals, columns: [{ key: 'dimension', label: 'Dimension' }, { key: 'value', label: 'Value' }, { key: 'rationale', label: 'Rationale' }, { key: 'actorId', label: 'Proposed by' }] });
    tracks.body.append(form({ legend: 'Record an assessment', submit: 'Record assessment', fields: [
      { name: 'dimension', label: 'Dimension', type: 'select', options: Object.keys(TRACKS) },
      { name: 'value', label: 'Value', required: true, help: `factual: ${TRACKS.factual.join(', ')}; editorial: ${TRACKS.editorial.join(', ')}; source type and procedural use the organization's vocabulary.` },
      { name: 'rationale', label: 'Rationale', type: 'textarea', required: true },
      { name: 'documentedRationale', label: 'Supported on a documented rationale (no released primary source cited)', type: 'checkbox' },
      { name: 'cites', label: 'Evidence link ids cited (space separated)' }],
      onSubmit: async (v) => { await api('knowledge', `/v1/claims/${id}/assessments`, { purpose: v.dimension === 'editorial' ? 'editorial' : ctx.purpose, body: { dimension: v.dimension, value: v.value, rationale: v.rationale, ...(v.documentedRationale ? { documentedRationale: true } : {}), ...(v.cites ? { cites: { linkIds: v.cites.split(/\s+/) } } : {}) } }); setTimeout(reload, 0); return 'Assessment recorded.'; } }));
    const ev = region('Evidence links'); body.append(ev.el);
    const e = c.evidence ?? {};
    const linkCols = [{ key: 'id', label: 'Link id' }, { key: 'evidenceRef', label: 'Evidence' }, { key: 'selector', label: 'Selector' }, { key: 'sourceType', label: 'Source type' }, { key: 'validation', label: 'Validation', render: (l) => h('span', { text: l.validation?.state ?? '' }) }, { key: 'note', label: 'Note' },
      { key: 'retract', label: 'Retract', sortable: false, render: (l) => action('Retract', async () => { await api('knowledge', `/v1/evidence-links/${l.id}/retract`, { purpose: ctx.purpose, body: { expectedRevision: l.revision, reason: 'Retracted in PAM' } }); setTimeout(reload, 600); return 'Retracted (record kept).'; }) }];
    table(ev.body, { caption: `Supporting (${(e.supporting ?? []).length})`, rows: e.supporting ?? [], emptyText: 'No supporting evidence linked.', columns: linkCols });
    table(ev.body, { caption: `Challenging (${(e.challenging ?? []).length})`, rows: e.challenging ?? [], emptyText: 'No challenging evidence linked.', columns: linkCols });
    if ((e.context ?? []).length) table(ev.body, { caption: 'Context', rows: e.context, columns: linkCols });
    if (c.independence) ev.body.append(h('p', { text: `Independence: ${c.independence.independentCorroboration ? 'independent corroboration recorded' : 'no independent corroboration'} (${c.independence.notice ?? ''})` }));
    ev.body.append(form({ legend: 'Link evidence', submit: 'Add evidence link', fields: [
      { name: 'evidenceRef', label: 'Evidence version reference (must pin a revision, for example E05:evidence_version:…@1)', required: true },
      { name: 'stance', label: 'Stance', type: 'select', options: ['supports', 'challenges', 'context'] },
      { name: 'sourceType', label: 'Source type', required: true }, { name: 'note', label: 'Note' }],
      onSubmit: async (v) => { await api('knowledge', '/v1/evidence-links', { purpose: ctx.purpose, body: { target: { kind: 'claim', id }, evidenceRef: v.evidenceRef, stance: v.stance, sourceType: v.sourceType, selector: { kind: 'whole' }, ...(v.note ? { note: v.note } : {}) } }); setTimeout(reload, 0); return 'Evidence linked.'; } }));
    const graph = region('Evidence graph'); body.append(graph.el);
    section(graph.body, () => api('knowledge', '/v1/graphs/evidence', { purpose: ctx.purpose, query: { claimId: id } }), (g, gb) => {
      if (g.table?.rows?.length) table(gb, { caption: 'Evidence graph (as a table)', rows: g.table.rows, columns: g.table.columns.map((col) => ({ key: col.key, label: col.label })) });
      else renderEmpty(gb.appendChild(h('div', {})), 'Nothing linked yet', 'The graph shows evidence, sources and families linked to this claim.');
      if (g.text) gb.append(h('details', {}, h('summary', { text: 'Plain text version' }), h('pre', { tabindex: '0', text: g.text })));
    });
  });
}
