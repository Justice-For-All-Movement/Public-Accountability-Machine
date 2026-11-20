// Sealed records (docs/SEALED_SOURCES.md): conversations, interview notes and documents from people at risk are encrypted
// in the researcher's browser (web/js/sealed-crypto.js) before they reach PAM. The server keeps:
//  - each researcher's PUBLIC sealing key (private keys never leave their devices);
//  - source code names (S-1, S-2, …) with channel and risk level, never names or contact details;
//  - each sealed record: the ciphertext envelope, stored as evidence (E05, so custody, retention and citation work as for
//    any evidence), plus its code name, channel, date and the salted commitment that lets a decrypting researcher prove
//    the original is unchanged.
// A full copy of the server therefore yields ciphertext, code names and dates — not what was said or by whom.
import { createHash } from 'node:crypto';
import { DomainError } from '../contracts.ts';
import type { Json } from '../contracts.ts';
import { requireCapability } from '../service-kit.ts';
import type { Route, ServiceContext, Sql } from '../service-kit.ts';
import type { Runtime } from './compose.ts';

const S = 'pam_app';
export const SEALED_MEDIA_TYPE = 'application/vnd.pam.sealed+json';
const RISK = ['low', 'medium', 'high', 'severe'];
const CHANNELS = ['signal', 'intake', 'email', 'phone', 'in_person', 'briar', 'other'];

export async function migrateSealed(sql: Sql): Promise<void> {
  await sql.query(`create table if not exists ${S}.sealing_keys (tenant_id text not null, project_id text not null, key_id text not null, actor_id text not null, label text not null,
    public_jwk jsonb not null, created_at timestamptz not null default now(), revoked_at timestamptz, primary key (tenant_id, project_id, key_id))`);
  await sql.query(`create table if not exists ${S}.sealed_sources (tenant_id text not null, project_id text not null, code text not null, seq integer not null, channel text not null, risk text not null,
    note text, created_by text not null, created_at timestamptz not null default now(), primary key (tenant_id, project_id, code))`);
  await sql.query(`create table if not exists ${S}.sealed_records (id text primary key, tenant_id text not null, project_id text not null, source_code text not null, channel text not null,
    occurred_on date, kind text not null, evidence_ref text not null, commitment text not null, recipients text[] not null, created_by text not null, created_at timestamptz not null default now())`);
  // Earlier envelopes of a record (re-sealed for new keys); each stays in evidence storage.
  await sql.query(`create table if not exists ${S}.sealed_record_versions (record_id text not null, evidence_ref text not null, recipients text[] not null, replaced_by text not null, replaced_at timestamptz not null default now())`);
  await sql.query(`create index if not exists sealed_records_scope on ${S}.sealed_records (tenant_id, project_id, created_at desc)`);
}

const B64 = /^[A-Za-z0-9+/]+={0,2}$/;
const fail = (m: string): never => { throw new DomainError('invalid_input', m); };
const isB64 = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max && B64.test(v);
const isCoord = (v: unknown): boolean => typeof v === 'string' && /^[A-Za-z0-9_-]{43}$/.test(v);
function publicJwk(v: unknown): { crv: string; kty: string; x: string; y: string } {
  const j = v as Record<string, unknown>;
  if (!j || typeof j !== 'object' || j.kty !== 'EC' || j.crv !== 'P-256' || !isCoord(j.x) || !isCoord(j.y) || 'd' in j) fail('publicJwk must be a P-256 public key (never a private key)');
  return { crv: 'P-256', kty: 'EC', x: j.x as string, y: j.y as string };
}
const canonical = (v: unknown): string => Array.isArray(v) ? `[${v.map(canonical).join(',')}]` : v && typeof v === 'object' ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}` : JSON.stringify(v);
export const keyIdOf = (jwk: { crv: string; kty: string; x: string; y: string }): string => createHash('sha256').update(canonical(jwk)).digest('hex');

/** Only a well-formed ciphertext envelope is accepted: no other fields, so plaintext cannot slip in by mistake. */
export function checkEnvelope(v: unknown): { commitment: string; recipients: string[] } {
  const e = v as Record<string, unknown>;
  if (!e || typeof e !== 'object' || Array.isArray(e)) fail('envelope must be an object');
  const allowed = ['format', 'v', 'alg', 'iv', 'ciphertext', 'recipients', 'commitment'];
  const extra = Object.keys(e).filter((k) => !allowed.includes(k)); if (extra.length) fail(`envelope has fields that are not part of a sealed envelope: ${extra.join(', ')}`);
  if (e.format !== 'pam-sealed' || e.v !== 1 || e.alg !== 'ECDH-P256+HKDF-SHA256+A256GCM') fail('unknown envelope format');
  if (!isB64(e.iv, 24) || !isB64(e.ciphertext, 40_000_000)) fail('iv and ciphertext must be base64');
  if (typeof e.commitment !== 'string' || !/^[0-9a-f]{64}$/.test(e.commitment)) fail('commitment must be a SHA-256 hex digest');
  if (!Array.isArray(e.recipients) || e.recipients.length < 1 || e.recipients.length > 50) fail('recipients must list 1–50 wrapped keys');
  const ids = (e.recipients as unknown[]).map((r) => {
    const x = r as Record<string, unknown>;
    const extraR = Object.keys(x ?? {}).filter((k) => !['keyId', 'epk', 'salt', 'iv', 'wrappedKey'].includes(k)); if (extraR.length) fail('recipient entries have unexpected fields');
    if (typeof x.keyId !== 'string' || !/^[0-9a-f]{64}$/.test(x.keyId)) fail('recipient keyId must be a key fingerprint');
    publicJwk(x.epk); if (!isB64(x.salt, 32) || !isB64(x.iv, 24) || !isB64(x.wrappedKey, 128)) fail('recipient wrapping fields must be base64');
    return x.keyId as string;
  });
  return { commitment: e.commitment as string, recipients: ids };
}

const read = (ctx: ServiceContext): void => { if (!['evidence:read', 'investigation:read', 'knowledge:read'].some((c) => ctx.capabilities.includes(c))) requireCapability(ctx, 'evidence:read'); };
const body = (r: { body: unknown }): Record<string, unknown> => (r.body && typeof r.body === 'object' && !Array.isArray(r.body) ? r.body as Record<string, unknown> : fail('A JSON object body is required'));

export function sealedRoutes(runtime: Runtime): Route[] {
  const sql = runtime.sql;
  return [
    // Public sealing keys of the project's researchers. Records are sealed for these keys.
    { method: 'GET', path: '/v1/sealed/keys', handler: async (r) => {
      read(r.ctx);
      const rows = await sql.query<Record<string, unknown>>(`select key_id, actor_id, label, public_jwk, created_at from ${S}.sealing_keys where tenant_id=$1 and project_id=$2 and revoked_at is null order by created_at`, [r.ctx.tenantId, r.ctx.projectId]);
      return { keys: rows.map((k) => ({ keyId: k.key_id, actorId: k.actor_id, label: k.label, publicJwk: k.public_jwk, createdAt: (k.created_at as Date).toISOString(), mine: k.actor_id === r.ctx.actor.id })) } as unknown as Json;
    } },
    { method: 'POST', path: '/v1/sealed/keys', handler: async (r) => {
      requireCapability(r.ctx, 'evidence:write');
      if (r.ctx.actor.kind !== 'human') throw new DomainError('forbidden', 'Only people hold sealing keys');
      const b = body(r); const jwk = publicJwk(b.publicJwk); const id = keyIdOf(jwk);
      const label = typeof b.label === 'string' && b.label.trim() !== '' && b.label.length <= 100 ? b.label.trim() : fail('label (for example "Laptop") is required');
      await sql.query(`insert into ${S}.sealing_keys (tenant_id, project_id, key_id, actor_id, label, public_jwk) values ($1,$2,$3,$4,$5,$6::jsonb) on conflict do nothing`, [r.ctx.tenantId, r.ctx.projectId, id, r.ctx.actor.id, label, JSON.stringify(jwk)]);
      return { status: 201, json: { keyId: id } };
    } },
    { method: 'POST', path: '/v1/sealed/keys/:id/revoke', handler: async (r) => {
      const rows = await sql.query(`update ${S}.sealing_keys set revoked_at=now() where tenant_id=$1 and project_id=$2 and key_id=$3 and actor_id=$4 and revoked_at is null returning key_id`, [r.ctx.tenantId, r.ctx.projectId, r.params.id, r.ctx.actor.id]);
      if (rows.length === 0) throw new DomainError('not_found', 'No active key of yours with that id');
      return { revoked: r.params.id } as unknown as Json;
    } },
    // Source code names. A code stands for a person whose identity is kept off the server.
    { method: 'GET', path: '/v1/sealed/sources', handler: async (r) => {
      read(r.ctx);
      const rows = await sql.query<Record<string, unknown>>(`select s.code, s.channel, s.risk, s.note, s.created_at, (select count(*) from ${S}.sealed_records x where x.tenant_id=s.tenant_id and x.project_id=s.project_id and x.source_code=s.code) as records
        from ${S}.sealed_sources s where s.tenant_id=$1 and s.project_id=$2 order by s.seq`, [r.ctx.tenantId, r.ctx.projectId]);
      return { sources: rows.map((s) => ({ code: s.code, channel: s.channel, risk: s.risk, note: s.note, records: Number(s.records), createdAt: (s.created_at as Date).toISOString() })) } as unknown as Json;
    } },
    { method: 'POST', path: '/v1/sealed/sources', handler: async (r) => {
      requireCapability(r.ctx, 'evidence:write');
      const b = body(r);
      const channel = CHANNELS.includes(b.channel as string) ? b.channel as string : fail(`channel must be one of ${CHANNELS.join(', ')}`);
      const risk = RISK.includes(b.risk as string) ? b.risk as string : fail(`risk must be one of ${RISK.join(', ')}`);
      const note = b.note === undefined || b.note === '' ? null : typeof b.note === 'string' && b.note.length <= 500 ? b.note : fail('note must be at most 500 characters');
      const out = await sql.tx(async (tx) => {
        await tx.query(`select pg_advisory_xact_lock(hashtext($1))`, [`sealed-sources:${r.ctx.tenantId}:${r.ctx.projectId}`]);
        const seq = Number((await tx.query<{ n: string }>(`select coalesce(max(seq), 0) + 1 as n from ${S}.sealed_sources where tenant_id=$1 and project_id=$2`, [r.ctx.tenantId, r.ctx.projectId]))[0]?.n ?? 1);
        await tx.query(`insert into ${S}.sealed_sources (tenant_id, project_id, code, seq, channel, risk, note, created_by) values ($1,$2,$3,$4,$5,$6,$7,$8)`, [r.ctx.tenantId, r.ctx.projectId, `S-${seq}`, seq, channel, risk, note, r.ctx.actor.id]);
        return `S-${seq}`;
      });
      return { status: 201, json: { code: out } };
    } },
    // Sealed records: the server receives only the ciphertext envelope and non-identifying metadata.
    { method: 'GET', path: '/v1/sealed/records', handler: async (r) => {
      read(r.ctx);
      const code = r.query.get('source');
      const rows = await sql.query<Record<string, unknown>>(`select id, source_code, channel, occurred_on, kind, evidence_ref, commitment, recipients, created_by, created_at from ${S}.sealed_records
        where tenant_id=$1 and project_id=$2 and ($3::text is null or source_code=$3) order by created_at desc limit 500`, [r.ctx.tenantId, r.ctx.projectId, code]);
      return { records: rows.map((x) => ({ id: x.id, sourceCode: x.source_code, channel: x.channel, occurredOn: x.occurred_on ? (x.occurred_on as Date).toISOString().slice(0, 10) : null, kind: x.kind, evidenceRef: x.evidence_ref, commitment: x.commitment, recipients: x.recipients, createdBy: x.created_by, createdAt: (x.created_at as Date).toISOString() })) } as unknown as Json;
    } },
    { method: 'POST', path: '/v1/sealed/records', handler: async (r) => {
      requireCapability(r.ctx, 'evidence:write');
      const b = body(r);
      const extra = Object.keys(b).filter((k) => !['sourceCode', 'kind', 'occurredOn', 'envelope'].includes(k)); if (extra.length) fail(`unexpected fields: ${extra.join(', ')} (a sealed record carries no plaintext)`);
      const code = typeof b.sourceCode === 'string' ? b.sourceCode : fail('sourceCode is required');
      const src = (await sql.query<{ channel: string }>(`select channel from ${S}.sealed_sources where tenant_id=$1 and project_id=$2 and code=$3`, [r.ctx.tenantId, r.ctx.projectId, code]))[0] ?? fail('Unknown source code; create it first');
      const kind = ['conversation', 'interview_notes', 'document', 'other'].includes(b.kind as string) ? b.kind as string : fail('kind must be conversation, interview_notes, document or other');
      const occurredOn = b.occurredOn === undefined || b.occurredOn === null || b.occurredOn === '' ? null : typeof b.occurredOn === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(b.occurredOn) ? b.occurredOn : fail('occurredOn must be a date (YYYY-MM-DD)');
      const env = checkEnvelope(b.envelope);
      const active = new Set((await sql.query<{ key_id: string }>(`select key_id from ${S}.sealing_keys where tenant_id=$1 and project_id=$2 and revoked_at is null`, [r.ctx.tenantId, r.ctx.projectId])).map((x) => x.key_id));
      const unknown = env.recipients.filter((k) => !active.has(k)); if (unknown.length) fail(`envelope is sealed for keys that are not registered in this project: ${unknown.map((k) => k.slice(0, 12)).join(', ')}`);
      const id = `sealed_${createHash('sha256').update(env.commitment).digest('hex').slice(0, 24)}`;
      const stored = await runtime.get('evidence').accept(r.ctx, { bytes: new TextEncoder().encode(JSON.stringify(b.envelope)), mediaType: SEALED_MEDIA_TYPE, filename: `${id}.sealed.json`,
        origin: { kind: 'sealed_record', label: `Sealed ${kind} from source ${code} (${src.channel}${occurredOn ? `, ${occurredOn}` : ''}); encrypted in the researcher's browser` } as Json, idempotencyKey: `sealed-${env.commitment}` }) as { ref: string };
      await sql.query(`insert into ${S}.sealed_records (id, tenant_id, project_id, source_code, channel, occurred_on, kind, evidence_ref, commitment, recipients, created_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) on conflict (id) do nothing`,
        [id, r.ctx.tenantId, r.ctx.projectId, code, src.channel, occurredOn, kind, stored.ref, env.commitment, env.recipients, r.ctx.actor.id]);
      return { status: 201, json: { id, evidenceRef: stored.ref, commitment: env.commitment } };
    } },
    // Re-seal for the project's current keys. The commitment must be unchanged (same content, same salt), so the record
    // stays the same evidence; the earlier envelope is kept.
    { method: 'POST', path: '/v1/sealed/records/:id/reseal', handler: async (r) => {
      requireCapability(r.ctx, 'evidence:write');
      const row = (await sql.query<{ evidence_ref: string; commitment: string; recipients: string[]; source_code: string; kind: string }>(`select evidence_ref, commitment, recipients, source_code, kind from ${S}.sealed_records where tenant_id=$1 and project_id=$2 and id=$3`, [r.ctx.tenantId, r.ctx.projectId, r.params.id]))[0] ?? (() => { throw new DomainError('not_found', 'No such sealed record'); })();
      const b = body(r); const env = checkEnvelope(b.envelope);
      if (env.commitment !== row.commitment) throw new DomainError('invalid_input', 'The re-sealed envelope has a different fingerprint: it is not the same record');
      const active = new Set((await sql.query<{ key_id: string }>(`select key_id from ${S}.sealing_keys where tenant_id=$1 and project_id=$2 and revoked_at is null`, [r.ctx.tenantId, r.ctx.projectId])).map((x) => x.key_id));
      const unknown = env.recipients.filter((k) => !active.has(k)); if (unknown.length) fail('envelope is sealed for keys that are not registered in this project');
      const stored = await runtime.get('evidence').accept(r.ctx, { bytes: new TextEncoder().encode(JSON.stringify(b.envelope)), mediaType: SEALED_MEDIA_TYPE, filename: `${r.params.id}.sealed.json`,
        origin: { kind: 'sealed_record_reseal', label: `Sealed record ${r.params.id} (source ${row.source_code}) re-sealed for ${env.recipients.length} keys; same fingerprint ${row.commitment.slice(0, 16)}…; previous envelope ${row.evidence_ref}` } as Json, idempotencyKey: `reseal-${r.params.id}-${[...env.recipients].sort().join('').slice(0, 64)}` }) as { ref: string };
      await sql.tx(async (tx) => {
        await tx.query(`insert into ${S}.sealed_record_versions (record_id, evidence_ref, recipients, replaced_by) values ($1,$2,$3,$4)`, [r.params.id, row.evidence_ref, row.recipients, r.ctx.actor.id]);
        await tx.query(`update ${S}.sealed_records set evidence_ref=$2, recipients=$3 where id=$1`, [r.params.id, stored.ref, env.recipients]);
      });
      return { id: r.params.id, evidenceRef: stored.ref, previous: row.evidence_ref, recipients: env.recipients.length } as unknown as Json;
    } },
    // The envelope itself, for decryption in the browser.
    { method: 'GET', path: '/v1/sealed/records/:id/envelope', handler: async (r) => {
      read(r.ctx);
      const row = (await sql.query<{ evidence_ref: string }>(`select evidence_ref from ${S}.sealed_records where tenant_id=$1 and project_id=$2 and id=$3`, [r.ctx.tenantId, r.ctx.projectId, r.params.id]))[0] ?? (() => { throw new DomainError('not_found', 'No such sealed record'); })();
      const bytes = await runtime.get('evidence').getBytes(r.ctx, row.evidence_ref, {}) as Uint8Array;
      return JSON.parse(new TextDecoder().decode(bytes)) as Json;
    } },
  ];
}
