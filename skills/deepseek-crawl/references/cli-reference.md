# DeepSeek Crawl CLI Reference

Use this reference when the Skill needs exact command selection, bounds, output
behavior, or error handling.

## Initialization

```text
deepseek-crawl init
  [--skip-auth]
  [--skip-skills]
  [--project, -p]
  [--agent, -a <agents,codex,claude-code,cursor,all>]
  [--copy]
  [--force]
  [--json]
```

`init` is the recommended first-run setup. It performs these steps in order:

1. Reuse an environment or stored API key.
2. Prompt for and store a key only when credentials are missing and
   `--skip-auth` is absent.
3. Install or update the bundled Skill unless `--skip-skills` is present.
4. Run a non-billable `doctor` check.

Defaults:

- Scope: global `~/.agents/skills/deepseek-crawl`.
- Mode: symlink. Use `--copy` for transient installs such as `npx`.
- Existing symlink to the same source: unchanged.
- Existing conflicting destination: error unless `--force`.
- Exit `0` only when the doctor check passes; `1` for setup or diagnostic
  failure; `2` for invalid options.

`--project`, `--agent`, `--copy`, and `--force` cannot be combined with
`--skip-skills`. `init` never enables `doctor --live` and never makes a billable
DeepSeek request.

`--json` emits one object:

```json
{
  "version": 1,
  "ok": true,
  "auth": {
    "configured": true,
    "source": "environment",
    "changed": false,
    "skipped": false
  },
  "skills": {},
  "doctor": {}
}
```

When `--skip-skills` is used, `skills` is `{ "skipped": true }`.

## Prerequisite Check

```bash
deepseek-crawl doctor --json
deepseek-crawl --version
```

`doctor` does not make a billable request. Never print `DEEPSEEK_API_KEY`.

Credentials:

- `DEEPSEEK_API_KEY`, or a key stored by `deepseek-crawl init` / `auth set`
- `deepseek-crawl auth set [deepseek|firecrawl|gateway]`
- `deepseek-crawl auth status [credential] --json`
- `deepseek-crawl auth remove [credential] --json`

Optional environment:

- `DEEPSEEK_BASE_URL`
- `DEEPSEEK_TIMEOUT_MS`
- `DEEPSEEK_MAX_RETRIES`
- `DEEPSEEK_CACHE_DIR`
- `FIRECRAWL_API_KEY` and `FIRECRAWL_UPSTREAM_URL` for the optional gateway

## Balance

```text
deepseek-crawl balance
  [--json]
  [--output, -o <path>]
```

Reads the authenticated DeepSeek account balance from `/user/balance`. The
request is non-billable and does not call Search or Fetch.

Human output lists each currency with total, granted, and topped-up balances.
`--json` emits one stable object:

```json
{
  "version": 1,
  "provider": "deepseek",
  "available": true,
  "balances": [
    {
      "currency": "CNY",
      "total": "110.00",
      "granted": "10.00",
      "topped_up": "100.00"
    }
  ]
}
```

Balances are sorted by currency. `available` reflects DeepSeek's
`is_available` field. Use this command when a user or workflow explicitly asks
to route by DeepSeek availability; it does not choose a provider.

## Firecrawl-Compatible Gateway

```text
deepseek-crawl gateway
  [--remote]
  [--host <host>]
  [--port <1..65535>]

deepseek-crawl gateway url
  [--port <1..65535>]

deepseek-crawl gateway status
  [--json]
```

Starts a Firecrawl v2-compatible HTTP service. It is not started by ordinary CLI
or MCP commands.

Defaults:

- Host: `127.0.0.1`
- Local port: starts at `8787` and automatically tries subsequent free ports
- Explicit `--port`: strict fixed port
- Remote mode: fixed `8787` unless `--port` is supplied
- Upstream: `FIRECRAWL_UPSTREAM_URL` or `https://api.firecrawl.dev`

Use `auth set firecrawl` to make Firecrawl-first local mode available; otherwise
common routes use DeepSeek. Remote mode requires `auth set gateway`, or the
equivalent environment variables in non-interactive deployments. Set the
Firecrawl SDK `apiKey` to the gateway token. The gateway removes that incoming
Authorization value before requesting Firecrawl and uses its stored Firecrawl
credential.

The gateway supports these common routes:

```text
POST   /v2/search
POST   /v2/scrape
POST   /v2/map
POST   /v2/crawl
GET    /v2/crawl/:id
GET    /v2/crawl/:id/errors
DELETE /v2/crawl/:id
```

It first uses Firecrawl and switches to DeepSeek when Firecrawl returns `402`,
the local exhausted-credit cooldown is active, or no Firecrawl credential is
available. `429`, authentication errors, invalid requests, and `5xx` are returned
without provider switching.

Firecrawl connection failures and timeouts before a response return
`502 upstream_unavailable`; the gateway does not switch providers.

Only DeepSeek-equivalent common options are supported on fallback. Markdown is
the supported Scrape/Search/Crawl output format; browser actions, screenshots,
structured Extract, external-link Crawl, and subdomain Crawl are rejected.
DeepSeek Crawl IDs use the `dsc_` prefix and remain process-local for 24 hours.
Firecrawl-owned Crawl IDs continue to use the Firecrawl upstream.

Client setup:

```bash
export FIRECRAWL_API_URL="$(deepseek-crawl gateway url)"
```

`gateway url` succeeds with exactly one healthy instance. If multiple instances
exist, pass `--port`. `gateway status --json` lists all healthy instances and
removes stale PID/state entries. It also reports nonsecret credential readiness
for `deepseek`, `firecrawl`, and `gateway_auth`. Instance JSON uses
`started_at`.

`GET /healthz` is unauthenticated and returns only status, version, PID, and
local/remote mode. It never returns provider keys or user content.

Every response includes `x-request-id`. CLI request logs are one JSON object on
stderr with normalized route, status, duration, provider, and fallback reason.
API keys, request bodies, query strings, and full target URLs are excluded.
Authentication failures and request concurrency are bounded.

WebSocket `Watcher` is unsupported and returns `426 websocket_not_supported`.
Use polling Crawl status methods or the SDK convenience Crawl method.

The gateway process does not read `FIRECRAWL_API_URL`. Set
`FIRECRAWL_UPSTREAM_URL` only when the Firecrawl upstream is not
`https://api.firecrawl.dev`. `--allow-remote` remains a compatibility alias for
`--remote`.
Upstream responses are streamed. SIGINT/close cancels active process-local
DeepSeek Crawl jobs.

## Escalation

```text
No URL → Search → Fetch selected URL(s)
Known site, unknown page → Map --search → Batch Fetch selected URL(s)
Known docs section requiring many pages → Crawl Plan → bounded Crawl or Batch Fetch
```

## Search

```text
deepseek-crawl search <query>
  [--count <1..50>]
  [--content]
  [--max-content-chars <0..1000000>]
  [--ori-question <text>]
  [--localization <ip>]
  [--json]
  [--output, -o <path>]
```

Defaults:

- count: `10`
- content: `false`
- human content limit: `4,000` code points per result
- JSON without an explicit limit preserves API content

Use `--content` when the result content is likely sufficient for the task.

## Fetch

```text
deepseek-crawl fetch <url>
  [--max-chars <0..1000000>]
  [--cache-ttl <1..31536000>]
  [--fresh]
  [--json]
  [--output, -o <path>]
```

Defaults:

- human content limit: `30,000` code points
- `-o` without `--json` writes Markdown
- `-o` with `--json` writes structured JSON

### Batch Fetch

```text
deepseek-crawl fetch --input <path|->
  --output-dir <dir>
  [--job-dir <dir>]
  [--concurrency <1..5>]
  [--delay-ms <0..5000>]
  [--max-chars <0..1000000>]
  [--cache-ttl <1..31536000>]
  [--fresh]
  [--json]

deepseek-crawl fetch resume <job-dir>
  [--cache-ttl <1..31536000>]
  [--fresh]
  [--json]

deepseek-crawl fetch status <job-dir> [--json]

deepseek-crawl fetch --retry-failed <fetch.json>
  --output-dir <dir>
  [--concurrency <1..5>]
  [--delay-ms <0..5000>]
  [--max-chars <0..1000000>]
  [--cache-ttl <1..31536000>]
  [--fresh]
  [--json]
```

Defaults:

- concurrency: `3`
- delay: `250 ms`
- max chars: `0`

With `--job-dir`, the initial command requires absent, disjoint job and final
output directories. The job persists normalized URLs and settings, appends each
successful page or failure to a recovery journal, and compacts state on
interruption or completion. `resume` runs only pending normalized URLs and
publishes the final output atomically after all pending URLs are attempted.
Recorded failures are not retried by `resume`; use Batch Retry after the final
report exists. `status` does not require credentials.

Recovery is at-least-once. A crash after DeepSeek returns but before the local
page or journal commit may cause resume to request that page again. Local report
and page consistency is preserved, but billing is not exactly-once.

Input formats:

- Map result JSON containing `urls`.
- JSON string arrays.
- JSON arrays of objects containing `url`.
- Newline-separated URLs.
- `-` for stdin.

The output directory must be new. It contains `fetch.json` and
`pages/NNNN-slug.md`. Partial failures remain successful; an all-failed batch
publishes the report and exits `1`.

Retry mode reads an existing `fetch.json`, retries only its failed URLs, and
preserves each available original index and previous failure under `retry_of`.
Invalid or unsupported failures are listed in `retry_of.skipped`. The retry
output directory must be new. Duplicate failures are counted in
`retry_of.deduplicated`.

### Fetch Cache

```text
deepseek-crawl fetch <url> --cache-ttl <seconds> [--fresh]
deepseek-crawl cache clear [--json]
```

The cache is disabled unless `--cache-ttl` is supplied. TTL is 1 to
31,536,000 seconds. Only successful Fetch responses are stored.
`--fresh` bypasses a hit, calls the API, and refreshes the entry.

Default locations:

- macOS: `~/Library/Caches/deepseek-crawl`
- `$XDG_CACHE_HOME/deepseek-crawl`
- `~/.cache/deepseek-crawl`
- Override: `DEEPSEEK_CACHE_DIR`

The directory is `0700`; entry files are `0600`. Cache read/write failures do
not fail the web request and increment `cache_errors`.

Cache hits bypass the API delay scheduler. Only cache misses are throttled by
`--delay-ms` and network concurrency.

## Map

```text
deepseek-crawl map <url>
  [--search <text>]
  [--limit <1..1000>]
  [--json]
  [--output, -o <path>]
```

Defaults:

- limit: `500`

Search matching is case-insensitive against the normalized URL. With
`--search`, every returned URL must match and the seed is not forced into the
result. No matches are a successful empty result.

Without `--search`, the seed URL is always retained and the remaining URLs are
selected lexicographically up to the limit.

Map output contains:

```json
{
  "version": 1,
  "seed_url": "https://example.com/",
  "generated_at": "2026-11-13T12:00:00.000Z",
  "limit": 100,
  "search": "docs",
  "total": 2,
  "truncated": false,
  "urls": [
    {
      "url": "https://example.com/docs",
      "sources": ["sitemap"]
    }
  ],
  "warnings": []
}
```

The `search` field is omitted when no filter is used.

## Crawl

```text
deepseek-crawl crawl <url>
  [--max-depth <0..5>]
  [--max-pages <1..100>]
  [--concurrency <1..5>]
  [--delay-ms <0..5000>]
  [--include-paths <patterns>]
  [--exclude-paths <patterns>]
  [--ignore-query-parameters]
  [--sitemap <include|only|skip>]
  [--plan-only]
  [--cache-ttl <1..31536000>]
  [--fresh]
  [--baseline <crawl.json|dir>]
  [--changed-only]
  [--job-dir <dir>]
  --output, -o <dir>
  [--json]

deepseek-crawl crawl --retry-failed <crawl.json>
  --output, -o <dir>
  [--cache-ttl <1..31536000>]
  [--fresh]
  [--json]

deepseek-crawl crawl resume <job-dir>
  --output, -o <dir>
  [--cache-ttl <1..31536000>]
  [--fresh]
  [--json]

deepseek-crawl crawl status <job-dir> [--json]

deepseek-crawl crawl monitor <url>
  --monitor-dir <dir>
  --output, -o <runs-dir>
  [--max-depth <0..5>]
  [--max-pages <1..100>]
  [--concurrency <1..5>]
  [--delay-ms <0..5000>]
  [--include-paths <patterns>]
  [--exclude-paths <patterns>]
  [--ignore-query-parameters]
  [--sitemap <include|only|skip>]
  [--cache-ttl <1..31536000>]
  [--fresh]
  [--fail-on-change]
  [--only-modified]
  [--ignore-removed]
  [--json]

deepseek-crawl crawl monitor status <monitor-dir> [--json]
deepseek-crawl crawl monitor reset <monitor-dir> [--json]
```

Defaults:

- depth: `2`
- pages: `20`
- concurrency: `2`
- delay: `250 ms`
- Sitemap mode: `include`

The seed is depth `0`. CLI Crawl merges same-origin Sitemap URLs with Markdown
links from DeepSeek Fetch, remains inside the exact origin, processes
deterministic depth layers, and records partial page failures.

Crawl reports use schema v2. Baselines require version 2 with complete page
metadata; version 1 reports are rejected without migration support.

Sitemap modes:

- `include`: merge Sitemap URLs and seed-page Markdown links.
- `only`: ignore Markdown links and use Sitemap URLs only.
- `skip`: use Markdown links only, preserving `0.6.0` behavior.

Sitemap URLs are enqueued at depth `1` and obey origin, path, query, depth,
page, and discovery limits. Sitemap failures are warnings; seed failure is
fatal. MCP Crawl does not expose Sitemap options and remains Markdown-only.

### Crawl Plan

Add `--plan-only` to preview the initial depth-1 frontier without fetching any
discovered child page:

```bash
deepseek-crawl crawl <url> \
  --plan-only \
  --max-depth 1 \
  --max-pages 20 \
  --include-paths "/docs/*" \
  -o plan.json
```

In this mode, `--output` is a new JSON file path, not a directory. The plan
reads the seed page and Sitemap, so the seed request remains billable. An
existing output path is rejected before the seed request is made.

The plan contains:

- `urls`: selected child URLs; this array is valid Batch Fetch input.
- `deferred`: eligible URLs omitted by the page limit.
- `filtered`: URLs omitted by `cross_origin`, `path_filtered`, or
  `discovery_limit`.
- `stats`: candidate, eligible, selected, deferred, filtered, and planned page
  counts.
- `warnings` and `diagnostics_truncated`.

Link-dense plans retain at most the discovery limit plus 1,000 diagnostic
candidates. When `diagnostics_truncated` is true, stats describe the retained
window rather than a complete inventory.

Plan covers the initial frontier only. Deeper pages require fetching the
selected child pages.

### Incremental Crawl

```bash
deepseek-crawl crawl <url> \
  --baseline previous/crawl.json \
  --changed-only \
  --cache-ttl 3600 \
  -o changes
```

The baseline can be a schema v2 `crawl.json` or its containing Crawl directory.
It must contain version 2 complete page metadata and valid SHA-256
`content_hash` values. Version 1 reports are rejected.

`content_hash` covers the raw DeepSeek Markdown before local truncation.
`--changed-only` requires `--baseline` and writes only added or modified pages.
All fetched pages remain in the report:

- added/modified pages have `written: true` and `path`.
- unchanged pages have `written: false` and no `path`.
- `changes.removed` lists baseline URLs absent from the current discovery scope.
- `stats.added`, `modified`, `unchanged`, and `removed` provide counts.

With `--changed-only`, CLI Crawl may skip DeepSeek Fetch for a deepest-frontier
Sitemap page when its valid `lastmod` exactly matches the value stored by the
baseline. The baseline content hash and page summary are reused, the page remains
unchanged in the report, and `stats.sitemap_lastmod_skipped` reports the count.

Pages with newer, older, missing, or invalid `lastmod` values are fetched.
Intermediate pages are always fetched because their body can reveal deeper
links. Sitemap `skip` mode and individual pages without `sitemap_lastmod` do not
use this optimization.

### Change Monitor

Change Monitor is a one-shot incremental Crawl workflow with persistent state.
It does not start a daemon:

```bash
deepseek-crawl crawl monitor "https://example.com/docs/" \
  --monitor-dir .deepseek-crawl/monitor/example-docs \
  --max-depth 1 \
  --max-pages 20 \
  --include-paths "/docs/*" \
  --cache-ttl 3600 \
  --fail-on-change \
  -o .deepseek-crawl/monitor/example-docs-runs \
  --json
```

Schedule the same one-shot command with cron, CI, a system timer, or Agent
Automation. The state directory contains `state.json` and a transient
`writer.lock`. Monitor state uses schema v2; version 1 state must be reset.

Behavior:

- The first successful run creates the baseline and reports no change.
- Later runs compare with the persisted baseline and write a new timestamped
  directory below the runs directory; an existing report is never overwritten.
- The report is published before `state.json` rotates atomically.
- Failed or unvisited pages keep their previous known hash instead of being
  treated as removed.
- Only one process may write a monitor directory. A stale PID lock is
  recoverable.
- The first run fixes the seed and crawl scope in `state.json`. Later runs reuse
  depth, page limit, concurrency, delay, filters, query handling, and Sitemap
  mode. Use `reset` before intentionally changing scope.

Trigger semantics:

- Default: added, modified, or removed pages count as changes.
- `--ignore-removed`: removed pages are counted in `changes.removed` but do not
  satisfy the trigger.
- `--only-modified`: only modified pages satisfy the trigger and only modified
  pages are written. Added pages remain in the report and baseline.
- `--fail-on-change`: exit `3` after publishing the report and rotating state
  when the effective trigger condition is met. No trigger or the first baseline
  run exits `0`.

Inspect and reset:

```bash
deepseek-crawl crawl monitor status monitor-dir --json
deepseek-crawl crawl monitor reset monitor-dir --json
```

`status` is read-only. `reset` requires the writer lock and deletes only
`state.json`; the next normal Monitor run creates a new baseline. Monitor is
CLI-only and has no MCP equivalent.

### Resumable Crawl Jobs

Supply `--job-dir <new-dir>` on a normal Crawl to enable durable checkpoints.
The job directory contains:

```text
job.json
pages/
writer.lock
```

`job.json` uses schema v2 and is checkpointed after seed discovery and after each
page. It records the crawl options, counters, seen URLs, source provenance,
frontier, active layer, pages, failures, warnings, and next index. Version 1 jobs
are rejected.

Resume:

```bash
deepseek-crawl crawl resume job-dir -o final-output --cache-ttl 3600
```

Resume does not reread the seed page or Sitemap. It continues only unfinished
URLs in the active layer and publishes the final output atomically. A completed
job can be resumed to retry publication.

Status without taking the writer lock:

```bash
deepseek-crawl crawl status job-dir --json
```

Only one writer may own a job. Stale `writer.lock` files whose PID is gone are
recovered automatically. Invalid, incomplete, or incompatible job state fails
explicitly. `--job-dir` is not currently combinable with Plan, Retry, baseline,
or changed-only modes.

### Crawl Retry

Crawl retry reads settings from an existing `crawl.json` and retries only its
failed pages:

```bash
deepseek-crawl crawl --retry-failed crawl.json -o retry-output --json
```

- The seed and successful pages are not requested again.
- Retry requests remain same-origin and within the original depth limit.
- Original `index`, `depth`, `sources`, and failure reason are retained.
- The original `max_pages` bounds the number of retry requests.
- Duplicate failed URLs are counted in `retry_of.deduplicated`.
- Invalid, cross-origin, depth-exceeding, or over-limit failures are listed in
  `retry_of.skipped`; `retry_of.truncated` reports the page-limit case.
- `--concurrency`, `--delay-ms`, filters, Sitemap mode, and plan mode cannot be
  combined with `--retry-failed`.

Path filters match the URL pathname. Prefix matching is used without `*` or `?`;
includes are ORed, excludes win, and the seed bypasses filters.
`--ignore-query-parameters` strips query strings before deduplication and Fetch.

Output:

```text
<dir>/
  crawl.json
  pages/
    0001-page.md
```

Read `crawl.json` first. It contains page paths, failures, settings, stats,
Sitemap mode/candidate metadata, per-page discovery `sources`, and `warnings`,
but not duplicate page bodies.

## Output Rules

- Quote URLs in shell commands.
- Prefer `--json` for automation and `-o` for reusable results.
- New Map files and Crawl directories are never overwritten.
- Search and Fetch `-o` use the existing compatible overwrite behavior.
- Map warnings go to stderr and are retained in JSON. Crawl warnings are shown
  in human summary output and retained in `crawl.json`.
- Use bounded file reads such as `jq`, `head`, `rg`, and `wc`.

## Hard Limits

| Resource            | Limit                 |
| ------------------- | --------------------- |
| Fetch response body | 8 MiB                 |
| Batch CLI input     | 8 MiB                 |
| Batch Fetch URLs    | 10,000                |
| Fetch cache TTL     | 31,536,000 seconds    |
| Fetch cache entry   | 16 MiB                |
| Crawl page content  | 1,000,000 code points |
| Crawl discovery CLI | 10,000 URLs           |
| Map candidates      | 10,000 URLs           |
| Sitemap documents   | 10                    |
| Sitemap response    | 5 MiB                 |
| Sitemap redirects   | 3, same-origin        |
| Gateway request     | 8 MiB                 |
| Gateway timeout     | 120 seconds           |
| Gateway Crawl job   | 24 hours, in process  |

## Exit and Cancellation

- `0`: success, including partial Crawl results with at least one successful
  page.
- `1`: runtime, configuration, network, or output failure.
- `2`: CLI usage error.
- `130`: SIGINT cancellation after cleanup.

`SIGINT` stops a running gateway and closes its listener.

## Common Setup Failures

- `deepseek-crawl: command not found` — install/build the local CLI and put it on
  `PATH`.
- `DEEPSEEK_API_KEY is required` — configure the environment; never pass the key
  as a CLI flag.
- Sitemap warnings — Map may still succeed from seed-page links, and CLI Crawl
  may still succeed from whichever discovery source is available.
- Private/reserved Sitemap target — Map rejects direct network access to
  non-public addresses.
- Map or Crawl billing warning — reduce `--limit`, `--max-pages`, or depth before
  retrying.
