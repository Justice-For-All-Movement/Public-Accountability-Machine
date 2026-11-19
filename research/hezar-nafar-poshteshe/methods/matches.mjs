import { signIn, engine, signOut } from './pam.mjs';
import { writeFileSync } from 'node:fs';
await signIn();
const r = await engine('knowledge', 'POST', '/v1/entity-match-suggestions', { entityType: 'person', minSimilarity: Number(process.argv[2] ?? 0.9), limit: 5000, maxBlock: 400 });
writeFileSync(process.argv[3], JSON.stringify(r));
console.log('candidates', r.total, 'returned', r.candidates.length, 'truncated', r.truncated, 'compared', r.compared, 'skipped frequent keys', r.skippedFrequentKeys.length);
const c0 = r.candidates[0]; console.log('example keys', Object.keys(c0));
console.log(JSON.stringify(c0).slice(0, 900));
await signOut();
