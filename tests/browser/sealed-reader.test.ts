// The offline sealed reader (tools/sealed-reader.html), opened from disk: unlocks a key backup, opens a sealed file,
// verifies the fingerprint, makes no network request, and is accessible.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { browserSkip, axe } from './helpers.ts';
import type { Browser, Page } from './helpers.ts';
// @ts-expect-error plain JavaScript module shared with the browser
import { generateKeyPair, seal, backup } from '../../web/js/sealed-crypto.js';
const require = createRequire(import.meta.url);

const skip = browserSkip();

test('offline sealed reader opens sealed files with a key backup and never touches the network', { skip, timeout: 120_000 }, async () => {
  const { chromium } = require('playwright') as { chromium: { launch(): Promise<Browser> } };
  const dir = await mkdtemp(join(tmpdir(), 'reader-'));
  const k = await generateKeyPair();
  await writeFile(join(dir, 'key.json'), JSON.stringify(await backup(k.privateJwk, k.publicJwk, 'reader test passphrase')));
  await writeFile(join(dir, 'rec.sealed.json'), JSON.stringify({ ...(await seal({ text: 'She sang Mara Beboos to her brother.' }, [{ id: k.id, publicJwk: k.publicJwk }])), label: 'S-3 · conversation' }));
  const browser = await chromium.launch();
  try {
    const page: Page = await browser.newPage();
    const requests: string[] = []; page.on('request', (r: { url(): string }) => { if (!r.url().startsWith('file:') && !r.url().startsWith('blob:')) requests.push(r.url()); });
    await page.goto(new URL('../../tools/sealed-reader.html', import.meta.url).href);
    await page.getByLabel('Key backup file').setInputFiles(join(dir, 'key.json'));
    await page.getByLabel('Passphrase').fill('wrong passphrase!!');
    await page.getByRole('button', { name: 'Unlock key' }).click();
    await page.getByText('Wrong passphrase').waitFor();
    await page.getByLabel('Passphrase').fill('reader test passphrase');
    await page.getByRole('button', { name: 'Unlock key' }).click();
    await page.getByText(/^Key unlocked:/).waitFor({ timeout: 30_000 });
    await page.getByLabel(/^Sealed files/).setInputFiles(join(dir, 'rec.sealed.json'));
    await page.getByRole('button', { name: 'Open' }).click();
    await page.getByText('She sang Mara Beboos to her brother.').waitFor();
    await page.getByText('Fingerprint verified: this is the original as sealed.').waitFor();
    await page.getByText('S-3 · conversation').waitFor();
    assert.deepEqual(requests, [], 'no network requests');
    const blocked = await page.evaluate(async () => { try { await fetch('https://example.org/'); return false; } catch { return true; } });
    assert.equal(blocked, true, 'the page cannot reach the network');
    for (const scheme of ['light', 'dark'] as const) { await page.emulateMedia({ colorScheme: scheme }); assert.deepEqual(await axe(page), [], `reader accessible (${scheme})`); }
  } finally { await browser.close(); }
});
