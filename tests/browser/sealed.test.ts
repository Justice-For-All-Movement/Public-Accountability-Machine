// Sealed sources end to end: a key made in the browser (backup downloaded), a code name, a conversation sealed in the
// browser, the server holding only ciphertext, and decryption on the device with the fingerprint verified.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withApp, browserSkip, settled, axe } from './helpers.ts';

const skip = browserSkip();
const SECRET = 'His mother said he played the setar every evening and loved Mohsen Namjoo.';

test('sealed sources: the server never sees the plaintext; the device decrypts and verifies', { skip, timeout: 300_000 }, async () => {
  await withApp(async (app) => {
    const { page, errors } = await app.page();
    await app.signIn(page);
    await page.goto(`${app.url}/sealed`); await settled(page);
    assert.deepEqual(await axe(page), [], 'sealed sources page accessible before setup');
    await page.getByLabel(/^Name for this key/).fill('Test laptop');
    await page.getByLabel(/^Backup passphrase \(at least 12/).fill('a long test passphrase');
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Create key and download backup' }).click()]);
    const backup = JSON.parse(await (await import('node:fs/promises')).readFile(await download.path() as string, 'utf8'));
    assert.equal(backup.format, 'pam-sealing-key-backup'); assert.ok(!('d' in backup.publicJwk), 'no private key material in the clear');
    await page.getByText(/registered in this project/).waitFor();

    await page.getByLabel(/^Channel/).selectOption('signal');
    await page.getByLabel(/^Risk to this person/).selectOption('severe');
    await page.getByRole('button', { name: 'Create code name' }).click();
    await page.getByText('Created S-1.').waitFor();
    await page.goto(`${app.url}/sealed`); await settled(page);
    await page.getByLabel(/^Kind/).selectOption('conversation');
    await page.getByLabel(/^Text \(paste/).fill(SECRET);
    await page.getByRole('button', { name: 'Encrypt here and upload' }).click();
    await page.getByText(/Sealed and uploaded as E05:/).waitFor({ timeout: 30_000 });

    // The server: no plaintext anywhere in the stored evidence or the record index.
    const rows = await app.stack.runtime.sql.query<{ evidence_ref: string; source_code: string }>('select evidence_ref, source_code from pam_app.sealed_records');
    assert.equal(rows.length, 1); assert.equal(rows[0]!.source_code, 'S-1');
    const ctx = await app.org.as(app.org.owner, 'research');
    const evidence = app.stack.runtime.get('evidence');
    await app.stack.settle(async () => (await evidence.describe(ctx, rows[0]!.evidence_ref))?.available === true);
    const stored = new TextDecoder().decode(await evidence.getBytes(ctx, rows[0]!.evidence_ref, {}));
    assert.ok(!stored.includes('setar') && !stored.includes('Namjoo'), 'the stored evidence is ciphertext only');
    const dump = JSON.stringify(await app.stack.runtime.sql.query('select * from pam_app.sealed_records'));
    assert.ok(!dump.includes('setar'));

    await page.goto(`${app.url}/sealed`); await settled(page);
    await page.getByRole('button', { name: 'Decrypt here' }).click();
    await page.getByText(SECRET).waitFor();
    await page.getByText('Fingerprint verified: this is the original as sealed.').waitFor();
    for (const scheme of ['light', 'dark'] as const) { await page.emulateMedia({ colorScheme: scheme }); assert.deepEqual(await axe(page), [], `decrypted view accessible (${scheme})`); }
    assert.deepEqual(errors, []);
  });
});
