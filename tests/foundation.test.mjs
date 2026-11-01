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

test('actual repository preserves approved inventory and remains foundation-only', async () => {
  assert.deepEqual(await validateRepository(root), { stage: 'foundation-only', engines: 14, approvedSuiteTasks: 122 });
});

test('each operational-effect flag is rejected, including truthy strings', () => {
  for (const key of Object.keys(manifest.effects)) {
    for (const value of [true, 'false', 0, null]) {
      const changed = structuredClone(manifest); changed.effects[key] = value;
      assert.throws(() => validateFoundationManifest(changed));
    }
  }
});

test('a missing, duplicate, unknown or misdirected upstream is rejected', () => {
  const mutations = [
    (m) => m.engines.pop(),
    (m) => { m.engines[1] = structuredClone(m.engines[0]); },
    (m) => { m.engines[0].id = 'E99'; },
    (m) => { m.engines[0].repository = 'other-owner/other-engine'; },
  ];
  for (const mutate of mutations) { const changed = structuredClone(manifest); mutate(changed); assert.throws(() => validateFoundationManifest(changed)); }
});

test('repository existence and historical tests cannot be labeled integration readiness', () => {
  for (const [key, value] of [['integrationStatus', 'connected'], ['qualification', 'verified']]) {
    const changed = structuredClone(manifest); changed.engines[0][key] = value;
    assert.throws(() => validateFoundationManifest(changed));
  }
});

test('stopping boundary, types, identity and unexpected fields are checked', () => {
  const mutations = [
    (m) => { m.operationalHold = false; },
    (m) => { m.schemaVersion = '1'; },
    (m) => { m.repository = 'other/repository'; },
    (m) => { m.stage = 'live'; },
    (m) => { m.effects.send = false; },
    (m) => { m.engines[0].credentials = 'synthetic-never-used'; },
  ];
  for (const mutate of mutations) { const changed = structuredClone(manifest); mutate(changed); assert.throws(() => validateFoundationManifest(changed)); }
  for (const value of [null, [], true, 'foundation']) assert.throws(() => validateFoundationManifest(value));
});

test('original stable task IDs, dependencies, criteria and planned statuses cannot drift', () => {
  const mutations = [
    (r) => { r.units[1].id = 'PAM-001'; },
    (r) => { r.units[1].externalPrerequisites = []; },
    (r) => { r.units[2].dependsOn = []; },
    (r) => { r.units[1].acceptanceCriteria = ['Different criterion']; },
    (r) => { r.units[1].requirements = []; },
    (r) => { r.units[1].implementationStatus = 'complete'; },
    (r) => { r.units[1].contributingPrs = [1]; },
    (r) => { r.haltAfterFoundation = false; },
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
