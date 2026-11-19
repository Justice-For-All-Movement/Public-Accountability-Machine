// Two-factor sign-in through the browser: set up on the Account security screen, sign out, sign in with a code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withApp, browserSkip, settled, axe } from './helpers.ts';

const skip = browserSkip();

test('two-factor sign-in: setup with an authenticator code, recovery codes shown once, sign-in needs a code', { skip, timeout: 300_000 }, async () => {
  const { totp } = await import('../../engines/identity/src/engine/mfa.ts') as { totp(secret: string, at: Date): string };
  await withApp(async (app) => {
    const { page, errors } = await app.page();
    await app.signIn(page);
    await page.goto(`${app.url}/account`);
    await settled(page);
    await page.getByText('Off', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Start setup' }).click();
    await page.locator('svg.pam-qr').waitFor();
    if (process.env.PAM_QR_SHOT) await page.locator('.pam-qr-box').screenshot({ path: process.env.PAM_QR_SHOT });
    const secret = (await page.locator('dt:text-is("Setup key") + dd').innerText()).trim();
    assert.match(secret, /^[A-Z2-7]{32}$/);
    assert.deepEqual(await axe(page), [], 'the setup view is accessible');
    await page.getByLabel(/^Six-digit code from the app/).fill(totp(secret, new Date()));
    await page.getByRole('button', { name: 'Confirm' }).click();
    await page.locator('.pam-recovery-codes code').first().waitFor({ timeout: 15_000 }).catch(async () => { throw new Error(`no recovery codes; page says: ${(await page.locator('.pam-region').innerText()).slice(0, 600)}`); });
    const codes = await page.locator('.pam-recovery-codes code').allInnerTexts();
    assert.equal(codes.length, 10);

    await page.getByRole('button', { name: 'Sign out' }).click();
    await page.getByLabel(/^Login/).waitFor();
    await page.getByLabel(/^Login/).fill(app.org.owner.login);
    await page.getByLabel(/^Password/).fill(app.org.owner.password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.locator('.pam-form-error:not([hidden])').waitFor({ timeout: 10_000 }).catch(async () => { throw new Error(`no error shown; page: ${(await page.locator('main').innerText()).slice(0, 500)} | errors: ${errors.join(' ; ')}`); });
    const said = await page.locator('.pam-form-error').innerText();
    assert.match(said, /one-time code/, said);
    await page.getByLabel(/^One-time code/).fill(codes[0] as string);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.locator('#pam-nav:not([hidden])').waitFor();
    await page.goto(`${app.url}/account`);
    await settled(page);
    await page.getByText('9', { exact: true }).waitFor();
    // Only the expected refusal (sign-in without a code) may appear among failed requests.
    assert.deepEqual(errors.filter((e) => !e.includes('/v1/sessions')), []);
  });
});

test('sign in on a phone: the Account screen shows a QR code; opening the link signs a fresh device in once', { skip, timeout: 300_000 }, async () => {
  await withApp(async (app) => {
    const { page, errors } = await app.page();
    await app.signIn(page);
    await page.goto(`${app.url}/account`);
    await settled(page);
    await page.getByRole('button', { name: 'Show a sign-in QR code' }).click();
    await page.locator('svg[aria-label="QR code that signs your phone in to PAM"]').waitFor();
    await page.getByText(/Expires in \d+ s\./).waitFor();
    assert.deepEqual(await axe(page), [], 'the sign-in code view is accessible');
    // The same one-time link the QR code carries, created for the owner's session, opened on a separate "phone".
    const identity = app.stack.runtime.get('identity');
    const link = await identity.createDeviceLink(app.org.owner.refreshToken) as { token: string };
    const phone = await app.page({ width: 390, height: 844 });
    await phone.page.goto(`${app.url}/link#t=${encodeURIComponent(link.token)}`);
    await phone.page.locator('#pam-nav:not([hidden])').waitFor();
    assert.equal(new URL(phone.page.url()).pathname, '/overview');
    assert.equal(new URL(phone.page.url()).hash, '', 'the token is removed from the address bar');
    // A second phone with the same link is refused and lands on the sign-in form with an explanation.
    const other = await app.page({ width: 390, height: 844 });
    await other.page.goto(`${app.url}/link#t=${encodeURIComponent(link.token)}`);
    await other.page.getByText(/That sign-in code did not work/).waitFor();
    assert.deepEqual(errors, []); assert.deepEqual(phone.errors, []);
  });
});
