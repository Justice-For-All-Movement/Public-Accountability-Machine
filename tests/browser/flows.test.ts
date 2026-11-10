// Core flows driven through the browser against the real composed application.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withApp, browserSkip, settled, tabTo } from './helpers.ts';

const skip = browserSkip();

test('sign-in, organization/project selection, evidence upload → quarantined → available → viewer, redaction, inspector', { skip, timeout: 300_000 }, async () => {
  // The server's own worker loop is off: the test moves the quarantine forward explicitly with stack.settle().
  await withApp(async (app) => {
    const identity = app.stack.runtime.get('identity');
    await identity.createProject(await app.org.as(app.org.owner, 'administration'), { id: 'second', name: 'Second project' });
    const { page, errors } = await app.page();
    await page.goto(`${app.url}/`);
    await page.getByLabel(/^Login/).fill(app.org.owner.login);
    await page.getByLabel(/^Password/).fill('wrong-password');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.locator('.pam-form-error:not([hidden])').waitFor();
    await app.signIn(page);
    errors.length = 0; // the refused sign-in above logs its 401 response; nothing else may
    assert.equal(await page.locator('#pam-org-name').innerText(), 'Fictional Accountability Collective');
    assert.equal(await page.evaluate(() => localStorage.length), 0, 'nothing is kept in localStorage');
    assert.ok(await page.evaluate(() => sessionStorage.getItem('pam.session') !== null), 'the refresh token is kept in sessionStorage only');
    const options = await page.locator('#pam-scope option').allInnerTexts();
    assert.ok(options.some((o) => o.includes('Second project')), `both projects listed: ${options.join(' | ')}`);

    await page.goto(`${app.url}/evidence`);
    await settled(page);
    await page.getByLabel(/^File/).setInputFiles({ name: 'memo.txt', mimeType: 'text/plain', buffer: Buffer.from('Fictional memo: the Example Works board met on 3 March.\n') });
    await page.getByLabel(/^Where it came from/).fill('Handed over by a fictional volunteer');
    await page.getByRole('button', { name: 'Upload' }).click();
    await page.locator('.pam-form-status', { hasText: 'in quarantine until checks finish' }).waitFor();
    await page.locator('text=quarantined (being checked; not yet available)').first().waitFor();
    await app.stack.settle();
    await page.getByText('available', { exact: true }).first().waitFor({ timeout: 20_000 });
    await page.getByRole('link', { name: 'memo.txt' }).click();
    await page.locator('pre.pam-viewer__text').waitFor();
    assert.match(await page.locator('pre.pam-viewer__text').innerText(), /Example Works board met on 3 March/);

    // Redact the first 15 characters (a derivative), then open the derivative in the inspector: its source is the original.
    await page.getByLabel(/^First character to remove/).fill('0');
    await page.getByLabel(/^End \(exclusive\)/).fill('15');
    await page.getByLabel(/^Reason/).fill('Remove the heading');
    await page.getByRole('button', { name: 'Create redacted copy' }).click();
    const done = page.locator('.pam-form-status', { hasText: 'Redacted copy created' });
    await done.waitFor();
    const derivative = /(E05:evidence_version:[^\s.]+)/.exec(await done.innerText())?.[1] as string;
    const original = await page.locator('dd button.pam-ref').first().getAttribute('data-ref');
    await page.evaluate(async (ref: string) => { (await import('/js/ui.js')).openInspector(ref); }, derivative);
    await page.locator('#pam-inspector:not([hidden])').waitFor();
    await page.locator('#pam-inspector .ws-inspector').waitFor();
    await page.locator('#pam-inspector [role="tab"]', { hasText: 'Sources' }).click();
    await page.locator('#pam-inspector [role="tabpanel"]').getByText(original!.split('@')[0]!.split(':')[2]!, { exact: false }).first().waitFor();
    await page.locator('#pam-inspector .pam-inspector__controls').getByRole('button', { name: 'Add review note' }).waitFor();
    // A uref shown anywhere opens the drawer too.
    await page.getByRole('button', { name: 'Close inspector' }).click();
    assert.equal(await page.locator('#pam-inspector').isHidden(), true);
    await page.locator('dd button.pam-ref').first().click();
    await page.locator('#pam-inspector:not([hidden]) .ws-graph, #pam-inspector:not([hidden]) .ws-table').first().waitFor();
    await page.keyboard.press('Escape');

    // Project switch: the second project has its own (empty) evidence.
    await page.locator('#pam-scope').selectOption({ label: 'Fictional Accountability Collective · Second project' });
    await page.goto(`${app.url}/evidence`);
    await settled(page);
    assert.equal(await page.getByRole('link', { name: 'memo.txt' }).count(), 0, 'evidence of the first project is not shown in the second');
    await page.getByText('No evidence yet').waitFor();
    assert.deepEqual(errors, []);

    await page.getByRole('button', { name: 'Sign out' }).click();
    await page.getByRole('heading', { name: 'Sign in' }).waitFor();
    assert.equal(await page.evaluate(() => sessionStorage.getItem('pam.session')), null);
  }, {}, { worker: false });
});

test('objective, run and task board pause/resume; correspondence draft listed in Drafts', { skip, timeout: 300_000 }, async () => {
  await withApp(async (app) => {
    // A fictional action so a run can be started; the objective policy makes it wait for approval, so it never runs.
    app.stack.runtime.orchestration.registerAction('demo.note', { description: 'Records a note (test action)', requires: [], run: async () => ({ output: {} }) });
    const { page, errors } = await app.page();
    await app.signIn(page);
    await page.goto(`${app.url}/objectives`);
    await settled(page);
    await page.getByLabel(/^Title/).fill('Map the fictional procurement trail');
    await page.getByLabel(/^Description/).fill('Fictional objective for the browser test.');
    await page.getByLabel(/^Research lane/).fill('documentary');
    await page.getByLabel(/^Actions that need human approval/).fill('demo.note');
    await page.getByRole('button', { name: 'Create objective' }).click();
    await page.getByRole('link', { name: 'Map the fictional procurement trail' }).click();
    await settled(page);
    await page.getByLabel(/^Ad-hoc tasks/).fill('collect, demo.note\nreview, demo.note, collect');
    await page.getByRole('button', { name: 'Start run' }).click();
    await page.locator('.pam-form-status', { hasText: 'Run started with 2 tasks.' }).waitFor();
    const card = page.locator('.ws-card', { hasText: 'review (demo.note)' });
    await card.waitFor();
    assert.match(await card.innerText(), /Waits on 1 \(1 not done\)/);
    await card.getByRole('button', { name: 'Pause' }).click();
    await page.locator('[data-dialog="confirm"]').click(); // the control has an optional reason: it asks before sending
    await page.locator('.ws-board__column[data-column="paused"] .ws-card', { hasText: 'review' }).waitFor();
    await page.locator('.ws-card', { hasText: 'review (demo.note)' }).getByRole('button', { name: 'Resume' }).click();
    if (await page.locator('[data-dialog="confirm"]').count()) await page.locator('[data-dialog="confirm"]').click();
    await page.locator('.ws-board__column[data-column="review"] .ws-card', { hasText: 'review' }).waitFor();
    const tasks = await app.stack.runtime.orchestration.listTasks(await app.org.as(app.org.owner, 'administration'), {});
    assert.equal(tasks.find((t: { key: string }) => t.key === 'review')?.state, 'awaiting_approval', 'resume restored the previous state');

    await page.goto(`${app.url}/correspondence`);
    await settled(page);
    await page.getByLabel(/^Address/).fill('desk@example.org');
    await page.getByRole('button', { name: 'Add mailbox' }).click();
    await page.getByLabel(/^From mailbox/).waitFor();
    await settled(page);
    await page.getByLabel(/^To \(addresses/).fill('records@example.org');
    await page.getByLabel(/^Subject/).first().fill('Request for fictional records');
    await page.getByLabel(/^Message/).fill('Please share the fictional meeting minutes.');
    await page.getByRole('button', { name: 'Save draft' }).click();
    await page.locator('.pam-form-status', { hasText: 'Draft saved. It is listed under Drafts.' }).waitFor();
    await page.getByRole('button', { name: /^Drafts/ }).click();
    await page.getByRole('button', { name: 'Request for fictional records' }).waitFor();
    assert.match(await page.locator('.pam-folders button', { hasText: 'Drafts' }).innerText(), /1/);
    assert.deepEqual(errors, []);
  });
});

test('permission denied (403) for a user without the purpose; keyboard-only navigation and form', { skip, timeout: 300_000 }, async () => {
  await withApp(async (app) => {
    const researcher = await app.stack.addUser(app.org, 'Rafael Research', ['investigator']);
    const { page } = await app.page();
    await app.signIn(page, researcher);
    await page.goto(`${app.url}/release`);
    await settled(page);
    await page.locator('.pam-screen [data-state="denied"]').first().waitFor();
    assert.match(await page.locator('.pam-screen').innerText(), /Not found or not permitted/);

    // Keyboard only: skip link, navigation, and a form submitted with the keyboard.
    await page.goto(`${app.url}/overview`);
    await settled(page);
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Skip to main content');
    await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'main');
    await page.locator('body').focus();
    assert.ok(await tabTo(page, '#pam-nav a[href="/knowledge"]'), 'the Knowledge link is reachable with Tab');
    await page.keyboard.press('Enter');
    await page.waitForURL(/\/knowledge$/);
    await settled(page);
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'pam-title', 'focus moves to the new screen heading');
    assert.ok(await tabTo(page, 'textarea[name="text"]'), 'the claim text field is reachable');
    // An empty required field is refused and the error is tied to the field.
    assert.ok(await tabTo(page, 'form:has(textarea[name="text"]) button[type="submit"]'));
    await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('name')), 'text');
    const described = await page.evaluate(() => document.activeElement?.getAttribute('aria-describedby') ?? '');
    assert.match(await page.locator(`#${described.split(' ').pop()}`).innerText(), /required/);
    await page.keyboard.type('The fictional board met on 3 March.');
    assert.ok(await tabTo(page, 'select[name="claimType"]'));
    assert.ok(await tabTo(page, 'form:has(textarea[name="text"]) button[type="submit"]'));
    await page.keyboard.press('Enter');
    await page.locator('.pam-form-status', { hasText: 'Claim created (unassessed).' }).waitFor({ timeout: 10_000 }).catch(async (e) => { throw new Error(`${e.message}\n${await page.locator('form').first().innerText()}`); });
    await page.getByRole('link', { name: 'The fictional board met on 3 March.' }).waitFor();
  });
});

test('an engine absent from the deployment shows the disconnected state', { skip, timeout: 300_000 }, async () => {
  const real = new URL('../../engines', import.meta.url).pathname;
  const dir = await mkdtemp(join(tmpdir(), 'pam-engines-'));
  for (const name of await readdir(real)) if (name !== 'production') await symlink(join(real, name), join(dir, name));
  await withApp(async (app) => {
    const { page } = await app.page();
    await app.signIn(page);
    await page.goto(`${app.url}/production`);
    await settled(page);
    await page.locator('.pam-screen [data-state="disconnected"]').first().waitFor();
    assert.match(await page.locator('.pam-screen').innerText(), /Disconnected[\s\S]*production/);
    await page.goto(`${app.url}/overview`);
    await settled(page);
    assert.match(await page.locator('.pam-screen').innerText(), /E10\s+production\s+unavailable/);
  }, { PAM_ENGINES_DIR: dir });
});
