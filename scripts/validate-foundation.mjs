import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { validateFoundationManifest } from '../src/foundation.mjs';

export function validateRegistry(registry, approvedBacklog) {
  if (registry.schemaVersion !== 1 || registry.repository !== 'neophilism/Public-Accountability-Machine'
      || registry.haltAfterFoundation !== true || registry.plannedPrCount !== 9
      || !Array.isArray(registry.units) || registry.units.length !== 9) {
    throw new TypeError('Invalid foundation registry');
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
    const externalHolds = original.dependencies.filter(id => !originalIds.has(id))
      .map(id => 'Required original cross-project milestone ' + id +
        ' is not yet mapped to a verified upstream repo/unit; block this unit until source evidence is linked');
    if (unit.legacyWorkUnitId !== original.id || unit.id !== canonical(original.id)
        || unit.title !== original.title
        || unit.implementationStatus !== 'planned' || unit.prs.length !== 0
        || unit.contributingPrs.length !== 0
        || JSON.stringify(unit.dependsOn) !== JSON.stringify(local)
        || JSON.stringify(unit.externalPrerequisites) !== JSON.stringify(externalHolds)
        || JSON.stringify(unit.externalDependencies) !== '[]'
        || JSON.stringify(unit.acceptanceCriteria) !== JSON.stringify(original.acceptance)
        || JSON.stringify(unit.requirements) !== JSON.stringify(original.requirements)) {
      throw new TypeError(`Original roadmap or planned status changed: ${original.id}`);
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
  console.log(`Foundation valid: ${result.engines} upstream engines; ${result.approvedSuiteTasks} preserved suite tasks.`);
  console.log('Operational PAM implementation is on hold. No integration or deployment is qualified.');
}
