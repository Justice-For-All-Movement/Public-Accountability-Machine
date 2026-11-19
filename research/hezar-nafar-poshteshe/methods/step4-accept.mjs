// Accepts the import's record proposals in batches (a mechanical, row-for-row transcription of the official file).
import { signIn, engine, signOut } from './pam.mjs';
import { readFileSync, writeFileSync } from 'node:fs';
const DIR = process.argv[2]; const max = Number(process.argv[3] ?? 5);
const progress = JSON.parse(readFileSync(`${DIR}/import-progress.json`, 'utf8'));
progress.accepted ??= [];
const todo = progress.proposals.filter((id) => !progress.accepted.includes(id)).slice(0, max);
await signIn();
let ok = 0, failed = 0;
for (let i = 0; i < todo.length; i += 200) {
  const ids = todo.slice(i, i + 200);
  const out = await engine('knowledge', 'POST', '/v1/proposal-reviews', { ids, decision: 'accept', reason: 'Row-for-row import of the preserved official spreadsheet (President\'s office list, Dey 1404); each record is pinned to its row. Accepted as a faithful transcription, not as verification.' });
  ok += out.reviewed; failed += out.failed;
  for (const r of out.results) if (r.state === 'accepted') progress.accepted.push(r.id); else if (r.error) console.log('failed', r.id, JSON.stringify(r.error).slice(0, 200));
  writeFileSync(`${DIR}/import-progress.json`, JSON.stringify(progress));
  console.log(`accepted ${ok}, failed ${failed} (of ${todo.length} this pass)`);
}
if (process.argv[4] === 'show') {
  const first = (await engine('knowledge', 'POST', '/v1/roster', { caseId: 'hezar-official-list', entityType: 'person', limit: 3 }));
  console.log('roster total:', first.total, '| counts:', JSON.stringify(first.counts));
  const g = first.groups[0];
  console.log('example group:', JSON.stringify({ names: g.names, attributes: g.attributes ?? g.values, members: (g.members ?? g.records ?? []).length, claims: (g.members ?? g.records ?? [])[0]?.claims?.map((c) => ({ text: c.text, evidence: (c.evidence ?? []).map((e) => e.evidenceRef + ' ' + (e.selectorLabel ?? JSON.stringify(e.selector))) })) }, null, 1).slice(0, 1500));
}
await signOut();
