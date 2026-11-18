// Records across sources (E07 record linkage): the people (or other entities) named by many sources, joined only by
// human identity decisions. Candidate matches are similarity aids; disagreements between sources are shown with every
// value and its records, and nothing is chosen for the reviewer.
import { api } from '../api.js';
import { h, clear, region, section, table, renderEmpty, form, action, ref } from '../ui.js';

const list = (s) => (s ?? '').split(',').map((x) => x.trim()).filter(Boolean);
const fmt = (v) => (v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));

export async function render(el, ctx) {
  const state = { caseId: ctx.params.get('case') ?? '', entityType: ctx.params.get('type') ?? 'person', expect: list(ctx.params.get('expect') ?? '') };
  const scope = region('Scope', 2, 'Choose the case and the attributes every record should have. The roster and candidates below use this scope.');
  const proposals = region('Record proposals awaiting review', 2, 'Each proposal is one mention of one entity in one source, with its quotations. Accepting creates unassessed records; it verifies nothing.');
  const candidates = region('Candidate matches', 2, 'Pairs of records whose written names are similar across spellings and scripts. Similarity decides nothing: record a decision for each pair.');
  const roster = region('Roster', 2, 'One row per person group: records joined by human “same” decisions or merges. Values that differ between records are listed with their sources.');
  const incidents = region('Incidents (research leads)', 2, 'Groups that share a place and a day. This is a lead for research, not a finding that the people were together.');
  const dates = region('Date conversion', 2, 'Converts a date stated in another calendar to the Gregorian day and checks a stated weekday.');
  el.append(scope.el, proposals.el, candidates.el, roster.el, incidents.el, dates.el);
  const scoped = () => ({ ...(state.caseId ? { caseId: state.caseId } : {}), entityType: state.entityType });

  scope.body.append(form({ legend: 'Scope', submit: 'Apply scope', resetOnSuccess: false, fields: [
    { name: 'caseId', label: 'Case identifier (empty = whole project)', value: state.caseId },
    { name: 'entityType', label: 'Entity type', value: state.entityType },
    { name: 'expect', label: 'Expected attributes (comma separated), for example age, dateOfDeath, placeOfDeath', value: state.expect.join(', ') }],
    onSubmit: async (v) => { state.caseId = v.caseId; state.entityType = v.entityType || 'person'; state.expect = list(v.expect); reloadAll(); return 'Scope applied.'; } }));

  const reloadProposals = section(proposals.body, () => api('knowledge', '/v1/records/proposal', { purpose: ctx.purpose, query: { state: 'pending', limit: 500, ...(state.caseId ? { caseId: state.caseId } : {}) } }), (rows, body) => {
    const records = rows.filter((r) => r.proposalType === 'record');
    if (records.length === 0) { renderEmpty(body.appendChild(h('div', {})), 'No record proposals waiting', 'Run the action agent.extract_records on a processed list or bulletin to propose records.'); return; }
    const view = records.map((r) => ({ ...r, name: r.item?.entity?.name ?? '', attributes: Object.entries(r.item?.entity?.attributes ?? {}).map(([k, v]) => `${k}: ${fmt(v)}`).join('; '),
      quotes: (r.item?.claims ?? []).flatMap((c) => (c.evidence ?? []).map((e) => e.excerpt?.quote ?? '')).filter(Boolean).join(' | '), origin: r.origin?.ref ?? r.origin?.kind ?? '' }));
    table(body, { caption: `Record proposals (${view.length})`, rows: view, rowHeader: 'name', columns: [
      { key: 'name', label: 'Name as written' }, { key: 'attributes', label: 'Attributes stated' }, { key: 'quotes', label: 'Quotations' }, { key: 'origin', label: 'Source' },
      { key: 'decide', label: 'Decision', sortable: false, render: (r) => h('span', {},
        action('Accept', async () => { await api('knowledge', `/v1/proposals/${r.id}/review`, { purpose: ctx.purpose, body: { decision: 'accept', reason: 'Accepted after review of the quotation in PAM', expectedRevision: r.revision } }); setTimeout(reloadProposals, 400); return 'Accepted.'; }),
        action('Reject', async () => { await api('knowledge', `/v1/proposals/${r.id}/review`, { purpose: ctx.purpose, body: { decision: 'reject', reason: 'Rejected after review in PAM', expectedRevision: r.revision } }); setTimeout(reloadProposals, 400); return 'Rejected.'; })) }] });
    body.append(h('p', {}, action(`Accept all ${view.length} shown`, async () => {
      const out = await api('knowledge', '/v1/proposal-reviews', { purpose: ctx.purpose, body: { ids: view.slice(0, 500).map((r) => r.id), decision: 'accept', reason: 'Accepted in bulk after review of the listed quotations in PAM' } });
      setTimeout(reloadAll, 400); return `Accepted ${out.reviewed}; ${out.failed} could not be accepted.`;
    }, { confirmText: `Accept all ${view.length} record proposals shown? Accepting creates unassessed records; it verifies nothing.` })));
  });

  const decide = (c, decision) => action(decision === 'same' ? 'Same' : decision === 'different' ? 'Different' : 'Unresolved', async () => {
    await api('knowledge', '/v1/entity-match-batches', { purpose: ctx.purpose, body: { decisions: [{ leftId: c.left.id, rightId: c.right.id, decision, rationale: `Recorded in PAM after comparing “${c.left.name}” and “${c.right.name}”${c.attributes.differ.length ? `; differing: ${c.attributes.differ.map((d) => d.key).join(', ')}` : ''}`, similarity: c.similarity.value }] } });
    setTimeout(() => { void reloadCandidates(); void reloadRoster(); }, 300); return `Recorded: ${decision}.`;
  });
  const reloadCandidates = section(candidates.body, () => api('knowledge', '/v1/entity-match-suggestions', { purpose: ctx.purpose, body: { ...scoped(), limit: 300 } }), (s, body) => {
    if (s.total === 0) { renderEmpty(body.appendChild(h('div', {})), 'No open candidates', `Compared ${s.compared} records; every similar pair has a decision.`); }
    else table(body, { caption: `Candidate pairs (${s.candidates.length} of ${s.total})`, rows: s.candidates.map((c) => ({ ...c, l: c.left.name, r: c.right.name, sim: c.similarity.value, agree: c.attributes.agree.join(', '), differ: c.attributes.differ.map((d) => `${d.key}: ${fmt(d.left)} / ${fmt(d.right)}`).join('; ') })), columns: [
      { key: 'l', label: 'Record A' }, { key: 'r', label: 'Record B' }, { key: 'sim', label: 'Name similarity (aid only)', numeric: true }, { key: 'agree', label: 'Attributes that agree' }, { key: 'differ', label: 'Attributes that differ' },
      { key: 'refs', label: 'References', sortable: false, render: (c) => h('span', {}, ref(c.left.ref), ' ', ref(c.right.ref)) },
      { key: 'decide', label: 'Identity decision', sortable: false, render: (c) => h('span', {}, decide(c, 'same'), decide(c, 'different'), decide(c, 'unresolved')) }] });
    if ((s.skippedFrequentKeys ?? []).length) body.append(h('p', { class: 'ws-notice ws-notice--warn', text: `Not compared through very frequent name parts: ${s.skippedFrequentKeys.slice(0, 12).map((k) => `${k.key} (${k.records})`).join(', ')}. Records sharing only such a part are not suggested.` }));
    body.append(h('p', { class: 'ws-muted', text: s.notice }));
  });

  const rosterFilter = { only: '' };
  const reloadRoster = section(roster.body, () => api('knowledge', '/v1/roster', { purpose: ctx.purpose, body: { ...scoped(), ...(state.expect.length ? { expect: state.expect } : {}), ...(rosterFilter.only ? { only: rosterFilter.only } : {}), limit: 500 } }), (r, body) => {
    const c = r.counts;
    body.append(h('p', { text: `${c.groups} group(s) from ${c.records} record(s); ${c.withConflicts} with disagreements, ${c.withUnresolvedMatches} with unresolved matches, ${c.withMissing} missing an expected attribute, ${c.singleRecord} known from one record only.` }));
    body.append(h('p', {}, ...['', 'conflicts', 'unresolved', 'missing'].map((o) => h('button', { type: 'button', class: 'ws-button', 'aria-pressed': String(rosterFilter.only === o), onClick: () => { rosterFilter.only = o; void reloadRoster(); } }, o === '' ? 'All groups' : o === 'conflicts' ? 'With disagreements' : o === 'unresolved' ? 'With unresolved matches' : 'Missing attributes'))));
    if (r.groups.length === 0) { renderEmpty(body.appendChild(h('div', {})), 'No groups in this view', 'Accept record proposals or change the filter.'); return; }
    const detail = h('div', {});
    table(body, { caption: `Groups (${r.groups.length} of ${r.total})`, rowHeader: 'name', rows: r.groups.map((g) => ({ ...g, other: g.names.filter((n) => n !== g.name).join('; '), n: g.members.length,
      values: Object.entries(g.attributes).map(([k, vs]) => `${k}: ${vs.map((v) => fmt(v.value)).join(' / ')}`).join('; '), conflictText: g.conflicts.join(', '), missingText: g.missing.join(', ') })), columns: [
      { key: 'name', label: 'Name' }, { key: 'other', label: 'Other written names' }, { key: 'n', label: 'Records', numeric: true }, { key: 'values', label: 'Stated values' },
      { key: 'conflictText', label: 'Disagreements' }, { key: 'missingText', label: 'Missing' }, { key: 'unresolvedMatches', label: 'Unresolved matches', numeric: true },
      { key: 'open', label: 'Sources', sortable: false, render: (g) => h('button', { type: 'button', class: 'ws-button', onClick: () => showGroup(detail, g) }, `Show sources for ${g.name}`) }] });
    body.append(detail, h('p', { class: 'ws-muted', text: r.notice }));
  });

  incidents.body.append(form({ legend: 'Group by place and day', submit: 'Find incidents', resetOnSuccess: false, fields: [
    { name: 'placeAttribute', label: 'Place attribute', value: 'placeOfDeath', required: true }, { name: 'dateAttribute', label: 'Date attribute', value: 'dateOfDeath', required: true },
    { name: 'minSize', label: 'Smallest group to list', type: 'number', min: 1, value: '2' }],
    onSubmit: async (v) => {
      const out = await api('knowledge', '/v1/incidents', { purpose: ctx.purpose, body: { ...scoped(), placeAttribute: v.placeAttribute, dateAttribute: v.dateAttribute, ...(v.minSize ? { minSize: v.minSize } : {}) } });
      clear(incidentOut);
      if (out.total === 0) renderEmpty(incidentOut.appendChild(h('div', {})), 'No groups', `${out.groupsWithoutPlaceOrDate} group(s) have no stated place or date.`);
      else table(incidentOut, { caption: `Incidents (${out.incidents.length} of ${out.total})`, rows: out.incidents.map((x) => ({ ...x, placeText: fmt(x.place), people: x.people.map((p) => `${p.name}${p.conflicting ? ' (sources disagree)' : ''}`).join('; ') })), columns: [{ key: 'date', label: 'Day' }, { key: 'placeText', label: 'Place' }, { key: 'size', label: 'People', numeric: true }, { key: 'people', label: 'Names' }] });
      incidentOut.append(h('p', { class: 'ws-muted', text: out.notice }));
      return `${out.total} group(s) found.`;
    } }));
  const incidentOut = h('div', {}); incidents.body.append(incidentOut);

  dates.body.append(form({ legend: 'Date', submit: 'Convert', resetOnSuccess: false, fields: [
    { name: 'calendar', label: 'Calendar', type: 'select', options: ['persian', 'islamic-civil', 'islamic-umalqura', 'islamic-tbla', 'coptic', 'ethiopic', 'indian', 'buddhist', 'roc', 'gregory'] },
    { name: 'year', label: 'Year', type: 'number', required: true }, { name: 'month', label: 'Month (number or name, for example 10 or Dey)', required: true },
    { name: 'day', label: 'Day', type: 'number', required: true }, { name: 'weekday', label: 'Weekday stated by the source (optional, in English)' }, { name: 'locales', label: 'Languages of month names (comma separated, for example en, fa)', value: 'en' }],
    onSubmit: async (v) => {
      const out = await api('knowledge', '/v1/dates/convert', { purpose: ctx.purpose, body: { calendar: v.calendar, year: v.year, month: /^\d+$/.test(v.month) ? Number(v.month) : v.month, day: v.day, ...(v.weekday ? { weekday: v.weekday.toLowerCase() } : {}), locales: list(v.locales) } });
      return `${out.gregorian} (${out.weekday})${out.weekdayMatches === false ? ` — the stated weekday (${out.statedWeekday}) does not match this date` : ''}.`;
    } }));

  function reloadAll() { void reloadProposals(); void reloadCandidates(); void reloadRoster(); }
}

function showGroup(el, g) {
  clear(el);
  const r = region(`Sources for ${g.name}`, 3); el.append(r.el);
  table(r.body, { caption: 'Records in this group', rowHeader: 'name', rows: g.members.map((m) => ({ ...m, attrs: Object.entries(m.attributes ?? {}).map(([k, v]) => `${k}: ${fmt(v)}`).join('; '), claimText: (m.claims ?? []).map((c) => c.text).join(' | '), sources: (m.claims ?? []).flatMap((c) => c.evidenceRefs) })), columns: [
    { key: 'name', label: 'Name as written' }, { key: 'attrs', label: 'Attributes' }, { key: 'claimText', label: 'What the source says' },
    { key: 'sources', label: 'Evidence', sortable: false, render: (m) => h('span', {}, ...m.sources.map((s) => h('span', {}, ref(s), ' '))) }, { key: 'ref', label: 'Record', render: (m) => ref(m.ref) }] });
  const rows = Object.entries(g.attributes).filter(([, vs]) => vs.length > 1).flatMap(([k, vs]) => vs.map((v) => ({ key: k, value: fmt(v.value), records: v.records.length })));
  if (rows.length) table(r.body, { caption: 'Disagreements between records', rows, columns: [{ key: 'key', label: 'Attribute' }, { key: 'value', label: 'Value' }, { key: 'records', label: 'Records stating it', numeric: true }] });
}
