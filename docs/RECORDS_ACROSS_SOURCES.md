# Records across sources

This guide covers investigations in which many independent sources each list the same people (or other entities). The
sources might be rights groups' lists, official lists, news bulletins or family statements. They spell the names
differently, write them in different scripts and calendars, and disagree about ages, dates and places. The goal is a
roster in which every person is a group of source records joined only by human decisions. Every value keeps its source,
and every disagreement stays visible.

The workflow uses engines E04 (acquisition), E05 (preservation), E06 (processing), E07 (knowledge: record linkage) and
E00 (agents). It reaches families or their representatives through E03 (correspondence), E11 (consent) and E02 (intake).
Nothing in this guide is specific to a country. The deployment supplies its own sources, attribute names and forms.

## 1. Acquire and preserve each source

Configure each source in **Discovery** (E04): an index page, a listing, a feed or a single document. Run a collection,
and every acquired item is preserved in E05 with its digest and custody. A file obtained some other way, such as a PDF
report or a spreadsheet, is uploaded under **Evidence** with its origin noted. Acquisition does not give permission to
republish (E04 rule). A copy of one report published by several outlets is still one source; record it as a source
family in E07.

## 2. Process

Run `processing.process_evidence` on each preserved version, either as a task or from **Evidence**. Text-layer PDFs,
HTML and plain text are extracted directly. Scanned pages are read by OCR. For non-Latin scripts, install the
deployment's OCR language data (`OCR_LANGUAGES`, for example `"eng fas ara"`, at image build time; see the Dockerfile).
In OCR `auto` mode, E06 then reads each page with the installed languages that match the script it detects.

## 3. Extract one record per mention (agent task)

Create an objective under **Objectives & agents**, and start a run with one `agent.extract_records` task per processed
source:

```json
{ "key": "extract-list-1", "action": "agent.extract_records",
  "input": { "evidenceRef": "E05:evidence_version:…@1", "caseId": "roster-1", "entityType": "person",
             "attributes": [ { "key": "age", "description": "age in years", "kind": "number" },
                             { "key": "placeOfDeath", "description": "place where the person died", "kind": "text" },
                             { "key": "dateOfDeath", "description": "date of death", "kind": "date" },
                             { "key": "hometown", "description": "home town", "kind": "text" } ] } }
```

- A long document is split into windows of whole segments. Each window becomes its own task with one model answer.
- The model must quote the document for the name, for every attribute and for its one-sentence statement. A name,
  attribute or statement whose quotation is not found verbatim in the preserved text is dropped, and the drop is counted
  in the task output.
- Dates: the model reports a date as written in the source's calendar. PAM converts it with E07 `convertDate`, using the
  ICU calendars of the runtime, so no model does the conversion. The record keeps `<key>` (Gregorian `YYYY-MM-DD`),
  `<key>Stated` (the stated form) and, when the source's weekday disagrees with its date or the date is impossible,
  `<key>Issue`.
- The output is a set of **record proposals** in E07 (one per mention). Nothing becomes a record until a person accepts it.

The action needs `ANTHROPIC_API_KEY` and a token budget (`tokens_in`) assigned to the executing identity in
**Resources**.

## 4. Review in "Records across sources"

The **Records across sources** screen (E07 record linkage) has these parts:

1. **Record proposals**: read each name, its attributes and its quotations, then accept or reject. You can accept
   everything shown in one action, which accepts up to 500 proposals, each in its own transaction.
2. **Candidate matches**: pairs of records whose written names are similar across spellings, hyphenation, parenthesised
   alternative names and scripts. Each pair lists the attributes that agree and the attributes that differ. Record
   **Same**, **Different** or **Unresolved** for each pair; the similarity number decides nothing. Very common name parts
   (frequent given names) are not used to find candidates, and the screen lists them.
3. **Roster**: one row per person group, with every written name, every stated value and its records, the
   disagreements, any missing expected attributes, and any unresolved matches. Open **Show sources** to see each record's
   claim and evidence. The roster never chooses between disagreeing values.
4. **Incidents**: groups that share a place and a day. Use them as research leads, for example to find people who may
   have died in the same event. They are not findings.
5. **Date conversion** for a single date.

Disagreements are resolved by research, not by choosing a value. To resolve one, add evidence, record a contradiction or
an assessment on the claims, or ask the people who know (see below).

## 5. Families and representatives

- Draft inquiries with `agent.draft_inquiry`. A draft is never sent without a human or an explicit grant (E03 rules),
  and every inquiry discloses who is asking and why.
- Publish a participant form (E02) in the families' language. Form definitions carry translations, and a translation
  that declares `direction: "rtl"` renders right to left. Participants may stay pseudonymous.
- Record what each family agrees to: purpose, audience, territory and time (E11). Withdrawal blocks every downstream use.
- Mark the identity of a person at risk as **protected** in E07 (`protectedIdentity`, with an identity compartment). Their
  name and quotations are then withheld from everyone without the disclosure capability, including in proposals,
  suggestions and the roster.

## API (gateway `/api/e/knowledge/v1/...`)

`POST /proposals/records`, `POST /proposal-reviews`, `POST /entity-match-suggestions`, `POST /entity-match-batches`,
`POST /roster`, `POST /incidents`, `POST /dates/convert`. The E07 `docs/ENGINE_API.md` section "Record linkage across
sources" is the reference.

## Limits

- Name comparison is a consonant-skeleton method with configurable romanization equivalences (`KNOWLEDGE_NAME_EQUIVALENCES`).
  Different romanizations of the same sound outside the configured table, such as an English exonym against a
  transliteration, may score below the threshold. Lower `minSimilarity` to see more candidates.
- Incidents group by exact folded place text and day. Two spellings of one place are separate until the place values
  are made consistent.
- Extraction quality depends on the model, and nothing in this workflow verifies a death or its circumstances. Accepted
  records are unassessed claims about what each source states.
