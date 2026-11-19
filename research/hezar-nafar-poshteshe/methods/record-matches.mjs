import { signIn, engine, signOut } from './pam.mjs';
import { readFileSync } from 'node:fs';
await signIn();
const d = JSON.parse(readFileSync(process.argv[2], 'utf8')); let n = 0;
for (let i = 0; i < d.length; i += 200) {
  const r = await engine('knowledge', 'POST', '/v1/entity-match-batches', { decisions: d.slice(i, i + 200), idempotencyKey: `${process.argv[3] ?? "hezar-exact"}-${i}` });
  n += r.recorded; console.log('recorded', n);
}
await signOut();
