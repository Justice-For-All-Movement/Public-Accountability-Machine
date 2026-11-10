# Worker brief — finishing one accountability engine

You are completing ONE engine of the Public Accountability Machine (PAM) suite. Another worker owns every other engine;
an integrator owns PAM (E00), the kit and cross-engine wiring. Stay inside your repository.

## Read first (in this order, then start coding)
1. `/home/user/public-accountability-machine/docs/ENGINE_SERVICE_CONVENTION.md` — binding convention.
2. `/home/user/identity-authorization-and-policy-engine/src/service-kit.ts` and `src/contracts.ts` — the kit you vendor
   byte-identically (`cp`; kit sha256 `95475a907267ba1fdd54b557aabe5645c37add9788a5b2d0854d9accfd5d8ea5`). Its test
   (`tests/service-kit.test.ts`) shows usage. Never edit your copy. If the kit lacks something, build it in your engine and
   mention it in your final report.
3. Your catalog entry: `/tmp/claude-0/-home-user/6c69afcf-0f21-58b4-b92f-3a60f1dff6f9/scratchpad/catalog_<EID>.json`
   (purpose, owns, api, events, limits, acceptance) and, if useful, your tasks in
   `/home/user/public-accountability-machine/docs/approved-design/development_backlog.json` (grep your engine id; keep
   the acceptance criteria, ignore the old per-task PR sequence).
4. Your repository's README, AGENTS.md, `src/`, and a skim of unmerged remote branches
   (`git ls-remote --heads origin`; `git fetch --depth 1 origin <branch>` only if a branch looks like it holds needed work).
   Preserve useful existing code and reuse it inside the service layer where it fits. Do not delete meaningful tests.

## Fixed names
| Engine | short name (capability prefix) | schema |
|---|---|---|
| E00 PAM orchestration | `orchestration` | `e00_orchestration` |
| E01 Identity | `identity` | `e01_identity` |
| E02 Intake | `intake` | own application database |
| E03 Correspondence | `correspondence` | `e03_correspondence` |
| E04 Discovery | `discovery` | `e04_discovery` |
| E05 Evidence | `evidence` | `e05_evidence` |
| E06 Processing | `processing` | `e06_processing` |
| E07 Knowledge | `knowledge` | `e07_knowledge` |
| E08 Investigation | `investigation` | `e08_investigation` |
| E09 Editorial | `editorial` | `e09_editorial` |
| E10 Production | `production` | `e10_production` |
| E11 Consent | `consent` | `e11_consent` |
| E12 Release | `release` | `e12_release` |
| E13 Resources | `resources` | `e13_resources` |
| E14 Workspace | `workspace` | `e14_workspace` |

Capabilities are `<short>:<action>`. Actions named `disclose_identity, contact, send, publish, approve, spend, grant, admin,
export, withdraw, events` are sensitive: the kit never grants them through `<short>:*`, so use exactly those action names for
operations of that nature (e.g. `release:publish`, `correspondence:send`, `evidence:export`, `knowledge:approve`).
Universal refs: `uref('E05','evidence_version', id, revision)`.

## What "done" means for your engine
- The substantive responsibilities in your assignment are implemented as real, persisted behaviour behind
  `createEngine(...)` — not state-machine sketches, canned results or fakes presented as functionality.
- HTTP API (`routes`) covers the service; `npm run serve` starts a usable standalone server
  (env: `DATABASE_URL`, `PORT`, `IDENTITY_PUBLIC_KEYS` = JSON map kid→PEM or `IDENTITY_JWKS_FILE`, `OBJECT_STORE*`, engine-specific).
- Tests run against real PostgreSQL (and real tools/files/sockets where the behaviour depends on them), cover the acceptance
  criteria in your catalog entry and assignment, tenant isolation (second tenant sees nothing through any method, search,
  count, export, job result or object key), fail-closed authorization, idempotent replay, and stale/blocked propagation.
- `docs/ENGINE_API.md` documents the full surface accurately, including what is NOT implemented or not verified.
- `npm run check` is green with `TEST_DATABASE_URL` set; CI workflow gets a postgres service and `TEST_DATABASE_URL`.
- `AGENTS.md` (active instructions) updated in a short section stating this completion assignment supersedes the earlier
  foundation-only / per-PR sequencing rules; historical records and results are left intact. README gets a short
  "Service layer" section (how to run, test, use). If `registry/` validation pins the old `neophilism/...` repository name
  or would fail in CI under `Justice-For-All-Movement/...`, make it accept the current repository without weakening it.
- Work is committed on branch `feature/pam-completion` and pushed (`git push -u origin feature/pam-completion`) at
  sensible checkpoints and at the end. Do not open pull requests, do not push to `main`, do not touch other repositories.

## Rules
- Shell: `export PATH=/opt/node24/bin:$PATH` in every command. Postgres:
  `TEST_DATABASE_URL=postgresql://pam:pam@127.0.0.1:5432/postgres`. Do not modify shell profiles. Other workers share this
  machine (4 CPUs): run targeted tests while iterating, the full check at checkpoints; never kill processes you did not start;
  bind test servers to port 0 / 127.0.0.1.
- Installed tools: ffmpeg/ffprobe, poppler (pdftotext, pdftoppm, pdfinfo), tesseract (eng, spa, ukr, osd), ImageMagick `convert`,
  rsvg-convert, sox, fluidsynth + `/usr/share/sounds/sf2/FluidR3_GM.sf2`, espeak-ng, exiftool, clamscan (no signature DB —
  database host is blocked), pandoc, libreoffice, zip/unzip, python3 (numpy, PIL). npm registry and PyPI are reachable;
  huggingface, model CDNs and most other hosts are blocked. Do not run `apt-get` unless your engine section says you may.
- Commit identity: `git -c user.name="Claude" -c user.email="noreply@anthropic.com" commit`. End every commit message with:
  ```
  Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_017TiySvaeBGGKdwSiK2eqTU
  ```
  Never put model identifiers elsewhere in the repository.
- Development testing never contacts real third parties, sends real mail, charges money, publishes, or uses real people's
  data. Fictional fixtures (`example.org`, invented names), controlled local servers and sandbox modes only.
- Real provider adapters must be implemented (configuration, auth, requests, error handling) even without credentials; state
  them as "implemented, not verified against a live provider". A missing credential or tool yields an explicit `unavailable`
  result at runtime, never a silent fake.
- Security: SSRF, path traversal, injection, secret leakage into logs/errors/audit, cross-tenant leakage. Agents and models
  never receive provider secrets. Do not weaken or delete tests that protect access control, privacy, integrity, consent or
  recovery. Do not claim independent security review.
- Country-neutral, deployment-configurable (languages, jurisdictions, templates, catalogs are data).
- Be efficient: inspect briefly, then implement. Prefer a few coherent modules over many tiny files. No planning documents
  beyond `docs/ENGINE_API.md`.

## Final report (your last message, ≤ 45 lines, plain facts)
1. Branch + final commit SHA (pushed? yes/no).
2. Entry points: exact import path, `createEngine` deps/ports/config, serve command + env vars.
3. Service method list as one-line TypeScript signatures (the integrator codes against this; be exact) — or point to the
   section of `docs/ENGINE_API.md` if longer than ~25 lines, giving only the most important signatures here.
4. Events emitted (type → subject kind) and `applyUpstreamChange` behaviour.
5. Commands executed and results (test counts; what ran on real Postgres/tools).
6. Not implemented / not verified / known defects — precise.
