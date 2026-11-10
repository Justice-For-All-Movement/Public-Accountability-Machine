# Continuation record

Single source of truth for where the completion assignment stands. Update at every checkpoint.

_Last updated: 2026-11-10 05:20 UTC (after the second usage-limit interruption)._

## Repositories (branch `feature/pam-completion` in each)

| Engine | Repository (`Justice-For-All-Movement/…`) | Commit | State |
|---|---|---|---|
| E00 | Public-Accountability-Machine | `3fcc16a` | Orchestration engine + application server (composition, gateway, event router, CLI). 12 tests pass; composed smoke test passes. No workflow actions, UI or acceptance tests yet. |
| E01 | Identity-Authorization-and-Policy-Engine | `fa803a0` | Service layer complete. 103 tests pass. Live OIDC/intake not verified. |
| E05 | Evidence-Storage-and-Provenance-Engine | `0764e4d` | Service layer complete. 94 tests pass; GitHub CI green. S3 and official ClamAV DB not verified. |
| E11 | Consent-rights-and-use-decisions-engine | `9f6e8e1` | Service layer complete. 83 tests pass; GitHub CI green. |
| E13 | Resources-and-commercial-operations-engine | `ed35585` | Service layer complete. 69 tests pass. Stripe adapter not verified (no credentials). |
| E06 | Document-and-Media-Processing-Engine | `7e7af0c`+ | In progress (worker resumed). |
| E07 | Knowledge-and-verification-engine | `7b592f4`+ | In progress, WIP pushed (worker resumed). |
| E08 | Factual-investigation-engine | — | In progress, uncommitted work on disk (worker resumed). |
| E12 | Packaging-release-and-correction-engine | — | In progress, uncommitted work on disk (worker resumed). |
| E02 | Secure-Intake-Case-Workflow-Engine | — | Existing app (1.0.0-rc.9); completion/integration-contract work barely started. |
| E03, E04 | Correspondence, Discovery | — | Existing foundation code; service layer barely started. |
| E09, E10 | Editorial-and-Story-Development, Media-Production | — | Remotes were empty; fresh implementation barely started locally. |
| E14 | Visual-workspace-and-audit-engine | — | Not started (scheduled with the application UI). |

Note: the assignment named E09/E10 `…-engine`; the actual repositories are `Editorial-and-Story-Development` and
`Media-Production`. Older engine manifests reference `github.com/neophilism/…` URLs; new work uses the organization URLs.

## Working entry points (PAM)

```sh
npm ci
npm run engines:link        # development: symlink sibling checkouts into ./engines (or `engines:install` at pinned revisions)
npm run migrate             # needs DATABASE_URL; prints which engines are ready
npm run bootstrap-admin     # needs PAM_ADMIN_LOGIN, PAM_ADMIN_PASSWORD, PAM_ORG_NAME, IDENTITY_KEY_ENCRYPTION_KEY
npm start                   # http://127.0.0.1:8080 — gateway /api/e/<engine>/v1/..., app routes /api/app/v1/...
```

Required env for a local run: `DATABASE_URL`, `IDENTITY_KEY_ENCRYPTION_KEY` (≥32 chars), `EVIDENCE_MASTER_KEY` (32 bytes
base64), and either `CLAMAV_DATABASE_DIR` or the explicit `EVIDENCE_SCAN_POLICY=structural_only`.

## Executed tests (this environment: Node 24.22.2, PostgreSQL 16.15)

- PAM `npm run check`: 12 pass. Composed smoke test (clean database): bootstrap admin → login → purpose-scoped token →
  evidence accept through the gateway → worker scan/release → health → invalid token refused (401).
- Engine results as listed in the table; each engine's `docs/ENGINE_API.md` states what ran on real PostgreSQL and tools.

## Environment facts for the next session

- Node 24 is not on PATH by default: `export PATH=/opt/node24/bin:$PATH` (install from nodejs.org if the container is new).
- PostgreSQL 16: `service postgresql start`; role `pam`/`pam` superuser for tests.
- Installed for processing/production: tesseract (eng, spa, ukr), fluidsynth + FluidR3_GM soundfont, espeak-ng, clamav
  (no signature DB reachable), exiftool, rsvg-convert, sox, poppler, ffmpeg, pandoc, libreoffice.
- Docker daemon is not available. Model CDNs (huggingface etc.) are blocked; npm and PyPI are reachable.
- Per-engine worker instructions: `WORKER_BRIEF.md` (kept in this repository under `docs/`).

## Known defects / risks

- Engines' vendored `DomainError` classes differ per copy; PAM unifies the check at load time (`unifyDomainError`).
- No model provider key is configured; agent reasoning will run through deterministic planners unless one is supplied.
- `engines.lock.json` revisions are still null (development uses `engines:link`); pin with `npm run engines:pin` at release.

## External blockers

- Live verification of mail, payment, OIDC, S3 and model providers needs credentials that are not present.
- Hosted deployment has not been attempted.

## Next concrete action

1. Let E06, E07, E08, E12 finish; then run E02, E03, E04, then E09, E10 (at most four workers at a time; each costs ~300k tokens).
2. PAM: per-engine factories in `src/app/compose.ts` for each finished engine; workflow actions in `src/app/registry.ts`
   driving acceptance test A (intake → evidence → processing → knowledge → investigation → package → legal-support draft).
3. E14 + browser UI (`web/`), then acceptance tests A–F with retained evidence; pin engine revisions; open one PR per repository.
