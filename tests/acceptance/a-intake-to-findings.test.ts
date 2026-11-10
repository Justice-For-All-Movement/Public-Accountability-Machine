// Acceptance test A (in progress): evidence → processing → knowledge → investigation → package, across two isolated
// organizations, on the real composed application. Intake (E02), discovery (E04) and legal-support drafting (E12) join
// this test as those engines land; until then their steps are absent, not simulated.
import test, { after } from 'node:test';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
import { REQUIRED, skipReason, withStack } from './harness.ts';

const skip = skipReason([...REQUIRED, 'discovery']);
// Controlled retrieval source: a local HTTP server standing in for a public records site (fictional content).
const pages: Record<string, { type: string; body: string; status?: number }> = {
  '/records/': { type: 'text/html', body: '<html><head><title>Riverside Council records</title></head><body><h1>Published records</h1><ul><li><a href="/records/invoice-0312.txt">Invoice 0312</a></li><li><a href="/records/missing.txt">Withdrawn record</a></li></ul><a rel="next" href="/records/page2">next</a></body></html>' },
  '/records/page2': { type: 'text/html', body: '<html><body><ul><li><a href="/records/approval-register.txt">Approval register, March</a></li><li><a href="/records/contact.html">Records office contact</a></li></ul></body></html>' },
  '/records/contact.html': { type: 'text/html', body: '<html><head><title>Records office</title></head><body><h1>Records office</h1><p>Requests about payment approvals are handled by the Records Officer, Riverside Council: <a href="mailto:records@riverside-council.example.org">records@riverside-council.example.org</a></p></body></html>' },
  '/records/invoice-0312.txt': { type: 'text/plain', body: 'Riverside Supplies Ltd. Invoice 0312 dated 2 March for 4,200: sandbags and pumps. No second invoice was issued in March.\n' },
  '/records/approval-register.txt': { type: 'text/plain', body: 'Approval register, March. 3 March: payment 4,200 Riverside Supplies approved (M. Okafor). No entry for 9 March.\n' },
};
const source = createServer((req, res) => { const page = pages[req.url ?? '']; if (page === undefined) { res.writeHead(404).end('gone'); return; } res.writeHead(page.status ?? 200, { 'content-type': page.type }).end(page.body); });
await new Promise<void>((ok) => source.listen(0, '127.0.0.1', ok));
const sourcePort = (source.address() as { port: number }).port;
after(() => { source.close(); });
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
  // 3b. Acquire additional material from the controlled source; real receipts; failures and gaps stay visible.
  const discovery = runtime.get('discovery');
  const src = await discovery.createSource(research, { name: 'Riverside Council published records', kind: 'html_index', baseUrl: `http://127.0.0.1:${sourcePort}/records/`, accessTerms: 'Public records page; citation permitted, reproduction rights unknown.', reuse: 'citation_only', idempotencyKey: 'src' });
  const run = await discovery.startCollection(research, { sourceId: src.id, level: 'bytes', questionRef: q2.ref, extractLeads: true, idempotencyKey: 'run' });
  await stack.settle(async () => ['completed', 'failed', 'cancelled'].includes((await discovery.getRun(research, run.id)).state));
  const cov = await discovery.coverage(research, { runId: run.id });
  assert.equal((await discovery.getRun(research, run.id)).state, 'completed', JSON.stringify(cov));
  assert.equal(cov.acquiredBytes, 3, `three originals acquired: ${JSON.stringify(cov)}`); assert.ok(cov.failed + cov.notFound >= 1, 'the withdrawn record is reported, not hidden');
  const receipts = await discovery.listReceipts(research, { runId: run.id, limit: 50 });
  const receiptList = (Array.isArray(receipts) ? receipts : receipts.items) as any[];
  assert.ok(receiptList.some((r) => /approval-register/.test(JSON.stringify(r)) && /[0-9a-f]{64}/.test(JSON.stringify(r))), 'acquisition receipts record URL and digest');
  const acquired = ((await discovery.listItems(research, { runId: run.id, limit: 50 })) as any); const acquiredItems: any[] = [];
  for (const i of ((Array.isArray(acquired) ? acquired : acquired.items) as any[])) { const full = await discovery.getItem(research, i.id); const acq = (full.acquisitions as any[] | undefined)?.find((x) => x.evidenceRef); if (acq) acquiredItems.push({ ...full, evidenceRef: acq.evidenceRef }); }
  assert.equal(acquiredItems.length, 3, 'acquired originals were handed to the evidence engine');
  const registerItem = acquiredItems.find((i) => /approval-register/.test(i.url ?? i.canonicalUrl ?? JSON.stringify(i)))!;
  await stack.settle(async () => (await evidence.describe(research, registerItem.evidenceRef))?.available === true);
  const registerInfo = await evidence.describe(research, registerItem.evidenceRef);
  assert.match(new TextDecoder().decode(await evidence.getBytes(research, registerItem.evidenceRef)), /No entry for 9 March/);
  assert.match(JSON.stringify(await evidence.provenance(research, registerItem.evidenceRef)), /discovery/, 'evidence provenance names the acquisition');
  const leadPage = await discovery.listLeads({ ...research, capabilities: [...research.capabilities, 'discovery:read_leads'] }, { limit: 20 }) as any;
  assert.match(JSON.stringify(leadPage), /records@riverside-council\.example\.org/, 'a contact lead was extracted with its published route');
  // SSRF: a loopback port that is not on the deployment allowlist is refused
  const bad = await discovery.createSource(research, { name: 'Internal admin', kind: 'html_index', baseUrl: 'http://127.0.0.1:9/', accessTerms: 'n/a', idempotencyKey: 'bad' }).then(async (b: any) => { const r = await discovery.startCollection(research, { sourceId: b.id, level: 'bytes' }); await stack.settle(async () => ['completed', 'failed', 'cancelled'].includes((await discovery.getRun(research, r.id)).state)); return discovery.coverage(research, { runId: r.id }); }, (e: any) => ({ refused: e.code }));
  assert.ok((bad as any).refused !== undefined || (bad as any).acquiredBytes === 0, 'non-allowlisted private address yields nothing'); 
  await knowledge.addEvidenceLink(research, { target: { kind: 'claim', id: unauthorised.id }, evidenceRef: registerInfo.ref, selector: { kind: 'text', quote: 'No entry for 9 March' }, stance: 'supports', sourceType: 'official_record' });
  await investigation.recordAttempt(research, inv.id, { kind: 'acquisition', questionId: q2.id, target: 'Riverside Council published records', method: 'collection run over the public records index', outcome: 'partial', detail: `3 originals acquired, ${cov.failed + cov.notFound} unavailable; receipts retained.`, refs: [run.ref, registerInfo.ref] });
  console.log('acquired', registerInfo.ref, 'coverage', JSON.stringify({ discovered: cov.discovered, acquiredBytes: cov.acquiredBytes, failed: cov.failed, notFound: cov.notFound }));

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
}, { DISCOVERY_ALLOWED_PRIVATE_HOSTS: `127.0.0.1:${sourcePort}`, DISCOVERY_ALLOWED_PORTS: `80,443,${sourcePort}`, DISCOVERY_MIN_INTERVAL_MS: '20' }));
