// Rights (E11): permissions (record, review, withdraw with affected outputs), use decisions lookup, holds.
import { api } from '../api.js';
import { h, clear, region, section, table, renderEmpty, form, action, dl, ref, badge } from '../ui.js';

const permBadge = (p) => badge(p.status === 'active' ? (p.reviewState === 'reviewed' ? 'ok' : 'stale') : 'blocked', { label: `${p.status}, ${p.reviewState}` });
const words = (s) => (s ?? '').split(/[\s,]+/).filter(Boolean);

export async function render(el, ctx) {
  const perms = region('Permissions'); const record = region('Record a permission'); const result = h('div', { 'aria-live': 'polite' });
  const decisions = region('Use decisions'); const holds = region('Holds');
  el.append(perms.el, result, record.el, decisions.el, holds.el);
  const reload = section(perms.body, () => api('consent', '/v1/permissions', { purpose: ctx.purpose }), (rows, body) => {
    if (rows.length === 0) { renderEmpty(body.appendChild(h('div', {})), 'No permissions recorded', 'Record what a holder allowed, refused or restricted below.'); return; }
    table(body, { caption: `Permissions (${rows.length})`, rows, rowHeader: 'summary', columns: [
      { key: 'summary', label: 'Permission' }, { key: 'effect', label: 'Effect' }, { key: 'scope', label: 'Scope', render: (p) => h('span', { text: `${p.scope?.type}: ${p.scope?.value}` }) }, { key: 'actions', label: 'Actions' },
      { key: 'status', label: 'Status', render: permBadge }, { key: 'ref', label: 'Reference', render: (p) => ref(p.ref) },
      { key: 'do', label: 'Actions', sortable: false, render: (p) => h('span', {},
        p.reviewState === 'recorded' ? action('Mark reviewed', async () => { await api('consent', `/v1/permissions/${p.id}/review`, { purpose: ctx.purpose, body: { outcome: 'reviewed', expectedRevision: p.revision } }); setTimeout(reload, 400); return 'Reviewed.'; }) : null,
        p.status === 'active' ? action('Withdraw', async () => {
          const w = await api('consent', `/v1/permissions/${p.id}/withdraw`, { purpose: ctx.purpose, body: { reason: 'Withdrawn as recorded in PAM' } });
          clear(result).append(h('h2', { text: 'Withdrawal recorded' }), dl([['Withdrawal', ref(w.withdrawalRef)], ['Scope', w.scope], ['Actions', w.actions], ['Affected outputs', (w.affectedOutputs ?? []).length ? w.affectedOutputs : 'none recorded'], ['Uses needing follow-up', String((w.affectedUses ?? []).length)], ['Decisions now stale', String((w.staleDecisions ?? []).length)]]));
          if ((w.affectedUses ?? []).length) table(result, { caption: 'Affected uses', rows: w.affectedUses, columns: [{ key: 'output', label: 'Output' }, { key: 'action', label: 'Action' }, { key: 'state', label: 'State' }] });
          setTimeout(reload, 400); return `Withdrawn; ${(w.affectedOutputs ?? []).length} affected outputs.`;
        }, { danger: true, confirmText: 'Withdraw this permission? Dependent outputs will be blocked for future use.' }) : null) }] });
  });
  record.body.append(form({ legend: 'Permission', submit: 'Record permission', fields: [
    { name: 'holderRef', label: 'Holder reference (uref of the person or organization who decides)', required: true },
    { name: 'scopeType', label: 'Scope', type: 'select', options: ['subject', 'collection', 'kind', 'pattern'] }, { name: 'scopeValue', label: 'Scope value (for example the evidence uref)', required: true },
    { name: 'effect', label: 'Effect', type: 'select', options: ['allow', 'deny', 'restrict'] }, { name: 'actions', label: 'Actions (space separated, for example publish reproduce quote)', required: true },
    { name: 'purposes', label: 'Purposes (optional)' }, { name: 'audiences', label: 'Audiences (optional)' }, { name: 'restrictions', label: 'Restrictions (optional, comma separated)' },
    { name: 'method', label: 'How it was obtained', type: 'select', options: ['recorded_verbal', 'signed_form', 'intake_checkbox', 'license_document', 'other'] },
    { name: 'evidenceRef', label: 'Evidence of it (uref; required for signed forms and licence documents)' }, { name: 'obtainedAt', label: 'When it was given', type: 'datetime-local' }, { name: 'note', label: 'Note' }],
    onSubmit: async (v) => {
      const holder = await api('consent', '/v1/holders', { purpose: ctx.purpose, body: { ref: v.holderRef } });
      const p = await api('consent', '/v1/permissions', { purpose: ctx.purpose, body: { holderId: holder.id, scope: { type: v.scopeType, value: v.scopeValue }, effect: v.effect, actions: words(v.actions), ...(words(v.purposes).length ? { purposes: words(v.purposes) } : {}), ...(words(v.audiences).length ? { audiences: words(v.audiences) } : {}), ...(v.restrictions ? { restrictions: v.restrictions.split(',').map((x) => x.trim()).filter(Boolean) } : {}),
        provenance: { method: v.method, ...(v.evidenceRef ? { evidenceRef: v.evidenceRef } : {}), ...(v.obtainedAt ? { obtainedAt: new Date(v.obtainedAt).toISOString() } : {}), ...(v.note ? { note: v.note } : {}) } } });
      void reload(); return `Recorded: ${p.summary}. It needs review by another person.`;
    } }));
  const out = h('div', {});
  decisions.body.append(form({ legend: 'Ask for a decision', submit: 'Decide', resetOnSuccess: false, fields: [{ name: 'subjects', label: 'Subjects (urefs, space separated)', required: true }, { name: 'action', label: 'Action (for example publish)', required: true }, { name: 'purpose', label: 'Purpose', required: true }, { name: 'audience', label: 'Audience' }],
    onSubmit: async (v) => { const d = await api('consent', '/v1/use-decisions', { purpose: ctx.purpose, body: { subjects: words(v.subjects), action: v.action, purpose: v.purpose, ...(v.audience ? { audience: v.audience } : {}) } }); clear(out).append(dl([['Decision', d.decision], ['Reference', ref(d.decisionRef)], ['Reasons', d.reasons], ['Restrictions', d.restrictions], ['Policy version', d.policyVersion]])); void loadDecisions(); return `Decision: ${d.decision}.`; } }), out);
  const decList = h('div', {}); decisions.body.append(decList);
  const loadDecisions = () => section(decList, () => api('consent', '/v1/use-decisions', { purpose: ctx.purpose }), (rows, body) => table(body, { caption: `Recorded decisions (${rows.length})`, rows, emptyText: 'No decisions recorded yet.', columns: [{ key: 'decisionRef', label: 'Decision', render: (d) => ref(d.decisionRef ?? d.ref) }, { key: 'decision', label: 'Outcome' }, { key: 'action', label: 'Action' }, { key: 'subjects', label: 'Subjects' }, { key: 'stale', label: 'Stale' }, { key: 'decidedAt', label: 'When' }] }));
  loadDecisions();
  const reloadHolds = section(holds.body, () => api('consent', '/v1/holds', { purpose: ctx.purpose }), (rows, body) => {
    if (rows.length === 0) renderEmpty(body.appendChild(h('div', {})), 'No holds', 'A hold stops use of a subject while a question is open.');
    else table(body, { caption: `Holds (${rows.length})`, rows, columns: [{ key: 'subject', label: 'Subject' }, { key: 'reasonCode', label: 'Reason' }, { key: 'status', label: 'Status' }, { key: 'note', label: 'Note' }, { key: 'rel', label: 'Release', sortable: false, render: (x) => (x.status === 'active' ? action('Release hold', async () => { await api('consent', `/v1/holds/${x.id}/release`, { purpose: ctx.purpose, body: { reason: 'Released in PAM' } }); setTimeout(reloadHolds, 300); return 'Released.'; }) : h('span', { text: '—' })) }] });
    body.append(form({ legend: 'Place a hold', submit: 'Place hold', fields: [{ name: 'subject', label: 'Subject (uref)', required: true }, { name: 'reasonCode', label: 'Reason code', required: true, placeholder: 'safety_review' }, { name: 'note', label: 'Note' }],
      onSubmit: async (v) => { await api('consent', '/v1/holds', { purpose: ctx.purpose, body: { subject: v.subject, reasonCode: v.reasonCode, ...(v.note ? { note: v.note } : {}) } }); setTimeout(reloadHolds, 0); return 'Hold placed.'; } }));
  });
}
