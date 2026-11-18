// Acceptance test F: records across sources on the composed application. Two fictional casualty lists name the same
// fictional person with different spellings, ages and calendars. A model-backed agent task (against a controlled local
// model server, never the live provider) proposes one record per mention; quotations that are not in the document are
// dropped; a date in another calendar is converted deterministically and a weekday that disagrees is recorded. A person
// then accepts the proposals, records an identity decision on the candidate pair, and reads a roster that keeps both
// ages side by side, and an incident grouping by place and day.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { REQUIRED, skipReason, withStack } from './harness.ts';

const skip = skipReason(REQUIRED);

const LIST_A = 'List A (fictional). Harbourtown, Thursday 18 Dey 1404.\n1. Dariush Feyzabadi, 24, shot on 18 Dey 1404 in Harbourtown.\n2. Mina Sadeghzadeh, 31, shot on 18 Dey 1404 in Harbourtown.\n';
const LIST_B = 'List B (fictional bulletin). Darioush Feizabadi (25) was killed in Harbourtown on Friday, 8 January 2026, his family said.\n';
const date = (calendar: string, year: number, month: number, day: number, weekday = '') => ({ calendar, year, month, day, weekday });
const none = { calendar: 'unknown', year: 0, month: 0, day: 0, weekday: '' };
const ANSWERS: Record<string, unknown> = {
  'List A': { entries: [
    { name: 'Dariush Feyzabadi', nameQuote: 'Dariush Feyzabadi, 24', aliases: [], statement: 'The list says Dariush Feyzabadi was shot in Harbourtown.', statementQuote: 'Dariush Feyzabadi, 24, shot on 18 Dey 1404 in Harbourtown',
      attributes: [{ key: 'age', value: '24', quote: 'Dariush Feyzabadi, 24', date: none }, { key: 'placeOfDeath', value: 'Harbourtown', quote: 'shot on 18 Dey 1404 in Harbourtown', date: none }, { key: 'dateOfDeath', value: '18 Dey 1404', quote: 'shot on 18 Dey 1404', date: date('persian', 1404, 10, 18) }] },
    { name: 'Mina Sadeghzadeh', nameQuote: 'Mina Sadeghzadeh, 31', aliases: [], statement: 'The list says Mina Sadeghzadeh was shot in Harbourtown.', statementQuote: 'Mina Sadeghzadeh, 31, shot on 18 Dey 1404 in Harbourtown',
      attributes: [{ key: 'age', value: '31', quote: 'Mina Sadeghzadeh, 31', date: none }, { key: 'placeOfDeath', value: 'Harbourtown', quote: 'in Harbourtown', date: none }, { key: 'dateOfDeath', value: '18 Dey 1404', quote: 'shot on 18 Dey 1404', date: date('persian', 1404, 10, 18) }] },
    // Not in the document: must be dropped, not proposed.
    { name: 'Invented Person', nameQuote: 'Invented Person, 40', aliases: [], statement: 'x', statementQuote: 'x', attributes: [] },
  ] },
  'List B': { entries: [
    { name: 'Darioush Feizabadi', nameQuote: 'Darioush Feizabadi (25)', aliases: [], statement: 'The bulletin says Darioush Feizabadi was killed in Harbourtown.', statementQuote: 'Darioush Feizabadi (25) was killed in Harbourtown',
      attributes: [{ key: 'age', value: '25', quote: 'Darioush Feizabadi (25)', date: none }, { key: 'placeOfDeath', value: 'Harbourtown', quote: 'killed in Harbourtown', date: none },
        { key: 'dateOfDeath', value: 'Friday, 8 January 2026', quote: 'on Friday, 8 January 2026', date: date('gregory', 2026, 1, 8, 'Friday') },
        // An attribute whose quotation is not in the document is dropped.
        { key: 'hometown', value: 'Elmtown', quote: 'born in Elmtown', date: none }] },
  ] },
};

// Controlled local server speaking the Messages streaming format.
const asked: string[] = [];
const model = createServer((req, res) => {
  let raw = ''; req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    const body = JSON.parse(raw); const prompt = JSON.stringify(body.messages);
    const key = Object.keys(ANSWERS).find((k) => prompt.includes(k)) ?? 'List A';
    asked.push(key);
    const text = JSON.stringify(ANSWERS[key]);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (event: string, data: unknown): void => { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
    send('message_start', { type: 'message_start', message: { id: 'msg_f', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 1 } } });
    send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
    send('content_block_stop', { type: 'content_block_stop', index: 0 });
    send('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 200 } });
    send('message_stop', { type: 'message_stop' });
    res.end();
  });
});
await new Promise<void>((ok) => model.listen(0, '127.0.0.1', ok));
const modelUrl = `http://127.0.0.1:${(model.address() as { port: number }).port}`;
after(() => { model.close(); });

test('F: records across sources — extraction with quotations and calendars, identity decision, roster disagreements, incidents', { skip, timeout: 600_000 }, () => withStack(async (stack) => {
  const { runtime } = stack;
  const org = await stack.createOrg('Harbourtown Remembrance Project');
  const investigator = await stack.addUser(org, 'Ines Investigator', ['investigator']);
  const research = await org.as(investigator, 'research'); const admin = await org.as(org.owner, 'administration');
  const evidence = runtime.get('evidence'), processing = runtime.get('processing'), knowledge = runtime.get('knowledge'), resources = runtime.get('resources');
  const o = runtime.orchestration;
  const opCtx = { ...admin, capabilities: [...admin.capabilities, 'orchestration:write', 'orchestration:control', 'orchestration:read'] };

  // 1. Preserve and process both fictional lists.
  const refs: string[] = [];
  for (const [name, body] of [['list-a.txt', LIST_A], ['list-b.txt', LIST_B]] as const) {
    const v = await evidence.accept(research, { bytes: new TextEncoder().encode(body), mediaType: 'text/plain', filename: name, origin: { kind: 'manual_import', note: 'fictional acceptance fixture' }, idempotencyKey: name });
    refs.push(v.ref);
  }
  await stack.settle(async () => (await Promise.all(refs.map((r) => evidence.describe(research, r)))).every((d: any) => d?.available === true));
  const runs = await Promise.all(refs.map((r, i) => processing.requestProcessing(research, { evidenceRef: r, idempotencyKey: `p-${i}` })));
  await stack.settle(async () => (await Promise.all(runs.map((p: any) => processing.getProcessing(research, p.id)))).every((v: any) => ['done', 'partial', 'failed'].includes(v.state)));

  // 2. Model-backed extraction as an orchestrated task. A token budget is assigned to PAM's service identity first.
  const svc = (await runtime.sql.query<{ orchestrator_service_id: string }>('select orchestrator_service_id from pam_app.tenants where tenant_id=$1', [org.tenantId]))[0]!.orchestrator_service_id;
  const budget = await resources.createBudget(admin, { name: 'Model tokens', level: 'agent', unit: 'tokens_in', ceiling: 200_000, actorId: svc, idempotencyKey: 'tokens' });
  await resources.assignBudget(admin, budget.id, svc);
  const objective = await o.createObjective(opCtx, { title: 'Name every person in the Harbourtown lists', description: 'Propose one record per mention for review.', lane: 'primary' });
  const attributes = [{ key: 'age', description: 'age in years', kind: 'number' }, { key: 'placeOfDeath', description: 'place where the person was killed', kind: 'text' }, { key: 'dateOfDeath', description: 'date of death', kind: 'date' }, { key: 'hometown', description: 'home town', kind: 'text' }];
  const run = await o.startRun(opCtx, { objectiveId: objective.id, tasks: refs.map((r, i) => ({ key: `extract-${i}`, action: 'agent.extract_records', input: { evidenceRef: r, attributes, caseId: 'harbourtown' } })) });
  await stack.settle(async () => ['completed', 'failed', 'cancelled'].includes((await o.getRun(opCtx, run.id)).status), 240_000);
  const finished = await o.getRun(opCtx, run.id);
  assert.equal(finished.status, 'completed', JSON.stringify(finished.tasks.map((t: any) => [t.key, t.state, t.lastError ?? t.error ?? null])));
  const outputs: any[] = await Promise.all(finished.tasks.map((t: any) => o.getTask(opCtx, t.id)));
  const outA: any = outputs.find((t) => t.key === 'extract-0')?.output, outB: any = outputs.find((t) => t.key === 'extract-1')?.output;
  assert.equal(outA.proposed, 2); assert.equal(outA.droppedEntries, 1, 'an entry whose quotation is not in the document is dropped');
  assert.equal(outB.proposed, 1); assert.equal(outB.droppedAttributes, 1, 'an attribute whose quotation is not in the document is dropped');
  assert.equal(outB.dateIssues, 1, 'the bulletin\'s weekday disagrees with its date');
  assert.deepEqual(asked.sort(), ['List A', 'List B'], 'one model answer per document');

  // 3. Nothing is a record until a person accepts it.
  const pending = (await knowledge.list(research, 'proposal', { caseId: 'harbourtown', state: 'pending' })) as any[];
  assert.equal(pending.length, 3);
  const darioushProposal = pending.find((p) => p.item.entity.name === 'Darioush Feizabadi');
  assert.deepEqual(darioushProposal.item.entity.attributes, { age: 25, placeOfDeath: 'Harbourtown', dateOfDeath: '2026-01-08', dateOfDeathIssue: 'The source states friday, but 2026-01-08 was a thursday' });
  const dariushProposal = pending.find((p) => p.item.entity.name === 'Dariush Feyzabadi');
  assert.equal(dariushProposal.item.entity.attributes.dateOfDeath, '2026-01-08', '18 Dey 1404 converted deterministically');
  assert.equal(dariushProposal.item.entity.attributes.dateOfDeathStated, '1404-10-18 (persian)');
  assert.ok(dariushProposal.item.claims[0].evidence.every((e: any) => LIST_A.includes(e.excerpt.quote)), 'every proposed quotation is in the preserved document');
  assert.equal((await knowledge.list(research, 'entity', { caseId: 'harbourtown' })).length, 0);
  const reviewed = await knowledge.reviewProposals(research, { ids: pending.map((p) => p.id), decision: 'accept', reason: 'Quotations checked against both lists' });
  assert.equal(reviewed.reviewed, 3);

  // 4. Candidate pair → human identity decision → roster with both ages kept.
  const sug = await knowledge.suggestEntityMatches(research, { caseId: 'harbourtown' });
  assert.equal(sug.total, 1);
  const c = sug.candidates[0];
  assert.deepEqual(new Set([c.left.name, c.right.name]), new Set(['Dariush Feyzabadi', 'Darioush Feizabadi']));
  assert.ok(c.attributes.differ.some((d: any) => d.key === 'age'));
  await knowledge.recordEntityMatches(research, { decisions: [{ leftId: c.left.id, rightId: c.right.id, decision: 'same', rationale: 'Same place and day; spelling variants; ages differ by one', similarity: c.similarity.value }] });
  const roster = await knowledge.roster(research, { caseId: 'harbourtown', expect: ['age', 'dateOfDeath', 'placeOfDeath', 'hometown'] });
  assert.equal(roster.counts.groups, 2); assert.equal(roster.counts.records, 3);
  const g = roster.groups.find((x: any) => x.members.length === 2);
  assert.deepEqual(g.attributes.age.map((v: any) => v.value).sort(), [24, 25], 'both ages are kept; none is chosen');
  assert.ok(g.conflicts.includes('age'));
  assert.ok(g.missing.includes('hometown'));
  assert.ok(g.members.every((m: any) => m.claims.length === 1 && m.claims[0].evidenceRefs.length === 1));
  const inc = await knowledge.incidents(research, { caseId: 'harbourtown', placeAttribute: 'placeOfDeath', dateAttribute: 'dateOfDeath' });
  assert.equal(inc.total, 1); assert.equal(inc.incidents[0].size, 2);

  // 5. Through PAM's gateway the same views are available to the browser application.
  console.log('records across sources: proposals', pending.length, 'groups', roster.counts.groups, 'incident size', inc.incidents[0].size);
}, { ANTHROPIC_API_KEY: 'sk-ant-test-controlled-server', ANTHROPIC_BASE_URL: modelUrl }));
