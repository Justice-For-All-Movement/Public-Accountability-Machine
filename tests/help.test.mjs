// Every titled section of every screen has help text (bubbles and tour), and no help text points at a section that
// no longer exists.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { SCREENS } from '../web/js/help.js';

const dir = new URL('../web/js/screens/', import.meta.url);
const ids = Object.fromEntries([...readFileSync(new URL('index.js', dir), 'utf8').matchAll(/id: '([^']+)'[^\n]*import\('\.\/([a-z-]+)\.js'\)/g)].map((m) => [m[2], m[1]]));
test('every screen section has help, and all help refers to real sections', () => {
  const missing = [], stale = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.js') && x !== 'index.js')) {
    const id = ids[f.replace(/\.js$/, '')]; if (!id) continue;
    const titles = [...readFileSync(new URL(f, dir), 'utf8').matchAll(/region\('([^']+)'/g)].map((m) => m[1]);
    const help = (SCREENS[id] ?? []).map(([t]) => t);
    for (const t of titles) if (!help.includes(t)) missing.push(`${id}: ${t}`);
    for (const t of help) if (!titles.includes(t)) stale.push(`${id}: ${t}`);
  }
  assert.deepEqual(missing, [], 'sections without help text');
  assert.deepEqual(stale, [], 'help text for sections that do not exist');
});
