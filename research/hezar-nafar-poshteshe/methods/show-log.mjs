import { signIn, signOut, engine, LOG_ID } from './pam.mjs';
await signIn();
const a = await engine('investigation', 'GET', `/v1/investigations/${LOG_ID}/attempts`);
console.log('entries', a.length); const l = a[a.length - 1]; console.log(JSON.stringify({ at: l.at ?? l.createdAt, kind: l.kind, target: l.target, outcome: l.outcome, refs: l.refs, detail: l.detail }).slice(0, 900));
await signOut();
