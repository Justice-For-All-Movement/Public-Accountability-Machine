# Continuation record

Single source of truth for where the completion assignment stands. Update at every checkpoint.

_Last updated: 2026-11-18 (session 4: records across sources)._

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
- **Added (see docs/COVERAGE.md "Added in session 2")**: model-backed agent actions (claims with exact quotations, research questions, inquiry drafts, quoted
  answers; editorial model port) — proposals only, `unavailable` without `ANTHROPIC_API_KEY`, adapter tested against a
  controlled local server only. Identity refresh-token rotation with reuse detection; the browser client rotates on every
  session restore. Worker housekeeping for host-delegated duties (E13 licence-expiry notices).

## Session 3 (2026-11-15): PR triage, re-pin, engine features

- **Engine PR backlog** resolved: DDM-010 inventory contracts closed (stale `neophilism/*` identity, CI dependency outside
  the organization); boardroom legacy hardening merged (E04, E06, E12, E13); intake SI-35..39 drafts ported onto main
  (intake #54) and closed; knowledge correction-impact PostgreSQL contention tests finished and merged.
- **E05 main CI** had failed deterministically: `ubuntu-latest` became 26.04 (no `postgresql-client-16`; pg_dump 18 writes
  `SET transaction_timeout`, rejected by PostgreSQL 16 on restore). Engines and PAM CI now pin `ubuntu-24.04` and assert
  the client version.
- **New engine features** (each with tests, in `docs/ENGINE_API.md`): E05 opt-in scheduled disposal execution; E04
  page-level robots enforcement; E03 `sanitizedHtml`; E13 reservation commit/release only by the reserver or
  `resources:admin`.
- **PAM**: `engines.lock.json` moved to those mains (evidence, discovery, correspondence, intake, knowledge, processing,
  release, resources). The correspondence screen loads a message's `sanitizedHtml` on demand and never renders the
  original HTML (before, thread messages carried no HTML, so nothing was shown); every sandboxed frame now carries a
  no-network CSP (sandbox="" alone blocked scripts but not remote images). No PAM screen exposes E05 retention/disposal.
- **Local evidence on the new pins** (Node 24, PostgreSQL 16.15, CI tool set): `npm run check` 16/16; acceptance A–E 5/5;
  browser tests 7/7 incl. a new sanitized-HTML assertion. The hosted services were not redeployed in this session.

## Session 4 (2026-11-18): records across sources

Purpose: an investigation in which many sources list the same people under different spellings, scripts and calendars
(guide: `docs/RECORDS_ACROSS_SOURCES.md`). Research engines only; no media-generation work.

- **E07** record linkage on branch `feature/cross-source-linkage` (PR #45): record proposals, bulk review, candidate
  matches, identity-decision batches, roster, incidents and calendar conversion. Tested in `tests/engine-linkage.test.ts`.
- **E06** Arabic-script and Hebrew language profiles on branch `feature/arabic-script-languages` (PR #22).
- **PAM**: `agent.extract_records`, the **Records across sources** screen, acceptance **F**, the fix for the Knowledge
  proposals panel, `tokens_in` budget estimates for model actions, and an `OCR_LANGUAGES` build argument in the Dockerfile.
- `engines.lock.json` is re-pinned to the E07 merge commit (993e688) and the E06 merge commit (8057d6d) after CI passed on both. With those pins: `npm run check` 16/16 against PostgreSQL 16, acceptance A–F 6/6, browser 7/7.
- Local environment for this session: Node 24 at `/opt/node24/bin`; PostgreSQL 16; tools installed with apt (exiftool,
  fluidsynth, espeak-ng, sox, rsvg, imagemagick, libreoffice, apertium, tesseract fas/ara/osd). Playwright 1.63.0 installed
  `--no-save` and driving the system Chrome (`/usr/bin/google-chrome`) through a preload script, because the Playwright CDN
  is blocked here.

## Session 5 (2026-11-19): research record standard

The owner made the research record standard binding for the platform (`docs/RESEARCH_RECORD_STANDARD.md`): PAM is a
historical research platform whose record must survive hostile dispute. Implemented in `src/app/research.ts`:
tool register (exact source in E05, SHA-256), research runs (purpose, tools, command, environment, build, UTC times,
exit, outcome, output in E05, automatic entry in the project's research log — an E08 investigation opened on first use),
the write journal (every authenticated gateway write, accepted or refused, with the engine's request id), gateway
enforcement (`PAM_RESEARCH_RECORD=enforce` by default: a write from outside the web application needs an open run in
`x-pam-run`, else 428; identity exempt), automatic runs for every orchestration action, append-only triggers, the
Research record screen and `scripts/research-run.mjs`. Evidence: acceptance G; acceptance A–F and browser tests pass with
it on. Local note: `engines/correspondence` needs `npm ci` in its checkout after a fresh clone (sanitize-html).

## Environment facts for the next session

- Node 24 is not on PATH by default: `export PATH=/opt/node24/bin:$PATH` (install from nodejs.org if the container is new).
- PostgreSQL 16: `service postgresql start`; role `pam`/`pam` superuser for tests.
- Tools installed natively: tesseract (eng, spa, ukr), fluidsynth + FluidR3_GM, espeak-ng, clamav (no signature DB
  reachable), exiftool, rsvg-convert, sox, poppler, ffmpeg, pandoc, libreoffice, apertium eng-spa, pocketsphinx.
- No Docker daemon. Model CDNs blocked; npm and PyPI reachable. Render workspace and Neon org reachable but EMPTY; nothing
  was created there.
- Worker instructions used for engines: `docs/WORKER_BRIEF.md`.

- **Merged**: every repository's `feature/pam-completion` was fast-forwarded into `main` (editorial and production got a
  `main` branch; their GitHub default branch still names `feature/pam-completion`, which holds the same commit, and is
  changed in each repository's settings) after CI passed on every head. The Render services deploy from `main`.

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
   provider verification (mail, OIDC, payments, Anthropic API key for model-backed agents).
2. Redeploy the hosted services from the new PAM main and intake `b1f099f` (operator action).
3. Remaining engine "not implemented" items (each engine's `docs/ENGINE_API.md`), e.g. E14 `projection.lagged` /
   `alert.raised` (needs a decision on what a projection is versus PAM's "Needs attention" alerts).
