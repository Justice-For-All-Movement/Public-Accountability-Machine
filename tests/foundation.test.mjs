import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, cp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateFoundationManifest } from '../src/foundation.mjs';
import { validateRegistry, validateRepository } from '../scripts/validate-foundation.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const load = async (name) => JSON.parse(await readFile(join(root, name), 'utf8'));
const manifest = await load('config/foundation.json');
const registry = await load('registry/prs.json');
const backlog = await load('docs/approved-design/development_backlog.json');

test('repository preserves the approved inventory at the integrated-application stage', async () => {
  assert.deepEqual(await validateRepository(root), { stage: 'integrated-application', engines: 14, approvedSuiteTasks: 122 });
});

test('a missing, duplicate, unknown or misdirected upstream is rejected', () => {
  const mutations = [
    (m) => m.engines.pop(),
    (m) => { m.engines[1] = structuredClone(m.engines[0]); },
    (m) => { m.engines[0].id = 'E99'; },
    (m) => { m.engines[0].repository = 'other-owner/other-engine'; },
    (m) => { m.engines[0].credentials = 'synthetic-never-used'; },
    (m) => { m.repository = 'other/repository'; },
  ];
  for (const mutate of mutations) { const changed = structuredClone(manifest); mutate(changed); assert.throws(() => validateFoundationManifest(changed)); }
  for (const value of [null, [], true, 'foundation']) assert.throws(() => validateFoundationManifest(value));
});

test('integration or qualification cannot be claimed without an exact pinned revision', () => {
  for (const [key, value] of [['integrationStatus', 'connected'], ['qualification', 'integration_tested'], ['qualification', 'certified'], ['revision', 'main']]) {
    const changed = structuredClone(manifest); changed.engines[0].revision = null; changed.engines[0][key] = value;
    assert.throws(() => validateFoundationManifest(changed));
  }
  const ok = structuredClone(manifest); ok.engines[0].revision = 'a'.repeat(40); ok.engines[0].integrationStatus = 'connected'; ok.engines[0].qualification = 'integration_tested';
  validateFoundationManifest(ok);
});

test('original stable task IDs, dependencies, criteria and requirements cannot drift', () => {
  const mutations = [
    (r) => { r.units[1].id = 'PAM-001'; },
    (r) => { r.units[2].dependsOn = []; },
    (r) => { r.units[1].acceptanceCriteria = ['Different criterion']; },
    (r) => { r.units[1].requirements = []; },
    (r) => { r.units[1].implementationStatus = 'certified'; },
    (r) => { r.units.pop(); },
  ];
  for (const mutate of mutations) { const changed = structuredClone(registry); mutate(changed); assert.throws(() => validateRegistry(changed, backlog)); }
});

test('actual filesystem edit to a recovered design file fails byte-integrity validation', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'pam-foundation-'));
  try {
    for (const dir of ['config', 'registry', 'docs/approved-design']) await cp(join(root, dir), join(temporary, dir), { recursive: true });
    await writeFile(join(temporary, 'docs/approved-design/requirements.json'), '{}\n');
    await assert.rejects(validateRepository(temporary), /Recovered approved design bytes changed/);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
