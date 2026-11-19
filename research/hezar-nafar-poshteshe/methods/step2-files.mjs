import { signIn, engine, signOut } from './pam.mjs';
await signIn();
const sourceId = 'f77df3c5-e6b5-4867-ac9a-ab7e83b08257';
const src = await engine('discovery', 'GET', `/v1/sources/${sourceId}`);
const hosts = [...new Set([...(src.config.allowedHosts ?? []), 'media.mehrnews.com', 'cdn.jamaran.news'])];
await engine('discovery', 'PATCH', `/v1/sources/${sourceId}`, { config: { ...src.config, allowedHosts: hosts } }).catch(async (e) => {
  if (e.status === 404 || e.status === 405) await engine('discovery', 'POST', `/v1/sources/${sourceId}`, { config: { ...src.config, allowedHosts: hosts } }); else throw e; });
const files = { pdf: 'https://media.mehrnews.com/d/2026/02/01/0/5887639.pdf?ts=1769955111592', xls: process.argv[2] };
for (const [k, url] of Object.entries(files)) {
  const run = await engine('discovery', 'POST', '/v1/acquisitions', { sourceId, url, level: 'bytes', idempotencyKey: `hn-official-${k}` });
  console.log(k, 'run', run.id ?? run.run?.id, run.state ?? run.run?.state);
}
await signOut();
