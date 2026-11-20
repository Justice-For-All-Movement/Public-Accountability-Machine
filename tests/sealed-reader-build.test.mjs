// The committed offline reader is exactly what scripts/build-sealed-reader.mjs builds from web/js/sealed-crypto.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
test('tools/sealed-reader.html is up to date with the sealing code', () => {
  const before = readFileSync(new URL('../tools/sealed-reader.html', import.meta.url), 'utf8');
  execFileSync(process.execPath, [new URL('../scripts/build-sealed-reader.mjs', import.meta.url).pathname], { stdio: 'ignore' });
  assert.equal(readFileSync(new URL('../tools/sealed-reader.html', import.meta.url), 'utf8'), before, 'run node scripts/build-sealed-reader.mjs and commit the result');
});
