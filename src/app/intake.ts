// Intake bridge (E02 → PAM). The intake engine is a separate application reached only through its versioned service API
// with a tenant-scoped credential. The bridge reads its gap-free event feed and:
//   submission.created   → preserves a COPY of the immutable original account in E05 (the original stays owned by E02);
//   attachment.released  → preserves the released bytes in E05 with E02's digest and custody history carried over;
//   case.opened          → opens an investigation in E08 whose original account is the preserved copy.
// Quarantined or blocked uploads are never fetched (E02 refuses to serve them). Protected fields are never requested.
// Credentials are deployment secrets (environment), never stored in the database: PAM_INTAKE_LINKS =
//   {"<PAM organization id>": {"baseUrl": "https://intake.example.org/api/v1", "token": "sicwe_…"}}
import { createHash } from 'node:crypto';
import { DomainError, canonical } from '../contracts.ts';
import type { Json } from '../contracts.ts';
import type { ServiceContext } from '../service-kit.ts';
import { APP_SCHEMA } from './compose.ts';
import type { Runtime } from './compose.ts';

export type IntakeLink = Readonly<{ baseUrl: string; token: string }>;
export function intakeLinks(env: Readonly<Record<string, string | undefined>>): Map<string, IntakeLink> {
  if (!env.PAM_INTAKE_LINKS) return new Map();
  const parsed = JSON.parse(env.PAM_INTAKE_LINKS) as Record<string, IntakeLink>;
  return new Map(Object.entries(parsed).map(([tenant, link]) => {
    const url = new URL(link.baseUrl);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) throw new DomainError('invalid_config', 'Intake base URL must be HTTPS (plain HTTP only on loopback)');
    if (typeof link.token !== 'string' || link.token.length < 20) throw new DomainError('invalid_config', 'Intake credential is missing');
    return [tenant, { baseUrl: link.baseUrl.replace(/\/$/, ''), token: link.token }];
  }));
}

type Any = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
async function call(link: IntakeLink, path: string, raw = false): Promise<{ status: number; json: Any; bytes: Uint8Array; headers: Headers }> {
  const response = await fetch(`${link.baseUrl}${path}`, { headers: { authorization: `Bearer ${link.token}`, accept: raw ? 'application/octet-stream' : 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(30_000) });
  const bytes = new Uint8Array(await response.arrayBuffer());
  let json: Any = {};
  if (!raw) { try { json = JSON.parse(new TextDecoder().decode(bytes)) as Any; } catch { json = {}; } }
  if (!response.ok) throw new DomainError(response.status === 404 ? 'not_found' : response.status >= 500 ? 'unavailable' : 'invalid_state', `Intake ${path.split('?')[0]} answered ${response.status}${json.error?.code ? ` (${json.error.code})` : ''}`);
  return { status: response.status, json, bytes, headers: response.headers };
}

export async function migrateIntake(runtime: Runtime): Promise<void> {
  await runtime.sql.query(`create table if not exists ${APP_SCHEMA}.intake_links (tenant_id text not null, intake_kind text not null, intake_id text not null, pam_ref text not null, created_at timestamptz not null default now(), primary key (tenant_id, intake_kind, intake_id))`);
}
async function link(runtime: Runtime, tenantId: string, kind: string, id: string): Promise<string | null> {
  return ((await runtime.sql.query<{ pam_ref: string }>(`select pam_ref from ${APP_SCHEMA}.intake_links where tenant_id=$1 and intake_kind=$2 and intake_id=$3`, [tenantId, kind, id]))[0]?.pam_ref) ?? null;
}
async function remember(runtime: Runtime, tenantId: string, kind: string, id: string, ref: string): Promise<void> {
  await runtime.sql.query(`insert into ${APP_SCHEMA}.intake_links (tenant_id, intake_kind, intake_id, pam_ref) values ($1,$2,$3,$4) on conflict do nothing`, [tenantId, kind, id, ref]);
}
const uuidish = (v: unknown): string => { const s = String(v); if (!/^[A-Za-z0-9._~-]{1,128}$/.test(s)) throw new DomainError('invalid_input', 'Unexpected intake identifier'); return s; };

async function preserveAccount(runtime: Runtime, ctx: ServiceContext, intake: IntakeLink, submissionId: string): Promise<string> {
  const existing = await link(runtime, ctx.tenantId, 'submission', submissionId);
  if (existing !== null) return existing;
  const s = (await call(intake, `/submissions/${submissionId}`)).json.data as Any;
  const account = s.originalAccount as Any;
  // E02's digest is over the answers alone; it is re-checked here before the copy is preserved.
  const recomputed = createHash('sha256').update(canonical(account.answers)).digest('hex');
  const copy = { schema: 'intake-original-account-copy/v1', owner: 'E02', submission: `E02:submission:${submissionId}`, form: { slug: s.form?.slug, versionNumber: s.form?.versionNumber, fields: (s.form?.fields ?? []).map((f: Any) => ({ id: f.id, label: f.label, protected: f.protected })) },
    locale: s.locale, channel: s.channel, submittedAt: s.submittedAt, answers: account.answers, protectedFieldsWithheld: (s.protectedCompartments ?? []).flatMap((c: Any) => c.fieldIds ?? []),
    intakeDigest: { sha256: account.sha256, recordedSha256: account.recordedSha256, canonicalization: account.canonicalization, matchesRecord: account.digestMatchesRecord === true, recomputedByPam: recomputed, consistent: recomputed === account.sha256 } };
  const bytes = new TextEncoder().encode(`${JSON.stringify(copy, null, 2)}\n`);
  const info = await runtime.get('evidence').accept(ctx, { bytes, mediaType: 'application/json', filename: `original-account-${submissionId}.json`, idempotencyKey: `intake-account-${submissionId}`,
    origin: { kind: 'intake_submission', owner: 'E02', ownerRef: `E02:submission:${submissionId}`, note: 'Copy of the immutable original account. The original remains owned by the intake engine; protected fields were not copied.', intakeSha256: account.sha256, digestConsistent: recomputed === account.sha256, submittedAt: s.submittedAt } as Json }) as { ref: string };
  await remember(runtime, ctx.tenantId, 'submission', submissionId, info.ref);
  return info.ref;
}

async function preserveAttachment(runtime: Runtime, ctx: ServiceContext, intake: IntakeLink, versionId: string, submissionId: string | null): Promise<string> {
  const existing = await link(runtime, ctx.tenantId, 'document_version', versionId);
  if (existing !== null) return existing;
  const content = await call(intake, `/documents/${versionId}/content`, true);
  const declared = content.headers.get('x-content-sha256') ?? '';
  const actual = createHash('sha256').update(content.bytes).digest('hex');
  if (declared !== actual) throw new DomainError('integrity_failed', 'Intake bytes do not match the digest the intake engine declared');
  const custody = (await call(intake, `/documents/${versionId}/custody`)).json.data as Any;
  const filename = decodeURIComponent(content.headers.get('x-original-filename') ?? `${versionId}.bin`).replaceAll(/[^\w.\- ]+/g, '_').slice(0, 200) || `${versionId}.bin`;
  const info = await runtime.get('evidence').accept(ctx, { bytes: content.bytes, mediaType: decodeURIComponent(content.headers.get('x-declared-content-type') ?? 'application/octet-stream').split(';')[0] ?? 'application/octet-stream', filename, idempotencyKey: `intake-doc-${versionId}`,
    origin: { kind: 'intake_attachment', owner: 'E02', ownerRef: `E02:document_version:${versionId}`, ...(submissionId === null ? {} : { submission: `E02:submission:${submissionId}` }), intakeSha256: declared,
      intakeScan: { status: custody.document?.malwareScanStatus ?? null, provider: custody.document?.malwareScanProvider ?? null, at: custody.document?.malwareScannedAt ?? null },
      intakeCustody: ((custody.custody ?? []) as Any[]).map((c) => ({ action: c.action, from: c.fromCustodian, to: c.toCustodian, at: c.occurredAt })), note: 'Copy of a released intake upload; the intake engine retains the original and its custody.' } as Json }) as { ref: string };
  await remember(runtime, ctx.tenantId, 'document_version', versionId, info.ref);
  return info.ref;
}

async function openInvestigation(runtime: Runtime, ctx: ServiceContext, intake: IntakeLink, caseId: string, submissionId: string): Promise<string> {
  const existing = await link(runtime, ctx.tenantId, 'case', caseId);
  if (existing !== null) return existing;
  const accountRef = await preserveAccount(runtime, ctx, intake, submissionId);
  const kase = (await call(intake, `/cases/${caseId}`)).json.data as Any;
  const inv = await runtime.get('investigation').openInvestigation(ctx, { title: `Intake case ${String(kase.caseNumber ?? kase.reference ?? caseId).slice(0, 80)}`, originRef: `E02:case:${caseId}`,
    scopeStatement: 'Investigate the account received through intake: what happened, what supports or contradicts it, and what remains unknown.',
    originalAccount: { ref: accountRef, summary: 'The participant\'s original account is preserved unchanged as referenced evidence.', label: 'allegation' }, idempotencyKey: `intake-case-${caseId}` }) as { ref: string };
  await remember(runtime, ctx.tenantId, 'case', caseId, inv.ref);
  return inv.ref;
}

export type IntakeReport = { tenants: number; events: number; preserved: number; failures: string[] };
/** One pass over every linked organization's intake feed. At-least-once; every step is idempotent. */
export async function syncIntakeOnce(runtime: Runtime): Promise<IntakeReport> {
  const report: IntakeReport = { tenants: 0, events: 0, preserved: 0, failures: [] };
  const links = intakeLinks(runtime.env);
  if (links.size === 0 || runtime.maybe('evidence') === null) return report;
  for (const [tenantId, intake] of links) {
    const home = (await runtime.sql.query<{ home_project_id: string }>(`select home_project_id from ${APP_SCHEMA}.tenants where tenant_id=$1`, [tenantId]))[0];
    if (home === undefined) { report.failures.push(`${tenantId}: organization not provisioned`); continue; }
    report.tenants++;
    const cursorKey = `intake:${tenantId}`;
    let after = await runtime.orchestration.routerCursor(cursorKey);
    try {
      const page = (await call(intake, `/events?limit=100${after === '0' ? '' : `&after=${encodeURIComponent(after)}`}`)).json as Any;
      const ctx = await runtime.serviceContext({ tenantId, projectId: home.home_project_id });
      for (const e of (page.data ?? []) as Any[]) {
        report.events++;
        const r = e.resource ?? {};
        if (e.type === 'submission.created' && r.type === 'submission') { await preserveAccount(runtime, ctx, intake, uuidish(r.id)); report.preserved++; }
        else if (e.type === 'attachment.released') { await preserveAttachment(runtime, ctx, intake, uuidish(r.id), r.parentType === 'submission' ? uuidish(r.parentId) : null); report.preserved++; }
        else if (e.type === 'case.opened' && r.parentType === 'submission' && runtime.maybe('investigation') !== null) await openInvestigation(runtime, ctx, intake, uuidish(r.id), uuidish(r.parentId));
        after = String(e.cursor);
        await runtime.orchestration.routerCursorSet(cursorKey, after);
      }
    } catch (error) { report.failures.push(`${tenantId}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  return report;
}
/** PAM reference recorded for an intake object, if it has been brought in. */
export function intakeRef(runtime: Runtime, tenantId: string, kind: 'submission' | 'document_version' | 'case', id: string): Promise<string | null> { return link(runtime, tenantId, kind, id); }
