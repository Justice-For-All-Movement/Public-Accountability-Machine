# Public Accountability Machine

Autonomous, human-supervised investigation, accountability and multimedia-production platform. This repository holds the
orchestration engine (E00) and the integrated application that coordinates fourteen independent engines (E01–E14).

**Status: under active completion — not yet a finished product.** See [docs/CONTINUATION.md](docs/CONTINUATION.md) for exactly
what works, what has been tested and what remains. Nothing here is deployed, and no live provider has been verified.

## What exists today

- `src/orchestration/` — E00: objectives, directives, workflow definitions, task graphs with dependencies, persistent agents
  with project-scoped memory, runs, checkpoints, leases, retries, pause/resume/cancel/reassign, policy-gated proposals,
  budget reservation and crash recovery that marks unknown side effects `uncertain` instead of repeating them.
- `src/service-kit.ts` — the shared engine service kit (vendored from the Identity engine).
- `docs/ENGINE_SERVICE_CONVENTION.md` — the convention all engines follow.
- The original fifteen-engine design, 122-task backlog and requirements, retained byte-for-byte under `docs/approved-design/`.

## Using the application

`npm start` serves the browser application at `http://127.0.0.1:8080` (plain ES modules and CSS in `web/`, no build
step; the workspace component library is served from `engines/workspace/web/`). Sign in with an account created by
`npm run bootstrap-admin` or by an administrator, then choose the organization and project at the top of the page.

- Each screen obtains an access token for exactly one purpose (shown under the screen title) and re-issues it when it
  expires. The refresh token lives in memory and `sessionStorage` only; **Sign out** ends the session on the server.
- Any universal reference (`E05:evidence_version:…`) is a link that opens the inspector drawer: linked sources and
  dependents (graph, table or text), the object's details and the controls your role may use there.
- Screens: Overview, Objectives & agents, Intake & cases, Evidence, Investigations, Knowledge, Correspondence,
  Editorial, Production, Rights, Release, Discovery, Resources, Audit, Administration, plus global search.
- A screen whose engine is not running shows **Disconnected**; one your role or purpose does not allow shows
  **Not found or not permitted**. Nothing is shown as done, sent or available before the engine says so.
- Intake is a separate application: set `PAM_INTAKE_PUBLIC_URL` to link its staff UI and participant form.
- First run for a new organization: **Administration → Run provisioning**.

Browser tests: `TEST_DATABASE_URL=… npm run test:browser` (real PostgreSQL, engines from `./engines`, pre-installed
Playwright Chromium; axe-core from the workspace engine).

## Check

```sh
npm ci
TEST_DATABASE_URL=postgresql://USER:PASS@127.0.0.1:5432/postgres npm run check
```

Tests that need PostgreSQL create and drop their own databases; without `TEST_DATABASE_URL` they are reported as skipped.

## Read next

- [Architecture](docs/ARCHITECTURE.md)
- [Continuation record](docs/CONTINUATION.md)
- [Engine service convention](docs/ENGINE_SERVICE_CONVENTION.md)
- [Foundation checkpoint (historical)](docs/FOUNDATION_CHECKPOINT.md)
- [Dependency inventory](config/foundation.json)
- [Application work registry](registry/prs.json)
- [Original approved design](docs/approved-design/engine_catalog.json)
- [Original suite backlog](docs/approved-design/development_backlog.json)
- [Recovery provenance](docs/approved-design/provenance.json)
- [Contributor instructions](AGENTS.md)

