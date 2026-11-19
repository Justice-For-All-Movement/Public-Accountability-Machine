# Writes the public run index (RUNS.md) from the extracted run history: times, descriptions, results and commands; no outputs.
import json, sys
runs = json.load(open(sys.argv[1]))
F = '`' * 3
out = ['# Run index', '',
 "Every command run for this research, in order, with UTC times. Commands are verbatim except that credentials are replaced by `[REDACTED]`; paths show the working folder of the machine that ran them (in the scripts here it is `HEZAR_WORKDIR`). Outputs are not published here because they contain many people's names. The complete history with outputs is stored in PAM evidence `E05:evidence_version:ed0a9353-db31-4177-ac77-8e860a43b983@1`; each run after 2026-11-19 21:43 UTC has its own run record linked from the research log.", '',
 "A command whose finish time equals its start was started in the background; its real completion time is in the engines' audit trail.", '',
 '| # | Started (UTC) | Finished (UTC) | What it did | Result |', '| --- | --- | --- | --- | --- |']
for i, r in enumerate(runs, 1):
    out.append(f"| {i} | {r['started'][:19].replace('T', ' ')} | {(r['finished'] or '')[:19].replace('T', ' ')} | {r['description'].replace('|', '/')} | {'failed — fixed in the next step' if r['failed'] else 'ok'} |")
out += ['', '## Commands', '']
for i, r in enumerate(runs, 1):
    out += [f"### {i}. {r['description']}", '', f"Started {r['started']} · finished {r['finished']}" + (' · **failed**' if r['failed'] else ''), '', '<details><summary>Command</summary>', '', F + 'bash', r['command'].replace(F, "'''"), F, '', '</details>', '']
open(sys.argv[2], 'w').write('\n'.join(out) + '\n')
print(len(runs), 'runs written')
