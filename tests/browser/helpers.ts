// Browser test helpers: the real composed application (acceptance harness: real PostgreSQL, real engines from ./engines)
// served by startServer on an ephemeral port and driven with the pre-installed Playwright Chromium.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { startServer } from '../../src/app/server.ts';
import { withStack, skipReason } from '../acceptance/harness.ts';
import type { Org, Person, Stack } from '../acceptance/harness.ts';

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Page = any; export type Browser = any;

export function browserSkip(): string | false {
  const base = skipReason(['identity', 'workspace', 'evidence']);
  if (base !== false) return base;
  try { require.resolve('playwright'); } catch { return 'playwright is not installed in this environment'; }
  return false;
}

export type App = { stack: Stack; org: Org; url: string; browser: Browser;
  /** New page with console/page errors collected into `errors`. */
  page(options?: { colorScheme?: 'light' | 'dark'; width?: number; height?: number }): Promise<{ page: Page; errors: string[] }>;
  signIn(page: Page, person?: Person): Promise<void>;
  stop(): Promise<void> };

export async function withApp(fn: (app: App) => Promise<void>, extraEnv: Record<string, string> = {}, options: { worker?: boolean } = {}): Promise<void> {
  await withStack(async (stack) => {
    const org = await stack.createOrg('Fictional Accountability Collective');
    const server = await startServer(stack.runtime, { port: 0, worker: options.worker ?? true, workerIntervalMs: 300, webDir: new URL('../../web', import.meta.url).pathname });
    const { chromium } = require('playwright') as { chromium: { launch(): Promise<Browser> } };
    const browser = await chromium.launch();
    const app: App = { stack, org, url: server.url, browser,
      async page(options = {}) {
        const context = await browser.newContext({ colorScheme: options.colorScheme ?? 'light', viewport: { width: options.width ?? 1280, height: options.height ?? 900 } });
        const page = await context.newPage();
        const errors: string[] = [];
        // Failed requests are reported with their address (the console only says "Failed to load resource").
        page.on('console', (m: { type(): string; text(): string }) => { if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) errors.push(m.text()); });
        page.on('response', (r: { status(): number; url(): string; request(): { method(): string } }) => { if (r.status() >= 400) errors.push(`HTTP ${r.status()} ${r.request().method()} ${r.url().replace(server.url, '')}`); });
        page.on('pageerror', (e: Error) => errors.push(`pageerror: ${e.message}`));
        return { page, errors };
      },
      async signIn(page, person = org.owner) {
        await page.goto(`${server.url}/overview`);
        await page.getByLabel('Login').fill(person.login);
        await page.getByLabel('Password').fill(person.password);
        await page.getByRole('button', { name: 'Sign in' }).click();
        await page.locator('#pam-nav:not([hidden])').waitFor();
      },
      async stop() { await browser.close(); await server.stop(); },
    };
    try { await fn(app); } finally { await app.stop(); }
  }, extraEnv);
}

let axeSource: string | null = null;
/** Runs axe-core in the page; returns serious and critical violations. */
export async function axe(page: Page): Promise<{ id: string; impact: string; help: string; nodes: string[] }[]> {
  axeSource ??= readFileSync(new URL('../../engines/workspace/node_modules/axe-core/axe.min.js', import.meta.url), 'utf8');
  // Evaluated through the debugging protocol: the page's CSP forbids inline scripts, which is intended.
  if (!(await page.evaluate('typeof window.axe !== "undefined"'))) await page.evaluate(axeSource);
  const result = await page.evaluate(async () => {
    // @ts-expect-error axe is injected above
    const r = await window.axe.run(document, { resultTypes: ['violations'] });
    return r.violations.map((v: { id: string; impact: string; help: string; nodes: { target: string[] }[] }) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.map((n) => n.target.join(' ')) }));
  });
  return (result as { id: string; impact: string; help: string; nodes: string[] }[]).filter((v) => v.impact === 'serious' || v.impact === 'critical');
}

/** Waits until no panel is loading. */
export async function settled(page: Page, timeout = 30_000): Promise<void> {
  await page.locator('.pam-screen').first().waitFor({ timeout });
  await page.waitForTimeout(250);
  await page.waitForFunction(() => document.querySelectorAll('[aria-busy="true"], [data-state="loading"]').length === 0, null, { timeout });
  await page.waitForTimeout(100);
}

/** Presses Tab until the focused element matches, returning false if it is never reached. */
export async function tabTo(page: Page, matches: string, max = 250): Promise<boolean> {
  for (let i = 0; i < max; i++) {
    await page.keyboard.press('Tab');
    if (await page.evaluate((sel: string) => document.activeElement !== null && document.activeElement.matches(sel), matches)) return true;
  }
  return false;
}
