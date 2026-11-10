// Acceptance test C: investigated material becomes an editorial project with source-linked, basis-labelled passages,
// then real written work, still image, music, video and an interactive work are produced, edited, re-rendered, exported
// and reopened. Outputs are opened with real tools and copied to PAM_ARTIFACTS_DIR (default ./artifacts/acceptance-c).
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { REQUIRED, skipReason, withStack } from './harness.ts';

const skip = skipReason([...REQUIRED, 'editorial', 'production']);
const OUT = resolve(process.env.PAM_ARTIFACTS_DIR ?? './artifacts', 'acceptance-c');

test('C: investigation → editorial (testimony, inference, reconstruction, invention labelled) → written, image, music, video, interactive produced, revised, exported, reopened', { skip, timeout: 1_800_000 }, () => withStack(async (stack) => {
  const { runtime } = stack; mkdirSync(OUT, { recursive: true });
  const evidence = runtime.get('evidence'), knowledge = runtime.get('knowledge'), investigation = runtime.get('investigation');
  const editorial = runtime.get('editorial'), production = runtime.get('production'), consent = runtime.get('consent');
  const org = await stack.createOrg('Riverside Relief Watch');
  const [investigator, reviewer, editor, editor2, producer, rights] = await Promise.all([
    stack.addUser(org, 'Ines Investigator', ['investigator']), stack.addUser(org, 'Rafi Reviewer', ['reviewer']), stack.addUser(org, 'Edda Editor', ['editor']),
    stack.addUser(org, 'Emil Editor', ['editor']), stack.addUser(org, 'Paz Producer', ['producer']), stack.addUser(org, 'Rhea Rights', ['rights_manager'])]);
  const research = await org.as(investigator, 'research'); const ed = await org.as(editor, 'editorial'); const ed2 = await org.as(editor2, 'editorial');
  const prod = await org.as(producer, 'production'); const rts = await org.as(rights, 'rights');

  // Investigated material (fictional): a ledger extract and a witness statement, one approved finding.
  const ledger = 'Riverside Flood Relief Fund ledger extract. 3 March: 4,200 to Riverside Supplies Ltd, approved by the treasurer. 9 March: 4,200 to Riverside Supplies Ltd, no approval recorded.\n';
  const ev = await evidence.accept(research, { bytes: new TextEncoder().encode(ledger), mediaType: 'text/plain', filename: 'ledger.txt', origin: { kind: 'manual_import', note: 'fictional acceptance fixture' }, idempotencyKey: 'ledger' });
  await stack.settle(async () => (await evidence.describe(research, ev.ref)).available === true);
  const claim = await knowledge.createClaim(research, { text: 'The fund ledger records two transfers of 4,200 to Riverside Supplies Ltd in March.', claimType: 'observation', idempotencyKey: 'c' });
  await knowledge.addEvidenceLink(research, { target: { kind: 'claim', id: claim.id }, evidenceRef: ev.ref, selector: { kind: 'text', quote: '9 March: 4,200' }, stance: 'supports', sourceType: 'official_record' });
  // A human reviewer assesses the claim; editorial will only call a passage a verified fact when this exists.
  await knowledge.recordAssessment(await org.as(reviewer, 'editorial'), claim.id, { dimension: 'factual', value: 'supported', rationale: 'Both transfers appear in the preserved primary ledger extract.', documentedRationale: true });
  const inv = await investigation.openInvestigation(research, { title: 'Riverside relief fund payments', originRef: 'E00:objective:acceptance-c', scopeStatement: 'The two March payments.', originalAccount: { summary: 'A resident reported a duplicate payment.', label: 'allegation' } });
  const q = await investigation.addQuestion(research, inv.id, { text: 'Were two payments made?', material: true, whyMaterial: 'Core', claimRefs: [claim.ref] });
  const finding = await investigation.createFinding(research, inv.id, { statement: 'The ledger records two transfers of 4,200 to Riverside Supplies Ltd, on 3 and 9 March; only the first shows an approval.', label: 'verified_fact', classification: 'established', questionIds: [q.id],
    supporting: [{ ref: ev.ref, selector: { quote: '9 March' } }, { ref: claim.ref }], limitations: ['Ledger extract only.'], confidence: { level: 'well_supported', basis: 'Primary ledger' },
    checklist: { primary_source_checked: { status: 'done', note: 'ledger' }, independence_by_source_family: { status: 'not_applicable', note: 'single record' }, counter_evidence_searched: { status: 'done', note: 'minutes' }, alternative_explanations_addressed: { status: 'done', note: 'n/a' }, subject_response_sought: { status: 'not_done', note: 'pending' }, dates_identities_confirmed: { status: 'done', note: 'ledger dates' } } });
  await investigation.submitFinding(research, finding.id); await investigation.reviewFinding(await org.as(reviewer, 'editorial'), finding.id, { decision: 'approve' });
  await investigation.disposeQuestion(research, q.id, { status: 'answered', answer: 'Yes', answerLabel: 'verified_fact', findingIds: [finding.id] });
  const pkg = await investigation.buildPackage(research, inv.id, { idempotencyKey: 'pkg' });
  // The organization permits adaptation of its own research material for internal production.
  const holder = await consent.registerHolder(rts, { ref: 'E01:organization:' + org.tenantId, kind: 'organisation' });
  for (const value of [ev.ref.split('@')[0], claim.ref.split('@')[0], finding.ref.split('@')[0]]) await consent.recordPermission(rts, { holderId: holder.id, scope: { type: 'subject', value }, effect: 'allow', actions: ['investigate', 'preserve', 'cite', 'adapt', 'reproduce'], audiences: ['internal', 'internal_review'], provenance: { method: 'other', note: 'Organization-owned research material (fictional acceptance run)' } });

  // Editorial project; generated documents keep labels and sources; invented and reconstructed material is added by hand.
  const project = await editorial.create(ed, 'editorial_project', { body: { title: 'Two payments', format: 'documentary', projectKind: 'artistic', publishingIdentity: 'Riverside Relief Watch', language: 'en', credits: [], investigationRefs: [inv.ref] } });
  const docs: Record<string, any> = {};
  for (const generator of ['narrative', 'lyrics', 'script', 'interactive'] as const) docs[generator] = (await editorial.generate(ed, { generator, editorialProjectId: project.id, package: pkg, title: `Two payments: ${generator}` })).document;
  const narrative = docs.narrative;
  const factual = narrative.body.blocks.find((b: any) => b.basis === 'verified_fact');
  assert.ok(factual && factual.sources.some((s: string) => s.startsWith('E08:finding:') || s.startsWith('E07:claim:')), 'factual passages link to findings or claims');
  const extra = [
    { id: 'recon-1', type: 'passage', text: 'Picture the clerk at the payment screen on the morning of 9 March.', basis: 'reconstruction', disclosure: 'Reconstruction: imagined from the ledger entry; no one has described this moment.', sources: [ev.ref] },
    { id: 'invent-1', type: 'passage', text: 'A river does not keep accounts, but it remembers every flood.', basis: 'invention', disclosure: 'Invention: a line written for this piece, not a fact.', sources: [] },
    { id: 'inf-1', type: 'passage', text: 'The missing approval suggests the second payment bypassed the usual check.', basis: 'inference', disclosure: 'Inference drawn from the ledger; not established.', sources: [finding.ref] },
  ];
  const revised = await editorial.revise(ed, 'document', narrative.id, { expectedRevision: narrative.revision, body: { ...narrative.body, blocks: [...narrative.body.blocks, ...extra] }, summary: 'Added labelled reconstruction, invention and inference' });
  await assert.rejects(editorial.revise(ed, 'document', narrative.id, { expectedRevision: revised.revision, body: { ...revised.body, blocks: [...revised.body.blocks, { id: 'bad', type: 'passage', text: 'Imagined scene.', basis: 'reconstruction', sources: [] }] } }), 'a reconstruction without a disclosure is refused');
  const fc = JSON.stringify(await editorial.factCheck(ed, narrative.id));
  assert.match(fc, /verified_fact/); assert.match(fc, /reconstruction/); assert.match(fc, /invention/);
  const exported: Record<string, any> = {};
  for (const [k, d] of Object.entries({ ...docs, narrative: revised })) {
    await editorial.requestReview(ed, 'document', d.id, { expectedRevision: d.revision });
    await editorial.approve(ed2, 'document', d.id, { revision: d.revision });
    exported[k] = await editorial.exportDocument(ed, d.id, d.revision, { requireApproved: true, intendedUse: 'adapt', audience: 'internal' });
  }
  assert.ok(exported.narrative.manifest.disclosures.some((x: any) => x.basis === 'invention'));
  // The organization holds the rights in its own editorial texts; recorded explicitly (no implicit ownership).
  for (const e of Object.values(exported)) await consent.recordPermission(rts, { holderId: holder.id, scope: { type: 'subject', value: String(e.manifest.document).split('@')[0] }, effect: 'allow', actions: ['adapt', 'reproduce', 'cite'], audiences: ['internal', 'internal_review'], provenance: { method: 'other', note: 'Work made by the organization (fictional acceptance run)' } });

  // Rendering spends compute; with no budget it is refused (no unattended spending). A project budget is set.
  const admin = await org.as(org.owner, 'administration');
  await runtime.get('resources').createBudget(admin, { name: 'Production compute', level: 'project', unit: 'compute_seconds', ceiling: 36_000, idempotencyKey: 'compute' });

  // Production: create, render, inspect real outputs, edit, re-render, export, reopen.
  const finish = async (render: any): Promise<any> => { let r = render; await stack.settle(async () => ['done', 'failed', 'blocked', 'cancelled'].includes((r = await production.getRender(prod, render.id)).state), 900_000); assert.equal(r.state, 'done', JSON.stringify(r).slice(0, 600)); return r; };
  const save = async (label: string, r: any): Promise<Record<string, string>> => { const paths: Record<string, string> = {}; for (const o of r.outputs) { const f = await production.getRenderOutput(prod, r.id, o.name); const p = join(OUT, `${label}-r${r.revision}-${o.name}`); writeFileSync(p, f.bytes); paths[o.name] = p; } writeFileSync(join(OUT, `${label}-r${r.revision}-manifest.json`), JSON.stringify(await production.getRenderManifest(prod, r.id), null, 2)); return paths; };
  const pick = (paths: Record<string, string>, ext: string): string => { const k = Object.keys(paths).find((n) => n.endsWith(ext)); assert.ok(k, `output ${ext} present: ${Object.keys(paths)}`); return paths[k!]!; };
  const results: Record<string, unknown> = {};

  // 1. Written work.
  const written = await production.createProjectFromEditorial(prod, { kind: 'written', editorial: exported.narrative, title: 'Two Payments' });
  const w1 = await finish(await production.requestRender(prod, { productionId: written.id, profile: 'final' }));
  const w1p = await save('written', w1);
  const pdfText = execFileSync('pdftotext', [pick(w1p, '.pdf'), '-']).toString();
  assert.match(pdfText, /Two payments/i); assert.match(pdfText, /Invention: a line written for this piece/); assert.match(pdfText, /Reconstruction:/);
  execFileSync('unzip', ['-t', pick(w1p, '.epub')]); execFileSync('unzip', ['-t', pick(w1p, '.docx')]);
  const w2rev = await production.applyOperations(prod, { productionId: written.id, operations: [{ op: 'setLayout', layout: { pageSize: 'A5' } }], summary: 'A5 layout' }).catch(() => production.applyOperations(prod, { productionId: written.id, operations: [{ op: 'set', path: '/layout/pageSize', value: 'A5' }], summary: 'A5 layout' }));
  const w2 = await finish(await production.requestRender(prod, { productionId: written.id, profile: 'final' }));
  const w2p = await save('written', w2);
  assert.match(execFileSync('pdfinfo', [pick(w2p, '.pdf')]).toString(), /Page size:\s+4(19|20)\.\d+ x 59[45]/, 'revised layout rendered at A5');
  assert.equal((await production.getRender(prod, w1.id)).state, 'done', 'the first render is retained');
  results.written = { renders: [w1.ref, w2.ref], revision: w2rev.revision };

  // 2. Still image: a quote card from a labelled block, then edited.
  const image = await production.createProjectFromEditorial(prod, { kind: 'image', editorial: exported.narrative, title: 'Quote card', options: { blockId: factual.id, width: 1200, height: 675 } });
  const i1 = await finish(await production.requestRender(prod, { productionId: image.id, profile: 'final' })); const i1p = await save('image', i1);
  const png1 = pick(i1p, '.png');
  assert.match(execFileSync('identify', ['-format', '%wx%h', png1]).toString(), /^1200x675$/);
  const head = await production.getRevision(prod, image.id);
  const textLayer = head.doc.layers.find((l: any) => l.type === 'text');
  await production.applyOperations(prod, { productionId: image.id, operations: [{ op: 'updateLayer', layerId: textLayer.id, set: { color: '#ffd166' } }], summary: 'Highlight colour' });
  const i2 = await finish(await production.requestRender(prod, { productionId: image.id, profile: 'final' })); const i2p = await save('image', i2);
  assert.notEqual(i1.outputs.find((o: any) => o.name.endsWith('.png')).sha256, i2.outputs.find((o: any) => o.name.endsWith('.png')).sha256, 'the edit changed the pixels');
  assert.doesNotMatch(execFileSync('exiftool', [pick(i2p, '.png')]).toString(), /Author|Creator\s*:/, 'metadata stripped');
  results.image = { renders: [i1.ref, i2.ref] };

  // 3. Music: lyrics composed into a song, transposed, re-rendered.
  const song = await production.createProjectFromEditorial(prod, { kind: 'audio', editorial: exported.lyrics, title: 'Two Payments (song)', options: { tempo: 96 } });
  const s1 = await finish(await production.requestRender(prod, { productionId: song.id, profile: 'final' })); const s1p = await save('song', s1);
  const dur = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', pick(s1p, '.wav')]).toString());
  assert.ok(dur > 20, `song lasts ${dur}s`);
  assert.ok(Object.keys(s1p).some((n) => n.endsWith('.mid')), 'MIDI exported');
  await production.applyOperations(prod, { productionId: song.id, operations: [{ op: 'transpose', semitones: 2 }], summary: 'Up a tone' });
  const s2 = await finish(await production.requestRender(prod, { productionId: song.id, profile: 'final' })); await save('song', s2);
  assert.notEqual(s1.outputs.find((o: any) => o.name.endsWith('.mid')).sha256, s2.outputs.find((o: any) => o.name.endsWith('.mid')).sha256, 'transposition changed the notes');
  results.song = { renders: [s1.ref, s2.ref], seconds: dur };

  // 4. Video from the script: scenes, synthetic narration, captions, disclosure cards.
  const video = await production.createProjectFromEditorial(prod, { kind: 'video', editorial: exported.script, title: 'Two Payments (short)', options: { width: 640, height: 360, fps: 12 } });
  const v1 = await finish(await production.requestRender(prod, { productionId: video.id, profile: 'final' })); const v1p = await save('video', v1);
  const streams = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', pick(v1p, '.mp4')]).toString();
  assert.match(streams, /video/); assert.match(streams, /audio/); assert.match(readFileSync(pick(v1p, '.srt'), 'utf8'), /\d\d:\d\d:\d\d,\d{3} -->/);
  const vdoc = (await production.getRevision(prod, video.id)).doc;
  await production.applyOperations(prod, { productionId: video.id, operations: [{ op: 'addScene', scene: { id: 'end-card', title: 'End card', duration: 3, visual: { type: 'title', title: 'Two payments. One approval.', subtitle: 'Riverside Relief Watch' } } }], summary: 'End card' });
  const v2 = await finish(await production.requestRender(prod, { productionId: video.id, profile: 'final' })); const v2p = await save('video', v2);
  const d1 = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', pick(v1p, '.mp4')]).toString()), d2 = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', pick(v2p, '.mp4')]).toString());
  assert.ok(d2 > d1, `the added scene lengthened the video (${d1}s → ${d2}s)`);
  results.video = { renders: [v1.ref, v2.ref], scenes: vdoc.scenes.length + 1, seconds: [d1, d2] };

  // 5. Interactive work with a working preview and a distributable.
  const story = await production.createProjectFromEditorial(prod, { kind: 'interactive', editorial: exported.interactive, title: 'Follow the money' });
  const preview = await production.previewInteractive(prod, story.id);
  assert.match(typeof preview === 'string' ? preview : JSON.stringify(preview), /<html|html/i);
  const x1 = await finish(await production.requestRender(prod, { productionId: story.id, profile: 'final' })); const x1p = await save('interactive', x1);
  execFileSync('unzip', ['-t', pick(x1p, '.zip')]);
  const xdoc = (await production.getRevision(prod, story.id)).doc;
  await production.applyOperations(prod, { productionId: story.id, operations: [{ op: 'updateNode', nodeId: xdoc.start, set: { title: 'Where did the money go?' } }], summary: 'Retitle start' });
  const x2 = await finish(await production.requestRender(prod, { productionId: story.id, profile: 'final' })); await save('interactive', x2);
  results.interactive = { renders: [x1.ref, x2.ref] };

  // Reopen saved projects at an earlier revision; manifests identify inputs, rights and versions.
  for (const p of [written, image, song, video, story]) {
    const r1 = await production.getRevision(prod, p.id, 1); assert.equal(r1.revision, 1);
    assert.ok((await production.listRevisions(prod, p.id)).length >= 2, 'edits are retained as revisions');
  }
  const vm = await production.getRenderManifest(prod, v2.id) as any;
  assert.ok(JSON.stringify(vm).includes(exported.script.manifest.document), 'manifest names the exact editorial revision');
  assert.ok(Array.isArray(vm.decisions ?? vm.useDecisions) || JSON.stringify(vm).includes('E11:decision:'), 'manifest records the rights decisions relied on');
  const exp = await production.createExport(prod, { renderId: v2.id, audience: 'internal' });
  writeFileSync(join(OUT, 'video-export.zip'), (await production.getExportBytes(prod, exp.id)).bytes); execFileSync('unzip', ['-t', join(OUT, 'video-export.zip')]);
  writeFileSync(join(OUT, 'summary.json'), JSON.stringify(results, null, 2));
  console.log('creative outputs in', OUT, JSON.stringify(results));
}));
