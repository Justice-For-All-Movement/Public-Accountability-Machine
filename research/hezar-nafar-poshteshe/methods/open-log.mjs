import { signIn, engine, signOut } from './pam.mjs';
import { writeFileSync } from 'node:fs';
await signIn();
const existing = await engine('investigation', 'GET', '/v1/investigations?originRef=' + encodeURIComponent('E05:evidence_version:dd536b0f-7c8f-4469-a1cb-8ecc9abb30b3@1'));
let inv = existing.find?.((i) => i.data?.title?.startsWith('Hezar Nafar Poshteshe')) ?? (existing.items ?? []).find((i) => i.data?.title?.startsWith('Hezar Nafar Poshteshe'));
if (!inv) inv = await engine('investigation', 'POST', '/v1/investigations', {
  title: 'Hezar Nafar Poshteshe: A Thousand Stand Behind Them — list research and decision log',
  originRef: 'E05:evidence_version:dd536b0f-7c8f-4469-a1cb-8ecc9abb30b3@1',
  scopeStatement: 'Build a well-researched list of the people killed by the Islamic Republic of Iran in the events of Dey 1404 (December 2025 – January 2026), starting from the list the government itself published, and research each person (public sources first, later consenting friends, family and associates) up to a memorial profile that could inform a memorial song. This investigation is the project\'s research log: every collection step, method, matching rule, decision, correction and failed attempt is recorded here as an attempt, with references to the stored evidence and records. National ID digits from the official list are never copied into records or this log.',
  originalAccount: { ref: 'E05:evidence_version:dd536b0f-7c8f-4469-a1cb-8ecc9abb30b3@1', summary: 'The Iranian President\'s office published (Dey 1404 / late January – 1 February 2026) a list of people it says were killed in the unrest, announced as 2,986 names; the published spreadsheet holds 2,985 rows (first name, surname, father\'s name, last six digits of national ID). Recorded as the government\'s allegation, not as a verified or complete account.', label: 'allegation' },
  idempotencyKey: 'hezar-research-log-v1',
});
console.log(inv.id, inv.state); writeFileSync('log-id.txt', inv.id);
await signOut();
