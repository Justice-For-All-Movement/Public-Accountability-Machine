import { signIn, engine, signOut } from './pam.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';
await signIn();
const items = await engine('discovery', 'GET', `/v1/items?runId=${process.argv[2]}&limit=50`);
mkdirSync(process.argv[3], { recursive: true });
for (const it of items) {
  const full = await engine('discovery', 'GET', `/v1/items/${it.id}`);
  const acq = (full.acquisitions ?? [])[0];
  if (!acq) { console.log('no acquisition for', it.url); continue; }
  const b = await engine('discovery', 'GET', `/v1/acquisitions/${acq.id}/bytes`).catch((e) => ({ error: e.message }));
  const host = new URL(it.url).host;
  if (b.error) { console.log(host, 'bytes error', b.error.slice(0, 150)); continue; }
  const text = typeof b === 'string' ? b : b.bytesBase64 ? Buffer.from(b.bytesBase64, 'base64').toString('utf8') : JSON.stringify(b);
  writeFileSync(`${process.argv[3]}/${host}.html`, text);
  const files = [...new Set([...text.matchAll(/https?:\/\/[^"'\s<>]+\.(?:pdf|xlsx?|csv|docx?|zip)(?:\?[^"'\s<>]*)?/gi)].map((m) => m[0]))];
  console.log(host, 'evidence:', acq.evidenceRef ?? '-', '| bytes:', text.length, '| attachments:', files.slice(0, 6).join(' '));
}
await signOut();
