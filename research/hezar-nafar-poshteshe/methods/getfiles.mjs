// Downloads the two preserved official files (exact captured bytes) for parsing; records their evidence refs and digests.
import { signIn, engine, signOut } from './pam.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
await signIn();
mkdirSync(process.argv[2], { recursive: true });
const out = {};
for (const [k, runId] of [['pdf', 'f7cc2c5d-9026-43b9-8985-26db8eaea2a0'], ['xls', '71c6b545-a33e-4cbc-9480-f4fb30978e49']]) {
  const [it] = await engine('discovery', 'GET', `/v1/items?runId=${runId}&limit=5`);
  const full = await engine('discovery', 'GET', `/v1/items/${it.id}`);
  const acq = full.acquisitions[0];
  const r = await fetch(`https://pam-em80.onrender.com/api/e/discovery/v1/acquisitions/${acq.id}/bytes`, { headers: { authorization: `Bearer ${await (await import('./pam.mjs')).token('research')}` } });
  const buf = Buffer.from(await r.arrayBuffer());
  writeFileSync(`${process.argv[2]}/official.${k}`, buf);
  out[k] = { evidenceRef: acq.evidenceRef, sha256: acq.sha256, size: buf.length, localSha256: createHash('sha256').update(buf).digest('hex'), url: it.url };
  console.log(k, acq.evidenceRef, 'bytes', buf.length, 'digest matches capture:', out[k].localSha256 === acq.sha256, r.headers.get('content-type'));
}
writeFileSync(`${process.argv[2]}/official.json`, JSON.stringify(out, null, 2));
await signOut();
