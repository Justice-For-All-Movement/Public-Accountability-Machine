// Sealed sources: conversations, notes and documents from people at risk, encrypted in this browser before upload.
// The private key lives only on this device (IndexedDB, non-extractable) and in the backup file the person keeps.
import { appApi, session } from '../api.js';
import { h, region, section, form, action, dl, listOrEmpty, ref, announce } from '../ui.js';
import * as sc from '../sealed-crypto.js';

// ── this device's key (IndexedDB) ──
const DB = 'pam-sealed', STORE = 'keys';
const idb = () => new Promise((ok, fail) => { const r = indexedDB.open(DB, 1); r.onupgradeneeded = () => r.result.createObjectStore(STORE); r.onsuccess = () => ok(r.result); r.onerror = () => fail(r.error); });
async function idbDo(mode, fn) { const db = await idb(); return new Promise((ok, fail) => { const t = db.transaction(STORE, mode); const req = fn(t.objectStore(STORE)); t.oncomplete = () => ok(req?.result); t.onerror = () => fail(t.error); }); }
const slot = (projectKey) => `key:${projectKey}`;
export async function deviceKey(projectKey) { try { return await idbDo('readonly', (s) => s.get(slot(projectKey))) ?? null; } catch { return null; } }
async function keepOnDevice(projectKey, id, publicJwk, privateJwk) {
  const privateKey = await sc.importPrivate(privateJwk, false);   // non-extractable: scripts on this page cannot export it
  await idbDo('readwrite', (s) => s.put({ id, publicJwk, privateKey, savedAt: new Date().toISOString() }, slot(projectKey)));
}
const download = (name, obj) => { const a = h('a', { href: URL.createObjectURL(new Blob([JSON.stringify(obj, null, 1)], { type: 'application/json' })), download: name }); document.body.append(a); a.click(); a.remove(); };

export async function render(el, ctx) {
  const p = ctx.purpose; const projectKey = `${session().tenantId}:${session().projectId}`;
  const intro = region('How sealing works', 2, 'Material from people at risk is encrypted in this browser before it is sent. The server keeps only scrambled text, a code name for the source (S-1, S-2…), the channel, the date and a fingerprint that proves the original was not changed. If the server were broken into, none of it could be read. Real names and contact details are never entered here.');
  const keyR = region('Your sealing key', 2, 'Your private key stays on this device. Keep the backup file and its passphrase somewhere safe and separate (for example a USB stick): without them, sealed material cannot be read on another device, or by anyone, if this device is lost.');
  const srcR = region('Source code names', 2);
  const addR = region('Add a sealed record', 2);
  const listR = region('Sealed records', 2);
  intro.body.append(h('p', {}, 'For the safest reading, use the ', h('a', { href: 'https://github.com/Justice-For-All-Movement/Public-Accountability-Machine/blob/main/tools/sealed-reader.html', rel: 'noreferrer', text: 'offline sealed reader' }), ': save it once, check its fingerprint against docs/SEALED_SOURCES.md, and open downloaded sealed files with it on your own device, without any page from this server.'));
  el.append(intro.el, keyR.el, srcR.el, addR.el, listR.el);

  const reloadKey = section(keyR.body, async () => ({ mine: await deviceKey(projectKey), keys: (await appApi('/v1/sealed/keys', { purpose: p })).keys }), ({ mine, keys }, body) => {
    const registered = mine && keys.some((k) => k.keyId === mine.id);
    body.append(dl([['This device', mine ? `Key ${sc.fingerprintText(mine.id)} ${registered ? '(registered in this project)' : '(not registered in this project)'}` : 'No sealing key on this device'],
      ['Keys that can read new records', keys.length ? keys.map((k) => `${k.label}: ${sc.fingerprintText(k.keyId)}`).join(' · ') : 'none yet']]));
    if (!mine) {
      body.append(form({ legend: 'Create a sealing key on this device', submit: 'Create key and download backup', fields: [
        { name: 'label', label: 'Name for this key (for example "Laptop")', required: true },
        { name: 'passphrase', label: 'Backup passphrase (at least 12 characters; write it down)', type: 'password', required: true, autocomplete: 'new-password' }],
        onSubmit: async (v) => {
          const k = await sc.generateKeyPair();
          const file = await sc.backup(k.privateJwk, k.publicJwk, v.passphrase);
          download(`pam-sealing-key-${k.id.slice(0, 8)}.json`, file);
          await keepOnDevice(projectKey, k.id, k.publicJwk, k.privateJwk);
          await appApi('/v1/sealed/keys', { purpose: p, body: { publicJwk: k.publicJwk, label: v.label } });
          queueMicrotask(reloadKey); return 'Key created, backup downloaded, public key registered.';
        } }));
      body.append(form({ legend: 'Or restore your key from a backup file', submit: 'Restore', fields: [
        { name: 'file', label: 'Backup file', type: 'file', required: true }, { name: 'passphrase', label: 'Backup passphrase', type: 'password', required: true, autocomplete: 'current-password' }],
        onSubmit: async (v) => {
          const k = await sc.restore(JSON.parse(await v.file.text()), v.passphrase);
          await keepOnDevice(projectKey, k.id, k.publicJwk, k.privateJwk);
          await appApi('/v1/sealed/keys', { purpose: p, body: { publicJwk: k.publicJwk, label: 'Restored key' } });
          queueMicrotask(reloadKey); return 'Key restored on this device.';
        } }));
    } else if (!registered) {
      body.append(action('Register this key in this project', async () => { await appApi('/v1/sealed/keys', { purpose: p, body: { publicJwk: mine.publicJwk, label: 'This device' } }); queueMicrotask(reloadKey); return 'Registered.'; }));
    }
  });

  const reloadSources = section(srcR.body, () => appApi('/v1/sealed/sources', { purpose: p }), (out, body) => {
    listOrEmpty(body, out.sources, 'No sources yet', 'Create a code name before adding the first record from a person.', { caption: 'Sources by code name', columns: [
      { key: 'code', label: 'Code' }, { key: 'channel', label: 'Channel' }, { key: 'risk', label: 'Risk' }, { key: 'records', label: 'Records' }, { key: 'note', label: 'Note (no identifying details)' }] });
    body.append(form({ legend: 'New source code name', submit: 'Create code name', fields: [
      { name: 'channel', label: 'Channel', type: 'select', options: ['signal', 'intake', 'email', 'phone', 'in_person', 'briar', 'other'], required: true },
      { name: 'risk', label: 'Risk to this person if exposed', type: 'select', options: ['low', 'medium', 'high', 'severe'], required: true },
      { name: 'note', label: 'Note — never a name, number, address or anything that identifies them' }],
      onSubmit: async (v) => { const o = await appApi('/v1/sealed/sources', { purpose: p, body: { channel: v.channel, risk: v.risk, note: v.note } }); queueMicrotask(reloadSources); return `Created ${o.code}.`; } }));
  });

  section(addR.body, async () => ({ sources: (await appApi('/v1/sealed/sources', { purpose: p })).sources, keys: (await appApi('/v1/sealed/keys', { purpose: p })).keys }), ({ sources, keys }, body) => {
    if (sources.length === 0 || keys.length === 0) { body.append(h('p', { class: 'pam-intro', text: 'Create your sealing key and a source code name first.' })); return; }
    body.append(form({ legend: 'Seal and upload', submit: 'Encrypt here and upload', fields: [
      { name: 'source', label: 'Source code name', type: 'select', options: sources.map((s) => s.code), required: true },
      { name: 'kind', label: 'Kind', type: 'select', options: ['conversation', 'interview_notes', 'document', 'other'], required: true },
      { name: 'date', label: 'Date (YYYY-MM-DD)', type: 'date' },
      { name: 'text', label: 'Text (paste the conversation or notes)', type: 'textarea' },
      { name: 'file', label: 'Attach a file (optional)', type: 'file' }],
      onSubmit: async (v, f) => {
        const file = v.file;
        if (!v.text && !file) throw new Error('Paste text or attach a file');
        const files = file ? [{ name: file.name, type: file.type || 'application/octet-stream', base64: sc.b64(await file.arrayBuffer()) }] : [];
        const envelope = await sc.seal({ text: v.text ?? '', files }, keys.map((k) => ({ id: k.keyId, publicJwk: k.publicJwk })));
        const out = await appApi('/v1/sealed/records', { purpose: p, body: { sourceCode: v.source, kind: v.kind, occurredOn: v.date || undefined, envelope } });
        f?.querySelector?.('form')?.reset(); queueMicrotask(reloadList); announce('Sealed record uploaded.');
        return `Sealed and uploaded as ${out.evidenceRef}. Readable by ${keys.length} key(s).`;
      } }));
  });

  const reloadList = section(listR.body, async () => ({ ...(await appApi('/v1/sealed/records', { purpose: p })), keys: (await appApi('/v1/sealed/keys', { purpose: p })).keys }), (out, body) => {
    const active = out.keys.map((k) => k.keyId);
    const viewer = h('div', { class: 'pam-sealed-viewer' });
    listOrEmpty(body, out.records, 'No sealed records yet', 'Sealed records appear here; only holders of a listed key can open them.', { caption: 'Sealed records, newest first', columns: [
      { key: 'sourceCode', label: 'Source' }, { key: 'kind', label: 'Kind' }, { key: 'occurredOn', label: 'Date' }, { key: 'channel', label: 'Channel' },
      { key: 'evidenceRef', label: 'Evidence', sortable: false, render: (r) => ref(r.evidenceRef, 'evidence') },
      { key: 'recipients', label: 'Readable by', sortable: false, render: (r) => {
        const missing = active.filter((k) => !r.recipients.includes(k));
        const span = h('span', { text: `${r.recipients.filter((k) => active.includes(k)).length} of ${active.length} current keys` });
        if (missing.length === 0) return span;
        return h('span', {}, span, ' ', action('Re-seal for current keys', async () => {
          const mine = await deviceKey(projectKey); if (!mine || !r.recipients.includes(mine.id)) throw new Error('Only someone who can open this record can re-seal it');
          const env = await appApi(`/v1/sealed/records/${encodeURIComponent(r.id)}/envelope`, { purpose: p });
          const next = await sc.reseal(env, mine.id, mine.privateKey, out.keys.map((k) => ({ id: k.keyId, publicJwk: k.publicJwk })));
          await appApi(`/v1/sealed/records/${encodeURIComponent(r.id)}/reseal`, { purpose: p, body: { envelope: next } });
          queueMicrotask(reloadList); return 'Re-sealed; the fingerprint is unchanged.';
        }));
      } },
      { key: 'commitment', label: 'Offline copy', sortable: false, render: (r) => action('Download sealed file', async () => {
        const env = await appApi(`/v1/sealed/records/${encodeURIComponent(r.id)}/envelope`, { purpose: p });
        download(`${r.id}.sealed.json`, { ...env, label: `${r.sourceCode} · ${r.kind}${r.occurredOn ? ` · ${r.occurredOn}` : ''}` });
        return 'Downloaded (still encrypted). Open it with the offline sealed reader.';
      }) },
      { key: 'id', label: 'Open', sortable: false, render: (r) => action('Decrypt here', async () => {
        const mine = await deviceKey(projectKey); if (!mine) throw new Error('No sealing key on this device');
        const env = await appApi(`/v1/sealed/records/${encodeURIComponent(r.id)}/envelope`, { purpose: p });
        const { content, commitmentVerified } = await sc.open(env, mine.id, mine.privateKey);
        viewer.replaceChildren(h('h3', { text: `${r.sourceCode} · ${r.kind}${r.occurredOn ? ` · ${r.occurredOn}` : ''}` }),
          h('p', { class: commitmentVerified ? 'ws-notice' : 'ws-notice ws-notice--warn', text: commitmentVerified ? 'Fingerprint verified: this is the original as sealed.' : 'Fingerprint does NOT match: this content is not what was sealed.' }),
          // Sealed email carries its headers inside the ciphertext; shown as text only.
          ...(content.headers ? [h('pre', { text: [['From', [content.headers.fromName, content.headers.from].filter(Boolean).join(' ')], ['To', (content.headers.to ?? []).join(', ')], ['Cc', (content.headers.cc ?? []).join(', ')], ['Subject', content.headers.subject], ['Date', content.headers.date], ['Message-ID', content.headers.messageId]].filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join('\n') })] : []),
          h('pre', { text: content.text || '(no text)' }),
          ...(content.html ? [h('p', { class: 'ws-muted', text: 'This email also has an HTML version; it is kept in the sealed record and not rendered here.' })] : []),
          ...(content.files ?? []).map((x) => h('p', {}, h('a', { href: URL.createObjectURL(new Blob([sc.unb64(x.base64)], { type: x.type })), download: x.name, text: `Download ${x.name}` }))),
          action('Close', async () => { viewer.replaceChildren(); return 'Closed.'; }));
        return 'Decrypted on this device only.';
      }) }] });
    body.append(viewer);
  });
}
