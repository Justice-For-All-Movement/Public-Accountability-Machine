// Imports parsed entries of one source as record proposals (resumable), then accepts them.
import { signIn, engine, signOut } from './pam.mjs';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
const [entriesFile, caseId, label, sourceLabel] = process.argv.slice(2);
const entries = JSON.parse(readFileSync(entriesFile, 'utf8')).filter((e) => e.name);
const pf = entriesFile.replace(/\.json$/, '.progress.json');
const p = existsSync(pf) ? JSON.parse(readFileSync(pf, 'utf8')) : { done: {}, proposals: [], accepted: [] };
await signIn();
const todo = entries.filter((e) => !p.done[e.id]);
for (let i = 0; i < todo.length; i += 100) {
  const chunk = todo.slice(i, i + 100);
  const items = chunk.map((e) => ({
    entity: { entityType: 'person', name: e.name, attributes: { ...(e.place ? { placeOfDeath: e.place } : {}), ...(e.date ? { dateOfDeathAsStated: e.date } : {}), ...(e.age ? { ageAsStated: e.age } : {}), sourcePage: e.url, ...(e.number ? { sourceNumber: e.number } : {}) } },
    claims: [{ text: `${sourceLabel} records ${e.name} as killed${e.date ? `, ${e.date}` : ''}${e.place ? `, ${e.place}` : ''}.`, claimType: 'allegation', language: 'fa',
      evidence: [{ evidenceRef: e.evidenceRef, selector: { kind: 'text', quote: e.card.slice(0, 2000) }, stance: 'supports', sourceType: 'secondary', note: `Entry ${e.url}` }] }],
  }));
  const made = await engine('knowledge', 'POST', '/v1/proposals/records', { origin: { kind: 'import', ref: chunk[0].evidenceRef, label }, items, caseId });
  chunk.forEach((e, k) => { p.done[e.id] = made[k]?.id ?? true; }); p.proposals.push(...made.map((m) => m.id));
  writeFileSync(pf, JSON.stringify(p));
}
console.log('proposed', Object.keys(p.done).length, 'of', entries.length);
const pending = p.proposals.filter((id) => !p.accepted.includes(id));
for (let i = 0; i < pending.length; i += 200) {
  const ids = pending.slice(i, i + 200);
  const out = await engine('knowledge', 'POST', '/v1/proposal-reviews', { ids, decision: 'accept', reason: `Faithful transcription of ${sourceLabel}; accepted as a record of what that source says, not as verification.` }).catch((e) => ({ results: [], error: e.message }));
  for (const r of out.results ?? []) if (r.state === 'accepted' || /already been reviewed/.test(JSON.stringify(r.error ?? ''))) p.accepted.push(r.id);
  writeFileSync(pf, JSON.stringify(p));
}
console.log('accepted', p.accepted.length);
await signOut();
