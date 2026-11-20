#!/usr/bin/env node
// Builds tools/sealed-reader.html: a single self-contained page that opens sealed records offline. It inlines
// web/js/sealed-crypto.js, loads nothing, and its content-security policy forbids any network connection, so it does not
// depend on pages served by a PAM server. Prints the file's SHA-256 so people can check their copy.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const crypto = readFileSync(new URL('../web/js/sealed-crypto.js', import.meta.url), 'utf8').replace(/^export \{[^}]*\};?\s*$/m, '').replace(/^export /gm, '');
const page = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src blob:; connect-src 'none'; form-action 'none'; base-uri 'none'">
<meta name="referrer" content="no-referrer"><title>PAM sealed reader (offline)</title>
<style>
:root { color-scheme: light dark; --bg: #fff; --fg: #111; --muted: #555; --line: #bbb; --ok: #0a6b2e; --bad: #a40000; }
@media (prefers-color-scheme: dark) { :root { --bg: #111; --fg: #eee; --muted: #aaa; --line: #555; --ok: #6fd18f; --bad: #ff8a80; } }
body { font: 16px/1.5 system-ui, sans-serif; background: var(--bg); color: var(--fg); max-width: 50rem; margin: 0 auto; padding: 1rem; }
fieldset { border: 1px solid var(--line); margin: 1rem 0; padding: 0.75rem; } label { display: block; margin: 0.5rem 0 0.25rem; }
input, button { font: inherit; } button { padding: 0.3rem 0.8rem; margin-top: 0.5rem; } pre { white-space: pre-wrap; border: 1px solid var(--line); padding: 0.5rem; }
.ok { color: var(--ok); font-weight: 600; } .bad { color: var(--bad); font-weight: 600; } .muted { color: var(--muted); }
:focus-visible { outline: 3px solid currentColor; outline-offset: 2px; }
</style></head><body>
<h1>PAM sealed reader</h1>
<p class="muted">Works offline from this file. It cannot connect to any network. Nothing you open here leaves this device.</p>
<fieldset><legend>1. Your sealing key</legend>
<label for="kf">Key backup file</label><input id="kf" type="file" accept=".json,application/json">
<label for="pp">Passphrase</label><input id="pp" type="password" autocomplete="off">
<button id="unlock" type="button">Unlock key</button><p id="ks" role="status"></p></fieldset>
<fieldset><legend>2. Sealed records</legend>
<label for="rf">Sealed files (downloaded from PAM)</label><input id="rf" type="file" accept=".json,application/json" multiple>
<button id="openb" type="button">Open</button></fieldset>
<section id="out" aria-live="polite"></section>
<script>
${crypto}
let key = null;
const $ = (id) => document.getElementById(id);
const el = (tag, text, cls) => { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; if (cls) e.className = cls; return e; };
$('unlock').addEventListener('click', async () => {
  try { const f = $('kf').files[0]; if (!f) throw new Error('Choose your key backup file');
    const k = await restore(JSON.parse(await f.text()), $('pp').value); key = { id: k.id, privateKey: await importPrivate(k.privateJwk, false) };
    $('pp').value = ''; $('ks').textContent = 'Key unlocked: ' + fingerprintText(k.id); $('ks').className = 'ok';
  } catch (e) { $('ks').textContent = e.message; $('ks').className = 'bad'; }
});
$('openb').addEventListener('click', async () => {
  const out = $('out'); out.replaceChildren();
  if (!key) { out.append(el('p', 'Unlock your key first.', 'bad')); return; }
  for (const f of $('rf').files) {
    const box = el('article'); box.append(el('h2', f.name));
    try { const env = JSON.parse(await f.text()); if (env.label) box.append(el('p', env.label, 'muted'));
      const r = await open(env, key.id, key.privateKey);
      box.append(el('p', r.commitmentVerified ? 'Fingerprint verified: this is the original as sealed.' : 'Fingerprint does NOT match: this is not what was sealed.', r.commitmentVerified ? 'ok' : 'bad'));
      box.append(el('pre', r.content.text || '(no text)'));
      for (const x of r.content.files || []) { const a = el('a', 'Save attachment: ' + x.name); a.href = URL.createObjectURL(new Blob([unb64(x.base64)], { type: x.type })); a.download = x.name; box.append(el('p')); box.lastChild.append(a); }
    } catch (e) { box.append(el('p', e.message, 'bad')); }
    out.append(box);
  }
});
</script></body></html>
`;
writeFileSync(new URL('../tools/sealed-reader.html', import.meta.url), page);
console.log('tools/sealed-reader.html sha256', createHash('sha256').update(page).digest('hex'));
