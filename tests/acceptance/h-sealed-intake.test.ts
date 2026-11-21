// Acceptance test H: sealed intake answers. The real intake application (E02) is configured with the project's public
// sealing key; a participant's sealed answers and file reach intake only as a ciphertext envelope. The intake bridge gives
// the submission a source code name (channel intake, risk high by default; reused for the same submission), stores the
// envelope as a sealed record (E05, application/vnd.pam.sealed+json), and references that record — never plaintext — from
// the preserved account copy and from the investigation opened for the case. Nothing in PAM's database or object store
// contains the sealed plaintext; the researcher's private key opens the record with the fingerprint verified.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ADMIN_URL, REQUIRED, skipReason, withStack } from './harness.ts';
import { INTAKE_DIR, intakeSkip, startIntake } from './intake-app.ts';
import { intakeRef } from '../../src/app/intake.ts';
import { SEALED_MEDIA_TYPE, keyIdOf } from '../../src/app/sealed.ts';
// @ts-expect-error plain JavaScript module shared with the browser
import { generateKeyPair, importPrivate, open, seal } from '../../web/js/sealed-crypto.js';

const skip = skipReason(REQUIRED) || (ADMIN_URL === '' ? false : intakeSkip());
const SECRET = 'SEALED-ACCEPTANCE-PLAINTEXT-the-foreman-locked-the-fire-exit';
const SECRET_FILE = 'SEALED-ACCEPTANCE-FILE-BYTES-ledger-page-7';
const ORDINARY = 'Ordinary summary: a workplace safety concern.';

const sealedForm = {
  slug: 'sealed-report', name: 'Sealed report', accessMode: 'public',
  definition: { schemaVersion: 1, sections: [{ id: 'main', title: 'Your account', fields: [
    { id: 'summary', type: 'long_text', label: 'Summary', required: true },
    { id: 'story', type: 'long_text', label: 'What happened', sealed: true, required: true },
    { id: 'proof', type: 'file', label: 'Files', sealed: true },
  ] }] },
};

function scanDir(dir: string, needles: string[]): string[] {
  const hits: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) hits.push(...scanDir(path, needles));
    else { const text = readFileSync(path).toString('latin1'); if (needles.some((n) => text.includes(n))) hits.push(path); }
  }
  return hits;
}

test('H: sealed intake answers arrive in PAM as a sealed record only; no plaintext anywhere in PAM', { skip, timeout: 600_000 }, () => withStack(async (stack) => {
  const { runtime } = stack;
  const org = await stack.createOrg('Sealed intake org');
  const research = await org.as(org.owner, 'research');
  // The researcher's key: the private half stays here (the researcher's device); PAM and intake get the public half.
  const key = await generateKeyPair();
  assert.equal(keyIdOf(key.publicJwk), key.id);
  await runtime.sql.query(`insert into pam_app.sealing_keys (tenant_id, project_id, key_id, actor_id, label, public_jwk) values ($1,$2,$3,$4,$5,$6::jsonb)`,
    [org.tenantId, org.projectId, key.id, org.owner.actorId, 'Acceptance laptop', JSON.stringify(key.publicJwk)]);

  const intake = await startIntake(ADMIN_URL, { SEALING_RECIPIENTS: JSON.stringify([{ keyId: key.id, label: 'Acceptance laptop', publicJwk: key.publicJwk }]) });
  try {
    const manifest = JSON.parse(readFileSync(join(INTAKE_DIR, 'examples', 'reporting-manifest.example.json'), 'utf8'));
    const applied = await intake.api(intake.token, 'POST', '/application/manifest', { ...manifest, forms: [...manifest.forms, sealedForm] });
    assert.equal(applied.status, 200, JSON.stringify(applied.body).slice(0, 400));

    // What the participant's browser does: seal the sealed answers and file for the configured keys.
    const content = { schema: 'intake-sealed-answers/v1', text: `What happened\n${SECRET}`, answers: { story: SECRET, proof: ['ledger.txt'] },
      fields: [{ id: 'story', label: 'What happened', type: 'long_text' }, { id: 'proof', label: 'Files', type: 'file' }],
      files: [{ fieldId: 'proof', name: 'ledger.txt', type: 'text/plain', base64: Buffer.from(SECRET_FILE).toString('base64') }] };
    const recipients = [{ id: key.id, publicJwk: key.publicJwk }];
    // Intake refuses sealed answers in clear.
    const clear = await intake.api(intake.token, 'POST', '/submissions', { formSlug: 'sealed-report', answers: { summary: ORDINARY, story: SECRET } });
    assert.equal(clear.status, 422);
    const created = await intake.api(intake.token, 'POST', '/submissions', { formSlug: 'sealed-report', answers: { summary: ORDINARY }, sealedEnvelope: await seal(content, recipients) });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const second = await intake.api(intake.token, 'POST', '/submissions', { formSlug: 'sealed-report', answers: { summary: ORDINARY }, sealedEnvelope: await seal({ text: 'another person' }, recipients) });
    assert.equal(second.status, 201);
    const submissionId = created.body.data.id as string;

    stack.env.PAM_INTAKE_LINKS = JSON.stringify({ [org.tenantId]: { baseUrl: intake.apiBase, token: intake.token } });
    let accountRef: string | null = null;
    await stack.settle(async () => (accountRef = await intakeRef(runtime, org.tenantId, 'submission', submissionId)) !== null
      && (await intakeRef(runtime, org.tenantId, 'submission', second.body.data.id)) !== null, 120_000);
    const sealedRef = await intakeRef(runtime, org.tenantId, 'sealed_submission', submissionId);
    assert.ok(sealedRef, 'the sealed envelope was brought in');

    // One code name per submission (channel intake, risk high by default), each envelope a sealed record.
    const codes = await runtime.sql.query<{ intake_submission_id: string; source_code: string }>(`select intake_submission_id, source_code from pam_app.intake_sealed_sources where tenant_id=$1 order by source_code`, [org.tenantId]);
    assert.equal(codes.length, 2);
    const code = codes.find((c) => c.intake_submission_id === submissionId)!.source_code;
    assert.notEqual(code, codes.find((c) => c.intake_submission_id !== submissionId)!.source_code, 'each participant has their own code name');
    const source = (await runtime.sql.query<{ channel: string; risk: string; note: string }>(`select channel, risk, note from pam_app.sealed_sources where tenant_id=$1 and project_id=$2 and code=$3`, [org.tenantId, org.projectId, code]))[0]!;
    assert.deepEqual({ channel: source.channel, risk: source.risk }, { channel: 'intake', risk: 'high' });
    const records = await runtime.sql.query<{ id: string; source_code: string; kind: string; evidence_ref: string; commitment: string; recipients: string[] }>(`select id, source_code, kind, evidence_ref, commitment, recipients from pam_app.sealed_records where tenant_id=$1 and source_code=$2`, [org.tenantId, code]);
    assert.equal(records.length, 1);
    assert.equal(records[0]!.evidence_ref, sealedRef);
    assert.equal(records[0]!.kind, 'document');
    assert.deepEqual(records[0]!.recipients, [key.id]);

    // The record is ciphertext in E05; the researcher's private key opens it and the fingerprint verifies.
    await stack.settle(async () => (await runtime.get('evidence').describe(research, sealedRef!))?.available === true && (await runtime.get('evidence').describe(research, accountRef!))?.available === true);
    const info = await runtime.get('evidence').describe(research, sealedRef!) as { mediaType?: string };
    assert.match(JSON.stringify(info), new RegExp(SEALED_MEDIA_TYPE.replaceAll('.', '\\.').replaceAll('+', '\\+')));
    const envelope = JSON.parse(new TextDecoder().decode(await runtime.get('evidence').getBytes(research, sealedRef!, {}) as Uint8Array));
    assert.equal(envelope.commitment, records[0]!.commitment);
    const opened = await open(envelope, key.id, await importPrivate(key.privateJwk));
    assert.equal(opened.commitmentVerified, true);
    assert.equal(opened.content.answers.story, SECRET);
    assert.equal(Buffer.from(opened.content.files[0].base64, 'base64').toString(), SECRET_FILE);

    // The account copy holds the ordinary answers and a reference to the sealed record — not the sealed answers.
    const copy = JSON.parse(new TextDecoder().decode(await runtime.get('evidence').getBytes(research, accountRef!, {}) as Uint8Array));
    assert.deepEqual(copy.answers, { summary: ORDINARY });
    assert.deepEqual(copy.sealedFieldsWithheld, ['story', 'proof']);
    assert.equal(copy.sealedRecord.evidenceRef, sealedRef); assert.equal(copy.sealedRecord.sourceCode, code); assert.equal(copy.sealedRecord.unregisteredKeys, 0);

    // A case opened in intake: the investigation's original account points at the copy and names the sealed record.
    const opening = await intake.api(intake.token, 'POST', '/cases', { submissionId });
    assert.ok([200, 201].includes(opening.status), JSON.stringify(opening.body));
    let invRef: string | null = null;
    const caseId = opening.body.data.case?.id ?? opening.body.data.id;
    await stack.settle(async () => (invRef = await intakeRef(runtime, org.tenantId, 'case', caseId)) !== null, 60_000);
    const inv = await runtime.get('investigation').get(research, 'investigation', invRef!.split(':')[2]!.split('@')[0]!);
    assert.match(JSON.stringify(inv), new RegExp(sealedRef!.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')));

    // Re-running the bridge changes nothing: same code, same record.
    await stack.settle();
    assert.equal((await runtime.sql.query(`select 1 from pam_app.intake_sealed_sources where tenant_id=$1`, [org.tenantId])).length, 2);
    assert.equal((await runtime.sql.query(`select 1 from pam_app.sealed_records where tenant_id=$1`, [org.tenantId])).length, 2);

    // Nowhere in PAM — any table of any schema, or any stored object — is the sealed plaintext.
    const needles = [SECRET, SECRET_FILE, Buffer.from(SECRET_FILE).toString('base64')];
    const tables = await runtime.sql.query<{ schemaname: string; tablename: string }>(`select schemaname, tablename from pg_tables where schemaname not in ('pg_catalog', 'information_schema')`);
    assert.ok(tables.length > 20);
    for (const t of tables) {
      const rows = await runtime.sql.query<{ row: string }>(`select t::text as row from "${t.schemaname}"."${t.tablename}" t`);
      for (const r of rows) assert.ok(!needles.some((n) => r.row.includes(n)), `${t.schemaname}.${t.tablename} holds sealed plaintext`);
    }
    assert.deepEqual(scanDir(stack.dataDir, needles), [], 'no stored object holds sealed plaintext');
  } finally { await intake.close(); }
}));
