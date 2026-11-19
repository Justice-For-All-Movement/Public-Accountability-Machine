import { signIn, engine, signOut } from './pam.mjs';
await signIn();
for (const id of process.argv.slice(2)) {
  let a;
  for (let i = 0; i < 30; i++) { a = await engine('discovery', 'GET', `/v1/discovery/searches/${id}`).catch((e) => ({ error: e.message })); if (a.error || !['queued', 'running'].includes(a.state)) break; await new Promise((ok) => setTimeout(ok, 5000)); }
  if (a.error) { console.log(id, a.error.slice(0, 200)); continue; }
  console.log(id.slice(0, 8), a.state, 'results:', a.resultCount, a.error ?? '');
  const items = await engine('discovery', 'GET', `/v1/items?runId=${a.runId}&limit=10`).catch(() => []);
  for (const it of items.slice(0, 6)) console.log('   ', (it.title ?? '').slice(0, 70), '|', (it.url ?? '').slice(0, 80));
}
await signOut();
