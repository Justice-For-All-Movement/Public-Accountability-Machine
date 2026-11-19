# Software and services used

What was running when each step was taken, so a step can be repeated on the same software.

## PAM (where the data and decisions live)

| Period (UTC, 2026-11-19) | Hosted PAM commit | Notes |
| --- | --- | --- |
| until 20:49 | `8ba44c2` | Project `hezar-nafar-poshteshe` created at 20:45 |
| 20:54 – 21:42 | `c7a480d` | All list capture, import and cross-source linking |
| from 21:42 | `431ebcc` and later | Adds only this research folder; see the Render deploy history for later commits |

- Hosting: Render (free plan), service `pam`; database: Neon PostgreSQL; evidence bytes: Neon S3-compatible storage.
- Engine versions: the exact commit of each engine is pinned in [`engines.lock.json`](../../engines.lock.json) at the PAM commit above.
- Engines used so far: discovery (E04) for capture and search; evidence storage (E05) for preserved originals and run records; knowledge (E07) for person records, claims and same-person decisions; investigation (E08) for the research log; identity (E01) for sign-in and access tokens.

## Local tools that ran the scripts in `methods/`

| Tool | Version |
| --- | --- |
| Node.js | 22.23.4 (built-in `fetch`; through the proxy with `NODE_USE_ENV_PROXY=1`) |
| Python | 3.13.18 |
| xlrd (reads the official `.xls`) | 2.0.1 |
| Python standard library only otherwise | `difflib` (near-spelling ratio), `unicodedata` (NFC), `re`, `json` |

No browser automation or third-party scraper was used so far. Web pages and files were fetched by PAM's discovery
engine (plain HTTP GET, robots.txt honoured, each response stored unchanged in evidence storage with its hash) and
parsed afterwards from the stored copies by the scripts here (`parse_shq.py` for the memorial-site list pages).

## External services

| Service | Use | Status |
| --- | --- | --- |
| Brave Search API (free tier, about 1,000 queries per month) | Per-person web search through a discovery search source | Working |
| Google Programmable Search (engine `a4769869d71934dc5`, whole web) | Second search source | Refused (HTTP 403) until the Custom Search API is enabled on the key's project |
| Internet Archive | Wayback lookup and capture | Keys configured; not used yet |
| Anthropic API | Model-backed extraction agents in PAM | Configured; no model output has been accepted into the list yet |

## Re-running a step

1. Set `HEZAR_WORKDIR` to a folder holding `pam-admin.txt` (sign-in for a PAM administrator) and, for search, `search-keys.json`. Neither is in this repository.
2. Point `BASE` in `methods/pam.mjs` at the PAM instance.
3. Run the step through the recorder, so the run is logged like every other: `node methods/run.mjs "<why>" methods/<script> [args…]`.
