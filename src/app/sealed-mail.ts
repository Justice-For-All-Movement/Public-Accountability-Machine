// Seal on arrival (docs/SEALED_SOURCES.md, "Sealed mailboxes"). For a mailbox listed in the project setting
// `correspondence.sealedMailboxes`, every message the correspondence engine (E03) receives is:
//   1. read once with PAM's service identity (text, HTML, attachments, headers);
//   2. sealed on the server for the project's registered PUBLIC sealing keys (sealOnServer: the server can seal, never open);
//   3. stored as a sealed record (kind `conversation`, channel `email`) under a source code name. One code per sender
//      address: PAM keeps the sender → code mapping only as HMAC-SHA-256(SEALED_MAIL_HMAC_KEY, organization, project,
//      address), so the mapping table reveals no address;
//   4. erased from E03 (`eraseMessageContent`, preservedAs = the sealed record's evidence reference).
// Crash safety: each step's outcome is recorded in `pam_app.sealed_mail` before the next one runs, and E03 is asked to
// erase only once the sealed record is stored (E03 also confirms the evidence reference itself). With no sealing key
// registered nothing is sealed or erased; an attention alert is raised and the message waits. Failures are retried with
// backoff and raise an alert; they never block the event router. Replies in sealed mailboxes are never forwarded as
// knowledge proposals (their text would otherwise be copied into the knowledge engine).
import { createHmac } from 'node:crypto';
import { DomainError } from '../contracts.ts';
import type { Json, Scope } from '../contracts.ts';
import { requireCapability } from '../service-kit.ts';
import type { EngineEvent, Route, ServiceContext, Sql } from '../service-kit.ts';
import { getSetting, setSetting } from './compose.ts';
import type { Runtime } from './compose.ts';
import { activeRecipients, createSourceCode, sealOnServer, storeSealedRecord } from './sealed.ts';

const S = 'pam_app';
export const SEALED_MAILBOXES = 'correspondence.sealedMailboxes';
export const ERASE_REASON = 'Sealed on arrival for the project researchers (sealed mailbox); readable content kept only in the sealed record';
type Any = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export async function migrateSealedMail(sql: Sql): Promise<void> {
  // sender_key is an HMAC of the address; the address itself is never stored.
  await sql.query(`create table if not exists ${S}.sealed_mail_senders (tenant_id text not null, project_id text not null, sender_key text not null, source_code text not null,
    created_at timestamptz not null default now(), primary key (tenant_id, project_id, sender_key))`);
  // Progress of each message through seal → store → erase. Ids and references only, never content.
  await sql.query(`create table if not exists ${S}.sealed_mail (tenant_id text not null, project_id text not null, message_id text not null, mailbox_id text not null,
    state text not null check (state in ('pending','waiting_for_keys','sealed','erased')), record_id text, evidence_ref text, attempts integer not null default 0, last_error text,
    next_attempt_at timestamptz not null default now(), created_at timestamptz not null default now(), updated_at timestamptz not null default now(), primary key (tenant_id, project_id, message_id))`);
  await sql.query(`create index if not exists sealed_mail_due on ${S}.sealed_mail (next_attempt_at) where state <> 'erased'`);
}

/** HMAC-SHA-256 of the sender address under SEALED_MAIL_HMAC_KEY, or null when no usable key is configured. */
export function senderKey(env: Readonly<Record<string, string | undefined>>, scope: Scope, address: string): string | null {
  const key = env.SEALED_MAIL_HMAC_KEY;
  if (typeof key !== 'string' || key.length < 32) return null;
  return createHmac('sha256', key).update(`pam-sealed-mail-sender-v1\u0000${scope.tenantId}\u0000${scope.projectId}\u0000${address.trim().toLowerCase()}`).digest('hex');
}

export async function sealedMailboxes(runtime: Runtime, scope: Scope): Promise<string[]> {
  const v = await getSetting<unknown>(runtime, scope, SEALED_MAILBOXES);
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

const messageIdOf = (subject: string): string | null => { const m = /^E03:message:([0-9a-f-]{36})(?:@\d+)?$/i.exec(subject); return m === null ? null : (m[1] as string).toLowerCase(); };
const retryMs = (runtime: Runtime): number => Math.max(100, Number(runtime.env.PAM_SEALED_MAIL_RETRY_MS ?? 30_000));

/** Attention item for a person (shown under "Needs attention"); one per message and kind. */
async function alert(runtime: Runtime, scope: Scope, messageId: string, type: string): Promise<void> {
  await runtime.sql.query(`insert into ${S}.alerts (tenant_id, project_id, event_key, engine, type, subject, at) values ($1,$2,$3,'E03',$4,$5,now()) on conflict do nothing`,
    [scope.tenantId, scope.projectId, `pam-sealed-mail:${messageId}:${type}`, type, `E03:message:${messageId}`]);
}

/** Router reaction to E03 `message.received`: records the message for sealing (before the router cursor moves) and seals it now. */
export async function onMessageReceived(runtime: Runtime, ctx: ServiceContext, e: EngineEvent): Promise<void> {
  const messageId = messageIdOf(e.subject);
  if (messageId === null) return;
  const scope = { tenantId: e.tenantId, projectId: e.projectId };
  const sealed = await sealedMailboxes(runtime, scope);
  if (sealed.length === 0) return;
  const correspondence = runtime.maybe('correspondence');
  if (correspondence === null) throw new DomainError('unavailable', 'The correspondence engine is not running');
  let mailboxId: string;
  try { mailboxId = (await correspondence.getMessage(ctx, messageId) as Any).mailboxId as string; }
  catch (error) { if (error instanceof DomainError && error.code === 'not_found') return; throw error; }
  if (!sealed.includes(mailboxId)) return;
  await runtime.sql.query(`insert into ${S}.sealed_mail (tenant_id, project_id, message_id, mailbox_id, state) values ($1,$2,$3,$4,'pending') on conflict do nothing`, [scope.tenantId, scope.projectId, messageId, mailboxId]);
  await sealMessage(runtime, scope, messageId);
}

/** True when the message is (or is to be) sealed: its text must not be copied anywhere else. */
export async function isSealedMessage(runtime: Runtime, ctx: ServiceContext, e: EngineEvent): Promise<boolean> {
  const messageId = messageIdOf(e.subject);
  if (messageId === null) return false;
  if ((await runtime.sql.query(`select 1 from ${S}.sealed_mail where tenant_id=$1 and project_id=$2 and message_id=$3`, [e.tenantId, e.projectId, messageId])).length > 0) return true;
  const sealed = await sealedMailboxes(runtime, { tenantId: e.tenantId, projectId: e.projectId });
  if (sealed.length === 0) return false;
  try { const m = await runtime.get('correspondence').getMessage(ctx, messageId) as Any; return m.contentErased === true || sealed.includes(m.mailboxId as string); }
  catch { return true; } // undecidable: fail closed (do not copy the text)
}

/** Source code for a sender: reused through the HMAC mapping, created on first contact. */
async function sourceCodeFor(runtime: Runtime, ctx: ServiceContext, address: string, messageId: string): Promise<string> {
  const scope = { tenantId: ctx.tenantId, projectId: ctx.projectId };
  const key = senderKey(runtime.env, scope, address);
  const create = (): Promise<string> => createSourceCode(runtime, ctx, { channel: 'email', risk: 'high', note: 'Wrote to a sealed mailbox (code assigned on arrival)' });
  if (key === null) {
    // Without the HMAC key the sender cannot be recognised again; sealing still goes ahead (content safety comes first).
    await alert(runtime, scope, messageId, 'correspondence.sealed_mail_sender_unlinked');
    return create();
  }
  const find = async (): Promise<string | null> => (await runtime.sql.query<{ source_code: string }>(`select source_code from ${S}.sealed_mail_senders where tenant_id=$1 and project_id=$2 and sender_key=$3`, [scope.tenantId, scope.projectId, key]))[0]?.source_code ?? null;
  const existing = await find();
  if (existing !== null) return existing;
  const code = await create();
  const inserted = await runtime.sql.query<{ source_code: string }>(`insert into ${S}.sealed_mail_senders (tenant_id, project_id, sender_key, source_code) values ($1,$2,$3,$4) on conflict do nothing returning source_code`, [scope.tenantId, scope.projectId, key, code]);
  return inserted[0]?.source_code ?? (await find()) ?? code;
}

const day = (v: unknown): string | null => { const t = typeof v === 'string' ? Date.parse(v) : NaN; return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null; };

/**
 * Takes one message as far as it can go: pending/waiting → sealed (record stored) → erased. Never throws for an expected
 * condition; any failure is recorded on the row (and alerted) and retried later with backoff.
 */
export async function sealMessage(runtime: Runtime, scope: Scope, messageId: string): Promise<string> {
  // Claim the row (a lease of ten minutes): two workers never seal the same message at once, and a worker that dies
  // mid-way leaves the row to be picked up again when the lease runs out.
  const row = (await runtime.sql.query<{ state: string; evidence_ref: string | null; attempts: number }>(`update ${S}.sealed_mail set next_attempt_at=now() + interval '10 minutes'
    where tenant_id=$1 and project_id=$2 and message_id=$3 and state <> 'erased' and next_attempt_at <= now() returning state, evidence_ref, attempts`, [scope.tenantId, scope.projectId, messageId]))[0];
  if (row === undefined) return 'not_due';
  const set = async (fields: string, values: unknown[]): Promise<void> => {
    await runtime.sql.query(`update ${S}.sealed_mail set ${fields}, updated_at=now() where tenant_id=$1 and project_id=$2 and message_id=$3`, [scope.tenantId, scope.projectId, messageId, ...values]);
  };
  try {
    const ctx = await runtime.serviceContext(scope);
    const correspondence = runtime.get('correspondence');
    let evidenceRef = row.evidence_ref;
    if (row.state !== 'sealed' || evidenceRef === null) {
      const msg = await correspondence.getMessage(ctx, messageId) as Any;
      if (msg.contentErased === true) { await set(`state='erased', evidence_ref=coalesce(evidence_ref, $4), last_error=null`, [msg.preservedAs ?? null]); return 'erased'; }
      if ((await activeRecipients(runtime, scope)).length === 0) {
        // Nobody could open a sealed copy: keep the message readable where it is, and tell a person.
        await set(`state='waiting_for_keys', next_attempt_at=now() + ($4::int * interval '1 millisecond')`, [retryMs(runtime)]);
        await alert(runtime, scope, messageId, 'correspondence.sealed_mail_waiting_for_keys');
        return 'waiting_for_keys';
      }
      const files: Json[] = [];
      for (const a of (msg.attachments ?? []) as Any[]) {
        const got = await correspondence.getAttachment(ctx, a.id as string) as { meta: Any; bytes: Uint8Array };
        files.push({ name: String(a.filename ?? 'attachment'), type: String(a.mediaType ?? 'application/octet-stream'), base64: Buffer.from(got.bytes).toString('base64') });
      }
      const date = (msg.classificationDetail as Any | null)?.declaredDate ?? msg.receivedAt ?? null;
      const content: Json = {
        text: typeof msg.bodyText === 'string' ? msg.bodyText : '',
        ...(typeof msg.untrustedHtml === 'string' && msg.untrustedHtml !== '' ? { html: msg.untrustedHtml } : {}),
        files,
        // Inside the ciphertext: who wrote, to whom and about what, for the researchers who open it.
        headers: { date, messageId: msg.messageIdHeader ?? null, receivedAt: msg.receivedAt ?? null, from: msg.fromAddr ?? null, fromName: msg.fromName ?? null, to: msg.toAddrs ?? [], cc: msg.ccAddrs ?? [], subject: msg.subject ?? '' },
      };
      const code = await sourceCodeFor(runtime, ctx, String(msg.fromAddr ?? ''), messageId);
      const envelope = await sealOnServer(runtime, scope, content);
      const received = day(msg.receivedAt) ?? day(date);
      const stored = await storeSealedRecord(runtime, ctx, { sourceCode: code, kind: 'conversation', occurredOn: received, envelope,
        originLabel: `Sealed email from source ${code}${received ? `, received ${received}` : ''}; sealed on arrival on the server for the project keys and erased from correspondence` });
      evidenceRef = stored.evidenceRef;
      // Recorded before E03 is asked to erase: a crash after this point resumes at the erase step.
      await set(`state='sealed', record_id=$4, evidence_ref=$5, last_error=null`, [stored.id, stored.evidenceRef]);
    }
    await correspondence.eraseMessageContent(ctx, messageId, { reason: ERASE_REASON, preservedAs: evidenceRef });
    await set(`state='erased', last_error=null, next_attempt_at=now()`, []);
    return 'erased';
  } catch (error) {
    const message = error instanceof Error ? `${error instanceof DomainError ? `${error.code}: ` : ''}${error.message}`.slice(0, 300) : 'failed';
    const delay = Math.min(retryMs(runtime) * 2 ** Math.min(row.attempts, 6), 3_600_000);
    await set(`attempts=attempts+1, last_error=$4, next_attempt_at=now() + ($5::int * interval '1 millisecond')`, [message, delay]).catch(() => undefined);
    await alert(runtime, scope, messageId, 'correspondence.sealed_mail_failed').catch(() => undefined);
    return 'failed';
  }
}

/** Retries messages that are waiting for keys or failed earlier. Run once per worker pass. */
export async function sealPendingMailOnce(runtime: Runtime, limit = 25): Promise<{ attempted: number; erased: number }> {
  const due = await runtime.sql.query<{ tenant_id: string; project_id: string; message_id: string }>(`select tenant_id, project_id, message_id from ${S}.sealed_mail where state <> 'erased' and next_attempt_at <= now() order by next_attempt_at limit ${Math.max(1, Math.min(limit, 200))}`);
  let erased = 0;
  for (const r of due) if (await sealMessage(runtime, { tenantId: r.tenant_id, projectId: r.project_id }, r.message_id) === 'erased') erased++;
  return { attempted: due.length, erased };
}

export function sealedMailRoutes(runtime: Runtime): Route[] {
  return [
    // Which mailboxes seal on arrival, and how far their messages got. Counts and ids only.
    { method: 'GET', path: '/v1/correspondence/sealed-mailboxes', handler: async (r) => {
      requireCapability(r.ctx, 'correspondence:read');
      const counts = await runtime.sql.query<{ mailbox_id: string; state: string; n: string }>(`select mailbox_id, state, count(*) as n from ${S}.sealed_mail where tenant_id=$1 and project_id=$2 group by mailbox_id, state`, [r.ctx.tenantId, r.ctx.projectId]);
      const byMailbox: Record<string, Record<string, number>> = {};
      for (const c of counts) (byMailbox[c.mailbox_id] ??= {})[c.state] = Number(c.n);
      return { mailboxIds: await sealedMailboxes(runtime, r.ctx), sealingKeys: (await activeRecipients(runtime, r.ctx)).length, senderKeyConfigured: senderKey(runtime.env, r.ctx, 'probe@example.org') !== null, messages: byMailbox } as unknown as Json;
    } },
    // Administrators choose the sealed mailboxes. Each id must be a mailbox the caller can see in this project.
    { method: 'PUT', path: '/v1/correspondence/sealed-mailboxes', handler: async (r) => {
      requireCapability(r.ctx, 'correspondence:admin');
      if (r.ctx.actor.kind !== 'human') throw new DomainError('forbidden', 'Only a person can change which mailboxes are sealed');
      const ids = (r.body as { mailboxIds?: unknown } | null)?.mailboxIds;
      if (!Array.isArray(ids) || ids.length > 100 || !ids.every((x) => typeof x === 'string' && /^[0-9a-f-]{36}$/i.test(x))) throw new DomainError('invalid_input', 'mailboxIds must list up to 100 mailbox ids');
      const unique = [...new Set(ids.map((x) => (x as string).toLowerCase()))];
      const correspondence = runtime.get('correspondence');
      for (const id of unique) await correspondence.getMailbox(r.ctx, id);
      await setSetting(runtime, r.ctx, SEALED_MAILBOXES, unique);
      return { mailboxIds: unique } as unknown as Json;
    } },
  ];
}
