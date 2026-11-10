// Acceptance test B: an unresolved research question becomes a contact plan and a truthful, concise inquiry; it is sent
// under a bounded grant through a controlled mailbox (real SMTP and IMAP servers on loopback); the reply is preserved and
// its assertions are routed for verification as proposals; refusal, duplicate inbound events, grant revocation, takeover
// before dispatch and an ambiguous send are exercised. No real mail leaves this machine.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { REQUIRED, skipReason, withStack } from './harness.ts';
import { setSetting } from '../../src/app/compose.ts';

const skip = skipReason([...REQUIRED, 'correspondence']);
const code = (c: string) => (e: any) => e?.code === c;

test('B: question → contact plan → bounded automated inquiry → reply routed for verification; refusal, duplicates, revocation, takeover, ambiguous send', { skip, timeout: 600_000 }, async () => {
  const { startMailWorld, reply } = await import('../../engines/correspondence/tests/engine-helpers.ts');
  const world = await startMailWorld();
  try {
    await withStack(async (stack) => {
      const { runtime } = stack;
      const correspondence = runtime.get('correspondence'), investigation = runtime.get('investigation'), knowledge = runtime.get('knowledge'), identity = runtime.get('identity');
      const org = await stack.createOrg('Riverside Relief Watch');
      const investigator = await stack.addUser(org, 'Ines Investigator', ['investigator']);
      const correspondent = await stack.addUser(org, 'Cory Correspondent', ['correspondent']);
      const research = await org.as(investigator, 'research'); const desk = await org.as(correspondent, 'correspondence');
      // provisioning extended the administration purpose, which revoked earlier tokens: obtain it now
      const admin = await org.as(org.owner, 'administration'); const ownerDesk = admin;

      // The unresolved question.
      const inv = await investigation.openInvestigation(research, { title: 'Riverside relief fund payments', originRef: 'E00:objective:acceptance-b', scopeStatement: 'Whether a second payment was authorised.', originalAccount: { summary: 'A resident reported a duplicate payment.', label: 'allegation' } });
      const question = await investigation.addQuestion(research, inv.id, { text: 'Was the transfer of 9 March approved, and by whom?', material: true, whyMaterial: 'Decides whether it was unauthorised' });

      // Controlled mailbox with a verified, truthful sender profile.
      const mailbox = await correspondence.createMailbox(ownerDesk, { address: 'desk@riverside-watch.example.org', displayName: 'Riverside Relief Watch', provider: 'smtp_imap',
        senderProfile: { organizationName: 'Riverside Relief Watch', assistantName: 'the Riverside Relief Watch research assistant', humanContact: 'editors@riverside-watch.example.org' },
        config: { smtp: { host: '127.0.0.1', port: world.smtpPort, auth: 'password', username: 'mailbox-user' }, imap: { host: '127.0.0.1', port: world.imapPort, auth: 'password', username: 'mailbox-user', inbox: 'INBOX', sentFolder: 'Sent' } },
        credentials: { smtpPassword: world.password, imapPassword: world.password } });
      await correspondence.verifySenderProfile(ownerDesk, mailbox.id);
      assert.ok(!JSON.stringify(await correspondence.getMailbox?.(desk, mailbox.id) ?? mailbox).includes(world.password), 'provider credentials are never returned');
      await setSetting(runtime, admin, 'correspondence.defaultMailbox', mailbox.id);

      // A durable agent identity with NO standing right to contact anyone.
      const agentActor = await identity.createAgent(admin, { name: 'Outreach drafter', roles: ['agent_drafter'] });
      await assert.rejects(org.asAgent(agentActor.id, 'correspondence', ['correspondence:read', 'correspondence:write', 'correspondence:send', 'correspondence:contact']), code('forbidden'), 'without a grant the agent cannot obtain sending capability');
      // The organization permits bounded grants of contact/send to agents; a human issues them, time-limited.
      const expiresAt = new Date(Date.now() + 3600_000).toISOString();
      const grants: string[] = [];
      for (const capability of ['correspondence:send', 'correspondence:contact']) grants.push((await identity.createGrant(admin, { actorId: agentActor.id, capability, purpose: 'correspondence', reason: 'Bounded outreach for the 9 March question', expiresAt })).id);
      const bot = await org.asAgent(agentActor.id, 'correspondence', ['correspondence:read', 'correspondence:write', 'correspondence:send', 'correspondence:contact']);
      assert.equal(bot.actor.kind, 'agent');

      // Unattended spending is denied by default: the agent needs an explicitly assigned budget before it can send anything.
      const resources = runtime.get('resources');
      const sendBudget = await resources.createBudget(admin, { name: 'Outreach messages', level: 'agent', unit: 'messages', ceiling: 3, actorId: agentActor.id, categories: ['correspondence.send'], idempotencyKey: 'outreach-budget' });
      await resources.assignBudget(admin, sendBudget.id, agentActor.id);

      // Question → contact plan with route provenance and the reason the person may know → structured inquiry.
      const inquiry = { subject: 'Question about a payment approval on 9 March', purpose: 'We are researching payments from the Riverside Flood Relief Fund.', questions: ['Was a payment of 4,200 to Riverside Supplies Ltd approved on 9 March?', 'If so, who approved it?'] };
      const { plan, drafts } = await correspondence.planOutreach(bot, { questionRef: question.ref, question: question.data.text, context: 'Relief fund payment approvals', mailboxId: mailbox.id, inquiry,
        candidates: [{ contact: { address: 'records@riverside-council.example.org', displayName: 'Records Officer', organization: 'Riverside Council', whyMayKnow: 'Listed as handling requests about payment approvals on the council records page', routeSource: 'E04:lead:acceptance-b-lead' }, rationale: 'Published records contact' }] });
      const contactId = plan.candidates[0].contactId; const draft = drafts[0];
      assert.equal(plan.candidates[0].routeSource, 'E04:lead:acceptance-b-lead'); assert.match(plan.candidates[0].whyMayKnow, /payment approvals/);
      assert.ok(draft.bodyText.length < 1200, 'the inquiry is concise');
      // Impersonation is refused for agent-authored text.
      await assert.rejects(correspondence.createDraft(bot, { mailboxId: mailbox.id, contactId, structured: { ...inquiry, purpose: 'I am a lawyer acting for the fund and require this information.' } }), 'an agent draft claiming a professional identity is rejected');
      // Automation needs a human-verified contact route AND a sending grant bound to recipient, count and time.
      await assert.rejects(correspondence.sendMessage(bot, draft.id, {}), 'no grant, no send');
      await correspondence.verifyContact(desk, contactId, { note: 'Address confirmed on the council records page' });
      const grant = await correspondence.createGrant(ownerDesk, { granteeId: agentActor.id, mailboxId: mailbox.id, purpose: 'Payment approval inquiry', questionRefs: [question.ref], recipientAllowlist: ['records@riverside-council.example.org'], maxMessages: 2, perRecipientCap: 1, cooldownSeconds: 3600, followUpLimit: 1, expiresAt });
      const dispatch = await correspondence.sendMessage(bot, draft.id, { grantId: grant.id, idempotencyKey: 'send-1' });
      await stack.settle(async () => ['accepted', 'delivered'].includes((await correspondence.getDispatch(desk, dispatch.id)).state), 6000)
      assert.equal(world.smtpTransactions, 1);
      const sent = world.folders.get('Sent')?.messages.at(-1)?.raw.toString('utf8') ?? [...world.folders.values()].flatMap((f) => f.messages).at(-1)!.raw.toString('utf8');
      assert.match(sent, /Riverside Relief Watch/); assert.match(sent, /automated|research assistant/i, 'the message discloses that it is automated'); assert.match(sent, /editors@riverside-watch\.example\.org/, 'and how to reach a human');
      assert.doesNotMatch(sent, /lawyer|journalist|official capacity/i);
      const messageId = /^Message-ID:\s*(<[^>]+>)/im.exec(sent)![1]!;
      console.log('sent under grant', dispatch.ref ?? dispatch.id, messageId);

      // Reply: preserved as received, attributed, routed to verification as proposals (never verified).
      const answer = reply({ from: 'records@riverside-council.example.org', to: 'desk@riverside-watch.example.org', inReplyTo: messageId, body: 'Thank you for your question.\r\n\r\nOur approval register has no entry for 9 March. The only approval recorded for Riverside Supplies in March is dated 3 March.\r\n\r\nRecords Officer' });
      const ingest = await org.as(correspondent, 'correspondence');
      const first = await correspondence.ingestRawMessage({ ...ingest, capabilities: [...ingest.capabilities, 'correspondence:ingest'] }, mailbox.id, answer, {});
      const dup = await correspondence.ingestRawMessage({ ...ingest, capabilities: [...ingest.capabilities, 'correspondence:ingest'] }, mailbox.id, answer, {});
      assert.equal(first.duplicate, false); assert.equal(dup.duplicate, true, 'a duplicate inbound event does not create a second message');
      const rawBack: any = await correspondence.getRawMessage(desk, first.message.id);
      assert.deepEqual(Buffer.from(rawBack.bytes ?? rawBack.raw ?? rawBack), answer, 'the original bytes of the reply are preserved');
      const reviewerCtx = { ...research, capabilities: [...research.capabilities, 'knowledge:review'] };
      let proposals: any[] = [];
      await stack.settle(async () => { proposals = (await knowledge.list(reviewerCtx, 'proposal')) as any[]; return proposals.some((p) => JSON.stringify(p).includes('no entry for 9 March')); });
      const proposal = proposals.find((p) => JSON.stringify(p).includes('no entry for 9 March'));
      assert.match(JSON.stringify(proposal), /reply/); assert.match(JSON.stringify(proposal), /E03:message:[0-9a-f-]{36}/, 'the proposal cites the preserved message as its source');
      assert.equal(((await knowledge.list(research, 'claim')) as any[]).length, 0, 'a reply creates no claim until a human reviews the proposal');
      const assertions = await correspondence.listAssertions(desk, { messageId: first.message.id }).catch(() => correspondence.listAssertions(desk, {}));
      assert.ok(JSON.stringify(assertions).includes('attributed_unverified'));
      console.log('reply routed as proposal', proposal.ref);

      // Refusal → suppression: no further automated contact with that address.
      const second = await correspondence.planOutreach(bot, { questionRef: question.ref, question: question.data.text, mailboxId: mailbox.id, inquiry, candidates: [{ contact: { address: 'clerk@riverside-council.example.org', displayName: 'Clerk', whyMayKnow: 'Clerk to the committee', routeSource: 'E04:lead:acceptance-b-lead-2' } }] });
      const clerkId = second.plan.candidates[0].contactId; await correspondence.verifyContact(desk, clerkId, {});
      const grant2 = await correspondence.createGrant(ownerDesk, { granteeId: agentActor.id, mailboxId: mailbox.id, purpose: 'Payment approval inquiry', questionRefs: [question.ref], recipientAllowlist: ['clerk@riverside-council.example.org'], maxMessages: 3, perRecipientCap: 3, cooldownSeconds: 0, followUpLimit: 2, expiresAt });
      await correspondence.ingestRawMessage({ ...ingest, capabilities: [...ingest.capabilities, 'correspondence:ingest'] }, mailbox.id, reply({ from: 'clerk@riverside-council.example.org', to: 'desk@riverside-watch.example.org', subject: 'Stop', body: 'STOP. Please do not contact me again.' }), {});
      await assert.rejects(correspondence.sendMessage(bot, second.drafts[0].id, { grantId: grant2.id }), 'a refusal suppresses further automated contact');

      // Takeover before dispatch: the queued automated send is cancelled and never reaches the provider.
      const third = await correspondence.planOutreach(bot, { questionRef: question.ref, question: question.data.text, mailboxId: mailbox.id, inquiry, candidates: [{ contact: { address: 'treasurer@riverside-fund.example.org', displayName: 'Treasurer', whyMayKnow: 'Named as approver in the ledger', routeSource: 'E04:lead:acceptance-b-lead-3' } }] });
      const treasurerId = third.plan.candidates[0].contactId; await correspondence.verifyContact(desk, treasurerId, {});
      const grant3 = await correspondence.createGrant(ownerDesk, { granteeId: agentActor.id, mailboxId: mailbox.id, purpose: 'Payment approval inquiry', questionRefs: [question.ref], recipientAllowlist: ['treasurer@riverside-fund.example.org'], maxMessages: 3, perRecipientCap: 3, cooldownSeconds: 0, followUpLimit: 2, expiresAt });
      const before = world.smtpTransactions;
      const queued = await correspondence.sendMessage(bot, third.drafts[0].id, { grantId: grant3.id });
      const taken = await correspondence.takeover(desk, { threadId: third.drafts[0].threadId, reason: 'Human will handle this contact' });
      assert.ok(taken.cancelledDispatches.length >= 1 || taken.cancelledDispatches >= 1, 'takeover cancels the pending automated dispatch');
      await stack.settle(); assert.equal(world.smtpTransactions, before, 'nothing was sent after takeover');
      assert.equal((await correspondence.getDispatch(desk, queued.id)).state, 'cancelled');
      await assert.rejects(correspondence.sendMessage(bot, third.drafts[0].id, { grantId: grant3.id }), 'automation stays stopped while a human has control');

      // Grant revocation (both layers): the correspondence grant, then the identity grant behind the agent's capability.
      const fourth = await correspondence.planOutreach(bot, { questionRef: question.ref, question: question.data.text, mailboxId: mailbox.id, inquiry, candidates: [{ contact: { address: 'auditor@riverside-fund.example.org', displayName: 'Auditor', whyMayKnow: 'Audited the fund', routeSource: 'E04:lead:acceptance-b-lead-4' } }] });
      const auditorId = fourth.plan.candidates[0].contactId; await correspondence.verifyContact(desk, auditorId, {});
      const grant4 = await correspondence.createGrant(ownerDesk, { granteeId: agentActor.id, mailboxId: mailbox.id, purpose: 'Payment approval inquiry', questionRefs: [question.ref], recipientAllowlist: ['auditor@riverside-fund.example.org'], maxMessages: 3, perRecipientCap: 3, cooldownSeconds: 0, followUpLimit: 2, expiresAt });
      await correspondence.revokeGrant(ownerDesk, grant4.id, { reason: 'No longer needed' });
      await assert.rejects(correspondence.sendMessage(bot, fourth.drafts[0].id, { grantId: grant4.id }), 'a revoked sending grant cannot be used');

      // Ambiguous send: the provider accepts DATA and the connection drops. The outcome is recorded as uncertain and
      // reconciled by Message-ID; recovery does not send a second time.
      const fifth = await correspondence.planOutreach(bot, { questionRef: question.ref, question: question.data.text, mailboxId: mailbox.id, inquiry, candidates: [{ contact: { address: 'bank@riverside-bank.example.org', displayName: 'Bank liaison', whyMayKnow: 'Holds the fund account', routeSource: 'E04:lead:acceptance-b-lead-5' } }] });
      const bankId = fifth.plan.candidates[0].contactId; await correspondence.verifyContact(desk, bankId, {});
      const grant5 = await correspondence.createGrant(ownerDesk, { granteeId: agentActor.id, mailboxId: mailbox.id, purpose: 'Payment approval inquiry', questionRefs: [question.ref], recipientAllowlist: ['bank@riverside-bank.example.org'], maxMessages: 3, perRecipientCap: 3, cooldownSeconds: 0, followUpLimit: 2, expiresAt });
      world.smtpMode = 'drop-after-data'; const tx = world.smtpTransactions;
      const lost = await correspondence.sendMessage(bot, fifth.drafts[0].id, { grantId: grant5.id });
      await stack.settle(async () => ['uncertain', 'accepted'].includes((await correspondence.getDispatch(desk, lost.id)).state));
      const uncertain = await correspondence.getDispatch(desk, lost.id);
      assert.equal(uncertain.state, 'uncertain'); assert.equal(uncertain.inTransit, true, 'visibly in transit while the outcome is unknown');
      world.smtpMode = 'accept';
      await stack.settle(async () => (await correspondence.getDispatch(desk, lost.id)).state === 'accepted', 180_000);
      assert.equal(world.smtpTransactions, tx + 1, 'exactly one SMTP transaction: recovery reconciled instead of resending');
      console.log('ambiguous send reconciled', (await correspondence.getDispatch(desk, lost.id)).reconciliation?.method);

      // Revoking the identity grant removes the agent's ability to obtain sending capability at all.
      for (const id of grants) await identity.revokeGrant(admin, { grantId: id, reason: 'Outreach finished' });
      await assert.rejects(org.asAgent(agentActor.id, 'correspondence', ['correspondence:send']), code('forbidden'));
      // the context obtained earlier no longer passes the current-state check that engines make before sensitive side effects
      const recheck = await identity.authorize(bot, { capability: 'correspondence:send' }).catch((e: any) => ({ allowed: false, reason: e.code }));
      assert.equal(recheck.allowed, false, `earlier agent context must no longer be authorized to send: ${JSON.stringify(recheck).slice(0, 200)}`);
      void randomBytes;
    }, { CORRESPONDENCE_SECRET_KEY: randomBytes(32).toString('base64'), CORRESPONDENCE_ALLOW_PRIVATE_HOSTS: '1', CORRESPONDENCE_RECONCILE_DELAY_MS: '200' });
  } finally { await world.close(); }
});
