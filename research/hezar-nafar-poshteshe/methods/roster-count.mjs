import { signIn, engine, signOut } from './pam.mjs';
await signIn();
const r = await engine('knowledge', 'POST', '/v1/roster', { ...(process.argv[2] === 'all' ? {} : { caseId: 'hezar-official-list' }), entityType: 'person', limit: 1 });
console.log('people in roster:', r.total, JSON.stringify(r.counts));
await signOut();
