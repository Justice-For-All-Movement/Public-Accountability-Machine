// Acceptance test A (in progress): evidence → processing → knowledge → investigation → package, across two isolated
// organizations, on the real composed application. Intake (E02), discovery (E04) and legal-support drafting (E12) join
// this test as those engines land; until then their steps are absent, not simulated.
import test from 'node:test';
import assert from 'node:assert/strict';
import { skipReason, withStack } from './harness.ts';

const skip = skipReason();
test('A: evidence is preserved, processed, linked to claims and investigated; a second organization sees nothing', { skip, timeout: 600_000 }, () => withStack(async (stack) => {
  const { runtime } = stack;
  const evidence = runtime.get('evidence'), processing = runtime.get('processing'), knowledge = runtime.get('knowledge'), investigation = runtime.get('investigation');
  const orgA = await stack.createOrg('Riverside Relief Watch'); const orgB = await stack.createOrg('Harbour Records Project');
  const investigator = await stack.addUser(orgA, 'Ines Investigator', ['investigator']);
  const reviewer = await stack.addUser(orgA, 'Rafi Reviewer', ['reviewer']);
  const research = await orgA.as(investigator, 'research');

  // 1. Preserve originals (fictional fixtures).
  const ledger = 'Riverside Flood Relief Fund - ledger extract\n3 March: transfer of 4,200 to Riverside Supplies Ltd, approved by treasurer M. Okafor.\n9 March: transfer of 4,200 to Riverside Supplies Ltd, no approval recorded.\n';
  const minutes = 'Committee minutes, 12 March. The treasurer stated that only one payment to Riverside Supplies had been authorised.\n';
  const a = await evidence.accept(research, { bytes: new TextEncoder().encode(ledger), mediaType: 'text/plain', filename: 'ledger-extract.txt', origin: { kind: 'manual_import', note: 'fictional acceptance fixture' }, idempotencyKey: 'ledger' });
  const b = await evidence.accept(research, { bytes: new TextEncoder().encode(minutes), mediaType: 'text/plain', filename: 'minutes.txt', origin: { kind: 'manual_import', note: 'fictional acceptance fixture' }, idempotencyKey: 'minutes' });
  assert.equal(a.available, false, 'new evidence starts in quarantine');
  await stack.settle(async () => (await evidence.describe(research, a.ref)).available && (await evidence.describe(research, b.ref)).available);
  assert.deepEqual(new TextDecoder().decode(await evidence.getBytes(research, a.ref)), ledger, 'restored original matches');

  // 2. Process: real extraction with segment anchors; searchable output.
  const pa = await processing.requestProcessing(research, { evidenceRef: a.ref, idempotencyKey: 'p-ledger' });
  const pb = await processing.requestProcessing(research, { evidenceRef: b.ref, idempotencyKey: 'p-minutes' });
  await stack.settle(async () => ['done', 'partial', 'failed'].includes((await processing.getProcessing(research, pa.id)).state) && ['done', 'partial', 'failed'].includes((await processing.getProcessing(research, pb.id)).state));
  const doneA = await processing.getProcessing(research, pa.id);
  assert.ok(['done', 'partial'].includes(doneA.state), `processing state ${doneA.state}: ${doneA.failure} ${JSON.stringify(doneA.steps?.map((x: any) => [x.kind ?? x.step, x.state, x.failure ?? x.error]))}`);
  const alignment = await processing.getAlignment(research, pa.id);
  const rep = alignment.representations[0];
  assert.match(rep.segments.map((x: any) => x.text).join(' '), /no approval recorded/);
  const hits = await processing.searchSegments(research, { q: 'Riverside Supplies' });
  assert.ok(hits.some((h: any) => h.evidenceRef === a.ref), 'search finds the ledger by its extracted text');
  console.log('processed', rep.ref, 'segments', rep.segments.length);

  // 3. Knowledge: source-linked claims with supporting AND challenging material, an alternative explanation, an assessment.
  const seg = rep.segments[0];
  const paid = await knowledge.createClaim(research, { text: 'Two transfers of 4,200 were made from the relief fund to Riverside Supplies Ltd in March.', claimType: 'observation', idempotencyKey: 'c-paid' });
  const unauthorised = await knowledge.createClaim(research, { text: 'The second transfer of 9 March was not authorised.', claimType: 'allegation', idempotencyKey: 'c-unauth' });
  await knowledge.addEvidenceLink(research, { target: { kind: 'claim', id: paid.id }, evidenceRef: a.ref, representationRef: rep.ref, selector: { kind: 'segment', segmentId: seg.id, quote: 'transfer of 4,200 to Riverside Supplies Ltd' }, stance: 'supports', sourceType: 'official_record' });
  await knowledge.addEvidenceLink(research, { target: { kind: 'claim', id: unauthorised.id }, evidenceRef: a.ref, representationRef: rep.ref, selector: { kind: 'segment', segmentId: seg.id, quote: 'no approval recorded' }, stance: 'supports' });
  await knowledge.addEvidenceLink(research, { target: { kind: 'claim', id: unauthorised.id }, evidenceRef: b.ref, selector: { kind: 'whole' }, stance: 'challenges', note: 'Minutes record the treasurer\'s statement only; they do not show who made the second transfer.' });
  const dossier = await knowledge.getClaim(research, unauthorised.id);
  assert.ok(JSON.stringify(dossier).includes('challenges') && JSON.stringify(dossier).includes('supports'), 'supporting and challenging material are kept together');
  // final assessments need the exact approval capability: the investigator proposes, a reviewer records
  await assert.rejects(knowledge.recordAssessment(research, paid.id, { dimension: 'factual', value: 'supported', rationale: 'x'.repeat(60), documentedRationale: true }), (e: any) => e.code === 'forbidden');
  await knowledge.recordAssessment(await orgA.as(reviewer, 'editorial'), paid.id, { dimension: 'factual', value: 'supported', rationale: 'Both transfers appear in the fund ledger extract, a primary financial record preserved as evidence.', documentedRationale: true });
  await knowledge.createEvent(research, { title: 'First transfer of 4,200 to Riverside Supplies Ltd', time: { earliest: '2026-03-03T00:00:00Z', latest: '2026-03-03T23:59:59Z', precision: 'day' }, claimIds: [paid.id] });
  await knowledge.createEvent(research, { title: 'Second transfer of 4,200 to Riverside Supplies Ltd, authorisation not recorded', time: { earliest: '2026-03-09T00:00:00Z', latest: '2026-03-09T23:59:59Z', precision: 'day' }, claimIds: [unauthorised.id] });
  const gaps = await knowledge.researchGaps(research, {});
  assert.ok(JSON.stringify(gaps).includes(unauthorised.id), 'the unassessed allegation is reported as a research gap');
  // an agent cannot finalise an assessment
  const agentLike = { ...research, actor: { ...research.actor, kind: 'agent' as const } };
  await assert.rejects(knowledge.recordAssessment(agentLike, unauthorised.id, { dimension: 'factual', value: 'supported', rationale: 'x'.repeat(60), documentedRationale: true }), (e: any) => e.code === 'forbidden');
  console.log('claims', paid.ref, unauthorised.ref);

  // 4. Investigation: questions, competing explanations, attempts, a reviewed finding, a package with exact sources.
  const inv = await investigation.openInvestigation(research, { title: 'Riverside relief fund payments', originRef: 'E00:objective:acceptance-a', scopeStatement: 'Whether relief fund money was paid out without authorisation in March.', originalAccount: { summary: 'A resident reported that the fund paid the same supplier twice.', label: 'allegation' }, idempotencyKey: 'inv' });
  const q1 = await investigation.addQuestion(research, inv.id, { text: 'Were two payments made to the same supplier?', material: true, whyMaterial: 'Core of the account', claimRefs: [paid.ref] });
  const q2 = await investigation.addQuestion(research, inv.id, { text: 'Who authorised the second payment?', material: true, whyMaterial: 'Determines whether it was unauthorised', claimRefs: [unauthorised.ref] });
  await investigation.addHypothesis(research, q2.id, { explanation: 'The second transfer was an unauthorised duplicate.', predictedObservations: ['No approval record exists'] });
  await investigation.addHypothesis(research, q2.id, { explanation: 'The second transfer was a legitimate second invoice approved outside the ledger.', predictedObservations: ['A second invoice or approval exists elsewhere'] });
  await investigation.recordAttempt(research, inv.id, { kind: 'search', questionId: q2.id, target: 'approval records for 9 March', method: 'full-text search of processed evidence', outcome: 'zero_result', detail: 'No approval record found in preserved material.' });
  const finding = await investigation.createFinding(research, inv.id, { statement: 'The fund ledger records two transfers of 4,200 to Riverside Supplies Ltd, on 3 and 9 March.', label: 'verified_fact', classification: 'established', questionIds: [q1.id],
    supporting: [{ ref: a.ref, selector: { representation: rep.ref, segmentId: seg.id } }, { ref: paid.ref }], limitations: ['Only a ledger extract was available; bank statements were not obtained.'], confidence: { level: 'well_supported', basis: 'Primary ledger record' },
    checklist: { primary_source_checked: { status: 'done', note: 'ledger extract' }, independence_by_source_family: { status: 'not_applicable', note: 'single primary record' }, counter_evidence_searched: { status: 'done', note: 'minutes reviewed' }, alternative_explanations_addressed: { status: 'done', note: 'n/a to existence of transfers' }, subject_response_sought: { status: 'not_done', note: 'correspondence engine not yet connected in this test' }, dates_identities_confirmed: { status: 'done', note: 'dates from ledger' } } });
  await investigation.submitFinding(research, finding.id);
  await assert.rejects(investigation.reviewFinding(await orgA.as(investigator, 'editorial'), finding.id, { decision: 'approve' }), 'the author cannot review their own finding');
  await investigation.reviewFinding(await orgA.as(reviewer, 'editorial'), finding.id, { decision: 'approve', notes: 'Checked against the ledger.' });
  await investigation.disposeQuestion(research, q1.id, { status: 'answered', answer: 'Yes, two transfers are recorded.', answerLabel: 'verified_fact', findingIds: [finding.id] });
  const check = await investigation.closureCheck(research, inv.id);
  assert.ok(JSON.stringify(check).includes(q2.id), 'closure is blocked while a material question is open');
  const pkg = await investigation.buildPackage(research, inv.id, { idempotencyKey: 'pkg1' });
  assert.match(pkg.markdown, /two transfers of 4,200/i); assert.ok(pkg.markdown.includes(a.ref), 'package cites the exact evidence version');
  assert.match(pkg.markdown, /bank statements were not obtained/); assert.match(pkg.markdown, /Who authorised the second payment/);
  assert.ok(pkg.markdown.includes(a.sha256), 'evidence index carries the retained digest');
  console.log('package', pkg.ref, pkg.digest.slice(0, 12));

  // 4b. Deliverables: factual chronology, evidence index and a jurisdiction-configured legal-support draft, for private review.
  const release = runtime.get('release');
  const { toReleasePackage, toEvidenceItems } = await import('../../src/app/adapters.ts');
  const releaser = await stack.addUser(orgA, 'Rosa Release', ['release_manager']);
  const rel = await orgA.as(releaser, 'release');
  const input = toReleasePackage(pkg) as any;
  const chrono = await release.buildPackage(rel, { kind: 'chronology', title: 'Chronology: relief fund payments', audience: 'internal_review', formats: ['html'], package: input, idempotencyKey: 'chrono' });
  const bundle = await release.buildPackage(rel, { kind: 'evidence_bundle', title: 'Evidence index', audience: 'internal_review', formats: ['html'], items: toEvidenceItems(pkg), idempotencyKey: 'bundle' });
  const draft = await release.buildPackage(rel, { kind: 'legal_draft', title: 'Oversight complaint (draft)', audience: 'legal_counsel', formats: ['html', 'pdf'], jurisdictionPackId: 'example-republic', documentType: 'oversight_complaint', package: input, values: { oversight_body: 'Example Republic Charities Board', complainant: 'Riverside Relief Watch' }, idempotencyKey: 'draft' });
  for (const c of [chrono, bundle, draft]) assert.equal(c.state, 'built', `${c.kind}: ${JSON.stringify(c.leakReport).slice(0, 400)}`);
  const text = async (c: any): Promise<string> => { let out = ''; for (const comp of c.components.filter((x: any) => /\.(md|html|json)$/.test(x.path))) { const got = await release.getComponent(rel, c.id, comp.path); out += new TextDecoder().decode(got.bytes ?? got); } return out; };
  const draftText = await text(draft);
  assert.match(draftText, /DRAFT/); assert.match(draftText, /not reviewed by a legal professional/i); assert.match(draftText, /authority to be identified|unresolved/i);
  assert.ok(draftText.includes(a.ref), 'the legal-support draft identifies its factual sources');
  assert.ok((await text(bundle)).includes(a.sha256), 'evidence index lists retained digests');
  const chronoText = await text(chrono);
  assert.match(chronoText, /2026-03-03[\s\S]*2026-03-09/, 'chronology is ordered'); assert.match(chronoText, /established/i); assert.match(chronoText, /unknown|disputed/i, 'unestablished entries are labelled, not presented as fact');
  console.log('deliverables', chrono.ref, bundle.ref, draft.ref, 'draft components', draft.components.map((x: any) => x.path).join(','));

  // 5. Isolation: the second organization cannot reach any of it through any engine surface.
  // organization B's owner holds every read capability there (purpose 'workspace' reads across all engines)
  const ownerB = { ...(await orgB.as(orgB.owner, 'research')), capabilities: [...new Set([...(await orgB.as(orgB.owner, 'research')).capabilities, ...(await orgB.as(orgB.owner, 'workspace')).capabilities])] };
  for (const [name, engine] of [['evidence', evidence], ['processing', processing], ['knowledge', knowledge], ['investigation', investigation], ['release', release]] as const) {
    for (const ref of [a.ref, rep.ref, paid.ref, inv.ref, pkg.ref, draft.ref]) assert.equal(await engine.inspect(ownerB, ref), null, `${name}.inspect leaks ${ref}`);
    assert.deepEqual(await engine.search(ownerB, { q: 'Riverside' }), [], `${name}.search leaks`);
    assert.deepEqual(await engine.audit({ ...ownerB, capabilities: [...ownerB.capabilities, `${name}:audit`] }, {}), [], `${name}.audit leaks`);
  }
  assert.equal(await evidence.describe(ownerB, a.ref), null); await assert.rejects(evidence.getBytes(ownerB, a.ref));
  assert.deepEqual(await processing.searchSegments(ownerB, { q: 'Riverside Supplies' }), []);
  assert.deepEqual(await evidence.list(ownerB, {}), []);
  await assert.rejects(investigation.getPackage(ownerB, inv.id)); await assert.rejects(knowledge.getClaim(ownerB, paid.id));
  // stored objects: every object key is under the owning tenant's prefix, and none under the other tenant's
  const { readdirSync } = await import('node:fs'); const { join } = await import('node:path');
  const tenantsOnDisk = new Set<string>(); for (const e of readdirSync(join(stack.dataDir, 'objects'))) for (const t of readdirSync(join(stack.dataDir, 'objects', e))) tenantsOnDisk.add(t);
  assert.ok(tenantsOnDisk.has(orgA.tenantId)); assert.ok(!tenantsOnDisk.has(orgB.tenantId), 'no objects exist under the second organization');
  // a token for organization B cannot be minted by a member of A
  await assert.rejects(runtime.get('identity').issueAccessToken({ refreshToken: investigator.refreshToken, tenantId: orgB.tenantId, projectId: orgB.projectId, purpose: 'research' }));
}));
