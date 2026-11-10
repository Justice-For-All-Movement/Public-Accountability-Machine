// Screens with real data: investigation work through to a package, knowledge claim detail, editorial document saving,
// a release candidate built from the investigation package, and a recorded permission. axe runs on each populated view.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withApp, browserSkip, settled, axe } from './helpers.ts';
import type { Page } from './helpers.ts';

const status = (page: Page, text: string | RegExp) => page.locator('.pam-form-status, .pam-action-result', { hasText: text }).first().waitFor({ timeout: 20_000 });
async function noErrorStates(page: Page, where: string): Promise<void> {
  const text = await page.locator('.pam-screen').innerText();
  assert.equal(await page.locator('.pam-screen [data-state="error"], .pam-screen [data-state="denied"], .pam-screen [data-state="disconnected"]').count(), 0, `${where}: ${text.slice(0, 3000)}`);
  assert.equal(await page.locator('.pam-form-error:not([hidden])').count(), 0, `${where}: form error ${text.slice(0, 3000)}`);
  assert.deepEqual(await axe(page), [], `${where}: axe`);
}

test('populated screens: investigation to package, knowledge, editorial, release candidate, rights', { skip: browserSkip(), timeout: 600_000 }, async () => {
  await withApp(async (app) => {
    const { page, errors } = await app.page();
    await app.signIn(page);
    // Investigation
    await page.goto(`${app.url}/investigations`); await settled(page);
    await page.getByLabel(/^Title/).fill('Fictional relief fund payments');
    await page.getByLabel(/^Origin reference/).fill('E05:evidence:00000000-0000-4000-8000-000000000001');
    await page.getByLabel(/^Scope statement/).fill('Whether two fictional payments were authorised.');
    await page.getByLabel(/^Original account/).fill('A fictional volunteer says two payments were made without approval.');
    await page.getByRole('button', { name: 'Open investigation' }).click();
    await status(page, 'Opened');
    await page.getByRole('link', { name: 'Fictional relief fund payments' }).click(); await settled(page);
    await page.locator('input[name="text"]').fill('Who authorised the second payment?');
    await page.getByLabel(/^Why it is material/).fill('It decides responsibility.');
    await page.getByRole('button', { name: 'Add question' }).click();
    await page.getByText('Who authorised the second payment?').first().waitFor(); await settled(page);
    await page.getByLabel(/^Target/).fill('Fictional board minutes archive');
    await page.getByLabel(/^Method/).fill('Searched the public archive');
    await page.locator('select[name="outcome"]').selectOption('zero_result');
    await page.getByLabel(/^Detail/).fill('No minutes for March are published.');
    await page.getByRole('button', { name: 'Record attempt' }).click();
    await page.getByRole('cell', { name: 'No minutes for March are published.' }).waitFor(); await settled(page);
    await noErrorStates(page, 'investigation detail');
    await page.getByRole('button', { name: 'Build package' }).click();
    await status(page, /Package version 1 built/);
    await page.getByRole('button', { name: 'View version 1' }).waitFor({ timeout: 20_000 }); await settled(page);
    await page.getByRole('button', { name: 'Markdown of version 1' }).click();
    await page.locator('pre', { hasText: 'Fictional relief fund payments' }).first().waitFor();
    await page.getByRole('button', { name: 'View version 1' }).click();
    const frame = page.locator('iframe.pam-sandbox');
    await frame.waitFor();
    assert.equal(await frame.getAttribute('sandbox'), '', 'package HTML is shown only in a sandbox without scripts');

    // Knowledge
    await page.goto(`${app.url}/knowledge`); await settled(page);
    await page.getByLabel(/^Claim text/).fill('The second fictional payment was approved by the treasurer.');
    await page.getByRole('button', { name: 'Create claim' }).click();
    await page.getByRole('link', { name: 'The second fictional payment was approved by the treasurer.' }).click(); await settled(page);
    assert.match(await page.locator('.pam-screen').innerText(), /factual[\s\S]*source_type[\s\S]*procedural[\s\S]*editorial/);
    await noErrorStates(page, 'claim detail');

    // Editorial
    await page.goto(`${app.url}/editorial`); await settled(page);
    await page.getByLabel(/^Title/).first().fill('Fictional relief fund story');
    await page.getByLabel(/^Publishing identity/).fill('Example Newsroom');
    await page.getByRole('button', { name: 'Create project' }).click();
    await page.getByRole('rowheader', { name: 'Fictional relief fund story' }).waitFor({ timeout: 20_000 }).catch(async (e: Error) => { throw new Error(`${e.message}\n${await page.locator('.pam-screen').innerText()}`); }); await settled(page);
    const docForm = page.locator('form', { hasText: 'New document' });
    await docForm.getByLabel(/^Title/).fill('First draft');
    await docForm.getByLabel(/^First block text/).fill('A fictional volunteer alleges two payments were not approved.');
    await docForm.getByLabel(/^Basis of the first block/).selectOption('allegation');
    await docForm.getByLabel(/^Attribution/).fill('A fictional volunteer');
    await docForm.getByRole('button', { name: 'Create document' }).click();
    await page.getByRole('link', { name: 'First draft' }).click(); await settled(page);
    await page.getByRole('button', { name: 'Add block' }).click();
    await page.getByRole('button', { name: 'Save new revision' }).click();
    await page.locator('.pam-form-error:not([hidden])', { hasText: 'Block 2 has no basis label.' }).waitFor();
    await page.locator('fieldset.pam-block').nth(1).locator('textarea').fill('What remains unknown is who signed.');
    await page.locator('fieldset.pam-block').nth(1).locator('select').selectOption('unknown_acknowledged');
    await page.getByRole('button', { name: 'Save new revision' }).click();
    await status(page, 'Saved as revision 2.');
    await settled(page);
    await page.getByRole('button', { name: 'Diff 1→2' }).waitFor();
    await noErrorStates(page, 'editorial document');

    // Release: chronology candidate from the investigation package
    await page.goto(`${app.url}/release`); await settled(page);
    await page.getByLabel(/^Title/).fill('Chronology: fictional payments');
    await page.getByRole('button', { name: 'Build candidate' }).click();
    await status(page, /Candidate built from package version 1: built/);
    await page.getByRole('link', { name: /Chronology: fictional payments/ }).click(); await settled(page);
    assert.match(await page.locator('.pam-screen').innerText(), /manifest\.json|Components/);
    await noErrorStates(page, 'release candidate');

    // Rights
    await page.goto(`${app.url}/rights`); await settled(page);
    await page.getByLabel(/^Holder reference/).fill('E05:evidence:00000000-0000-4000-8000-000000000002');
    await page.getByLabel(/^Scope value/).fill('E05:evidence:00000000-0000-4000-8000-000000000003');
    await page.getByLabel(/^Actions/).fill('publish');
    await page.getByLabel(/^When it was given/).fill('2026-11-01T10:00');
    await page.getByRole('button', { name: 'Record permission' }).click();
    await status(page, /Recorded:/); await settled(page);
    await noErrorStates(page, 'rights');
    assert.deepEqual(errors, []);
  });
});
