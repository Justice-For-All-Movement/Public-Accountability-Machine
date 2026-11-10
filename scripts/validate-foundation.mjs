import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { validateFoundationManifest } from '../src/foundation.mjs';

export function validateRegistry(registry, approvedBacklog) {
  // The foundation-only halt and per-task PR plan were superseded by the owner's completion assignment (2026-11-09).
  // Original work-unit identifiers, titles, requirements and acceptance criteria remain protected below.
  if (registry.schemaVersion !== 1 || registry.repository !== 'Justice-For-All-Movement/Public-Accountability-Machine'
      || registry.haltAfterFoundation !== false || !Array.isArray(registry.units) || registry.units.length !== 9) {
    throw new TypeError('Invalid registry');
  }
  const [foundation, ...operational] = registry.units;
  if (foundation.id !== 'PAM-000' || foundation.implementationStatus !== 'foundation_only'
      || JSON.stringify(foundation.dependsOn) !== '[]') {
    throw new TypeError('Foundation must remain distinct from operational work');
  }
  const approved = approvedBacklog.tasks.filter((task) => task.milestone === 'M07');
  if (approved.length !== 8 || operational.length !== approved.length) {
    throw new TypeError('Approved orchestration roadmap changed');
  }
  const canonical = (id) => id.replaceAll('.', '-');
  const originalIds = new Set(approved.map(task => task.id));
  for (let i = 0; i < approved.length; i++) {
    const original = approved[i];
    const unit = operational[i];
    const local = original.dependencies.filter(id => originalIds.has(id)).map(canonical);
    if (unit.legacyWorkUnitId !== original.id || unit.id !== canonical(original.id)
        || unit.title !== original.title
        || !['planned', 'implemented', 'locally_tested', 'integration_tested'].includes(unit.implementationStatus)
        || !Array.isArray(unit.prs) || !Array.isArray(unit.contributingPrs)
        || JSON.stringify(unit.dependsOn) !== JSON.stringify(local)
        || !Array.isArray(unit.externalPrerequisites)
        || JSON.stringify(unit.externalDependencies) !== '[]'
        || JSON.stringify(unit.acceptanceCriteria) !== JSON.stringify(original.acceptance)
        || JSON.stringify(unit.requirements) !== JSON.stringify(original.requirements)) {
      throw new TypeError(`Original roadmap identity, requirements or acceptance criteria changed: ${original.id}`);
    }
  }
}

export async function validateRepository(root) {
  const json = async (path) => JSON.parse(await readFile(resolve(root, path), 'utf8'));
  const manifest = await json('config/foundation.json');
  validateFoundationManifest(manifest);
  const provenance = await json('docs/approved-design/provenance.json');
  const expectedNames = ['development_backlog.json', 'domain_contracts.json', 'engine_catalog.json', 'requirements.json'];
  if (JSON.stringify(Object.keys(provenance.files).sort()) !== JSON.stringify(expectedNames)) {
    throw new TypeError('Approved design inventory changed');
  }
  for (const [name, hash] of Object.entries(provenance.files)) {
    const bytes = await readFile(resolve(root, 'docs/approved-design', name));
    if (createHash('sha256').update(bytes).digest('hex') !== hash) {
      throw new TypeError(`Recovered approved design bytes changed: ${name}`);
    }
  }
  const backlog = await json('docs/approved-design/development_backlog.json');
  const catalog = await json('docs/approved-design/engine_catalog.json');
  if (backlog.tasks.length !== 122 || new Set(backlog.tasks.map((task) => task.id)).size !== 122
      || catalog.engines.length !== 15 || catalog.engines[0].id !== 'E00') {
    throw new TypeError('Approved suite task or engine inventory changed');
  }
  validateRegistry(await json('registry/prs.json'), backlog);
  return { stage: manifest.stage, engines: manifest.engines.length, approvedSuiteTasks: backlog.tasks.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const result = await validateRepository(root);
  console.log(`Inventory valid: ${result.engines} upstream engines; ${result.approvedSuiteTasks} preserved suite tasks; stage ${result.stage}.`);
  console.log('This validates development metadata only. Acceptance evidence is recorded in docs/COVERAGE.md.');
}
