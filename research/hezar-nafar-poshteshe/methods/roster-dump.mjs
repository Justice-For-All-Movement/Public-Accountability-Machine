import { signIn, engine, signOut } from './pam.mjs';
import { writeFileSync } from 'node:fs';
await signIn();
const [caseId, out] = process.argv.slice(2); const all = [];
for (let offset = 0; ; offset += 2000) {
  const r = await engine('knowledge', 'POST', '/v1/roster', { caseId, entityType: 'person', offset, limit: 2000 });
  all.push(...r.groups); if (offset + 2000 >= r.total) break;
}
writeFileSync(out, JSON.stringify(all)); console.log(caseId, all.length); console.log(JSON.stringify(all[0]).slice(0, 1500));
await signOut();
