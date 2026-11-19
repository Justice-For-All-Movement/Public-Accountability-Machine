import { signIn, engine, signOut } from './pam.mjs';
await signIn();
const id = process.argv[2];
for (let i = 0; i < 60; i++) {
  const run = await engine('discovery', 'GET', `/v1/collections/${id}`);
  if (!['queued', 'running'].includes(run.state)) break;
  await new Promise((ok) => setTimeout(ok, 10_000));
}
const run = await engine('discovery', 'GET', `/v1/collections/${id}`);
const cov = await engine('discovery', 'GET', `/v1/collections/${id}/coverage`);
console.log('run', run.state, JSON.stringify({ discovered: cov.discovered, acquiredBytes: cov.acquiredBytes, failed: cov.failed, notFound: cov.notFound, restricted: cov.accessRestricted, skipped: cov.skippedByPolicy, gaps: cov.gaps }));
const items = await engine('discovery', 'GET', `/v1/items?runId=${id}&limit=50`).catch((e) => ({ error: e.message }));
for (const it of (Array.isArray(items) ? items : items.items ?? [])) console.log('-', it.state, it.lastOutcome ?? '', (it.url ?? '').slice(0, 70), it.currentAcquisition ? 'acq' : '', it.mediaType ?? '');
if (items.error) console.log(items.error.slice(0, 200));
await signOut();
