// Runs one research step and records it: the script's SHA-256, the method repository commit, the arguments, UTC start
// and end, exit status and complete output. The run record is stored in evidence storage (E05) and a research-log entry
// (E08 attempt) points to it. Usage: node run.mjs "<what this run is for>" <script> [args…]
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { signIn, signOut, logStep, storeEvidence } from './pam.mjs';
const [purpose, script, ...args] = process.argv.slice(2);
if (!purpose || !script) { console.error('usage: node run.mjs "<purpose>" <script> [args…]'); process.exit(2); }
const sha256 = createHash('sha256').update(readFileSync(script)).digest('hex');
const interpreter = script.endsWith('.py') ? ['python3', ['-I', script, ...args]] : ['node', [script, ...args]];
const started = new Date().toISOString(); let output = '';
const code = await new Promise((ok) => {
  const p = spawn(interpreter[0], interpreter[1], { env: process.env });
  const take = (d) => { const s = d.toString(); if (!/UNDICI-EHPA|trace-warnings/.test(s)) { output += s; process.stdout.write(s); } };
  p.stdout.on('data', take); p.stderr.on('data', take); p.on('close', ok);
});
const finished = new Date().toISOString();
const record = { purpose, script, scriptSha256: sha256, methodsRepo: 'Justice-For-All-Movement/Public-Accountability-Machine research/hezar-nafar-poshteshe/methods', args, interpreter: interpreter[0], runtime: { node: process.version }, started, finished, exitCode: code, output: output.slice(-200_000) };
await signIn();
const ref = await storeEvidence(JSON.stringify(record, null, 1), `run-${started.replace(/[:.]/g, '-')}-${script.replace(/[^A-Za-z0-9._-]/g, '_')}.json`, 'application/json', `Research run record: ${purpose}`);
await logStep({ kind: 'processing', target: purpose, method: `${interpreter[0]} ${script} ${args.join(' ')}`.slice(0, 500), outcome: code === 0 ? 'succeeded' : 'failed', refs: [ref].filter((r) => r.startsWith('E05:')),
  detail: `Run ${started} → ${finished} UTC, exit ${code}. Script SHA-256 ${sha256}. Full output and arguments in ${ref}. Last output lines:\n${output.trim().split('\n').slice(-8).join('\n')}` });
await signOut();
process.exit(code ?? 1);
