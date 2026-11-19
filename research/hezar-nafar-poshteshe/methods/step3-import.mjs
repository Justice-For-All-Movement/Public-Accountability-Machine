// Imports the official list as record proposals: one per spreadsheet row, pinned to the preserved spreadsheet and row.
import { signIn, engine, signOut } from './pam.mjs';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
const DIR = process.argv[2]; const limit = Number(process.argv[3] ?? 5); const batch = Number(process.argv[4] ?? 5);
const rows = JSON.parse(readFileSync(`${DIR}/rows.json`, 'utf8'));
const official = JSON.parse(readFileSync(`${DIR}/official.json`, 'utf8'));
const progressFile = `${DIR}/import-progress.json`;
const progress = existsSync(progressFile) ? JSON.parse(readFileSync(progressFile, 'utf8')) : { done: {}, proposals: [] };
await signIn();
const todo = rows.filter((r) => !progress.done[r.row]).slice(0, limit);
for (let i = 0; i < todo.length; i += batch) {
  const chunk = todo.slice(i, i + batch);
  const items = chunk.map((r) => {
    const name = `${r.first} ${r.last}`.trim();
    return {
      entity: { entityType: 'person', name, attributes: { fatherName: r.father, officialListRow: r.row, officialList: 'President\'s office list, Dey 1404 (Jan 2026)' } },
      claims: [{ text: `The President's office list of people killed in the events of Dey 1404 (January 2026) includes ${name}, father's name ${r.father} (spreadsheet row ${r.row}).`, claimType: 'observation', language: 'fa',
        evidence: [{ evidenceRef: official.xls.evidenceRef, selector: { kind: 'region', region: { sheet: 'Sheet1', row: r.row }, label: `Sheet1, row ${r.row}` }, stance: 'supports', sourceType: 'official_record' }] }],
    };
  });
  const made = await engine('knowledge', 'POST', '/v1/proposals/records', { origin: { kind: 'import', ref: official.xls.evidenceRef, label: 'Official list (President\'s office, 1 Feb 2026), imported row by row' }, items, caseId: 'hezar-official-list' });
  for (const [k, r] of chunk.entries()) { progress.done[r.row] = (made[k] ?? {}).id ?? true; }
  progress.proposals.push(...made.map((m) => m.id));
  writeFileSync(progressFile, JSON.stringify(progress));
  console.log(`batch ${i / batch + 1}: rows ${chunk[0].row}–${chunk.at(-1).row} → ${made.length} proposals`);
}
console.log('total proposed so far:', Object.keys(progress.done).length, 'of', rows.length);
await signOut();
