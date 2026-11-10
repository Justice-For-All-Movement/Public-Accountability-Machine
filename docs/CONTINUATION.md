# Continuation record

Single source of truth for where the completion assignment stands. Update at every checkpoint.

_Last updated: 2026-11-10 (end of session 1)._

## State

All fifteen engines have service layers on branch `feature/pam-completion`, pinned in `engines.lock.json`. PAM composes
them (`src/app/compose.ts`), routes correction/withdrawal events between them (`src/app/router.ts`), bridges the separate
intake application (`src/app/intake.ts`), runs agent actions (`src/app/registry.ts`) and serves the browser application
(`web/`). Acceptance tests A–E pass on the composed application from a clean clone at the pinned revisions.
Requirement-level status: `docs/COVERAGE.md`. Installation: `docs/INSTALL.md`.

| Engine | Repository (`Justice-For-All-Movement/…`) | Pinned commit |
|---|---|---|
| E00 | Public-Accountability-Machine | branch head |
| E01 | Identity-Authorization-and-Policy-Engine | see `engines.lock.json` |
| E02 | Secure-Intake-Case-Workflow-Engine | 4744348 |
| E03 | Correspondence-and-Outreach-Engine | 585d5d0 |
| E04 | Discovery-and-Acquisition-Engine | 530dbdb |
| E05 | Evidence-Storage-and-Provenance-Engine | 0764e4d |
| E06 | Document-and-Media-Processing-Engine | 3d0f4fb |
| E07 | Knowledge-and-verification-engine | ad3617e |
| E08 | Factual-investigation-engine | 5951942 |
| E09 | Editorial-and-Story-Development (was empty) | 0639821 |
| E10 | Media-Production (was empty) | 9d5b3cb |
| E11 | Consent-rights-and-use-decisions-engine | 9f6e8e1 |
| E12 | Packaging-release-and-correction-engine | 0a58ff4 |
| E13 | Resources-and-commercial-operations-engine | ed35585 |
| E14 | Visual-workspace-and-audit-engine | 27f2a14 |

## Environment facts for the next session

- Node 24 is not on PATH by default: `export PATH=/opt/node24/bin:$PATH` (install from nodejs.org if the container is new).
- PostgreSQL 16: `service postgresql start`; role `pam`/`pam` superuser for tests.
- Tools installed natively: tesseract (eng, spa, ukr), fluidsynth + FluidR3_GM, espeak-ng, clamav (no signature DB
  reachable), exiftool, rsvg-convert, sox, poppler, ffmpeg, pandoc, libreoffice, apertium eng-spa, pocketsphinx.
- No Docker daemon. Model CDNs blocked; npm and PyPI reachable. Render workspace and Neon org reachable but EMPTY; nothing
  was created there.
- Worker instructions used for engines: `docs/WORKER_BRIEF.md`.

## Known defects / limits (see also each engine's docs/ENGINE_API.md "Not implemented")

- No live external provider verified (mail, OIDC, S3, Stripe, ASR/translation/generation, webhooks).
- Not deployed; `render.yaml`/`Dockerfile` unapplied/unbuilt.
- No model provider configured: agent actions are deterministic engine operations; model-proposed work is supported
  (proposals) but no model adapter was exercised.
- Audience vocabulary must be shared between consent (E11) and release (E12) deployments.
- Several engine CI workflows have not yet run on GitHub.

## Next concrete actions

1. Open one pull request per repository from `feature/pam-completion` (none opened yet; owner decides on merge).
2. Owner decisions/credentials: hosted deployment authorization; mail/OIDC/S3/payment credentials for live verification;
   ClamAV signature source; private jurisdiction packs, source catalogs and the reviewed comparison-country lane.
3. Build and test the Dockerfile where a Docker daemon exists; run engine CI on GitHub.
