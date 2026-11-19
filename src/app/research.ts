// Research record standard (docs/RESEARCH_RECORD_STANDARD.md). PAM is a historical research platform: every change made
// to a project's research must be explainable later — by whom, when, with which tool and which exact version of it, for
// what purpose and with what result — including to a hostile party disputing it. This module provides:
//
// - a tool register: the exact source of every script, scraper or program used, preserved in evidence storage (E05) and
//   identified by its SHA-256;
// - research runs: one record per execution (purpose, tools by hash, command, environment, UTC start and finish, exit
//   status, complete output preserved in E05), each also entered in the project's research log (an E08 investigation's
//   attempts log);
// - a write journal: every authenticated write made through the gateway, by anyone, with actor, time, engine, path,
//   status, the request id the engine's own audit trail carries, and the run it belonged to;
// - enforcement at the gateway: a write that does not come from the PAM application and is not part of an open run is
//   refused (HTTP 428), so scripts and AI agents cannot change research without registering their tool and run first;
// - PAM's own orchestration actions (model-backed agents included) record a run automatically, naming the PAM build and
//   the model.
//
// The three tables are append-only in the database: journal rows and tool rows can never be changed or deleted, and a
// run row can only be finished once.
import { createHash, randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { DomainError } from '../contracts.ts';
import type { Json } from '../contracts.ts';
import { requireCapability } from '../service-kit.ts';
import type { Route, ServiceContext, Sql } from '../service-kit.ts';
import { getSetting, setSetting } from './compose.ts';
import type { Runtime } from './compose.ts';

export const STANDARD_VERSION = '1.0';
// The application schema (compose.ts APP_SCHEMA); a literal here because compose.ts imports this module.
const S = 'pam_app';
/** The PAM web application marks its requests with this header; the application itself is the tool for those writes. */
export const WEB_CLIENT = 'pam-web';
const LOG_KEY = 'research.logInvestigationId';
const WRITE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
/** Engines whose writes are journalled but never need a run: signing in, tokens and account security are not research. */
const EXEMPT_ENGINES = new Set(['identity']);

export type Mode = 'enforce' | 'record' | 'off';
export const modeOf = (env: Readonly<Record<string, string | undefined>>): Mode => {
  const m = env.PAM_RESEARCH_RECORD ?? 'enforce';
  if (m !== 'enforce' && m !== 'record' && m !== 'off') throw new DomainError('invalid_config', 'PAM_RESEARCH_RECORD must be enforce, record or off');
  return m;
};
/** The commit of the running PAM build (Render sets RENDER_GIT_COMMIT; other hosts set PAM_BUILD_COMMIT). */
export const buildOf = (env: Readonly<Record<string, string | undefined>>): string => env.PAM_BUILD_COMMIT ?? env.RENDER_GIT_COMMIT ?? 'unknown';

export async function migrateResearch(sql: Sql): Promise<void> {
  await sql.query(`create table if not exists ${S}.research_tools (tenant_id text not null, project_id text not null, sha256 text not null, name text not null, version text, description text not null,
    filename text, evidence_ref text, source_note text, registered_by text not null, registered_by_kind text not null, registered_at timestamptz not null default now(), primary key (tenant_id, project_id, sha256))`);
  await sql.query(`create table if not exists ${S}.research_runs (id text primary key, tenant_id text not null, project_id text not null, purpose text not null, tools text[] not null, command text not null,
    environment jsonb not null default '{}'::jsonb, parent_run_id text, actor_id text not null, actor_kind text not null, build text not null, started_at timestamptz not null default now(),
    finished_at timestamptz, exit_code integer, outcome text, summary text, output_ref text, log_attempt_id text, log_error text)`);
  await sql.query(`create index if not exists research_runs_scope on ${S}.research_runs (tenant_id, project_id, started_at desc)`);
  await sql.query(`create table if not exists ${S}.research_journal (seq bigserial primary key, at timestamptz not null default now(), tenant_id text not null, project_id text not null,
    actor_id text not null, actor_kind text not null, purpose text, engine text not null, method text not null, path text not null, status integer not null, request_id text not null,
    run_id text, client text, build text not null)`);
  await sql.query(`create index if not exists research_journal_scope on ${S}.research_journal (tenant_id, project_id, seq desc)`);
  // Append-only guarantees, enforced by the database rather than by application code.
  await sql.query(`create or replace function ${S}.research_append_only() returns trigger language plpgsql as $$
    begin
      -- Nested: a field of OLD is only resolvable on the table that has it.
      if tg_table_name = 'research_runs' and tg_op = 'UPDATE' then
        if old.finished_at is null and new.finished_at is not null
           and new.id = old.id and new.tenant_id = old.tenant_id and new.project_id = old.project_id and new.purpose = old.purpose and new.tools = old.tools
           and new.command = old.command and new.environment = old.environment and new.actor_id = old.actor_id and new.started_at = old.started_at and new.build = old.build
           and new.parent_run_id is not distinct from old.parent_run_id and new.actor_kind = old.actor_kind then
          return new;
        end if;
      end if;
      raise exception 'research record rows are append-only (%.% %)', tg_table_schema, tg_table_name, tg_op;
    end $$`);
  for (const t of ['research_tools', 'research_runs', 'research_journal']) {
    await sql.query(`drop trigger if exists ${t}_append_only on ${S}.${t}`);
    await sql.query(`create trigger ${t}_append_only before update or delete on ${S}.${t} for each row execute function ${S}.research_append_only()`);
  }
}

// ───────────── helpers ─────────────
const str = (v: unknown, name: string, max: number, required = true): string | null => {
  if (v === undefined || v === null || v === '') { if (required) throw new DomainError('invalid_input', `${name} is required`); return null; }
  if (typeof v !== 'string' || v.length > max) throw new DomainError('invalid_input', `${name} must be text of at most ${max} characters`);
  return v;
};
const sha = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');
/** Reading the record needs any read access to the project's research or workspace. */
const canRead = (ctx: ServiceContext): void => { if (!['workspace:read', 'investigation:read', 'evidence:read', 'knowledge:read'].some((c) => ctx.capabilities.includes(c))) requireCapability(ctx, 'workspace:read'); };
const body = (r: { body: unknown }): Record<string, unknown> => { if (r.body === null || typeof r.body !== 'object' || Array.isArray(r.body)) throw new DomainError('invalid_input', 'A JSON object body is required'); return r.body as Record<string, unknown>; };

/** The project's research log: an investigation (E08) whose attempts log is the chronological record. Opened on first use. */
export async function researchLog(runtime: Runtime, ctx: ServiceContext): Promise<string | null> {
  const existing = await getSetting<string>(runtime, ctx, LOG_KEY);
  if (existing !== null) return existing;
  const investigation = runtime.maybe('investigation');
  if (investigation === null) return null;
  const opened = await investigation.openInvestigation(ctx, {
    title: 'Research log', originRef: `E01:project:${ctx.projectId}`,
    scopeStatement: `The research log of this project under PAM research record standard ${STANDARD_VERSION}: every research run (tool, exact version, purpose, command, times, result and preserved output) is entered here as an attempt, and every method, rule, decision and correction is written down here so that any later researcher can understand and repeat the work.`,
    originalAccount: { summary: 'Research log opened automatically by PAM; it records the work, not a claim.', label: 'allegation' },
    idempotencyKey: `research-log-${ctx.projectId}`,
  }) as { id: string };
  await setSetting(runtime, ctx, LOG_KEY, opened.id);
  return opened.id;
}

type RunRow = { id: string; tenant_id: string; project_id: string; purpose: string; tools: string[]; command: string; environment: Json; parent_run_id: string | null; actor_id: string; actor_kind: string; build: string;
  started_at: Date; finished_at: Date | null; exit_code: number | null; outcome: string | null; summary: string | null; output_ref: string | null; log_attempt_id: string | null; log_error: string | null };
const runView = (r: RunRow): Json => ({ id: r.id, purpose: r.purpose, tools: r.tools, command: r.command, environment: r.environment, parentRunId: r.parent_run_id, actorId: r.actor_id, actorKind: r.actor_kind, build: r.build,
  startedAt: r.started_at.toISOString(), finishedAt: r.finished_at?.toISOString() ?? null, exitCode: r.exit_code, outcome: r.outcome, summary: r.summary, outputRef: r.output_ref, logAttemptId: r.log_attempt_id, logError: r.log_error });
const OUTCOMES = ['succeeded', 'partial', 'zero_result', 'failed', 'refused', 'access_restricted', 'unavailable', 'uncertain', 'cancelled'];
/** The investigation engine's limit for one attempt's detail. */
const LOG_DETAIL_MAX = 4000;
const KINDS = ['search', 'acquisition', 'contact', 'processing', 'knowledge', 'verification', 'other'];

/** Registers a tool by its exact source. The bytes are preserved in evidence storage; the SHA-256 identifies the version. */
export async function registerTool(runtime: Runtime, ctx: ServiceContext, input: { name: string; version?: string | null; description: string; filename?: string | null; bytes?: Uint8Array | null; mediaType?: string; sourceNote?: string | null }): Promise<{ sha256: string; evidenceRef: string | null; created: boolean }> {
  if ((input.bytes === undefined || input.bytes === null) && !input.sourceNote) throw new DomainError('invalid_input', 'A tool needs its source (contentBase64) or, for a built-in tool, a sourceNote naming where its code is published');
  const digest = input.bytes ? sha(input.bytes) : sha(`builtin\u0000${input.name}\u0000${input.sourceNote}`);
  const prior = (await runtime.sql.query<{ evidence_ref: string | null }>(`select evidence_ref from ${S}.research_tools where tenant_id=$1 and project_id=$2 and sha256=$3`, [ctx.tenantId, ctx.projectId, digest]))[0];
  if (prior !== undefined) return { sha256: digest, evidenceRef: prior.evidence_ref, created: false };
  let ref: string | null = null;
  if (input.bytes) {
    const stored = await runtime.get('evidence').accept(ctx, { bytes: input.bytes, mediaType: input.mediaType ?? 'text/plain', filename: input.filename ?? `${input.name}.txt`, origin: { kind: 'upload', label: `Research tool source: ${input.name}${input.version ? ` ${input.version}` : ''} (sha256 ${digest})` } as Json, idempotencyKey: `research-tool-${digest}` }) as { ref: string };
    ref = stored.ref;
  }
  await runtime.sql.query(`insert into ${S}.research_tools (tenant_id, project_id, sha256, name, version, description, filename, evidence_ref, source_note, registered_by, registered_by_kind) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) on conflict do nothing`,
    [ctx.tenantId, ctx.projectId, digest, input.name, input.version ?? null, input.description, input.filename ?? null, ref, input.sourceNote ?? null, ctx.actor.id, ctx.actor.kind]);
  return { sha256: digest, evidenceRef: ref, created: true };
}

export async function startRun(runtime: Runtime, ctx: ServiceContext, input: { purpose: string; tools: string[]; command: string; environment?: Json; parentRunId?: string | null }): Promise<{ id: string; logInvestigationId: string | null }> {
  if (!Array.isArray(input.tools) || input.tools.length === 0 || input.tools.length > 50 || !input.tools.every((t) => typeof t === 'string' && /^[0-9a-f]{64}$/.test(t))) throw new DomainError('invalid_input', 'tools must list 1–50 registered tool SHA-256 hashes');
  const known = await runtime.sql.query<{ sha256: string }>(`select sha256 from ${S}.research_tools where tenant_id=$1 and project_id=$2 and sha256 = any($3::text[])`, [ctx.tenantId, ctx.projectId, input.tools]);
  const missing = input.tools.filter((t) => !known.some((k) => k.sha256 === t));
  if (missing.length > 0) throw new DomainError('invalid_input', `Register these tools first (POST /api/app/v1/research/tools): ${missing.join(', ')}`);
  const env = input.environment ?? {};
  if (JSON.stringify(env).length > 16_000) throw new DomainError('invalid_input', 'environment is limited to 16,000 characters of JSON');
  const log = await researchLog(runtime, ctx).catch(() => null);
  const id = `run_${randomUUID()}`;
  await runtime.sql.query(`insert into ${S}.research_runs (id, tenant_id, project_id, purpose, tools, command, environment, parent_run_id, actor_id, actor_kind, build) values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11)`,
    [id, ctx.tenantId, ctx.projectId, input.purpose, input.tools, input.command, JSON.stringify(env), input.parentRunId ?? null, ctx.actor.id, ctx.actor.kind, buildOf(runtime.env)]);
  return { id, logInvestigationId: log };
}

export async function finishRun(runtime: Runtime, ctx: ServiceContext, id: string, input: { exitCode: number; outcome?: string; summary: string; kind?: string; output?: Uint8Array | null; outputFilename?: string; refs?: string[] }): Promise<Json> {
  const run = (await runtime.sql.query<RunRow>(`select * from ${S}.research_runs where id=$1 and tenant_id=$2 and project_id=$3`, [id, ctx.tenantId, ctx.projectId]))[0];
  if (run === undefined) throw new DomainError('not_found', 'No such research run in this project');
  if (run.actor_id !== ctx.actor.id) throw new DomainError('forbidden', 'Only the actor who started a run can finish it');
  if (run.finished_at !== null) throw new DomainError('conflict', 'This run is already finished');
  const outcome = input.outcome ?? (input.exitCode === 0 ? 'succeeded' : 'failed');
  if (!OUTCOMES.includes(outcome)) throw new DomainError('invalid_input', `outcome must be one of ${OUTCOMES.join(', ')}`);
  const kind = input.kind ?? 'processing';
  if (!KINDS.includes(kind)) throw new DomainError('invalid_input', `kind must be one of ${KINDS.join(', ')}`);
  let outputRef: string | null = null; const problems: string[] = [];
  // A run is always closed, even when its output cannot be stored; the problem is then written on the run itself.
  if (input.output) {
    try { outputRef = (await runtime.get('evidence').accept(ctx, { bytes: input.output, mediaType: 'text/plain', filename: input.outputFilename ?? `${id}-output.txt`, origin: { kind: 'upload', label: `Output of research run ${id}` } as Json, idempotencyKey: `research-output-${id}` }) as { ref: string }).ref; }
    catch (error) { problems.push(`output not stored: ${error instanceof Error ? error.message : String(error)}; output SHA-256 ${sha(input.output)}`); }
  }
  const finishedAt = new Date();
  const tools = await runtime.sql.query<{ sha256: string; name: string; version: string | null; evidence_ref: string | null; source_note: string | null }>(`select sha256, name, version, evidence_ref, source_note from ${S}.research_tools where tenant_id=$1 and project_id=$2 and sha256 = any($3::text[])`, [ctx.tenantId, ctx.projectId, run.tools]);
  let attemptId: string | null = null, logError: string | null = null;
  try {
    const log = await researchLog(runtime, ctx);
    if (log === null) logError = 'investigation engine unavailable';
    else {
      const refs = [...new Set([...(input.refs ?? []), ...(outputRef ? [outputRef] : []), ...tools.flatMap((t) => (t.evidence_ref ? [t.evidence_ref] : []))])].filter((r) => /^E\d\d:/.test(r)).slice(0, 50);
      const detail = [`Research run ${run.id} (standard ${STANDARD_VERSION}). ${input.summary}`, `Started ${run.started_at.toISOString()}, finished ${finishedAt.toISOString()} (UTC); exit ${input.exitCode}; by ${run.actor_kind} ${run.actor_id}; PAM build ${run.build}.`,
        `Command: ${run.command}`, `Tools: ${tools.map((t) => `${t.name}${t.version ? ` ${t.version}` : ''} sha256 ${t.sha256}${t.evidence_ref ? ` source ${t.evidence_ref}` : t.source_note ? ` (${t.source_note})` : ''}`).join('; ')}`,
        `Environment: ${JSON.stringify(run.environment)}`, outputRef ? `Complete output: ${outputRef}` : 'No output was submitted.'].join('\n');
      // A log entry holds at most 4,000 characters. A longer account is preserved whole in evidence storage and the
      // entry says so and links it; nothing is cut silently.
      let entry = detail;
      if (detail.length > LOG_DETAIL_MAX) {
        const full = (await runtime.get('evidence').accept(ctx, { bytes: new TextEncoder().encode(detail), mediaType: 'text/plain', filename: `${run.id}-record.txt`, origin: { kind: 'upload', label: `Full record of research run ${run.id}` } as Json, idempotencyKey: `research-record-${run.id}` }) as { ref: string }).ref;
        refs.unshift(full);
        const note = `\n[Shortened for the log: the complete record of this run (${detail.length} characters) is ${full}; also GET /api/app/v1/research/runs/${run.id}.]`;
        entry = detail.slice(0, LOG_DETAIL_MAX - note.length) + note;
      }
      const a = await runtime.get('investigation').recordAttempt(ctx, log, { kind, target: run.purpose.slice(0, 2000), method: run.command.slice(0, 500), outcome, detail: entry, refs: refs.slice(0, 50), idempotencyKey: `research-run-${run.id}` }) as { id: string };
      attemptId = a.id;
    }
  } catch (error) { logError = error instanceof Error ? error.message : String(error); }
  if (problems.length > 0) logError = [...problems, ...(logError === null ? [] : [logError])].join('; ');
  await runtime.sql.query(`update ${S}.research_runs set finished_at=$2, exit_code=$3, outcome=$4, summary=$5, output_ref=$6, log_attempt_id=$7, log_error=$8 where id=$1`, [id, finishedAt.toISOString(), input.exitCode, outcome, input.summary, outputRef, attemptId, logError]);
  return runView({ ...run, finished_at: finishedAt, exit_code: input.exitCode, outcome, summary: input.summary, output_ref: outputRef, log_attempt_id: attemptId, log_error: logError });
}

// ───────────── gateway: enforcement and journal ─────────────
/**
 * Called by the gateway before an engine handles a request. Returns false when it has answered the request itself
 * (refusal). Authenticated writes are journalled when the response finishes, whatever the outcome.
 */
export async function gatewayCheck(runtime: Runtime, engine: string, req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
  const mode = modeOf(runtime.env);
  if (mode === 'off' || !WRITE.has(req.method ?? 'GET')) return true;
  const auth = req.headers.authorization;
  if (typeof auth !== 'string' || !auth.startsWith('Bearer ')) return true; // public endpoints (sign-in, tokens) carry no bearer token
  const requestId = typeof req.headers['x-request-id'] === 'string' && /^[A-Za-z0-9._-]{1,100}$/.test(req.headers['x-request-id']) ? req.headers['x-request-id'] : randomUUID();
  req.headers['x-request-id'] = requestId; // the engine's own audit record carries the same id as the journal
  let ctx: ServiceContext;
  try { ctx = await runtime.verify(auth.slice(7), { requestId }); } catch { return true; } // the engine answers 401 itself
  const client = typeof req.headers['x-pam-client'] === 'string' ? req.headers['x-pam-client'].slice(0, 100) : null;
  const runHeader = typeof req.headers['x-pam-run'] === 'string' ? req.headers['x-pam-run'] : null;
  const build = buildOf(runtime.env);
  const journal = (status: number, runId: string | null): Promise<unknown> => runtime.sql.query(`insert into ${S}.research_journal (tenant_id, project_id, actor_id, actor_kind, purpose, engine, method, path, status, request_id, run_id, client, build) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [ctx.tenantId, ctx.projectId, ctx.actor.id, ctx.actor.kind, ctx.purpose ?? null, engine, req.method ?? '', path.slice(0, 2000), status, requestId, runId, client, build])
    .catch((error: unknown) => { console.error(JSON.stringify({ level: 'error', message: 'research journal write failed', requestId, error: error instanceof Error ? error.message : String(error) })); });
  // Refused attempts are part of the record too.
  const refuse = async (status: number, code: string, message: string): Promise<false> => {
    await journal(status, runHeader);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'x-request-id': requestId }).end(JSON.stringify({ error: { code, message, requestId, standard: `PAM research record standard ${STANDARD_VERSION}`, documentation: 'docs/RESEARCH_RECORD_STANDARD.md' } }));
    return false;
  };
  let runId: string | null = null;
  if (runHeader !== null) {
    const run = (await runtime.sql.query<{ actor_id: string; finished_at: Date | null }>(`select actor_id, finished_at from ${S}.research_runs where id=$1 and tenant_id=$2 and project_id=$3`, [runHeader, ctx.tenantId, ctx.projectId]))[0];
    if (run === undefined || run.finished_at !== null || run.actor_id !== ctx.actor.id) return await refuse(409, 'research_run_not_open', 'The research run named in x-pam-run is not an open run of yours in this project. Start a run first (POST /api/app/v1/research/runs).');
    runId = runHeader;
  } else if (mode === 'enforce' && client !== WEB_CLIENT && !EXEMPT_ENGINES.has(engine)) {
    return await refuse(428, 'research_run_required', 'Writes from scripts, tools and agents must belong to a research run: register the tool (POST /api/app/v1/research/tools), start a run (POST /api/app/v1/research/runs), send its id in the x-pam-run header, and finish the run with its output (POST /api/app/v1/research/runs/<id>/finish).');
  }
  res.once('finish', () => { void journal(res.statusCode, runId); });
  return true;
}

/** Wraps a PAM orchestration action so each execution is a research run under PAM's own (built-in) tool. */
export function recordedAction<T extends { run(a: { ctx: ServiceContext; task: { id: string; input?: Json } }): Promise<{ output: Json; summary?: string; refs?: readonly string[] }>; description: string }>(runtime: Runtime, name: string, def: T): T {
  if (modeOf(runtime.env) === 'off') return def;
  return { ...def, async run(a: Parameters<T['run']>[0]) {
    const note = `PAM build ${buildOf(runtime.env)}, orchestration action ${name}${runtime.model ? `, model ${runtime.model.name}` : ''}`;
    let runId: string | null = null;
    try {
      const tool = await registerTool(runtime, a.ctx, { name: `pam-action:${name}`, version: buildOf(runtime.env), description: def.description, sourceNote: `${note}; source published in the PAM repository at that commit` });
      runId = (await startRun(runtime, a.ctx, { purpose: `${name}: ${def.description}`.slice(0, 2000), tools: [tool.sha256], command: `task ${a.task.id}`, environment: { action: name, build: buildOf(runtime.env), model: runtime.model?.name ?? null, inputSha256: sha(JSON.stringify(a.task.input ?? null)) } })).id;
    } catch (error) { console.error(JSON.stringify({ level: 'warn', message: 'research run could not be started for action', action: name, error: error instanceof Error ? error.message : String(error) })); }
    try {
      const out = await def.run(a);
      if (runId !== null) await finishRun(runtime, a.ctx, runId, { exitCode: 0, summary: out.summary ?? `Action ${name} completed.`, refs: [...(out.refs ?? [])], output: new TextEncoder().encode(JSON.stringify(out.output ?? null, null, 1)) }).catch(() => undefined);
      return out;
    } catch (error) {
      if (runId !== null) await finishRun(runtime, a.ctx, runId, { exitCode: 1, outcome: 'failed', summary: `Action ${name} failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 4000) }).catch(() => undefined);
      throw error;
    }
  } } as T;
}

// ───────────── application routes ─────────────
export function researchRoutes(runtime: Runtime): Route[] {
  return [
    { method: 'POST', path: '/v1/research/tools', handler: async (r) => {
      const b = body(r);
      const content = str(b.contentBase64, 'contentBase64', 20_000_000, false);
      if (content !== null && !/^[A-Za-z0-9+/]*={0,2}$/.test(content)) throw new DomainError('invalid_input', 'contentBase64 must be base64');
      const out = await registerTool(runtime, r.ctx, { name: str(b.name, 'name', 200) as string, version: str(b.version, 'version', 200, false), description: str(b.description, 'description', 4000) as string,
        filename: str(b.filename, 'filename', 300, content !== null), bytes: content === null ? null : new Uint8Array(Buffer.from(content, 'base64')), mediaType: str(b.mediaType, 'mediaType', 200, false) ?? 'text/plain', sourceNote: str(b.sourceNote, 'sourceNote', 2000, false) });
      return { status: 201, json: out as unknown as Json };
    } },
    { method: 'POST', path: '/v1/research/runs', handler: async (r) => {
      const b = body(r);
      const out = await startRun(runtime, r.ctx, { purpose: str(b.purpose, 'purpose', 2000) as string, tools: b.tools as string[], command: str(b.command, 'command', 8000) as string, environment: (b.environment ?? {}) as Json, parentRunId: str(b.parentRunId, 'parentRunId', 100, false) });
      return { status: 201, json: out as unknown as Json };
    } },
    { method: 'POST', path: '/v1/research/runs/:id/finish', handler: async (r) => {
      const b = body(r);
      const output = str(b.outputBase64, 'outputBase64', 40_000_000, false);
      if (!Number.isInteger(b.exitCode)) throw new DomainError('invalid_input', 'exitCode must be an integer');
      return finishRun(runtime, r.ctx, r.params.id as string, { exitCode: b.exitCode as number, summary: str(b.summary, 'summary', 8000) as string, ...(typeof b.outcome === 'string' ? { outcome: b.outcome } : {}), ...(typeof b.kind === 'string' ? { kind: b.kind } : {}),
        output: output === null ? null : new Uint8Array(Buffer.from(output, 'base64')), ...(typeof b.outputFilename === 'string' ? { outputFilename: b.outputFilename.slice(0, 300) } : {}), ...(Array.isArray(b.refs) ? { refs: (b.refs as unknown[]).filter((x): x is string => typeof x === 'string') } : {}) });
    } },
    { method: 'GET', path: '/v1/research/runs/:id', handler: async (r) => {
      canRead(r.ctx);
      const run = (await runtime.sql.query<RunRow>(`select * from ${S}.research_runs where id=$1 and tenant_id=$2 and project_id=$3`, [r.params.id, r.ctx.tenantId, r.ctx.projectId]))[0];
      if (run === undefined) throw new DomainError('not_found', 'No such research run in this project');
      const writes = await runtime.sql.query<Record<string, unknown>>(`select seq, at, engine, method, path, status, request_id from ${S}.research_journal where tenant_id=$1 and project_id=$2 and run_id=$3 order by seq limit 5000`, [r.ctx.tenantId, r.ctx.projectId, run.id]);
      return { run: runView(run), writes: writes.map((w) => ({ ...w, seq: Number(w.seq), at: (w.at as Date).toISOString() })) } as unknown as Json;
    } },
    // The project's research record at a glance: standard, mode, log, tools, recent runs and writes, and counts.
    { method: 'GET', path: '/v1/research/record', handler: async (r) => {
      canRead(r.ctx);
      const scope = [r.ctx.tenantId, r.ctx.projectId];
      const limit = (k: string, d: number): number => Math.min(Math.max(Number(r.query.get(k) ?? d) || d, 1), 1000);
      const [tools, runs, journal, counts] = await Promise.all([
        runtime.sql.query<Record<string, unknown>>(`select sha256, name, version, description, filename, evidence_ref, source_note, registered_by, registered_by_kind, registered_at from ${S}.research_tools where tenant_id=$1 and project_id=$2 order by registered_at desc limit 500`, scope),
        runtime.sql.query<RunRow>(`select * from ${S}.research_runs where tenant_id=$1 and project_id=$2 order by started_at desc limit ${limit('runs', 50)}`, scope),
        runtime.sql.query<Record<string, unknown>>(`select seq, at, actor_id, actor_kind, purpose, engine, method, path, status, request_id, run_id, client, build from ${S}.research_journal where tenant_id=$1 and project_id=$2 order by seq desc limit ${limit('journal', 100)}`, scope),
        runtime.sql.query<Record<string, string>>(`select (select count(*) from ${S}.research_tools where tenant_id=$1 and project_id=$2) as tools, (select count(*) from ${S}.research_runs where tenant_id=$1 and project_id=$2) as runs,
          (select count(*) from ${S}.research_runs where tenant_id=$1 and project_id=$2 and finished_at is null) as open_runs, (select count(*) from ${S}.research_journal where tenant_id=$1 and project_id=$2) as writes,
          (select count(*) from ${S}.research_journal where tenant_id=$1 and project_id=$2 and run_id is null and status < 400 and coalesce(client,'') <> '${WEB_CLIENT}' and engine <> 'identity') as writes_outside_runs`, scope),
      ]);
      const c = counts[0] ?? {};
      return { standard: STANDARD_VERSION, mode: modeOf(runtime.env), build: buildOf(runtime.env), logInvestigationId: await getSetting<string>(runtime, r.ctx, LOG_KEY),
        counts: { tools: Number(c.tools ?? 0), runs: Number(c.runs ?? 0), openRuns: Number(c.open_runs ?? 0), writes: Number(c.writes ?? 0), writesOutsideRuns: Number(c.writes_outside_runs ?? 0) },
        tools: tools.map((t) => ({ ...t, registered_at: (t.registered_at as Date).toISOString() })), runs: runs.map(runView), journal: journal.map((w) => ({ ...w, seq: Number(w.seq), at: (w.at as Date).toISOString() })) } as unknown as Json;
    } },
  ];
}
