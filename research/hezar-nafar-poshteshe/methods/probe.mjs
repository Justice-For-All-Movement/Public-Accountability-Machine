// Captures a few pages through the hosted discovery engine (preserved with receipts) and prints their structure locally.
import { signIn, engine, signOut } from './pam.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';
await signIn();
const [name, base, ...urls] = process.argv.slice(2);
const src = await engine('discovery', 'POST', '/v1/sources', { name, kind: 'file_list', baseUrl: base, config: { urls, linkScope: 'any' }, accessTerms: 'Public memorial pages; captured for documentation; reproduction only with family consent.', reuse: 'citation_only', rateLimit: { minIntervalMs: 2500 }, idempotencyKey: `hn-probe-${name}` });
const run = await engine('discovery', 'POST', '/v1/collections', { sourceId: src.id, level: 'bytes', maxItems: urls.length, idempotencyKey: `hn-probe-run-${name}-${urls.length}` });
for (let i = 0; i < 40; i++) { const r = await engine('discovery', 'GET', `/v1/collections/${run.id}`); if (!['queued', 'running'].includes(r.state)) break; await new Promise((ok) => setTimeout(ok, 5000)); }
mkdirSync(`${process.argv[1].replace(/[^/]+$/, '')}probe`, { recursive: true });
for (const it of await engine('discovery', 'GET', `/v1/items?runId=${run.id}&limit=20`)) {
  const full = await engine('discovery', 'GET', `/v1/items/${it.id}`); const acq = full.acquisitions?.[0];
  if (!acq) { console.log('NOT acquired', it.state, it.url); continue; }
  const r = await fetch(`https://pam-em80.onrender.com/api/e/discovery/v1/acquisitions/${acq.id}/bytes`, { headers: { authorization: `Bearer ${await (await import('./pam.mjs')).token('research')}` } });
  const t = Buffer.from(await r.arrayBuffer()).toString('utf8');
  const f = `${process.argv[1].replace(/[^/]+$/, '')}probe/${encodeURIComponent(it.url).slice(0, 120)}.html`; writeFileSync(f, t);
  console.log('acquired', it.url, t.length, 'bytes', acq.evidenceRef);
}
console.log('source', src.id);
await signOut();
