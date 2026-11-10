// Every screen: navigation, zero console errors, the correct empty state, axe-core (light and dark) with no serious or
// critical violations, and reflow at 320 px without horizontal scrolling.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withApp, browserSkip, axe, settled } from './helpers.ts';
import type { Page } from './helpers.ts';

export const SCREENS = ['overview', 'objectives', 'intake', 'evidence', 'investigations', 'knowledge', 'correspondence', 'editorial', 'production', 'rights', 'release', 'discovery', 'resources', 'audit', 'admin', 'search'];

async function visit(page: Page, url: string, screen: string): Promise<void> {
  await page.goto(`${url}/${screen}`);
  await page.locator(`.pam-screen[data-screen="${screen}"]`).waitFor();
  await settled(page);
}

test('every screen loads with real empty states, no console errors, axe clean in light and dark, reflows at 320 px', { skip: browserSkip(), timeout: 600_000 }, async () => {
  await withApp(async (app) => {
    for (const scheme of ['light', 'dark'] as const) {
      const { page, errors } = await app.page({ colorScheme: scheme });
      await app.signIn(page);
      for (const screen of SCREENS) {
        await visit(page, app.url, screen);
        const bad = await page.locator('.pam-screen [data-state="error"], .pam-screen [data-state="denied"], .pam-screen [data-state="disconnected"], .pam-screen [data-state="not-built"]').count();
        assert.equal(bad, 0, `${screen}: no error, denied, disconnected or unbuilt state (${await page.locator('.pam-screen').innerText()})`);
        // The audit trail of a fresh organization already holds its provisioning records: real data, not an empty state.
        if (scheme === 'light' && screen !== 'audit') assert.ok(await page.locator('.pam-screen .ws-state--empty').count() > 0, `${screen}: shows an empty state on a fresh organization`);
        assert.equal(await page.locator('h1').count(), 1, `${screen}: one h1`);
        const violations = await axe(page);
        assert.deepEqual(violations, [], `${screen} (${scheme}): axe serious/critical violations`);
      }
      assert.deepEqual(errors, [], `console errors (${scheme})`);
      await page.context().close();
    }
    const { page, errors } = await app.page({ width: 320, height: 640 });
    await app.signIn(page);
    for (const screen of SCREENS) {
      await visit(page, app.url, screen);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      const wide = overflow <= 0 ? [] : await page.evaluate(() => [...document.querySelectorAll('body *')].filter((e) => e.getBoundingClientRect().right > document.documentElement.clientWidth + 0.5).slice(0, 5).map((e) => `${e.tagName}.${e.className}#${e.id}`));
      assert.ok(overflow <= 0, `${screen}: no horizontal scroll at 320 px (overflow ${overflow}px: ${wide.join(', ')})`);
    }
    assert.deepEqual(errors, []);
  });
});
