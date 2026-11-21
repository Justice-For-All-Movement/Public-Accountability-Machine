// Acceptance test H: seal on arrival. Mail to a sealed mailbox (a real IMAP server on loopback) is encrypted on arrival
// for the researchers' public keys, stored as a sealed record under a code name per sender, and erased from the
// correspondence engine; a researcher's private key opens it. Without a sealing key nothing is erased and a person is
// alerted. Mail to other mailboxes is untouched. Afterwards no table of any engine or of PAM, and no stored object, holds
// the sealed message's text, subject, sender address or name.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { REQUIRED, skipReason, withStack } from './harness.ts';
import { startServer } from '../../src/app/server.ts';
import { senderKey } from '../../src/app/sealed-mail.ts';

const skip = skipReason([...REQUIRED, 'correspondence']);
function walk(dir: string): string[] { try { return readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? walk(p) : [p]; }); } catch { return []; } }
// Words that occur only in the sealed messages.
const SECRET = 'quorvellian'; const SUBJECT_WORD = 'brindlemarsh'; const SENDER = 'mira.holloway@example.net'; const NAME = 'Holloway';
const sealedMail = (from: string, n: number, extra = ''): Buffer => Buffer.from(['From: "Mira Holloway" <' + from + '>', 'To: tips@riverside-watch.example.org', `Subject: ${SUBJECT_WORD} ledger ${n}`, `Message-ID: <sealed-${n}-${randomBytes(4).toString('hex')}@mail.example.net>`, 'Date: Tue, 17 Nov 2026 09:30:00 +0000',
  'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="x"', '',
  '--x', 'Content-Type: multipart/alternative; boundary="y"', '', '--y', 'Content-Type: text/plain; charset=utf-8', '', `The ${SECRET} ledger was moved to the annex on 3 March. ${extra}`, '--y', 'Content-Type: text/html; charset=utf-8', '', `<p>The <b>${SECRET}</b> ledger was moved to the annex on 3 March.</p>`, '--y--',
  '--x', 'Content-Type: application/pdf; name="annex-scan.pdf"', 'Content-Disposition: attachment; filename="annex-scan.pdf"', 'Content-Transfer-Encoding: base64', '', Buffer.from(`%PDF-fake ${SECRET} annex scan`).toString('base64'), '--x--', ''].join('\r\n'));

test('H: seal on arrival — sealed record opens with a researcher key, content erased from E03, no plaintext anywhere; other mailboxes untouched; no keys → no erase + alert', { skip, timeout: 600_000 }, async () => {
  const { startMailWorld } = await import('../../engines/correspondence/tests/engine-helpers.ts');
  const sc = await import('../../web/js/sealed-crypto.js' as string) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
  const world = await startMailWorld();
  const hmacKey = randomBytes(32).toString('base64');
  try {
    await withStack(async (stack) => {
      const { runtime } = stack;
      const correspondence = runtime.get('correspondence'); const identity = runtime.get('identity');
      const org = await stack.createOrg('Riverside Relief Watch');
      const researcher = await stack.addUser(org, 'Rhea Researcher', ['investigator']);
      const admin = await org.as(org.owner, 'administration');
      const server = await startServer(runtime, { port: 0, worker: false });
      try {
        const token = async (person: typeof researcher, purpose: string): Promise<string> => (await identity.issueAccessToken({ refreshToken: person.refreshToken, tenantId: org.tenantId, projectId: org.projectId, purpose }) as { token: string }).token;
        const call = async (path: string, bearer: string, init: { method?: string; body?: unknown } = {}) => {
          const res = await fetch(`${server.url}${path}`, { method: init.method ?? (init.body === undefined ? 'GET' : 'POST'), headers: { authorization: `Bearer ${bearer}`, 'x-pam-client': 'pam-web', ...(init.body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }) });
          return { status: res.status, json: await res.json().catch(() => null) as any }; // eslint-disable-line @typescript-eslint/no-explicit-any
        };
        const svc = await runtime.serviceContext({ tenantId: org.tenantId, projectId: org.projectId });
        assert.ok(svc.capabilities.includes('correspondence:erase'), 'provisioning gives PAM’s service identity the exact erase capability');

        // A tip line (sealed, on the controlled IMAP server) and an ordinary desk mailbox (not sealed).
        const tips = await correspondence.createMailbox(admin, { address: 'tips@riverside-watch.example.org', displayName: 'Tips', provider: 'smtp_imap',
          config: { smtp: { host: '127.0.0.1', port: world.smtpPort, auth: 'password', username: 'mailbox-user' }, imap: { host: '127.0.0.1', port: world.imapPort, auth: 'password', username: 'mailbox-user', inbox: 'INBOX', sentFolder: 'Sent' } },
          credentials: { smtpPassword: world.password, imapPassword: world.password } });
        const desk = await correspondence.createMailbox(admin, { address: 'desk@riverside-watch.example.org', displayName: 'Desk', provider: 'ingest_only' });

        // Only an administrator chooses sealed mailboxes.
        const adminToken = await token(org.owner, 'administration'); const researchToken = await token(researcher, 'research');
        assert.equal((await call('/api/app/v1/correspondence/sealed-mailboxes', researchToken, { method: 'PUT', body: { mailboxIds: [tips.id] } })).status, 403);
        assert.equal((await call('/api/app/v1/correspondence/sealed-mailboxes', adminToken, { method: 'PUT', body: { mailboxIds: ['00000000-0000-4000-8000-000000000000'] } })).status, 404);
        const set = await call('/api/app/v1/correspondence/sealed-mailboxes', adminToken, { method: 'PUT', body: { mailboxIds: [tips.id] } });
        assert.equal(set.status, 200, JSON.stringify(set.json)); assert.deepEqual(set.json.mailboxIds, [tips.id]);
        const status0 = await call('/api/app/v1/correspondence/sealed-mailboxes', researchToken);
        assert.deepEqual(status0.json.mailboxIds, [tips.id]); assert.equal(status0.json.sealingKeys, 0); assert.equal(status0.json.senderKeyConfigured, true);

        const stateOf = async (messageId: string): Promise<string | undefined> => (await runtime.sql.query<{ state: string }>(`select state from pam_app.sealed_mail where message_id=$1`, [messageId]))[0]?.state;
        const syncTips = async (): Promise<string[]> => {
          await correspondence.syncMailboxNow(svc, tips.id, {});
          const page = await correspondence.listThreads(admin, { mailboxId: tips.id, folder: 'all', limit: 50 });
          return (await Promise.all(page.items.map(async (t: any) => (await correspondence.getThread(admin, t.id)).messages.map((m: any) => m.id as string)))).flat(); // eslint-disable-line @typescript-eslint/no-explicit-any
        };

        // 1. No sealing key yet: the message stays readable, nothing is erased, and a person is alerted.
        world.deliver('INBOX', sealedMail(SENDER, 1));
        const [first] = await syncTips();
        assert.ok(first);
        await stack.settle(async () => (await stateOf(first!)) === 'waiting_for_keys');
        const stillReadable = await correspondence.getMessage(admin, first!);
        assert.equal(stillReadable.contentErased, false); assert.match(stillReadable.bodyText, new RegExp(SECRET));
        assert.equal((await runtime.sql.query(`select 1 from pam_app.sealed_records where tenant_id=$1`, [org.tenantId])).length, 0);
        assert.ok((await runtime.sql.query(`select 1 from e03_correspondence.messages x where x::text like $1`, [`%${SECRET}%`])).length > 0, 'the leak scan below can see clear text');
        const alerts = await call('/api/app/v1/alerts', researchToken);
        assert.ok(alerts.json.items.some((a: any) => a.type === 'correspondence.sealed_mail_waiting_for_keys' && a.subject === `E03:message:${first}`), JSON.stringify(alerts.json).slice(0, 400)); // eslint-disable-line @typescript-eslint/no-explicit-any

        // 2. A researcher registers a sealing key (the private key stays here, in the test, standing for her device).
        const key = await sc.generateKeyPair();
        const registered = await call('/api/app/v1/sealed/keys', researchToken, { body: { publicJwk: key.publicJwk, label: 'Laptop' } });
        assert.equal(registered.status, 201); assert.equal(registered.json.keyId, key.id);
        // The waiting message is now sealed and erased, a second one from the same sender joins the same code name,
        // and a message from someone else gets a new one.
        world.deliver('INBOX', sealedMail(SENDER, 2, 'Second note.'));
        world.deliver('INBOX', sealedMail('other.source@example.com', 3));
        const all = await syncTips();
        assert.equal(all.length, 3);
        await stack.settle(async () => (await Promise.all(all.map(stateOf))).every((s) => s === 'erased'));

        // 3. In E03 only tombstones remain.
        for (const id of all) {
          const m = await correspondence.getMessage(admin, id);
          assert.equal(m.contentErased, true); assert.match(m.tombstone, /^Content sealed and erased; preserved as E05:evidence_version:/);
          assert.doesNotMatch(JSON.stringify(m), new RegExp(`${SECRET}|${SUBJECT_WORD}|${SENDER}|${NAME}`));
          await assert.rejects(correspondence.getRawMessage(admin, id));
        }
        assert.equal((await correspondence.searchMessages(admin, { q: SECRET })).total, 0);

        // 4. The sealed records open with the researcher's private key and hold the whole message.
        const records = (await call('/api/app/v1/sealed/records', researchToken)).json.records as any[]; // eslint-disable-line @typescript-eslint/no-explicit-any
        assert.equal(records.length, 3); assert.ok(records.every((r) => r.channel === 'email' && r.kind === 'conversation' && r.recipients.includes(key.id) && r.occurredOn));
        const privateKey = await sc.importPrivate(key.privateJwk);
        const opened = [] as { code: string; content: any }[]; // eslint-disable-line @typescript-eslint/no-explicit-any
        for (const r of records) {
          const envelope = (await call(`/api/app/v1/sealed/records/${r.id}/envelope`, researchToken)).json;
          const { content, commitmentVerified } = await sc.open(envelope, key.id, privateKey);
          assert.equal(commitmentVerified, true); opened.push({ code: r.sourceCode, content });
        }
        const fromMira = opened.filter((o) => o.content.headers.from === SENDER);
        assert.equal(fromMira.length, 2); assert.equal(fromMira[0]!.code, fromMira[1]!.code, 'one code name per sender');
        const other = opened.find((o) => o.content.headers.from === 'other.source@example.com')!;
        assert.notEqual(other.code, fromMira[0]!.code);
        const one = fromMira.find((o) => o.content.headers.subject === `${SUBJECT_WORD} ledger 1`)!;
        assert.match(one.content.text, new RegExp(`The ${SECRET} ledger was moved`)); assert.match(one.content.html, /<b>quorvellian<\/b>/);
        assert.equal(one.content.headers.fromName, 'Mira Holloway'); assert.match(one.content.headers.messageId, /^<sealed-1-/); assert.ok(one.content.headers.date);
        assert.equal(one.content.files.length, 1); assert.equal(one.content.files[0].name, 'annex-scan.pdf');
        assert.equal(Buffer.from(one.content.files[0].base64, 'base64').toString(), `%PDF-fake ${SECRET} annex scan`);
        // The sender → code mapping is a keyed hash: it holds no address and cannot be recomputed without the key.
        const mapping = await runtime.sql.query<{ sender_key: string; source_code: string }>(`select sender_key, source_code from pam_app.sealed_mail_senders where tenant_id=$1`, [org.tenantId]);
        assert.equal(mapping.length, 2);
        assert.ok(mapping.some((m) => m.sender_key === senderKey({ SEALED_MAIL_HMAC_KEY: hmacKey }, org, SENDER) && m.source_code === fromMira[0]!.code));
        assert.ok(!mapping.some((m) => m.sender_key === senderKey({ SEALED_MAIL_HMAC_KEY: randomBytes(32).toString('base64') }, org, SENDER)));

        // 5. A mailbox that is not sealed is unaffected.
        const ingestCtx = { ...admin, capabilities: [...admin.capabilities, 'correspondence:ingest'] };
        const plain = await correspondence.ingestRawMessage(ingestCtx, desk.id, Buffer.from(['From: clerk@riverside-council.example.org', 'To: desk@riverside-watch.example.org', 'Subject: Opening hours', 'Message-ID: <plain-1@mail.example.net>', 'MIME-Version: 1.0', 'Content-Type: text/plain', '', 'The records office opens at nine on weekdays (wintermoot).', ''].join('\r\n')), {});
        await stack.settle();
        assert.equal(await stateOf(plain.message.id), undefined);
        const plainNow = await correspondence.getMessage(admin, plain.message.id);
        assert.equal(plainNow.contentErased, false); assert.match(plainNow.bodyText, /wintermoot/);
        assert.equal((await correspondence.searchMessages(admin, { q: 'wintermoot' })).total, 1);
        assert.equal((await call('/api/app/v1/sealed/records', researchToken)).json.records.length, 3);
        // The engine itself refuses to erase in favour of a copy evidence storage does not hold (crash safety does not rest on PAM alone).
        await assert.rejects(correspondence.eraseMessageContent(svc, plain.message.id, { reason: 'test', preservedAs: 'E05:evidence_version:00000000-0000-4000-8000-000000000000@1' }), (e: any) => e?.code === 'invalid_state'); // eslint-disable-line @typescript-eslint/no-explicit-any
        assert.equal((await correspondence.getMessage(admin, plain.message.id)).contentErased, false);

        // 6. No plaintext of the sealed mail anywhere: not in any table of any schema (PAM and every engine), not in any
        // stored object, and no sealing progress row or alert carries more than ids.
        const tables = await runtime.sql.query<{ table_schema: string; table_name: string }>(`select table_schema, table_name from information_schema.tables where table_type='BASE TABLE' and table_schema not in ('pg_catalog','information_schema')`);
        assert.ok(tables.some((t) => t.table_schema === 'pam_app') && tables.some((t) => t.table_schema === 'e03_correspondence'));
        const leaks: string[] = [];
        for (const t of tables) {
          const rows = await runtime.sql.query<{ t: string }>(`select x::text as t from "${t.table_schema}"."${t.table_name}" x`);
          for (const r of rows) for (const word of [SECRET, SUBJECT_WORD, SENDER, NAME, 'other.source@example.com', 'annex-scan']) if (r.t.includes(word)) leaks.push(`${t.table_schema}.${t.table_name}: ${word}`);
        }
        assert.deepEqual([...new Set(leaks)], [], 'no table holds the sealed mail in clear');
        const files = walk(join(stack.dataDir, 'objects'));
        assert.ok(files.length > 0);
        assert.deepEqual(files.filter((f) => { const b = readFileSync(f).toString('latin1'); return b.includes(SECRET) || b.includes(SENDER) || b.includes(SUBJECT_WORD); }), [], 'no stored object holds the sealed mail in clear');
        // Idempotent: further worker passes and a replayed event change nothing.
        await stack.settle();
        assert.equal((await runtime.sql.query(`select 1 from pam_app.sealed_records where tenant_id=$1`, [org.tenantId])).length, 3);
        const status = await call('/api/app/v1/correspondence/sealed-mailboxes', researchToken);
        assert.deepEqual(status.json.messages[tips.id], { erased: 3 }); assert.equal(status.json.sealingKeys, 1);
      } finally { await server.stop(); }
    }, { CORRESPONDENCE_SECRET_KEY: randomBytes(32).toString('base64'), CORRESPONDENCE_ALLOW_PRIVATE_HOSTS: '1', SEALED_MAIL_HMAC_KEY: hmacKey, PAM_SEALED_MAIL_RETRY_MS: '200' });
  } finally { await world.close(); }
});
