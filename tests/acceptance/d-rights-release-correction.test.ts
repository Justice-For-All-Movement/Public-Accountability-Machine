// Acceptance test D: participant restrictions and asset permissions; a private review package; an exact candidate
// approved for a controlled destination without private originals or protected metadata; then a source correction and a
// permission withdrawal propagate through claims, findings, editorial content, packages, approvals and distributions —
// prior versions retained, existing distributions flagged for follow-up. Real composed application; fictional data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { REQUIRED, skipReason, withStack } from './harness.ts';
import { toReleasePackage } from '../../src/app/adapters.ts';

const skip = skipReason([...REQUIRED, 'editorial', 'consent']);
const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? walk(p) : [p]; });

test('D: restrictions → private review → exact approval → controlled release → correction and withdrawal propagate', { skip, timeout: 600_000 }, () => withStack(async (stack) => {
  const { runtime } = stack;
  const evidence = runtime.get('evidence'), processing = runtime.get('processing'), knowledge = runtime.get('knowledge'), investigation = runtime.get('investigation');
  const editorial = runtime.get('editorial'), consent = runtime.get('consent'), release = runtime.get('release');
  const org = await stack.createOrg('Riverside Relief Watch');
  const [investigator, reviewer, editor, editor2, releaser, rights] = await Promise.all([
    stack.addUser(org, 'Ines Investigator', ['investigator']), stack.addUser(org, 'Rafi Reviewer', ['reviewer']), stack.addUser(org, 'Edda Editor', ['editor']),
    stack.addUser(org, 'Emil Editor', ['editor']), stack.addUser(org, 'Rosa Release', ['release_manager']), stack.addUser(org, 'Rhea Rights', ['rights_manager'])]);
  const research = await org.as(investigator, 'research'); const rev = await org.as(reviewer, 'editorial');
  const ed = await org.as(editor, 'editorial'); const ed2 = await org.as(editor2, 'editorial'); const rel = await org.as(releaser, 'release'); const rts = await org.as(rights, 'rights');

  // Testimony (fictional) preserved and processed; the witness's name is a protected term.
  const testimony = 'Interview with witness Heron, 14 March.\nI saw the treasurer sign the first payment on 3 March. On 9 March nobody signed anything; the clerk pressed send.\n';
  const ev = await evidence.accept(research, { bytes: new TextEncoder().encode(testimony), mediaType: 'text/plain', filename: 'interview-heron.txt', origin: { kind: 'manual_import', note: 'fictional acceptance fixture' }, idempotencyKey: 'interview' });
  await stack.settle(async () => (await evidence.describe(research, ev.ref)).available === true);
  const proc = await processing.requestProcessing(research, { evidenceRef: ev.ref, idempotencyKey: 'p' });
  await stack.settle(async () => ['done', 'partial', 'failed'].includes((await processing.getProcessing(research, proc.id)).state));
  const rep = (await processing.getAlignment(research, proc.id)).representations[0];
  const seg = rep.segments.find((s: any) => /9 March/.test(s.text)) ?? rep.segments[0];

  // Claim, finding and package built on the testimony.
  const claim = await knowledge.createClaim(research, { text: 'A witness states that nobody signed the 9 March payment.', claimType: 'allegation', idempotencyKey: 'c' });
  await knowledge.addEvidenceLink(research, { target: { kind: 'claim', id: claim.id }, evidenceRef: ev.ref, representationRef: rep.ref, selector: { kind: 'segment', segmentId: seg.id, quote: 'nobody signed anything' }, stance: 'supports', sourceType: 'testimony' });
  const inv = await investigation.openInvestigation(research, { title: 'Riverside relief fund payments', originRef: 'E00:objective:acceptance-d', scopeStatement: 'Who authorised the 9 March payment.', originalAccount: { summary: 'Witness account of the 9 March payment.', label: 'attributed_testimony' } });
  const q = await investigation.addQuestion(research, inv.id, { text: 'Did anyone sign the 9 March payment?', material: true, whyMaterial: 'Core question', claimRefs: [claim.ref] });
  const finding = await investigation.createFinding(research, inv.id, { statement: 'A witness states that nobody signed the 9 March payment; this is not independently confirmed.', label: 'attributed_testimony', classification: 'disputed', questionIds: [q.id],
    supporting: [{ ref: ev.ref, selector: { representation: rep.ref, segmentId: seg.id } }, { ref: claim.ref }], contradicting: [{ ref: ev.ref, selector: { note: 'the same witness confirms a signature on 3 March only' } }],
    limitations: ['Single witness; the payment system log was not obtained.'], confidence: { level: 'possible', basis: 'Single attributed account' },
    checklist: { primary_source_checked: { status: 'done', note: 'interview record' }, independence_by_source_family: { status: 'not_done', note: 'only one source' }, counter_evidence_searched: { status: 'done', note: 'ledger reviewed' }, alternative_explanations_addressed: { status: 'done', note: 'clerical error considered' }, subject_response_sought: { status: 'not_done', note: 'not yet contacted' }, dates_identities_confirmed: { status: 'done', note: 'dates from interview' } } });
  await investigation.submitFinding(research, finding.id);
  await investigation.reviewFinding(rev, finding.id, { decision: 'approve' });
  await investigation.disposeQuestion(research, q.id, { status: 'unresolvable', rationale: 'Payment system log unavailable to the project.', whatWouldResolve: 'The bank or council payment log.' });
  const pkg = await investigation.buildPackage(research, inv.id, { idempotencyKey: 'pkg' });

  // Participant permission with a standing restriction (anonymise); an asset licence for a third-party photo.
  const holder = await consent.registerHolder(rts, { ref: 'E02:participant:witness-heron', kind: 'participant' });
  const subject = ev.ref.split('@')[0];
  const permission = await consent.recordPermission(rts, { holderId: holder.id, scope: { type: 'subject', value: subject }, subjectKind: 'testimony', effect: 'allow', actions: ['investigate', 'preserve', 'cite', 'adapt', 'reproduce'],
    // Audience names are deployment vocabulary shared by consent and release (here the release engine's defaults).
    audiences: ['internal', 'internal_review', 'legal_counsel'], restrictions: ['anonymise'], provenance: { method: 'recorded_verbal', obtainedAt: '2026-03-14T10:00:00Z', note: 'Recorded at interview (fictional)' }, idempotencyKey: 'perm' });
  const publicDecision = await consent.decide(rts, { subjects: [subject], action: 'publish', purpose: 'accountability', audience: 'public' });
  assert.notEqual(publicDecision.decision, 'allow', 'public publication was never permitted');
  const citeUnknown = await consent.decide(rts, { subjects: ['E05:evidence_version:unregistered-photo'], action: 'cite', purpose: 'accountability', audience: 'legal_counsel' });
  assert.equal(citeUnknown.decision, 'allow', 'unknown reproduction rights do not prohibit citation');

  // Editorial work from the investigation, approved by a second editor at an exact revision.
  const project = await editorial.create(ed, 'editorial_project', { body: { title: 'The second payment', format: 'report', projectKind: 'factual', publishingIdentity: 'Riverside Relief Watch', language: 'en', credits: [], investigationRefs: [inv.ref] } });
  const gen = await editorial.generate(ed, { generator: 'narrative', editorialProjectId: project.id, package: pkg, title: 'The second payment' });
  const doc = gen.document;
  assert.ok(doc.body.blocks.every((b: any) => typeof b.basis === 'string'), 'every generated block carries a basis label');
  assert.ok(doc.body.blocks.some((b: any) => (b.sources ?? []).some((r: string) => r.startsWith('E08:') || r.startsWith('E07:'))), 'factual blocks cite findings or claims');
  await editorial.requestReview(ed, 'document', doc.id, { expectedRevision: doc.revision });
  await editorial.approve(ed2, 'document', doc.id, { revision: doc.revision, note: 'Checked against the package' });

  // Private review package: the protected name never leaves, even when planted in a source title.
  const input = toReleasePackage(pkg) as any;
  const leaky = await release.buildPackage(rel, { kind: 'source_companion', title: 'Sources', audience: 'legal_counsel', sources: [{ ref: ev.ref, title: 'Interview with Heron', supports: ['finding'] }], protectedTerms: ['Heron'], idempotencyKey: 'leaky' });
  assert.equal(leaky.state, 'leak_blocked', 'a protected name in a source title blocks the candidate');
  const cand = await release.buildPackage(rel, { kind: 'investigation_report', title: 'Report for counsel: 9 March payment', audience: 'legal_counsel', formats: ['html', 'pdf'], package: input, subjects: [subject], protectedTerms: ['Heron'], idempotencyKey: 'report' });
  assert.equal(cand.state, 'built', JSON.stringify(cand.leakReport).slice(0, 300));
  // Private review by a second person (the organization owner here) before any approval.
  await release.submitForReview(rel, cand.id, { reviewers: [org.owner.actorId] });
  await release.recordReview(await org.as(org.owner, 'release'), cand.id, { candidateDigest: cand.digest, outcome: 'accepted', body: 'Read in full; no identifying detail.' });
  const dest = await release.createDestination(await org.as(org.owner, 'administration'), { name: 'Counsel review portal', kind: 'local_directory', audiences: ['legal_counsel'], config: { root: 'review_portal' } });
  const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
  await assert.rejects(release.approve(rel, cand.id, { candidateDigest: '0'.repeat(64), audience: 'legal_counsel', destinationId: dest.id, expiresAt }), 'approval binds the exact digest');
  const approval = await release.approve(rel, cand.id, { candidateDigest: cand.digest, audience: 'legal_counsel', destinationId: dest.id, expiresAt, idempotencyKey: 'approve' });
  const released = await release.release(rel, cand.id, { approvalId: approval.id, audience: 'legal_counsel', destinationId: dest.id, protectedTerms: ['Heron'] });
  assert.ok(['delivered', 'released', 'succeeded'].includes(released.state ?? released.outcome), JSON.stringify(released).slice(0, 300));
  const delivered = walk(join(stack.dataDir, 'destinations'));
  assert.ok(delivered.length > 0, 'files reached the controlled destination');
  for (const file of delivered) {
    const bytes = readFileSync(file);
    assert.ok(!bytes.includes(Buffer.from('Heron')), `protected name absent from ${file}`);
    assert.ok(!bytes.equals(Buffer.from(testimony)), 'the private original is not included');
    if (file.endsWith('.pdf')) assert.doesNotMatch(execFileSync('exiftool', ['-a', '-G1', file]).toString(), /Heron|Author\s*:\s*\S/, 'no protected or author metadata in the PDF');
  }
  console.log('released', cand.ref, 'files', delivered.length);

  // Correction of the source text: the transcript was wrong about who pressed send.
  const corrected = await processing.correctText(research, { representation: rep.ref, corrections: [{ segmentId: seg.id, text: seg.text.replace('the clerk pressed send', 'the payment was scheduled automatically') }], reason: 'Re-listened to the recording' });
  const staleAll = async (): Promise<Record<string, boolean>> => ({
    claim: (await knowledge.getClaim(research, claim.id)).stale === true,
    finding: (await investigation.get(research, 'finding', finding.id)).stale === true,
    editorial: JSON.stringify(await editorial.listApprovals(ed, 'document', doc.id)).includes('needs_renewal'),
    approval: (JSON.stringify(await release.getCandidate(rel, cand.id)).includes('"stale":true')),
    followUp: (await release.distributionHistory(rel, { candidateId: cand.id, needsFollowUp: true })).length > 0,
  });
  let flags: Record<string, boolean> = {};
  await stack.settle(async () => { flags = await staleAll(); return Object.values(flags).every(Boolean); }, 120_000).catch(() => undefined);
  assert.deepEqual(flags, { claim: true, finding: true, editorial: true, approval: true, followUp: true }, 'the correction reached every dependent');
  const approvals = JSON.stringify(await release.getCandidate(rel, cand.id));
  assert.match(approvals, /invalid|stale/i, 'the approval of the exact candidate is no longer valid');
  await assert.rejects(release.approve(rel, cand.id, { candidateDigest: cand.digest, audience: 'legal_counsel', destinationId: dest.id, expiresAt }), 'a stale candidate cannot be re-approved; renewed review needs a new candidate');
  const history = await release.distributionHistory(rel, { candidateId: cand.id });
  assert.equal(history.length, 1, 'repeating the release did not distribute twice');
  // Prior versions retained.
  assert.match((await processing.getRepresentation(research, rep.ref, { revision: 1 })).segments.map((s: any) => s.text).join(' '), /clerk pressed send/);
  assert.equal(corrected.revision, 2);
  assert.equal(new TextDecoder().decode(await evidence.getBytes(research, ev.ref)), testimony, 'the original bytes are untouched');
  assert.equal((await editorial.get(ed, 'document', doc.id, doc.revision)).revision, doc.revision);

  // Withdrawal of the participant's permission: future use stops; existing outputs are identified.
  const withdrawal = await consent.withdraw(rts, { permissionId: permission.id, reason: 'Participant asked to stop' });
  assert.ok(withdrawal.affectedOutputs.length + withdrawal.affectedUses.length > 0, `withdrawal identifies affected outputs: ${JSON.stringify(withdrawal).slice(0, 300)}`);
  assert.equal((await consent.decide(rts, { subjects: [subject], action: 'adapt', purpose: 'accountability', audience: 'legal_counsel' })).decision, 'deny');
  await stack.settle(async () => (await release.getCandidate(rel, cand.id)).blocked === true, 60_000);
  const blockedEditorial = JSON.stringify(await editorial.listFlags(ed, { documentId: doc.id }).catch(() => editorial.get(ed, 'document', doc.id)));
  assert.match(blockedEditorial, /blocked|withdraw/i, 'editorial content depending on the testimony is blocked');
  const rebuild = await release.buildPackage(rel, { kind: 'investigation_report', title: 'Report v2', audience: 'legal_counsel', formats: ['html'], package: input, subjects: [subject], protectedTerms: ['Heron'], supersedes: cand.id, idempotencyKey: 'report-2' });
  const deny = await release.approve(rel, rebuild.id, { candidateDigest: rebuild.digest, audience: 'legal_counsel', destinationId: dest.id, expiresAt }).then(() => 'approved', (e: any) => e.code);
  assert.notEqual(deny, 'approved', 'after withdrawal no new approval is possible for material using the testimony');
  console.log('withdrawal affected', withdrawal.affectedOutputs.length, 'outputs;', 'flags', JSON.stringify(flags));
}));
