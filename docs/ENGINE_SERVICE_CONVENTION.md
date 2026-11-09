# Engine service convention (v1)

Active development convention for all fifteen engines. It supersedes the foundation-only freeze and the
per-task PR sequence; product requirements, acceptance criteria, engine boundaries and security rules are unchanged.

## 1. Shape of every engine

Every engine keeps its existing code and adds one uniform **service layer**:

| Piece | Location | Contract |
|---|---|---|
| Kit | `src/service-kit.ts` | Byte-identical copy of `Identity-Authorization-and-Policy-Engine/src/service-kit.ts` (sha256 recorded in `docs/ENGINE_API.md`). Never edit the copy; request kit changes from the integrator. `src/contracts.ts` must be the Identity version too (already vendored in most engines). |
| Entry | `src/engine/index.ts`, package export `./engine` | `manifest`, `SCHEMA`, `migrations`, `migrate(sql)`, `createEngine(deps)`, `routes(engine)` |
| Server | `src/engine/serve.ts`, npm script `serve`, export `./serve` | Reads env, runs migrations, serves HTTP, runs the engine's job worker loop |
| Docs | `docs/ENGINE_API.md` | Every service method, HTTP route, event, capability, port, env var, tool dependency; honest implemented/tested status |
| Tests | `tests/engine*.test.ts` | Real PostgreSQL via `withDisposableDatabase(pg, process.env.TEST_DATABASE_URL, …)`; skipped visibly when unset |

```ts
export const SCHEMA = 'e05_evidence';                       // eNN_<short>, owned exclusively by this engine
export const manifest: EngineManifestV1;
export const migrations: readonly Migration[];              // use {s} for the schema name
export function migrate(sql: Sql): Promise<string[]>;       // runMigrations(sql, SCHEMA, migrations)
export function createEngine(deps: { sql: Sql; objects?: ObjectStore; ports?: {...}; config?: {...} }): XEngine; // implements StandardEngine
export function routes(engine: XEngine): Route[];           // [...standardRoutes(engine), ...own '/v1/...' routes]
```

Rules:

- **Runtime**: Node 24, strict TypeScript, ESM, erasable syntax only, `.ts` relative imports. Runtime dependency `pg` (pin `8.23.1`);
  add other mature dependencies only where they replace real work (mail, PDF, etc.) and pin exact versions.
- **Data ownership**: one PostgreSQL schema per engine. Never read or write another engine's schema. Reference other engines'
  objects only by universal reference string (`uref`): `E05:evidence_version:<id>@<rev>`.
- **Tenancy**: every table row carries `tenant_id` (organization) and `project_id`; every query filters on both from
  `ServiceContext`. A foreign or compartment-hidden object is indistinguishable from a missing one (`not_found`), including in
  search, counts, exports, job results, caches and object keys (object keys start with `<tenantId>/<projectId>/`).
- **Authorization**: every service method takes `ctx: ServiceContext` first and calls `requireCapability(ctx, '<engine>:<action>')`
  before any read or write. Fail closed. Capabilities are narrow: read ≠ write ≠ disclose-identity ≠ contact ≠ publish ≠ spend.
  Re-check (via `AuthorizationPort` when supplied) immediately before sensitive side effects and inside workers.
- **Untrusted data**: uploaded files, retrieved pages, inbound mail and model output are data. They never supply capabilities,
  recipients, objectives, URLs to fetch with credentials, or shell arguments. Subprocesses are spawned with argument arrays,
  timeouts and size limits, never through a shell.
- **Writes**: one transaction per command (`sql.tx`), containing the state change, `appendAudit`, `emitEvent` and any `enqueueJob`.
  Mutating commands accept `idempotencyKey` and use `idempotent(...)`. History is append-only: corrections create revisions;
  nothing approved or cited is silently rewritten.
- **Work**: long or external work runs as kit jobs (`enqueueJob` / `runJobsOnce`): at-least-once, idempotent handlers,
  lease fencing, retries with dead-lettering, pause/cancel honoured before each side effect. External side effects whose outcome
  is unknown are recorded as `uncertain` and reconciled, never blindly repeated.
- **Standard surface**: implement `StandardEngine` — `inspect`, `search`, `audit`, `events` (service capability
  `<engine>:events`), `applyUpstreamChange`, `health`. `applyUpstreamChange` marks dependents stale/blocked (never deletes or
  rewrites), is idempotent by `eventId`, emits this engine's own `*.stale` / `*.blocked` events with the affected urefs, and
  returns them. Stale/blocked state must be visible in `inspect` with reasons.
- **Ports**: declare needed collaborators as `deps.ports` using kit port types (`EvidencePort`, `UseDecisionPort`,
  `AuthorizationPort`, `BudgetPort`) or engine-defined interfaces. The engine must work standalone with ports absent where that
  is safe, and must **deny** (not skip) when a port is required for a protective decision and is absent — unless config
  explicitly selects a documented standalone mode.
- **Honesty in state**: distinguish discovered/acquired/failed, queued/running/done/uncertain, verified/attributed/inferred.
  Never fabricate results, citations, delivery, review, or progress. A missing tool or credential yields an explicit
  `unavailable` state naming what is missing.
- **Country neutrality**: no country-specific institutions, sources, templates or names in source or fixtures. Fixtures are
  fictional (`example.org`, invented names).

## 2. Events and correction propagation

Engines emit outbox events `<domain>.<past-tense>` with `subject` = uref and a small JSON payload (ids, not content).
PAM's event router reads each engine's `events()` feed and delivers `UpstreamChange` to dependents:

```
E05/E06 source corrected ─▶ E07 claims stale ─▶ E08 findings stale ─▶ E09 passages/scenes stale ─▶ E10 renders stale ─▶ E12 approvals invalid
E11 permission withdrawn ─▶ E06/E09/E10 blocked for future use, E12 releases need follow-up
```

Each engine stores `sources: string[]` (urefs) on dependent objects so `applyUpstreamChange({refs})` can find them with
`urefMatches`. Engines emit, at minimum, `<thing>.stale` / `<thing>.blocked` events carrying `{ reason, cause: eventId }`.

## 3. Workspace

- Clones: `/home/user/<repo-name-lowercase>`; branch `feature/pam-completion`; commit often, push at checkpoints
  (`git push -u origin feature/pam-completion`).
- Node 24: `export PATH=/opt/node24/bin:$PATH` in every shell command.
- PostgreSQL 16: `TEST_DATABASE_URL=postgresql://pam:pam@127.0.0.1:5432/postgres` (tests create and drop their own databases).
- `npm run check` must stay green, including existing tests. Add `TEST_DATABASE_URL` + a `postgres` service to CI.
- Cross-repo dependency URLs must use the `Justice-For-All-Movement` organization.

## 4. Reporting states

Report separately: implemented · locally tested · integration tested · verified against a real configured provider ·
deployed and checked in a hosted environment. A controlled transport is test infrastructure, not live-provider proof.
