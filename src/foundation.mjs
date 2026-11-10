// Static inventory metadata for the engine suite. Validation of checked-in development metadata only;
// it is not a runtime security control. The foundation-only freeze was superseded by the owner's completion assignment (2026-11-09).
export const ENGINE_REPOSITORIES = Object.freeze({
  E01: 'Identity-Authorization-and-Policy-Engine',
  E02: 'Secure-Intake-Case-Workflow-Engine',
  E03: 'Correspondence-and-Outreach-Engine',
  E04: 'Discovery-and-Acquisition-Engine',
  E05: 'Evidence-Storage-and-Provenance-Engine',
  E06: 'Document-and-Media-Processing-Engine',
  E07: 'Knowledge-and-verification-engine',
  E08: 'Factual-investigation-engine',
  E09: 'Editorial-and-Story-Development',
  E10: 'Media-Production',
  E11: 'Consent-rights-and-use-decisions-engine',
  E12: 'Packaging-release-and-correction-engine',
  E13: 'Resources-and-commercial-operations-engine',
  E14: 'Visual-workspace-and-audit-engine',
});

export const OWNER = 'Justice-For-All-Movement';
export const INTEGRATION_STATUSES = Object.freeze(['not_connected', 'connected']);
export const QUALIFICATIONS = Object.freeze(['not_verified', 'locally_tested', 'integration_tested']);

function exact(value, keys) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Expected a JSON object');
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, i) => key !== expected[i])) throw new TypeError('Unexpected or missing metadata fields');
}

export function validateFoundationManifest(value) {
  // Input must be JSON data. This is not an authentication or authorization API.
  exact(value, ['schemaVersion', 'repository', 'stage', 'supersedes', 'engines']);
  if (value.schemaVersion !== 2 || value.repository !== `${OWNER}/Public-Accountability-Machine` || value.stage !== 'integrated-application'
      || value.supersedes !== 'foundation-only') throw new TypeError('Manifest identity changed');
  if (!Array.isArray(value.engines) || value.engines.length !== Object.keys(ENGINE_REPOSITORIES).length) throw new TypeError('Every independent upstream engine must be recorded');
  const seen = new Set();
  for (const entry of value.engines) {
    exact(entry, ['id', 'repository', 'revision', 'integrationStatus', 'qualification']);
    if (typeof entry.id !== 'string' || !Object.hasOwn(ENGINE_REPOSITORIES, entry.id) || seen.has(entry.id)) throw new TypeError('Unknown or duplicate upstream engine');
    if (entry.repository !== `${OWNER}/${ENGINE_REPOSITORIES[entry.id]}`) throw new TypeError('Engine repository must be the recorded organization repository');
    if (!INTEGRATION_STATUSES.includes(entry.integrationStatus) || !QUALIFICATIONS.includes(entry.qualification)) throw new TypeError('Unknown integration or qualification state');
    const pinned = typeof entry.revision === 'string' && /^[0-9a-f]{40}$/.test(entry.revision);
    if (entry.revision !== null && !pinned) throw new TypeError('Revision must be a full commit SHA or null');
    // A connection or qualification claim is only meaningful against an exact pinned source revision.
    if ((entry.integrationStatus !== 'not_connected' || entry.qualification !== 'not_verified') && !pinned) throw new TypeError('Integration claims require a pinned revision');
    seen.add(entry.id);
  }
}
