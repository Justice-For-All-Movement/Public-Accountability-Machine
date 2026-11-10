// Correspondence (E03): a mail workspace. Inbound content is untrusted: plain text is shown as text and HTML only in a
// sandboxed iframe without scripts. Sending states are shown in words, never as progress.
import { api } from '../api.js';
import { h, clear, region, section, table, renderEmpty, form, action, dl, ref, badge, download, sandboxedHtml, announce } from '../ui.js';

const FOLDERS = ['inbox', 'starred', 'sent', 'drafts', 'outbox', 'archive', 'spam', 'trash', 'all'];
const DISPATCH_WORDS = { queued: 'queued (waiting to be handed to the mail provider)', dispatching: 'dispatching (being handed to the provider now)', accepted: 'in transit (accepted by the provider; delivery not yet confirmed)', delivered: 'delivered', bounced: 'bounced (not delivered)', uncertain: 'uncertain (the outcome is unknown; it will be reconciled, never resent blindly)', not_sent: 'not sent', failed: 'failed (provider refused)', cancelled: 'cancelled before hand-off' };
const dispatchState = (s) => badge(['delivered', 'accepted'].includes(s) ? 'ok' : ['uncertain', 'queued', 'dispatching'].includes(s) ? 'stale' : ['failed', 'bounced', 'not_sent'].includes(s) ? 'failed' : 'unavailable', { label: DISPATCH_WORDS[s] ?? s });

export async function render(el, ctx) {
  const st = { folder: ctx.params.get('folder') ?? 'inbox', labelId: null, q: '', cursors: [null], page: 0, threadId: null };
  const layout = h('div', { class: 'pam-columns pam-columns--side' });
  const side = h('nav', { 'aria-label': 'Mail folders and labels' });
  const mainCol = h('div', {});
  layout.append(side, mainCol);
  el.append(layout);
  const listR = region('Conversations'); const threadR = region('Conversation'); const composeR = region('Compose');
  const queueR = region('Dispatch queue'); const grantsR = region('Sending grants'); const contactsR = region('Contacts'); const mailboxesR = region('Mailboxes');
  mainCol.append(listR.el, threadR.el, composeR.el, queueR.el, grantsR.el, contactsR.el, mailboxesR.el);
  threadR.body.append(h('p', { class: 'ws-muted', text: 'Select a conversation to read it.' }));

  const loadFolders = () => section(side, () => api('correspondence', '/v1/counts', { purpose: ctx.purpose }), (c, body) => {
    body.append(h('h2', { text: 'Folders' }));
    body.append(h('ul', { class: 'pam-folders' }, FOLDERS.map((f) => { const n = c.folders?.[f]; return h('li', {}, h('button', { type: 'button', class: 'ws-button', 'aria-current': st.folder === f && !st.labelId ? 'true' : undefined, onClick: () => { st.folder = f; st.labelId = null; st.cursors = [null]; st.page = 0; loadFolders(); loadList(); } }, h('span', { text: f[0].toUpperCase() + f.slice(1) }), h('span', { text: n ? `${n.total}${n.unread ? ` (${n.unread} unread)` : ''}` : '0' }))); })));
    body.append(h('h2', { text: 'Labels' }));
    if ((c.labels ?? []).length === 0) body.append(h('p', { class: 'ws-muted', text: 'No labels.' }));
    else body.append(h('ul', { class: 'pam-folders' }, c.labels.map((l) => h('li', {}, h('button', { type: 'button', class: 'ws-button', 'aria-current': st.labelId === l.id ? 'true' : undefined, onClick: () => { st.labelId = l.id; st.cursors = [null]; st.page = 0; loadFolders(); loadList(); } }, h('span', { text: l.name }), h('span', { text: `${l.total}` }))))));
    body.append(form({ legend: 'New label', submit: 'Create label', fields: [{ name: 'name', label: 'Label name', required: true }], onSubmit: async (v) => { await api('correspondence', '/v1/labels', { purpose: ctx.purpose, body: { name: v.name } }); setTimeout(loadFolders, 0); return 'Label created.'; } }));
  });

  const listHolder = h('div', {});
  const searchForm = form({ legend: 'Search messages', submit: 'Search', resetOnSuccess: false, fields: [{ name: 'q', label: 'Words to find in this mailbox' }], onSubmit: async (v) => { st.q = v.q; st.cursors = [null]; st.page = 0; loadList(); return v.q ? `Searching for “${v.q}”.` : 'Search cleared.'; } });
  listR.body.append(searchForm, listHolder);
  const loadList = () => section(listHolder, () => api('correspondence', '/v1/conversations', { purpose: ctx.purpose, query: { ...(st.labelId ? { labelId: st.labelId } : { folder: st.folder }), q: st.q, limit: 25, cursor: st.cursors[st.page] } }), (page, body) => {
    const where = st.labelId ? 'label' : `folder ${st.folder}`;
    if (page.items.length === 0) { renderEmpty(body.appendChild(h('div', {})), `No conversations in ${where}`, st.q ? 'Nothing matches the search.' : 'Nothing here yet.'); return; }
    table(body, { caption: `Conversations in ${where}${st.q ? ` matching “${st.q}”` : ''} (${page.total} in total, page ${st.page + 1})`, rows: page.items, rowHeader: 'subject', columns: [
      { key: 'subject', label: 'Subject', render: (t) => h('button', { type: 'button', class: 'ws-link', onClick: () => openThread(t.id) }, `${t.unreadCount ? '[unread] ' : ''}${t.subject || '(no subject)'}`) },
      { key: 'participants', label: 'Participants' }, { key: 'snippet', label: 'Snippet' }, { key: 'messageCount', label: 'Messages', numeric: true },
      { key: 'automation', label: 'Automation', render: (t) => h('span', { text: t.controlMode === 'human' || t.automation === 'human_control' ? 'human control' : t.automation ?? '' }) },
      { key: 'updatedAt', label: 'Updated' }] });
    body.append(h('div', { class: 'pam-toolbar' },
      h('button', { type: 'button', class: 'ws-button', disabled: st.page === 0 ? true : undefined, onClick: () => { st.page--; loadList(); } }, 'Previous page'),
      h('button', { type: 'button', class: 'ws-button', disabled: page.nextCursor ? undefined : true, onClick: () => { st.cursors[st.page + 1] = page.nextCursor; st.page++; loadList(); } }, 'Next page')));
  });

  const openThread = (id) => {
    st.threadId = id;
    section(threadR.body, () => api('correspondence', `/v1/conversations/${id}`, { purpose: ctx.purpose, query: { markRead: 'true' } }), (t, body) => {
      body.append(h('h3', { text: t.subject || '(no subject)', tabindex: '-1', id: 'pam-thread-title' }));
      body.append(dl([['Reference', ref(t.ref)], ['Control', t.controlMode === 'human' ? 'human control (automation stopped)' : `automation: ${t.automation ?? 'none'}`], ['Assignee', t.assignee], ['Contact', t.contact ? `${t.contact.displayName ?? ''} <${t.contact.address}>` : null], ['Question', t.questionRef]]));
      const modify = (patch, msg) => action(msg, async () => { await api('correspondence', '/v1/conversations/modify', { purpose: ctx.purpose, body: { threadIds: [id], ...patch } }); loadFolders(); loadList(); return `${msg}: done.`; });
      body.append(h('div', { class: 'pam-toolbar' },
        modify({ archived: true }, 'Archive'), modify({ starred: !t.starred }, t.starred ? 'Unstar' : 'Star'), modify({ trashed: true }, 'Move to trash'), modify({ read: false }, 'Mark unread'),
        t.controlMode === 'human'
          ? action('Resume automation', async () => { await api('correspondence', `/v1/conversations/${id}/resume`, { purpose: ctx.purpose, body: { reason: 'Resumed from PAM' } }); openThread(id); return 'Automation resumed.'; })
          : action('Take over (stop automation)', async () => { const r = await api('correspondence', `/v1/conversations/${id}/takeover`, { purpose: ctx.purpose, body: { reason: 'Taken over from PAM' } }); setTimeout(() => openThread(id), 1500); return `Taken over; ${r.cancelledDispatches?.length ?? 0} queued sends cancelled, ${r.inTransit?.length ?? 0} already in transit.`; })));
      body.append(form({ legend: 'Assign and label', submit: 'Apply', fields: [{ name: 'assignee', label: 'Assign to (actor id; empty to leave unchanged)' }, { name: 'labelId', label: 'Add label id (from the label list)' }], onSubmit: async (v) => { await api('correspondence', '/v1/conversations/modify', { purpose: ctx.purpose, body: { threadIds: [id], ...(v.assignee ? { assignee: v.assignee } : {}), ...(v.labelId ? { addLabelIds: [v.labelId] } : {}) } }); loadFolders(); return 'Applied.'; } }));
      for (const m of t.messages ?? []) body.append(message(ctx, m));
      if ((t.dispatches ?? []).length) table(body, { caption: 'Sends in this conversation', rows: t.dispatches, columns: [{ key: 'state', label: 'State', render: (d) => dispatchState(d.state) }, { key: 'to', label: 'To' }, { key: 'sendAt', label: 'Send at' }, { key: 'updatedAt', label: 'Updated' }] });
      body.append(composeForm(ctx, { threadId: id, replyToMessageId: t.messages?.at(-1)?.id, subject: t.subject?.startsWith('Re:') ? t.subject : `Re: ${t.subject ?? ''}` }, () => { loadFolders(); openThread(id); }));
      document.getElementById('pam-thread-title')?.focus();
    });
  };

  const mailboxList = await api('correspondence', '/v1/mailboxes', { purpose: ctx.purpose }).catch(() => []);
  if (mailboxList.length === 0) composeR.body.append(h('p', { class: 'ws-notice ws-notice--warn', text: 'No mailbox is configured, so nothing can be drafted yet. Add one under Mailboxes below.' }));
  else composeR.body.append(composeForm(ctx, { mailboxes: mailboxList }, () => { loadFolders(); loadList(); loadQueue(); }));
  const loadQueue = () => section(queueR.body, () => api('correspondence', '/v1/dispatches', { purpose: ctx.purpose }), (rows, body) => {
    if (rows.length === 0) { renderEmpty(body.appendChild(h('div', {})), 'Nothing queued or sent', 'Messages appear here once sending is requested.'); return; }
    table(body, { caption: `Dispatches (${rows.length})`, rows, columns: [{ key: 'state', label: 'State', render: (d) => dispatchState(d.state) }, { key: 'to', label: 'Recipient' }, { key: 'subject', label: 'Subject' }, { key: 'sendAt', label: 'Send at' }, { key: 'ref', label: 'Reference', render: (d) => ref(d.ref) },
      { key: 'actions', label: 'Actions', sortable: false, render: (d) => h('span', {}, d.state === 'queued' ? action('Cancel', async () => { await api('correspondence', `/v1/dispatches/${d.id}/cancel`, { purpose: ctx.purpose, body: { reason: 'Cancelled in PAM' } }); setTimeout(loadQueue, 300); return 'Cancelled.'; }) : null, d.state === 'uncertain' ? action('Reconcile now', async () => { const r = await api('correspondence', `/v1/dispatches/${d.id}/reconcile`, { purpose: ctx.purpose, body: {} }); setTimeout(loadQueue, 300); return `Now: ${DISPATCH_WORDS[r.state] ?? r.state}.`; }) : null) }] });
  });
  const loadGrants = () => section(grantsR.body, () => api('correspondence', '/v1/grants', { purpose: ctx.purpose }), async (rows, body) => {
    if (rows.length === 0) renderEmpty(body.appendChild(h('div', {})), 'No sending grants', 'Agents may only send under a grant created by a person.');
    else table(body, { caption: `Grants (${rows.length})`, rows, columns: [{ key: 'granteeId', label: 'Grantee' }, { key: 'purpose', label: 'Purpose' }, { key: 'state', label: 'State' }, { key: 'maxMessages', label: 'Max messages', numeric: true }, { key: 'used', label: 'Used', numeric: true }, { key: 'recipientAllowlist', label: 'Recipients' }, { key: 'expiresAt', label: 'Expires' },
      { key: 'revoke', label: 'Revoke', sortable: false, render: (g) => (g.state === 'active' ? action('Revoke', async () => { await api('correspondence', `/v1/grants/${g.id}/revoke`, { purpose: 'administration', body: { reason: 'Revoked in PAM' } }); setTimeout(loadGrants, 300); return 'Revoked; queued sends under it were cancelled.'; }, { danger: true }) : h('span', { text: '—' })) }] });
    const mailboxes = await api('correspondence', '/v1/mailboxes', { purpose: ctx.purpose }).catch(() => []);
    body.append(form({ legend: 'New sending grant (people only; uses the administration purpose)', submit: 'Create grant', fields: [
      { name: 'granteeId', label: 'Agent actor id', required: true }, { name: 'mailboxId', label: 'Mailbox', type: 'select', options: mailboxes.map((m) => ({ value: m.id, label: m.address })) },
      { name: 'purpose', label: 'Purpose of the outreach', required: true }, { name: 'recipientAllowlist', label: 'Allowed recipients (space separated)' }, { name: 'domainAllowlist', label: 'Allowed domains (space separated)' },
      { name: 'maxMessages', label: 'Maximum messages', type: 'number', min: 1, required: true }, { name: 'expiresAt', label: 'Expires at', type: 'datetime-local', required: true }],
      onSubmit: async (v) => { const sp = (s) => (s ? s.split(/\s+/).filter(Boolean) : undefined); await api('correspondence', '/v1/grants', { purpose: 'administration', body: { granteeId: v.granteeId, mailboxId: v.mailboxId, purpose: v.purpose, ...(sp(v.recipientAllowlist) ? { recipientAllowlist: sp(v.recipientAllowlist) } : {}), ...(sp(v.domainAllowlist) ? { domainAllowlist: sp(v.domainAllowlist) } : {}), maxMessages: v.maxMessages, expiresAt: new Date(v.expiresAt).toISOString() } }); setTimeout(loadGrants, 0); return 'Grant created.'; } }));
  });
  const loadContacts = () => section(contactsR.body, () => api('correspondence', '/v1/contacts', { purpose: ctx.purpose }), (page, body) => {
    const hist = h('div', {});
    if (page.items.length === 0) renderEmpty(body.appendChild(h('div', {})), 'No contacts', 'Contacts are recorded when you write to someone or plan outreach.');
    else table(body, { caption: `Contacts (${page.total})`, rows: page.items, rowHeader: 'address', columns: [{ key: 'address', label: 'Address' }, { key: 'displayName', label: 'Name' }, { key: 'organization', label: 'Organization' }, { key: 'state', label: 'State' },
      { key: 'history', label: 'History', sortable: false, render: (c) => h('button', { type: 'button', class: 'ws-button', onClick: () => section(hist, () => api('correspondence', `/v1/contacts/${c.id}`, { purpose: ctx.purpose }), (full, hb) => { hb.append(h('h3', { text: `History with ${c.address}` })); table(hb, { caption: 'Contact history', rows: full.history ?? [], columns: [{ key: 'at', label: 'When' }, { key: 'kind', label: 'What' }, { key: 'detail', label: 'Detail' }] }); }) }, `History of ${c.address}`) }] });
    body.append(hist);
  });
  section(mailboxesR.body, () => api('correspondence', '/v1/mailboxes', { purpose: ctx.purpose }), (rows, body) => {
    if (rows.length === 0) renderEmpty(body.appendChild(h('div', {})), 'No mailbox configured', 'An administrator adds a mailbox below; drafts need one.');
    else table(body, { caption: 'Mailboxes', rows, rowHeader: 'address', columns: [{ key: 'address', label: 'Address' }, { key: 'provider', label: 'Provider' }, { key: 'state', label: 'State' }, { key: 'controlMode', label: 'Control' }, { key: 'credentials', label: 'Credentials set', render: (m) => h('span', { text: (m.credentials?.configured ?? []).join(', ') || 'none' }) }] });
    body.append(form({ legend: 'Add a mailbox (administration purpose)', submit: 'Add mailbox', fields: [{ name: 'address', label: 'Address', type: 'email', required: true }, { name: 'displayName', label: 'Display name' }, { name: 'provider', label: 'Provider', type: 'select', options: ['ingest_only', 'smtp_imap', 'gmail', 'graph'], help: 'Provider settings and credentials are completed by an operator; ingest_only needs none.' }],
      onSubmit: async (v) => { await api('correspondence', '/v1/mailboxes', { purpose: 'administration', body: { address: v.address, provider: v.provider, ...(v.displayName ? { displayName: v.displayName } : {}) } }); setTimeout(() => ctx.navigate('/correspondence', { focus: false }), 300); return 'Mailbox added.'; } }));
  });
  loadFolders(); loadList(); loadQueue(); loadGrants(); loadContacts();
}

function message(ctx, m) {
  const el = h('article', { class: 'pam-message', 'aria-label': `Message from ${m.fromAddr}` });
  el.append(h('p', {}, h('strong', { text: m.fromName ? `${m.fromName} <${m.fromAddr}>` : m.fromAddr }), h('span', { class: 'ws-muted', text: ` to ${(m.toAddrs ?? []).join(', ')} · ${m.state} · ${m.receivedAt ?? m.sentAt ?? m.createdAt ?? ''}` })));
  if (m.trust === 'untrusted_external_content') el.append(h('p', { class: 'ws-notice ws-notice--warn', text: 'External message: its content is unverified and is shown as text.' }));
  el.append(h('pre', { tabindex: '0', text: m.bodyText || '(no text part)' }));
  if (m.bodyHtml || m.untrustedHtml) {
    const holder = h('div', {});
    el.append(h('details', {}, h('summary', { text: 'Show the HTML version in a sandbox (no scripts, no network)' }), holder));
    el.querySelector('details').addEventListener('toggle', () => { if (!holder.firstChild) holder.append(sandboxedHtml(m.bodyHtml ?? m.untrustedHtml, `HTML version of the message from ${m.fromAddr}`)); }, { once: true });
  }
  for (const a of m.attachments ?? []) el.append(h('p', {}, action(`Download ${a.filename}`, async () => { const res = await api('correspondence', `/v1/attachments/${a.id}`, { purpose: ctx.purpose, raw: true }); download(await res.blob(), a.filename); return `Downloaded ${a.filename}.`; })));
  if (m.state === 'draft') el.append(h('div', { class: 'pam-toolbar' }, action('Send', async () => { const d = await api('correspondence', `/v1/messages/${m.id}/send`, { purpose: ctx.purpose, body: {}, headers: { 'idempotency-key': `send-${m.id}-${m.revision}` } }); return `Send requested: ${DISPATCH_WORDS[d.state] ?? d.state}.`; })));
  return el;
}

function composeForm(ctx, base, done) {
  const values = { to: '', subject: base.subject ?? '' };
  let draftId = null; let revision = null; let file = null;
  const f = form({ legend: base.threadId ? 'Reply' : 'New message', submit: 'Save draft', resetOnSuccess: false, fields: [
    ...(base.threadId ? [] : [{ name: 'mailboxId', label: 'From mailbox', type: 'select', options: (base.mailboxes ?? []).map((m) => ({ value: m.id, label: m.address })) }, { name: 'to', label: 'To (addresses, comma separated)', required: true, value: values.to }]),
    { name: 'subject', label: 'Subject', value: values.subject }, { name: 'body', label: 'Message', type: 'textarea', rows: 6, required: true },
    { name: 'attachment', label: 'Attachment (optional)', type: 'file' }],
    onSubmit: async (v, formEl) => {
      const to = v.to ? v.to.split(',').map((x) => x.trim()).filter(Boolean) : undefined;
      if (draftId === null) { const d = await api('correspondence', '/v1/messages', { purpose: ctx.purpose, body: { ...(base.threadId ? { threadId: base.threadId, replyToMessageId: base.replyToMessageId } : { mailboxId: v.mailboxId }), ...(to ? { to } : {}), subject: v.subject, body: v.body } }); draftId = d.id; revision = d.revision; }
      else { const d = await api('correspondence', `/v1/messages/${draftId}`, { method: 'PATCH', purpose: ctx.purpose, body: { expectedRevision: revision, ...(to ? { to } : {}), subject: v.subject, body: v.body } }); revision = d.revision; }
      file = v.attachment;
      if (file) { await fetchAttachment(ctx, draftId, file); revision = (await api('correspondence', `/v1/messages/${draftId}`, { purpose: ctx.purpose })).revision; formEl.querySelector('input[type=file]').value = ''; }
      sendBtn.hidden = false; done();
      return 'Draft saved. It is listed under Drafts.';
    } });
  const sendBtn = h('div', { hidden: true }, action('Send this draft', async () => { const d = await api('correspondence', `/v1/messages/${draftId}/send`, { purpose: ctx.purpose, body: {}, headers: { 'idempotency-key': `send-${draftId}-${revision}` } }); announce('Send requested.'); done(); return `Send requested: ${DISPATCH_WORDS[d.state] ?? d.state}.`; }));
  return h('div', {}, f, sendBtn);
}
async function fetchAttachment(ctx, messageId, file) {
  // The attachment route takes the raw bytes as the body; the gateway forwards them unchanged.
  const { tokenFor } = await import('../api.js');
  const res = await fetch(`/api/e/correspondence/v1/messages/${messageId}/attachments?filename=${encodeURIComponent(file.name)}`, { method: 'POST', headers: { authorization: `Bearer ${await tokenFor(ctx.purpose)}`, 'content-type': file.type || 'application/octet-stream' }, body: file });
  if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error?.message ?? `Attachment refused (${res.status})`); }
  return res.json();
}
