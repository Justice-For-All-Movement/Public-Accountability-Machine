// Sealed mailboxes in the browser: an administrator marks a mailbox as sealed on the Correspondence page (with the
// no-key warning shown), and a message whose content was sealed and erased is shown as a tombstone with its reference.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withApp, browserSkip, settled, axe } from './helpers.ts';
import { getSetting } from '../../src/app/compose.ts';

const skip = browserSkip();

test('sealed mailboxes: administrator control, no-key warning, tombstone of an erased message', { skip, timeout: 300_000 }, async () => {
  await withApp(async (app) => {
    const { runtime } = app.stack; const correspondence = runtime.get('correspondence');
    const admin = await app.org.as(app.org.owner, 'administration');
    const tips = await correspondence.createMailbox(admin, { address: 'tips@example.org', provider: 'ingest_only' });
    const desk = await correspondence.createMailbox(admin, { address: 'desk@example.org', provider: 'ingest_only' });
    // A message in the unsealed desk mailbox, preserved elsewhere and erased (as the sealing worker does).
    const svc = await runtime.serviceContext({ tenantId: app.org.tenantId, projectId: app.org.projectId });
    const got = await correspondence.ingestRawMessage(svc, desk.id, Buffer.from(['From: someone@example.net', 'To: desk@example.org', 'Subject: Fictional sealed note', 'Message-ID: <b-sealed@mail.example.net>', 'MIME-Version: 1.0', 'Content-Type: text/plain', '', 'Fictional text that will be erased.', ''].join('\r\n')), {});
    const kept = await runtime.get('evidence').accept(svc, { bytes: new TextEncoder().encode('{"stand-in":"sealed copy"}'), mediaType: 'application/json', filename: 'copy.json', origin: { kind: 'test' } }) as { ref: string };
    // Evidence is quarantined until checked; E03 erases only in favour of a copy that is available.
    await app.stack.settle(async () => (await runtime.get('evidence').describe(svc, kept.ref))?.available === true);
    await correspondence.eraseMessageContent(svc, got.message.id, { reason: 'Sealed on arrival (test)', preservedAs: kept.ref });

    const { page, errors } = await app.page();
    await app.signIn(page);
    await page.goto(`${app.url}/correspondence`); await settled(page);
    const region = page.locator('section', { has: page.getByRole('heading', { name: 'Sealed mailboxes' }) });
    await region.waitFor();
    assert.match(await region.innerText(), /No sealing key is registered/);
    assert.match(await region.innerText(), /SEALED_MAIL_HMAC_KEY/);
    await page.getByLabel('Seal mail to tips@example.org on arrival').check();
    await page.getByRole('button', { name: 'Save sealed mailboxes' }).click();
    await region.locator('tr', { hasText: 'tips@example.org' }).filter({ hasText: 'sealed on arrival' }).waitFor();
    assert.deepEqual(await getSetting(runtime, app.org, 'correspondence.sealedMailboxes'), [tips.id]);
    await settled(page);
    assert.match(await region.locator('tr', { hasText: 'desk@example.org' }).innerText(), /not sealed/);
    assert.equal(await page.getByLabel('Seal mail to tips@example.org on arrival').isChecked(), true);
    assert.equal(await page.getByLabel('Seal mail to desk@example.org on arrival').isChecked(), false);

    // The erased message: a tombstone and the reference of the preserved copy, nothing else.
    await page.getByRole('button', { name: /Content sealed and erased/ }).first().click(); await settled(page);
    const article = page.locator('article.pam-message').first();
    assert.match(await article.innerText(), /Content sealed and erased; preserved as E05:evidence_version:/);
    assert.doesNotMatch(await article.innerText(), /Fictional text that will be erased|someone@example\.net/);
    assert.deepEqual(await axe(page), []);
    assert.deepEqual(errors, []);
  }, {}, { worker: false });
});
