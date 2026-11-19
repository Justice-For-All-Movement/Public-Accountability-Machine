# Hezar Nafar Poshteshe: A Thousand Stand Behind Them — research record

This folder is for anyone joining the research. It explains how the list of people killed in the events of Dey 1404
(December 2025 – January 2026) is being built, and where every decision is recorded. It holds **no personal data**:
the data, evidence and decisions live in PAM itself (project `hezar-nafar-poshteshe`).

## Where the record of decisions is

| What | Where in PAM | Notes |
| --- | --- | --- |
| **Research log** (every step, method, rule, failure and correction, in order) | Investigations → "Hezar Nafar Poshteshe … list research and decision log" (investigation engine, attempts log) | Append-only. A correction is a new entry naming what it corrects. Start here. |
| Original sources, unchanged (official XLS and PDF, captured web pages) | Evidence storage (E05), with hashes and capture provenance | Official spreadsheet: `E05:evidence_version:dd536b0f-7c8f-4469-a1cb-8ecc9abb30b3@1`; PDF: `E05:evidence_version:877caa8a-fd3c-40ed-a8f9-1c06afac03b7@1` |
| One record per person per source, with the claim it makes and a quote of the source | Knowledge engine (E07), cases `hezar-official-list`, `hezar-shohadayeghiam`, … | Every record says *what that source states*; none is marked verified by import. |
| Same-person decisions between sources | Knowledge engine entity matches (same / different / unresolved) | Each has its own written rationale and full revision history. |
| Who accepted what, when | Audit trail of each engine | Proposals record the agent or script; acceptances record the person. |

## Rules adopted so far (details and reasons are in the research log)

1. **The government list is an allegation, not ground truth.** It is the starting point because it is the state's own admission. Its count (2,986 announced, 2,985 rows) is recorded as published.
2. **National ID digits are never copied** out of the preserved original spreadsheet — not into records, logs, publications or this repository.
3. **Every source is labelled for what it is.** shohadayeghiam.info is an opposition-run memorial site (MEK-style language): a partisan secondary source, used for what it states, never as confirmation on its own.
4. **Names are kept exactly as each source writes them.** Only encoding variants of the *same* letter are treated as equal when comparing (Arabic-keyboard ي/ك vs Persian ی/ک, zero-width non-joiner vs space, diacritics). Genuine spelling variants (عبداله / عبدالله) are never treated as equal automatically.
5. **Linking two records as the same person:**
   - identical full name, occurring exactly once on each list → linked, but *provisional* (name only), and the rationale says so;
   - same name apart from spacing → linked only if the first-name/surname boundary falls in the same place on both lists (a correction made after review: “Bob MacDowell” is not “Bob Mac Dowell”);
   - near spellings → never linked; recorded as *unresolved* until a second fact (place, age, date, father’s name, photo) agrees;
   - any later conflicting fact reopens a link.
6. **Contact with people** (later stage) is diaspora-first; nobody inside Iran is contacted unless they have spoken publicly or reach out themselves; every message is approved by the project lead before it is sent.

## Methods (scripts in `methods/`)

The scripts that produced each step, so a step can be re-run and checked. They call a running PAM through its gateway
(`pam.mjs`); sign-in details and API keys are read from files in `HEZAR_WORKDIR` and are never stored here.

| Script | Step |
| --- | --- |
| `step1-source.mjs`, `capture-list.mjs` | Register a discovery source and capture pages/files into evidence |
| `xls_rows.py` | Read the official spreadsheet (header asserted; ID column reduced to a yes/no flag) |
| `step3-import.mjs`, `step4-accept.mjs` | One person record per official row, then acceptance |
| `parse_shq.py`, `import-source.mjs` | Parse memorial-site list cards (exact card text kept for quoting) and import them as records |
| `matches.mjs` | Knowledge-engine match suggestions (found too loose to decide on; see log) |
| `exact_match.py` | Name normalisation and identical-name matching (rule 5) |
| `roster-dump.mjs`, `record-matches.mjs` | Map matches to record ids and record decisions with rationale |
| `open-log.mjs`, `backfill-log.mjs` | Open the research log and the entries for the steps taken before the log existed |

New steps add an entry to the research log as they run (`logStep` in `pam.mjs`).
