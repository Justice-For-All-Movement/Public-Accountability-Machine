// Captures a list of URLs as one discovery run (preserved, with receipts), waits, then saves each page's bytes locally.
import { signIn, engine, signOut, token } from './pam.mjs';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
const [name, base, outDir, urlFile] = process.argv.slice(2);
const urls = JSON.parse(readFileSync(urlFile, 'utf8'));
await signIn();
const src = await engine('discovery', 'POST', '/v1/sources', { name, kind: 'file_list', baseUrl: base, config: { urls, linkScope: 'any' }, accessTerms: 'Public pages; captured for documentation and verification; quotations only, reproduction with permission.', reuse: 'citation_only', rateLimit: { minIntervalMs: 2000 }, idempotencyKey: `hn-src-${name}` });
const run = await engine('discovery', 'POST', '/v1/collections', { sourceId: src.id, level: 'bytes', maxItems: urls.length + 5, idempotencyKey: `hn-run-${name}-${urls.length}` });
for (let i = 0; i < 180; i++) { const r = await engine('discovery', 'GET', `/v1/collections/${run.id}`); if (!['queued', 'running'].includes(r.state)) break; await new Promise((ok) => setTimeout(ok, 5000)); }
const cov = await engine('discovery', 'GET', `/v1/collections/${run.id}/coverage`);
console.log('run', run.id, 'acquired', cov.acquiredBytes, 'failed', cov.failed, 'discovered', cov.discovered);
mkdirSync(outDir, { recursive: true });
const index = [];
let after; const items = [];
for (;;) { const page = await engine('discovery', 'GET', `/v1/items?runId=${run.id}&limit=200${after ? `&after=${after}` : ''}`); items.push(...page); if (page.length < 200) break; after = page.at(-1).id; }
for (const it of items) {
  const full = await engine('discovery', 'GET', `/v1/items/${it.id}`); const acq = full.acquisitions?.[0]; if (!acq) continue;
  for (let tries = 0; tries < 12; tries++) {
    const r = await fetch(`https://pam-em80.onrender.com/api/e/discovery/v1/acquisitions/${acq.id}/bytes`, { headers: { authorization: `Bearer ${await token('research')}` } });
    const buf = Buffer.from(await r.arrayBuffer());
    if (r.ok) { const file = `${outDir}/${index.length}.html`; writeFileSync(file, buf); index.push({ url: it.url, file, evidenceRef: acq.evidenceRef, sha256: acq.sha256 }); break; }
    await new Promise((ok) => setTimeout(ok, 10000)); // quarantine scan still running
  }
}
writeFileSync(`${outDir}/index.json`, JSON.stringify(index, null, 1));
console.log('saved', index.length, 'pages');
await signOut();
