# Requirement coverage

One record of where each original requirement (`docs/approved-design/requirements.json`) is implemented and what evidence
exists. Status words: **impl** implemented · **local** engine tests on real PostgreSQL/tools · **integ** exercised by a PAM
acceptance test on the composed application · **live** verified against a real configured external provider ·
**deployed** checked in a hosted environment. No requirement is **live** or **deployed** yet (see "Open items").

Acceptance tests (in `tests/acceptance/`): **A** intake → findings and deliverables, two-organization isolation ·
**B** research question → correspondence → verification · **C** investigation → finished creative works ·
**D** rights, private release, correction and withdrawal · **E** reliability and resource control ·
**F** records across sources (extraction with quotations and calendars → identity decisions → roster).

| Req | Implementation | Evidence | Status | Gaps / notes |
|---|---|---|---|---|
| R01 Country neutral engines | All engines; deployment data: jurisdiction packs (E12), source catalogs (E04), roles/purposes (E01), forms (E02) | fixtures fictional throughout; example pack "Example Republic" | integ (A, D) | Real deployment packs/catalogs are private data, not in source. |
| R02 Private by default; separate outbound/publish authority | E01 purposes + exact sensitive capabilities; E03 grants; E12 audiences, human accountability decision for public release | B (no send without grants), D (private review → restricted audience) | integ | Public release path tested in E12 engine tests only. |
| R03 Accessible intake | E02 public form: free, no lawyer, multilingual, drafts, pseudonymous, recovery | E02 `test:pg` (axe, keyboard); A (browser: draft, resume, upload, recovery) | integ | Validation messages beyond "required" English only; portal chrome English only. |
| R04 Thorough investigation | E08 questions, hypotheses, attempts, findings, checklist, closure guard, packages | E08 tests; A (closure blocked by open material question; package with limitations/unknowns) | integ | Interview plans and referral recommendations are records of E08 (closure guard, package, correction propagation). |
| R05 Contact discovery with provenance | E04 lead extraction with route provenance; E03 contact plans with `whyMayKnow`/`routeSource`, human route verification | A (lead from acquired page), B (plan carries route + reason) | integ | Extraction is rule-based (mailto/contact sections/JSON-LD). |
| R06 Honest autonomous outreach | E03 server-rendered structured inquiries with disclosure, role-claim rejection, grants, suppression, follow-up limits | B | integ | No live mail provider verified. |
| R07 Inbox and takeover | E03 folders, labels, search, threads, assignment, attachments; atomic takeover; in-transit visibility; PAM correspondence screen | B (takeover cancels queued send; uncertain send stays in transit); E03 tests | integ | Browser tests of the inbox screen: see UI test results. Inbound HTML: the PAM screen shows only E03's `sanitizedHtml` (allow-list) in a script-less, no-network sandbox; the original stays evidence (browser test). |
| R08 Systematic collection | E04 pagination, checkpoints, refresh, dedupe, rate limits, receipts, coverage, gaps, SSRF defence | E04 tests (crash/resume, SSRF matrix); A (controlled source); E (SIGKILL mid-collection) | integ | No JS rendering. Page-level robots (`X-Robots-Tag`, meta robots) enforced since session 3: `nofollow` pages not followed, `noarchive` items kept at metadata level (E04 tests). |
| R09 Preservation and provenance | E05 immutable versions, digests, custody chain, derivations, citations, retention, packages; intake copies keep E02 custody | E05 tests; A (intake custody carried over); E (backup/restore verify) | integ | S3 storage and official ClamAV signatures not verified. Opt-in scheduled disposal execution (`execute: true`, E05 tests) has no PAM screen; reachable through the E05 API only. |
| R10 Multimodal processing | E06 pdftotext/tesseract OCR/LibreOffice/pandoc/ffmpeg, PocketSphinx ASR, diarization, Apertium translation, corrections with history | E06 tests (real tools); A, D (processing, correction) | integ | Local ASR weak (en-US only); whisper/remote providers implemented, unverified. |
| R11 Evidence-linked knowledge | E07 entities, relationships, events, claims, statements, links, families | E07 tests; A | integ | — |
| R12 Verification and challenge | E07 four separate assessment dimensions, human-only final assessments, supporting + challenging links, contradictions, alternatives | A (agent refused; reviewer records), E07 tests | integ | No numerical scores by design. |
| R13 Persistent agents | E00 agents, project memory, leases, retries, checkpoints, budgets; E01 bounded agent tokens and grants; model-backed actions (`src/app/agents.ts`) that only propose or draft | E00 unit tests; B (agent identity without standing send authority); E (processes) | integ | Model-backed actions need `ANTHROPIC_API_KEY`; adapter tested against a controlled local server only. |
| R14 Visual audit | E14 linked graph + table + text equivalents, inspector, audit timeline, controls; PAM UI | E14 tests (Playwright/axe); PAM browser tests | integ (UI) | Accessibility tested in Chromium only, no screen reader. |
| R15 Victim-centred storytelling | E09 viewpoints with consent refs, basis labels, disclosures | C, E09 tests | integ | — |
| R16 Actual production across media | E10 written, image, music/audio, video, interactive pipelines with manifests | C (real outputs, edits, re-renders), E10 tests + pilot | integ | Sung guide is pitched synthetic speech; generative providers unverified. |
| R17 Long-term catalogue | E09 series, collections, reusable assets, translations, collaborators; E10 asset library | E09/E10 tests | local | Not exercised across a multi-year data set. |
| R18 Rights, consent, dignity | E11 purpose/audience/territory/time, multi-holder most-restrictive, no override, citation ≠ reproduction | D; E11 tests | integ | Audience names must be shared deployment vocabulary (E11 ↔ E12). |
| R19 Controlled publication | E12 candidates, leak pipeline, exact-digest approvals, destinations, receipts, distribution history | D; E12 tests | integ | Only local-directory destination exercised end to end; SFTP never executed. |
| R20 Corrections through the chain | Event router (`src/app/router.ts`) + every engine's `applyUpstreamChange` | D (correction → claim, finding, editorial approval, release approval, distribution follow-up; withdrawal blocks) | integ | — |
| R21 Commercial sustainability | E13 budgets, ledger, contributors, agreements, licences, invoices, credit notes and recorded refunds, revenue, margins, sandbox + Stripe adapters | E13 tests; C, E (budgets) | integ (budgets) / local (ledger) | Stripe unverified (no credentials). Reservations are settled only by their reserver or `resources:admin` (E13 tests). |
| R22 Distinct identities | E01 organizations, projects with kind, purposes; E09 project kinds (satire/campaign separated) | A (two organizations), E09 tests | integ | — |
| R23 Accountability materials | E12 report, chronology, evidence bundle, referral, records request, legal-support draft | A (chronology, evidence index, legal draft) | integ | Drafts never filed; no legal review claimed. |
| R24 Global operation | Locales (E02), languages (E06 OCR/translation), jurisdiction packs (E12), calendars (E02) | E02/E06/E12 tests | local | Few language packs installed. |
| R25 Balanced effort allocation | E00 lanes + measured active time → E13 lane allocation report; no outcome quotas | E13 tests; E00 overview | local | Lane policy UI present; comparison-country lane is deployment configuration. |
| R26 Reliability and recovery | Leases, retries, idempotency, outbox, backups, encryption at rest (E05), restore verification | E | integ | No hosted monitoring; no independent security review. |
| R27 Interoperability | Versioned HTTP APIs per engine, event feeds, universal refs, export packages (E05, E12, E10) | engine HTTP tests; A–D | integ | — |
| R28 Reuse intake engine | E02 consumed through its service API and event feed; Identity federation adapter | A (real intake app) | integ | Over HTTP on loopback; TLS path untested. |
| R29 Research continuity | E04 archive import (ZIP/WARC/directory) with provenance gaps; E05 gap records | E04 tests | local | No real private archive imported (by design). |
| R30 Observable autonomy and control | E00 overview, controls; E14 controls; PAM UI incl. the visibility-checked "Needs attention" panel (`/api/app/v1/alerts`) | E00 tests; E (pause/cancel across processes); browser tests | integ | — |

## Added in session 2

- E01 two-factor sign-in (TOTP, recovery codes, administrator reset) and refresh-token rotation with reuse detection;
  PAM Account security screen and one-time-code sign-in (browser test).
- E03 no-response outcome (`sweepNoResponse`, run by PAM housekeeping); E08 treats it as a closed attempt.
- E06 structured extraction proposals (dates, amounts, references, links, tables) with round-tripping selectors.
- E08 interview plans and referral recommendations. E11 withdraw-all for a holder (staff and participant).
- E13 credit notes with recorded refunds. PAM alerts ("Needs attention"), model-backed agent actions, housekeeping.

## Added in session 3

- E05 opt-in execution of scheduled disposal (`setRetention({ action: 'schedule', execute: true })`, `evidence:admin`,
  re-authorized at execution; holds and changed schedules delete nothing).
- E04 enforcement of page-level robots directives (`X-Robots-Tag`, meta robots) under the `honour` policy.
- E03 `sanitizedHtml` for inbound mail; PAM renders only it, and every PAM sandbox frame carries a no-network CSP.
- E13 reservation commit/release restricted to the reserving actor (or `resources:admin`).
- E02 hardening ported from SI-35..39 drafts (transport redirects, create-only S3 writes, envelope validation,
  undeclared answer keys, `.dockerignore`, `npm ci`). Knowledge correction-impact PostgreSQL contention tests.
- PAM CI pinned to `ubuntu-24.04` with an asserted PostgreSQL 16 client (26.04 runners ship no client 16).

## Added in session 4 (records across sources)

- E07 record linkage (`feature/cross-source-linkage`, E07 PR #45): record proposals (one entity plus its quoted claims),
  bulk human review, read-only candidate matches across spellings, scripts and romanizations (Arabic-script folding and
  transliteration; configurable equivalences), human identity decisions in batches, a roster that keeps every
  disagreeing value with its records, incident grouping by place and day, and deterministic ICU calendar conversion
  with weekday checks. Tests: E07 `tests/engine-linkage.test.ts`.
- PAM `agent.extract_records`: model-backed, one record proposal per mention, every name, attribute and statement tied to
  a verbatim quotation (others dropped and counted), dates converted by E07, long documents split into windowed tasks.
  Acceptance **F** (`tests/acceptance/f-records-across-sources.test.ts`) runs it on the composed application against a
  controlled local model server, then exercises human review, a candidate pair, the roster and incidents.
- PAM screen **Records across sources** (`web/js/screens/records.js`), covered by the browser screen test (axe, empty
  states, 320 px). The Knowledge screen's proposal panel now lists pending proposals; it had filtered on a state value
  (`proposed`) that E07 never uses, so it always showed none.
- Model-backed actions reserved budget in a unit E13 rejects (`token`); they now reserve `tokens_in`.
- E06 built-in language profiles for Arabic-script languages and Hebrew (E06 PR #22), so OCR `auto` reads Arabic-script
  pages with matching data. The container image takes `OCR_LANGUAGES` as a build argument.
- Guide: `docs/RECORDS_ACROSS_SOURCES.md`.

## Open items (honest list)

- **Live providers**: mail (SMTP/IMAP/Gmail/Graph), OIDC, S3, Stripe, ASR/translation/generation providers, webhook
  receivers — implemented, not verified (no credentials in this environment).
- **Deployment**: not deployed. Render workspace access exists but no deployment was authorized for billable resources.
- **Security**: no independent review; standalone engine servers do not all check token revocation.
- **CI**: engine CI workflows were updated; several have not yet run on GitHub.
