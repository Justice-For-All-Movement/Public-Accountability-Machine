import { signIn, signOut, logStep, storeEvidence } from './pam.mjs';
import { readFileSync } from 'node:fs';
await signIn();
const runs = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const ref = await storeEvidence(readFileSync(process.argv[2]), 'hezar-run-history-2026-11-19.json', 'application/json', 'Complete run history of the Hezar Nafar Poshteshe research steps on 2026-11-19, extracted from the working session (commands verbatim, credentials redacted, start of each output)', 'hezar-run-history-2026-11-19');
await logStep({ kind: 'other', target: 'Run history of every command used for the research so far', method: 'Extracted from the working session transcript (script extract_runs.py): each shell command with UTC start/finish, description, failure flag and the first 3,000 characters of its output; anything resembling a credential replaced by [REDACTED]', outcome: 'succeeded', refs: [ref],
  detail: `${runs.length} commands from ${runs[0].started} to ${runs[runs.length - 1].started} (UTC), including one-off inline analysis scripts, failed attempts and their fixes. Commands run in the background show a finish time equal to their start; their real completion time is in the engines' audit trail. Hosted PAM ran commit 8ba44c2 until 20:49 UTC and c7a480d from 20:54 to 21:42 UTC (Render deploy history); all list capture, import and linking ran on c7a480d. From 21:43 UTC every step is run through run.mjs, which stores its own run record.` });
console.log(ref);
await signOut();
