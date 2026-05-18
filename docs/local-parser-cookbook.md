# Local Parser Cookbook

Local parsers let `scan.mjs` read SSR or static career pages without asking an agent to browse the page. The parser runs as a local command, prints normalized jobs JSON to stdout, and lets the scanner keep using the same title filtering, deduplication, and pipeline output flow.

## When To Use This

Use `scan_method: local_parser` when a company career page has stable HTML, a documented endpoint, or another deterministic source that is easier to parse locally than with Playwright. The parser can be written in JavaScript, Python, shell, Go, or any executable available on the user's machine. `career-ops` does not bundle company-specific parser scripts; users bring their own script and point `portals.yml` at it.

## Portal Configuration

Most local parsers are company-specific: the script already knows the source URL, selectors, endpoint quirks, pagination, and normalization rules. In that common case, the scanner only needs to know which command to run:

```yaml
- name: Example Company
  careers_url: https://example.com/careers
  scan_method: local_parser
  parser:
    command: node
    script: scripts/parsers/example-company-jobs.js
    format: jobs-json-v1
  enabled: true
```

`args` are optional. Use them in whatever way helps the parser author: to make one script reusable across multiple companies, pass `{careers_url}` or `{company}`, enable a debug flag, store a JSON snapshot, or control any other script-specific behavior. `scan.mjs` executes the parser without shell interpolation and expands `{careers_url}` and `{company}` in parser arguments before execution.

## Token comparison benchmark

Reproduce and refresh these numbers:

```bash
npm install
npx playwright install chromium
npm run test:scan-tokens
```

Script: `test-scan-token-comparison.mjs`. Tokenizer: [`tiktoken`](https://github.com/openai/tiktoken) `cl100k_base` (proxy for Claude/GPT-class models).

### What is measured

| Arm | Simulates | `scan.mjs` LLM tokens |
|-----|-----------|----------------------:|
| `local_parser` | Fixture Python parsers (`cohere_jobs.py`, `mobileye_nuxt_jobs.py`) | **0** |
| `playwright_nivel_1` | Agent `browser_snapshot` equivalent (`document.body.innerText`) | Simulated input tokens |
| `api_nivel_2` | Agent WebFetch of full Ashby JSON (Cohere only) | Simulated input tokens |
| `websearch_nivel_3` | Sample SERP blob (`test/fixtures/websearch-nivel3-sample.txt`) | Simulated input tokens |
| `agent_total_simulated` | Sum of niveles 1+2+3 (additive agent path **without** local parser) | Sum of simulated tokens |

**Simulated** = payload size the model would see if that nivel ran in `/career-ops scan`. It is not billed API usage unless you actually run an agent.

### Results (2026-05-18)

Environment: career-ops `test/fixtures/parsers/`, live network, WSL2.

#### Cohere (`jobs.ashbyhq.com/cohere`)

| Method | Jobs | Input tokens | LLM in loop | Notes |
|--------|-----:|-------------:|:-----------:|-------|
| `local_parser` | 71 | 0 | no | 368,938 chars stdout; 86,458 tokens if pasted into a prompt |
| `playwright_nivel_1` | ~0* | 3,924 | simulated | 17,593 chars visible body text |
| `api_nivel_2` | 128 | 387,707 | simulated | 1,643,436 chars full Ashby API JSON (includes descriptions) |
| `websearch_nivel_3` | n/a | 212 | simulated | Fixture SERP snippets |
| **`agent_total_simulated`** | — | **391,843** | simulated | Sum niveles 1+2+3 |

\*Playwright job-link count is approximate on Ashby SPAs; token count is the reliable metric.

#### Mobileye (`careers.mobileye.com/jobs`)

| Method | Jobs | Input tokens | LLM in loop | Notes |
|--------|-----:|-------------:|:-----------:|-------|
| `local_parser` | 96 | 0 | no | 21,806 chars stdout; 7,092 tokens if pasted |
| `playwright_nivel_1` | ~364* | 50,978 | simulated | 275,806 chars visible body text |
| `api_nivel_2` | — | — | — | No public API in fixture config |
| `websearch_nivel_3` | — | — | — | Not run (no fixture for Mobileye) |
| **`agent_total_simulated`** | — | **50,978** | simulated | Playwright only |

#### Savings summary

| Company | Parser jobs | Agent-simulated tokens | Parser stdout if pasted† | Tokens avoided vs agent path |
|---------|------------:|-----------------------:|-------------------------:|-----------------------------:|
| Cohere | 71 | 391,843 | 86,458 | **391,843** (~100%) |
| Mobileye | 96 | 50,978 | 7,092 | **50,978** (~100%) |

†`scan.mjs` does **not** send parser stdout to an LLM; this column shows cost only if you pasted the JSON into chat manually.

### How to read these results

1. **Local parser = 0 LLM tokens during scan.** `scan.mjs` runs Python locally and parses stdout; no model in the loop.
2. **Cohere API arm is the largest simulated cost** (~388k tokens) because the benchmark tokenizes the **entire** Ashby API response, including long `descriptionPlain` fields. An agent that WebFetchs the same URL would pay a similar context cost. Playwright visible text alone is much smaller (~4k tokens).
3. **Job counts differ by arm.** Cohere parser filters to Engineering/R&D departments (71 jobs); Ashby API returns all board jobs (128); Mobileye parser filters R&D/Engineering + IL/EU/Remote (96). Compare token **efficiency** (tokens per relevant job), not raw job totals.
4. **Mobileye** has no nivel 2 API in this setup; agent discovery without a parser is dominated by Playwright (~51k tokens) on a large Nuxt SSR page.
5. With `modes/scan.md` rules (`local_parser_ok`), a successful parser run should **skip** Playwright and API for that company in agent scan, so real agent cost should approach **0**, not `agent_total_simulated`.

### Earlier heuristic example (Cohere only)

Before the automated benchmark, a manual comparison used `characters / 4` on rendered page text:

| Mode | Jobs surfaced | LLM tokens (search) | Basis |
|------|---------------:|--------------------:|-------|
| Browser scrape | 129 URLs | ~4,382 | 17,526 chars / 4 |
| Local parser | 71 (filtered scope) | **0** | subprocess + stdout JSON |

The automated benchmark replaces the hand estimate with `tiktoken` and adds Mobileye plus per-nivel breakdown.

## Stdout Contract

The parser must print one of these JSON shapes to stdout:

```json
[
  { "title": "Senior AI Engineer", "url": "https://example.com/jobs/123", "location": "Remote" }
]
```

```json
{
  "jobs": [
    { "title": "Senior AI Engineer", "url": "https://example.com/jobs/123", "location": "Remote" }
  ]
}
```

```json
{
  "results": [
    { "title": "Senior AI Engineer", "url": "https://example.com/jobs/123", "location": "Remote" }
  ]
}
```

`title` and `url` are required. `company` is optional; when omitted, the scanner uses the `tracked_companies` entry name. Relative URLs are resolved against `careers_url`.

## Artifact Storage

The scanner only needs stdout. If a parser also writes full JSON snapshots for debugging or audit, store them under `data/parser-output/{company}/`. Generated JSON artifacts must stay out of git; `.gitkeep` placeholders are the only committed exception for preserving directory structure.

## Failure Handling

Local parsers run before ATS API detection. If a local parser fails and the company has a detectable Greenhouse, Ashby, or Lever API source, `scan.mjs` records the parser failure and falls back to the API path for that company instead of dropping it from the scan.

## Test fixtures

Integration tests use parsers under `test/fixtures/parsers/`:

- `cohere_jobs.py` - Ashby public API (Cohere board)
- `mobileye_nuxt_jobs.py` - Nuxt `__NUXT_DATA__` SSR extraction (adapted from `companies-analysis-base`)

Run: `npm run test:local-parser` or `CAREER_OPS_PORTALS=test/fixtures/portals-local-parsers.yml node scan.mjs --dry-run`

Token tables: see [Token comparison benchmark](#token-comparison-benchmark) above.

## Agent scan (`/career-ops scan`)

`scan.mjs` already uses one provider per company (local parser only, no duplicate API pass). In full agent scan mode (`modes/scan.md`), when Nivel 0 succeeds for a company, the agent must **skip** Playwright (Nivel 1) and API (Nivel 2) for that company, and filter Nivel 3 WebSearch hits that match the same company. General portal queries (`site:jobs.ashbyhq.com`, role keywords) still run for discovery of other employers.
