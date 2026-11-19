#!/usr/bin/env node
// Runs one research step under the PAM research record standard (docs/RESEARCH_RECORD_STANDARD.md):
// registers the script (and any extra files it uses) by exact source, starts a research run, runs the script with
// PAM_RUN_ID / PAM_URL / PAM_TOKEN in its environment (it must send `x-pam-run: $PAM_RUN_ID` on every write), captures its
// complete output, and finishes the run with exit status and output. Nothing is changed in PAM outside the run.
//
//   PAM_URL=https://pam.example.org PAM_TOKEN=<research access token> \
//     node scripts/research-run.mjs --purpose "Capture list pages 1–51" [--kind acquisition] [--tool extra.py …] [--env key=value …] \
//       -- python3 -I capture.py --pages 51
//
// The script file is the first argument after `--` that names an existing file (after the interpreter, if any).
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';

const argv = process.argv.slice(2);
const sep = argv.indexOf('--');
if (sep === -1 || sep === argv.length - 1) { console.error('usage: research-run.mjs --purpose "<why>" [--kind k] [--tool file …] [--env k=v …] [--summary "<text>"] -- <command…>'); process.exit(2); }
const opts = argv.slice(0, sep), command = argv.slice(sep + 1);
const take = (name) => { const out = []; for (let i = 0; i < opts.length; i++) if (opts[i] === name) out.push(opts[++i]); return out; };
const purpose = take('--purpose')[0], kind = take('--kind')[0] ?? 'processing', summaryText = take('--summary')[0];
if (!purpose) { console.error('--purpose is required: say what this run is for'); process.exit(2); }
const base = process.env.PAM_URL, token = process.env.PAM_TOKEN;
if (!base || !token) { console.error('PAM_URL and PAM_TOKEN must be set'); process.exit(2); }

async function call(path, body) {
  const res = await fetch(`${base}/api/app${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${path}: ${res.status} ${JSON.stringify(json?.error ?? json)}`);
  return json;
}

const files = [...new Set([command.find((a, i) => i > 0 && existsSync(a)) ?? (existsSync(command[0]) ? command[0] : null), ...take('--tool')].filter(Boolean))];
if (files.length === 0) { console.error('No script file found in the command; name extra files with --tool'); process.exit(2); }
const tools = [];
for (const f of files) {
  const t = await call('/v1/research/tools', { name: basename(f), description: `Research tool ${basename(f)}`, filename: basename(f), contentBase64: readFileSync(f).toString('base64') });
  tools.push(t.sha256); console.error(`[research-run] tool ${basename(f)} sha256 ${t.sha256}${t.created ? ' (registered)' : ''}`);
}
const environment = { node: process.version, platform: process.platform, ...Object.fromEntries(take('--env').map((kv) => [kv.split('=')[0], kv.split('=').slice(1).join('=')])) };
const run = await call('/v1/research/runs', { purpose, tools, command: command.join(' '), environment });
console.error(`[research-run] run ${run.id} started; research log ${run.logInvestigationId ?? '(none)'}`);

let output = '';
const code = await new Promise((ok) => {
  const p = spawn(command[0], command.slice(1), { env: { ...process.env, PAM_RUN_ID: run.id } });
  const pass = (stream) => (d) => { output += d.toString(); stream.write(d); };
  p.stdout.on('data', pass(process.stdout)); p.stderr.on('data', pass(process.stderr));
  p.on('error', (e) => { output += `\n[failed to start: ${e.message}]\n`; ok(127); }); p.on('close', (c) => ok(c ?? 1));
});
const last = output.trim().split('\n').slice(-5).join(' / ').slice(0, 1500);
const done = await call(`/v1/research/runs/${run.id}/finish`, { exitCode: code, kind, summary: summaryText ?? `Exit ${code}. Last output: ${last || '(none)'}`, outputBase64: Buffer.from(output).toString('base64'), outputFilename: `${run.id}.log` });
console.error(`[research-run] run ${run.id} finished: ${done.outcome}; output ${done.outputRef ?? 'not stored'}; log entry ${done.logAttemptId ?? `not written (${done.logError})`}`);
process.exit(code);
