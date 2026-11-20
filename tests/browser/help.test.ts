// In-app help: help bubbles on hover and keyboard focus, the guided tour of a page, accessibility of both.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withApp, browserSkip, settled, axe } from './helpers.ts';

const skip = browserSkip();

test('help bubbles explain what is pointed at; the tour walks the page; both are accessible', { skip, timeout: 300_000 }, async () => {
  await withApp(async (app) => {
    const { page, errors } = await app.page();
    await app.signIn(page);
    await page.goto(`${app.url}/research-record`);
    await settled(page);
    const toggle = page.locator('#pam-help-toggle');
    assert.equal(await toggle.getAttribute('aria-pressed'), 'false');
    // Off: nothing pops up.
    await page.getByRole('heading', { name: 'Tools', exact: true }).hover();
    assert.equal(await page.locator('#pam-help-bubble').count(), 0);
    // On: hovering a section heading explains that section; the heading is described by the bubble.
    await toggle.click();
    assert.equal(await toggle.getAttribute('aria-pressed'), 'true');
    const heading = page.getByRole('heading', { name: 'Tools', exact: true });
    await heading.hover();
    const bubble = page.locator('#pam-help-bubble[role="tooltip"]');
    await bubble.waitFor();
    assert.match(await bubble.innerText(), /fingerprint of its exact source/);
    assert.equal(await heading.getAttribute('aria-describedby'), 'pam-help-bubble');
    for (const scheme of ['light', 'dark'] as const) { await page.emulateMedia({ colorScheme: scheme }); assert.deepEqual(await axe(page), [], `bubble accessible (${scheme})`); }
    // Header controls explain themselves too, also by keyboard focus.
    await page.locator('#pam-search-q').focus();
    assert.match(await bubble.innerText(), /Search all engines/);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#pam-help-bubble').count(), 0);
    // The setting is remembered.
    await page.reload(); await settled(page);
    assert.equal(await page.locator('#pam-help-toggle').getAttribute('aria-pressed'), 'true');

    // Tour: frame first, then every section in page order; Back/Next; focus on the dialog; Escape ends it.
    await page.getByRole('button', { name: 'Tour this page' }).click();
    const tour = page.getByRole('dialog');
    await tour.waitFor();
    assert.match(await tour.innerText(), /Step 1 of (\d+)/);
    const total = Number((await tour.innerText()).match(/Step 1 of (\d+)/)![1]);
    assert.ok(total >= 8, `tour has ${total} steps`);
    assert.ok(await tour.evaluate((el: Element) => el === document.activeElement), 'the tour dialog has focus');
    assert.deepEqual(await axe(page), [], 'tour accessible');
    const titles: string[] = [];
    for (let i = 0; i < total; i++) { titles.push(await tour.locator('.pam-help-bubble__title').innerText()); if (i < total - 1) await tour.getByRole('button', { name: 'Next' }).click(); }
    assert.equal(titles[0], 'Main menu');
    const order = ['Research record', 'Research runs', 'Tools', 'Write journal'].map((t) => titles.indexOf(t));
    assert.ok(order.every((x, i) => x >= 0 && (i === 0 || x > order[i - 1]!)), `sections in page order: ${titles.join(' | ')}`);
    assert.equal(await page.locator('.pam-help-target').count(), 1, 'the current step is highlighted');
    await tour.getByRole('button', { name: 'Back' }).click();
    assert.match(await tour.innerText(), new RegExp(`Step ${total - 1} of ${total}`));
    await page.keyboard.press('Escape');
    assert.equal(await page.getByRole('dialog').count(), 0);
    assert.equal(await page.locator('.pam-help-target').count(), 0);
    // A new page ends any tour and bubble.
    await page.getByRole('button', { name: 'Tour this page' }).click();
    await page.goto(`${app.url}/overview`); await settled(page);
    assert.equal(await page.getByRole('dialog').count(), 0);
    assert.deepEqual(errors, []);
  });
});
