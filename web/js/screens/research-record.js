// Research record (research record standard, docs/RESEARCH_RECORD_STANDARD.md): the project's research log, the tools used
// (exact versions by SHA-256, source preserved as evidence), every research run and every write made to the project.
import { appApi } from '../api.js';
import { h, region, section, listOrEmpty, dl, ref } from '../ui.js';

const time = (iso) => (iso ? h('time', { datetime: iso, text: new Date(iso).toLocaleString() }) : h('span', { class: 'ws-muted', text: 'open' }));
const short = (s, n = 12) => h('code', { text: String(s ?? '').slice(0, n), title: String(s ?? '') });

export async function render(el, ctx) {
  const summary = region('Research record', 2, 'Everything done to this project\'s research is recorded so that a later researcher — or anyone disputing the work — can see who did what, when, with which exact tool, why, and with what result. Records here can be added to but never changed or deleted.');
  const runs = region('Research runs', 2, 'One entry per execution of a tool, script or PAM agent: purpose, tools (by exact version), command, times, result and preserved output. Each run is also entered in the project\'s research log.');
  const tools = region('Tools', 2, 'Every script, scraper or program used, identified by the SHA-256 of its exact source, which is preserved in evidence storage.');
  const journal = region('Write journal', 2, 'Every change made to this project through PAM, by anyone, with the run it belonged to. "Application" means it was made in this web application.');
  el.append(summary.el, runs.el, tools.el, journal.el);
  section(summary.body, () => appApi('/v1/research/record?runs=200&journal=300', { purpose: ctx.purpose }), (rec, body) => {
    body.append(dl([
      ['Standard', `PAM research record standard ${rec.standard} (${rec.mode === 'enforce' ? 'enforced: scripts and agents cannot write outside a research run' : rec.mode === 'record' ? 'recording only, not enforced' : 'off'})`],
      ['Research log', rec.logInvestigationId ? h('a', { href: `/investigations?id=${encodeURIComponent(rec.logInvestigationId)}`, 'data-nav': true, text: 'Open the research log (investigation)' }) : 'Opened with the first research run'],
      ['Running PAM build', rec.build],
      ['Tools registered', String(rec.counts.tools)], ['Research runs', `${rec.counts.runs} (${rec.counts.openRuns} still open)`],
      ['Writes recorded', String(rec.counts.writes)], ['Writes outside any run (not from the application)', String(rec.counts.writesOutsideRuns)],
    ]));
    listOrEmpty(runs.body, rec.runs, 'No research runs yet', 'Runs appear here as soon as a tool or agent is run.', { caption: 'Research runs, newest first', columns: [
      { key: 'startedAt', label: 'Started', render: (r) => time(r.startedAt) }, { key: 'finishedAt', label: 'Finished', render: (r) => time(r.finishedAt) },
      { key: 'purpose', label: 'Purpose' }, { key: 'command', label: 'Command', render: (r) => h('code', { text: r.command }) },
      { key: 'outcome', label: 'Result', render: (r) => h('span', { text: r.finishedAt ? `${r.outcome} (exit ${r.exitCode})` : 'running' }) },
      { key: 'actorKind', label: 'By', render: (r) => h('span', { text: `${r.actorKind} ${String(r.actorId).slice(0, 8)}` }) },
      { key: 'outputRef', label: 'Output', sortable: false, render: (r) => (r.outputRef ? ref(r.outputRef, 'output') : h('span', { class: 'ws-muted', text: r.logError ? `not stored: ${r.logError}` : '—' })) },
      { key: 'tools', label: 'Tools', sortable: false, render: (r) => h('span', {}, ...r.tools.map((t) => short(t))) },
    ] });
    listOrEmpty(tools.body, rec.tools, 'No tools registered yet', 'A tool is registered with its exact source before its first run.', { caption: 'Registered tools', columns: [
      { key: 'name', label: 'Tool' }, { key: 'version', label: 'Version' }, { key: 'description', label: 'What it does' },
      { key: 'sha256', label: 'SHA-256', render: (r) => short(r.sha256, 16) },
      { key: 'evidence_ref', label: 'Source', sortable: false, render: (r) => (r.evidence_ref ? ref(r.evidence_ref, r.filename ?? 'source') : h('span', { text: r.source_note ?? '—' })) },
      { key: 'registered_at', label: 'Registered', render: (r) => time(r.registered_at) },
    ] });
    listOrEmpty(journal.body, rec.journal, 'No writes recorded yet', 'Every change made through PAM is listed here.', { caption: 'Most recent writes', columns: [
      { key: 'at', label: 'When', render: (r) => time(r.at) }, { key: 'engine', label: 'Engine' }, { key: 'method', label: 'Action', render: (r) => h('code', { text: `${r.method} ${r.path}` }) },
      { key: 'status', label: 'Status' }, { key: 'actor_kind', label: 'By', render: (r) => h('span', { text: `${r.actor_kind} ${String(r.actor_id).slice(0, 8)}` }) },
      { key: 'run_id', label: 'Run', render: (r) => (r.run_id ? short(r.run_id, 16) : h('span', { text: r.client === 'pam-web' ? 'Application' : r.engine === 'identity' ? 'Account' : 'none' })) },
      { key: 'request_id', label: 'Request', render: (r) => short(r.request_id, 8) },
    ] });
  });
}
