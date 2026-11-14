# Continuation record

Single source of truth for where the completion assignment stands. Update at every checkpoint.

_Last updated: 2026-11-14 (session 2)._

## State

All fifteen engines have service layers on branch `feature/pam-completion`, pinned in `engines.lock.json`. PAM composes
them (`src/app/compose.ts`), routes correction/withdrawal events (`src/app/router.ts`), bridges the separate intake
application (`src/app/intake.ts`), runs agent actions (`src/app/registry.ts`, model-backed ones in `src/app/agents.ts`)
and serves the browser application (`web/`). Requirement-level status: `docs/COVERAGE.md`. Installation: `docs/INSTALL.md`.

Evidence (session 2):

- **CI**: PAM's GitHub workflow now installs the pinned engines, builds intake and runs `npm run check`, acceptance A–E
  and the browser tests; a skipped test fails the job. Green on the pinned revisions. Engine CI green on every pinned head
  (identity, intake, knowledge, investigation, workspace re-checked after this session's changes).
- **Hosted (private, free tier)**: Render web services `pam` (Docker, this repository) and `intake-pam` (intake
  repository) on Neon PostgreSQL 16 (project `divine-recipe-12567945`: databases `neondb` for PAM, `intake` for E02).
  Both report ready; all fourteen PAM components available; intake linked to PAM's organization through a service
  credential (`PAM_INTAKE_LINKS`). A scripted smoke test against the hosted application passed: sign-in, organization and
  project directory, purpose token, evidence upload with matching SHA-256, listing, sign-out. Secrets live only in the
  Render service settings.
- **Merged**: `main` was ahead of the completion branch in knowledge (52 commits), investigation (45) and workspace (34);
  merged, full checks pass (283, 150, 257 tests).
- **Added**: model-backed agent actions (claims with exact quotations, research questions, inquiry drafts, quoted
  answers; editorial model port) — proposals only, `unavailable` without `ANTHROPIC_API_KEY`, adapter tested against a
  controlled local server only. Identity refresh-token rotation with reuse detection; the browser client rotates on every
  session restore. Worker housekeeping for host-delegated duties (E13 licence-expiry notices).

## Environment facts for the next session

- Node 24 is not on PATH by default: `export PATH=/opt/node24/bin:$PATH` (install from nodejs.org if the container is new).
- PostgreSQL 16: `service postgresql start`; role `pam`/`pam` superuser for tests.
- Tools installed natively: tesseract (eng, spa, ukr), fluidsynth + FluidR3_GM, espeak-ng, clamav (no signature DB
  reachable), exiftool, rsvg-convert, sox, poppler, ffmpeg, pandoc, libreoffice, apertium eng-spa, pocketsphinx.
- No Docker daemon. Model CDNs blocked; npm and PyPI reachable. Render workspace and Neon org reachable but EMPTY; nothing
  was created there.
- Worker instructions used for engines: `docs/WORKER_BRIEF.md`.

## Known defects / limits (see also each engine's docs/ENGINE_API.md "Not implemented")

- Hosted free tier: no persistent disk (objects stored under `/data` are lost on redeploy; use `OBJECT_STORE=s3` or a paid
  disk), and intake runs with `MALWARE_SCANNER_DRIVER=none`, so participant uploads stay quarantined. Render does not
  auto-deploy pushes to this branch: deploy explicitly.
- No live external provider verified (mail, OIDC, S3, Stripe, ASR/translation/generation, the Anthropic API, webhooks).
- Acceptance E asserts every record is acquired within one run after a crash; under heavy machine load a request can time
  out, which the discovery engine correctly records as failed with a scheduled retry, failing that strict assertion.
- Audience vocabulary must be shared between consent (E11) and release (E12) deployments.

## Next concrete actions

1. Owner decisions: paid disk or S3 storage and a malware scanner for the hosted deployment; credentials for live
   provider verification (mail, OIDC, payments, Anthropic API key for model-backed agents); merge of the
   `feature/pam-completion` branches into `main`.
2. Remaining engine "not implemented" items (each engine's `docs/ENGINE_API.md`).
