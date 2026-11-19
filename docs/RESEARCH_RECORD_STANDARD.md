# PAM research record standard (version 1.0)

**Binding on every person, script and AI agent that works in a PAM deployment.** Adopted by the project owner on
2026-11-19.

## Why

PAM is a historical research platform as much as a tool for current accountability. Its findings will be disputed, often
by governments and other powerful parties with every reason to discredit them, sometimes decades later, by people who
never met the researchers. That holds even in the strongest case: when a state publishes its own list of the people it
killed, the list will be relitigated, and so will every link, correction and omission made on top of it.

Research survives that only if every step can be shown: what was done, by whom, when, with which tool and which exact
version of it, on what source, for what reason, with what result, and what was tried and failed. The overhead is
deliberate.

## The rules

1. **Every tool is preserved.** Any script, scraper, parser, notebook, query or program that reads or changes a project's
   research is registered **before its first run**, with its exact source. PAM stores the source in evidence storage
   and identifies the version by its SHA-256. A changed script is a new tool version; register it again. Tools you did not
   write (a library, an external program, a model) are named with their version in the run's environment.
2. **Every execution is a research run.** A run records its purpose, the tools (by SHA-256), the exact command and
   arguments, the environment (runtime versions, settings, source and model versions), who ran it, the PAM build, UTC
   start and finish, exit status and outcome, a summary, and the **complete output**, which is stored in evidence storage.
   A run that fails or finds nothing is still finished and recorded; a failure is a finding.
3. **Every write belongs to a run or to the application.** PAM's gateway refuses a write from a script or agent that does
   not carry an open run of its own in the `x-pam-run` header (HTTP 428, `research_run_required`). Writes made in the PAM
   web application are attributed to the application and its build. Account and sign-in operations are exempt. Every
   authenticated write — accepted or refused — is entered in the project's write journal with the actor, time, engine,
   path, status, request id (the same id the engine's own audit trail carries) and run.
4. **Every decision is written down with its reason.** Methods, rules (for example, when two records count as the same
   person), source assessments, judgment calls, policies and corrections go into the project's **research log** (an
   investigation that PAM opens automatically) as entries. Each one gives the basis, the limitations and the references.
   PAM writes an entry for every run automatically; the reasoning behind a run is yours to add.
5. **Nothing is rewritten.** The tool register, the runs and the write journal are append-only in the database. A run can
   be finished only once. Log entries are append-only; a correction is a new entry naming the entry it corrects and saying
   who raised the problem. Records in the engines keep their full revision history. Superseded decisions stay visible.
6. **Sources are preserved unchanged and labelled for what they are.** Capture originals into evidence storage before
   working from them. Label each source's nature and partisanship. Record each statement as *what that source says*,
   never as verified fact because it was imported.
7. **PAM's own agents follow the same rules.** Every orchestration action, model-backed ones included, is recorded as a run
   automatically, naming the PAM build, the action and the model, with the input's hash and the output.
8. **What is private stays in PAM.** Project data, names, outputs and project-specific scripts live in the project's own
   record inside PAM, not in public repositories. Personal data that would endanger people (for example identity-number
   digits) is never copied out of the preserved original.

## How to comply (scripts and agents)

```text
POST /api/app/v1/research/tools        { name, version?, description, filename, contentBase64 }      → { sha256, evidenceRef }
POST /api/app/v1/research/runs         { purpose, tools: [sha256…], command, environment?, parentRunId? } → { id, logInvestigationId }
  … every write to /api/e/<engine>/… carries the header  x-pam-run: <id>
POST /api/app/v1/research/runs/<id>/finish { exitCode, summary, outcome?, kind?, outputBase64?, refs? } → the run, with outputRef and logAttemptId
GET  /api/app/v1/research/record       tools, runs, recent writes and counts (also the "Research record" screen)
GET  /api/app/v1/research/runs/<id>    one run and every write it made
```

`kind` is the research-log category: `search`, `acquisition`, `contact`, `processing`, `knowledge`, `verification` or
`other`. `outcome` defaults to `succeeded` for exit 0 and `failed` otherwise. A wrapper that registers the script, starts
the run, passes the run id to the script (for example as the `PAM_RUN_ID` environment variable for it to send as
`x-pam-run`), captures the output and finishes the run is the simplest way to comply. Use one for every step.

Write the reasoning (rule 4) as log entries: `POST /api/e/investigation/v1/investigations/<logInvestigationId>/attempts`
within a run, with `kind`, `target`, `method`, `outcome`, a `detail` that a stranger could follow, and `refs`.

## Deployment setting

`PAM_RESEARCH_RECORD` = `enforce` (default; required for any real deployment) · `record` (journal and runs without
refusing writes; development only) · `off` (tests of unrelated features only). The current mode is shown on the
Research record screen and returned by `/api/app/v1/research/record`, so a reader can see whether the record was
enforced. The running build is taken from `PAM_BUILD_COMMIT`, or `RENDER_GIT_COMMIT` on Render.

## What the standard does not do

- It cannot prove a person's reasoning was sound, only that it was written down and kept. Reviewers judge the reasoning.
- The `x-pam-client` header that marks the web application can be imitated by a script. Such writes are still journalled
  with the actor and time; a reviewer can see writes attributed to the application that no person made in it.
- Work done outside PAM (for example in a spreadsheet on someone's computer) is outside the record until its result is
  brought in by a run, with the file as an input preserved in evidence storage. Bring it in that way.
