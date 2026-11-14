# DeepSeek Crawl

**English** | [简体中文](README.md)

**CLI-first** web search, page reading, URL mapping, and bounded crawling for AI
agents, backed by DeepSeek's official Search and Fetch APIs.

The primary workflow is:

```text
Agent → deepseek-crawl CLI → DeepSeek APIs → files/JSON → Agent
```

The repository bundles a `deepseek-crawl` Agent Skill that teaches this
escalation:

1. `search` when no URL is known.
2. `fetch` when the URL is known.
3. `map --search` when the site is known but the page is not.
4. `crawl` only for bounded docs or section-wide reading.

This project replaces the common Firecrawl Search, Scrape, Map, and Crawl
capabilities. It is **not** a Firecrawl API or SDK compatibility layer.

MCP is optional. It remains available for clients that cannot execute the CLI,
but the CLI plus Skill is the preferred interface.

## Status

Version `0.7.0` provides:

- CLI-first Search, Fetch, Map, and Crawl.
- Sitemap-assisted Crawl by default, so traversal does not depend on links in
  the DeepSeek Markdown alone.
- A bundled Agent Skill with command routing and safe output conventions.
- Optional MCP tools for the same four operations.
- Public-network-only Sitemap access with DNS pinning and redirect validation.
- Deterministic Crawl limits, partial failure records, and atomic output.
- Built-in one-command Skill setup for the common `.agents/skills` directory or
  selected Agent-specific directories.
- CLI-managed API credentials with macOS Keychain and private file fallback.
- Batch Fetch from URL lists and Map JSON with per-page failure records.
- Crawl include/exclude paths and query-parameter deduplication.
- Crawl Plan previews the initial frontier before child pages are fetched.
- Batch Fetch and Crawl can retry only failed items from an existing report.
- Fetch, Batch, Crawl, Plan, and Retry can share an explicit-TTL local page cache.
- Fetch, Batch, and Crawl expose stable `content_hash`; Crawl can compare a baseline and write only changed pages.
- Crawl supports durable jobs, per-page checkpoints, `crawl resume`, and `crawl status`.

The project is open source under the MIT License.

## Requirements

- Node.js 22.12 or newer.
- A DeepSeek API key from <https://platform.deepseek.com/api_keys>, configured
  once with `deepseek-crawl auth set`.
- Network access to DeepSeek and, for CLI Map and Crawl, directly to the target
  Sitemap.

## Install

Install from GitHub:

```bash
npm install -g github:jsogn/deepseek-crawl
deepseek-crawl setup skills
deepseek-crawl auth set
deepseek-crawl doctor
```

After the npm release is available:

```bash
npm install -g deepseek-crawl@0.7.0
```

From this repository:

```bash
npm install
npm run build
npm link
deepseek-crawl setup skills
deepseek-crawl --version
```

`npm link` puts the local `deepseek-crawl` executable on your PATH. If you do
not want a global link, use `node /absolute/path/to/deepseek-crawl/dist/bin.js`.

## Agent Skill

The Skill is bundled in:

```text
skills/deepseek-crawl/
```

The default install uses the common Agent Skills directory:

```bash
deepseek-crawl setup skills
```

This creates:

```text
~/.agents/skills/deepseek-crawl
```

Install into the current project instead:

```bash
deepseek-crawl setup skills --project
```

Install only for selected Agents:

```bash
deepseek-crawl setup skills --agent codex
deepseek-crawl setup skills --agent claude-code,cursor
deepseek-crawl setup skills --agent all
```

Use `--copy` instead of the default absolute symlink, and `--force` only when
intentionally replacing an existing `deepseek-crawl` Skill directory. Setup
does not require a DeepSeek API key.

The universal ecosystem installer also works:

```bash
npx skills add jsogn/deepseek-crawl --skill deepseek-crawl
```

Start a new Agent session after installation so the Skill is discovered.

The Skill prefers the CLI and uses MCP only when the client requires it or the
user explicitly asks. It directs reusable output to `.deepseek-crawl/`, which is
already ignored by Git.

Recommended output convention:

```text
.deepseek-crawl/
  search-topic.json
  page-site-section.md
  map-site.json
  crawl-site-section/
```

## Prerequisite Check

```bash
deepseek-crawl doctor --json
```

This check does not make a billable DeepSeek request. Never print or pass the API
key as a command-line value.

## CLI

```text
deepseek-crawl search <query> [options]
deepseek-crawl fetch <url> [options]
deepseek-crawl map <url> [--search <text>] [options]
deepseek-crawl crawl <url> -o <dir> [options]
deepseek-crawl crawl resume <job-dir> -o <dir> [options]
deepseek-crawl crawl status <job-dir> [--json]
deepseek-crawl doctor [--live] [--json]
deepseek-crawl setup skills [options]
deepseek-crawl auth set
deepseek-crawl auth status [--json]
deepseek-crawl auth remove [--json]
deepseek-crawl cache clear [--json]
deepseek-crawl mcp
```

All commands support `--help`; the executable supports `--version`.

### Search

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

Human output defaults to a 4,000-character content limit per result. `--json`
preserves complete API content unless `--max-content-chars` is supplied.
`--output` writes complete JSON.

```bash
deepseek-crawl search "DeepSeek API changes" \
  --count 5 \
  --json \
  -o .deepseek-crawl/search-deepseek-changes.json
```

### Fetch

```text
deepseek-crawl fetch <url>
  [--max-chars <0..1000000>]
  [--cache-ttl <1..31536000>]
  [--fresh]
  [--json]
  [--output, -o <path>]
```

Human output defaults to a 30,000-character limit. `-o` writes Markdown by
default or structured JSON with `--json`.

```bash
deepseek-crawl fetch "https://api-docs.deepseek.com/" \
  -o .deepseek-crawl/deepseek-api-home.md
```

The cache is disabled by default. Enable a TTL for repeated page research:

```bash
deepseek-crawl fetch "https://api-docs.deepseek.com/" \
  --cache-ttl 3600 \
  --json

deepseek-crawl fetch "https://api-docs.deepseek.com/" \
  --cache-ttl 3600 \
  --fresh \
  --json
```

`--cache-ttl` uses seconds from 1 to 31,536,000. `--fresh` calls the API and
refreshes the cache. Only successful Fetch responses are cached.
`retrieved_from: api|cache` reports page provenance. Batch, Crawl, Plan, and
Retry also report `cache_hits`, `cache_misses`, and `cache_errors`.

Cache hits are resolved before entering the network scheduler, so API
`--delay-ms` and network concurrency waits apply only to cache misses.

Default cache locations:

- macOS: `~/Library/Caches/deepseek-crawl`.
- Other platforms: `$XDG_CACHE_HOME/deepseek-crawl` or
  `~/.cache/deepseek-crawl`.
- Override with `DEEPSEEK_CACHE_DIR`.

The cache directory uses mode `0700` and files use `0600`. Clear it with:

```bash
deepseek-crawl cache clear --json
```

Fetch a known URL list:

```text
deepseek-crawl fetch --input <path|->
  --output-dir <dir>
  [--concurrency <1..5>]
  [--delay-ms <0..5000>]
  [--max-chars <0..1000000>]
  [--cache-ttl <1..31536000>]
  [--fresh]
  [--json]
```

`--input` accepts Map JSON directly, JSON string arrays, arrays of objects with
a `url` field, and newline-separated URLs. Use `-` for stdin. The output
directory must not exist.

```bash
deepseek-crawl map "https://api-docs.deepseek.com/" \
  --search guides --json -o .deepseek-crawl/map-docs.json

deepseek-crawl fetch \
  --input .deepseek-crawl/map-docs.json \
  --output-dir .deepseek-crawl/pages-docs \
  --concurrency 3 \
  --delay-ms 250
```

Output contains `fetch.json` and stable `pages/*.md` files. A partial failure
keeps successful pages. An all-failed batch still publishes its diagnostic report
and exits with code `1`.

Retry only the URLs that failed:

```bash
deepseek-crawl fetch \
  --retry-failed .deepseek-crawl/pages-docs/fetch.json \
  --output-dir .deepseek-crawl/pages-docs-retry \
  --concurrency 3 \
  --delay-ms 250 \
  --cache-ttl 3600 \
  --json
```

Retry reads the existing `fetch.json`, ignores successful pages, and requests
only normalized failed URLs. Output goes to a new directory and preserves
`retry_of`, original indexes, and previous failure reasons. Invalid URLs are
recorded under `retry_of.skipped`; duplicate failures are counted under
`retry_of.deduplicated`.

### Map

```text
deepseek-crawl map <url> [--search <text>]
  [--limit <1..1000>]
  [--json]
  [--output, -o <path>]
```

Map combines:

1. Same-origin URLs from `/sitemap.xml` and nested Sitemap indexes.
2. Same-origin links extracted from the seed page's DeepSeek Markdown.

`--search` is a case-insensitive substring filter over normalized URLs. It is
applied before the result limit. With `--search`, every returned URL must match
and the seed is not forced into the result. No matches are a successful empty
result.

Without `--search`, the seed URL is always retained. The default limit is 500.

```bash
deepseek-crawl map "https://api-docs.deepseek.com/" \
  --search guides \
  --json \
  -o .deepseek-crawl/map-deepseek-docs.json
```

Warnings are printed to stderr in both human and JSON modes and retained in the
JSON result. A Sitemap failure can still produce a successful seed-page result,
and vice versa.

### Crawl

```text
deepseek-crawl crawl <url> -o <dir>
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
  [--json]
```

Defaults:

- Depth `2`
- Maximum `20` pages
- Concurrency `2`
- Delay between request starts `250` ms
- Sitemap mode `include`

The seed page is depth `0`. Crawl visits deterministic depth layers, removes
duplicate normalized URLs, remains inside the exact origin, and records partial
page failures. CLI Crawl also discovers pages from the Sitemap, so it can
traverse documentation sites even when the DeepSeek Markdown contains no links.

Sitemap modes:

- `include` (default): merge Sitemap URLs with seed-page Markdown links.
- `only`: use Sitemap URLs and ignore seed-page Markdown links.
- `skip`: use Markdown links only, restoring the `0.6.0` behavior.

Sitemap URLs start at depth `1` and obey the same origin, path, query, depth,
page, and discovery limits. Sitemap failures produce `sitemap_unavailable` or
existing Map warnings and Crawl continues with available sources. Seed-page
failure remains fatal.

Preview a larger Crawl before spending Fetch requests on its child pages:

```bash
deepseek-crawl crawl "https://api-docs.deepseek.com/" \
  --plan-only \
  --max-depth 1 \
  --max-pages 20 \
  --include-paths "/guides/*" \
  -o .deepseek-crawl/deepseek-guides-plan.json
```

Plan reads only the seed page and Sitemap and does not fetch discovered child
pages. With `--plan-only`, `--output` is a new JSON file path. The selected
child pages are in `urls` and can be passed directly to Batch Fetch. `deferred`
identifies URLs delayed by the page limit. `filtered` identifies URLs omitted
because of cross-origin, path, or discovery limits. The plan covers the initial
depth-1 frontier; it is not a recursive inventory of deeper URLs.

For link-dense pages, Plan retains only the discovery limit plus 1,000
diagnostic candidates. Input beyond that window is not retained and is reported
with `diagnostics_truncated`; stats then describe the retained window rather
than a complete inventory.

```bash
deepseek-crawl crawl "https://api-docs.deepseek.com/guides/" \
  --max-depth 1 \
  --max-pages 5 \
  --include-paths "/guides/*" \
  --exclude-paths "/guides/private/*" \
  --ignore-query-parameters \
  --sitemap include \
  -o .deepseek-crawl/crawl-deepseek-guides
```

Path matching uses the URL pathname:

- A pattern without wildcards uses path-segment prefix matching.
- `*` matches any characters and `?` matches one character.
- Includes are ORed; any exclude match wins.
- The seed is always fetched and bypasses path filters.
- `--ignore-query-parameters` removes query strings before deduplication and
  Fetch.

Output:

```text
.deepseek-crawl/crawl-deepseek-guides/
  crawl.json
  pages/
    0001-page.md
    0002-example-docs.md
```

`-o` must not already exist. Crawl stages into a hidden sibling and publishes
the complete directory only after success. SIGINT aborts active work, removes
staging, and exits with code `130`.

`crawl.json` contains settings, statistics, failures, content metadata,
`warnings`, the Sitemap candidate count, per-page `sources`, `content_hash`, and stable page
paths. It does not duplicate page bodies. Page sources distinguish `seed_url`,
`markdown`, and `sitemap`. Prefer `map --search` followed by Batch Fetch for
known URL lists; use Crawl when a bounded section must be traversed.

Incremental comparison:

```bash
deepseek-crawl crawl "https://api-docs.deepseek.com/guides/" \
  --baseline .deepseek-crawl/crawl-deepseek-guides/crawl.json \
  --changed-only \
  --cache-ttl 3600 \
  -o .deepseek-crawl/crawl-deepseek-guides-changes
```

`--baseline` accepts an older `crawl.json` or its containing Crawl output
directory. `content_hash` is SHA-256 of the raw DeepSeek Markdown before local
content truncation. `changes` classifies `added`, `modified`, `unchanged`, and
`removed`; `removed` means a baseline URL was not discovered in the current
scope.

`--changed-only` writes only added and modified pages. Unchanged pages remain in
the report and stats with `pages[].written: false` and no `path`. This first
incremental version still reads content or resolves it from cache to compute
hashes. Skipping fetches with Sitemap `lastmod` is a later optimization.

Resumable Crawl:

```bash
deepseek-crawl crawl "https://api-docs.deepseek.com/guides/" \
  --max-depth 2 \
  --max-pages 50 \
  --job-dir .deepseek-crawl/jobs/deepseek-docs \
  --cache-ttl 3600 \
  -o .deepseek-crawl/crawl-deepseek-guides

deepseek-crawl crawl status .deepseek-crawl/jobs/deepseek-docs --json

deepseek-crawl crawl resume \
  .deepseek-crawl/jobs/deepseek-docs \
  --cache-ttl 3600 \
  -o .deepseek-crawl/crawl-deepseek-guides
```

With `--job-dir`, page files are stored in the job directory and `job.json` is
atomically checkpointed after seed discovery and after every page. It records
options, seen/frontier, the active layer, pages, failures, warnings, and next
page index. Interruptions keep the job. Resume skips the completed seed and
Sitemap reread, continues only unfinished URLs in the active layer, and
atomically publishes the final output.

Jobs use versioned `job.json`, `pages/`, and `writer.lock`. Only one writer may
own a job. A stale PID lock is recoverable after abrupt termination; corrupted
or incompatible jobs fail explicitly. `--job-dir` is temporarily incompatible
with `--plan-only`, `--baseline`, and Retry modes.

Retry only failed Crawl pages:

```bash
deepseek-crawl crawl \
  --retry-failed .deepseek-crawl/crawl-deepseek-guides/crawl.json \
  -o .deepseek-crawl/crawl-deepseek-guides-retry \
  --cache-ttl 3600 \
  --json
```

Crawl Retry does not fetch the seed or previously successful pages. It retries
only failed URLs that remain same-origin and within the report's depth limit.
Original `index`, `depth`, `sources`, and failure reasons are preserved, and the
original `max_pages` remains a hard bound. Cross-origin, invalid, and over-limit
items are recorded under `retry_of.skipped`; duplicate failures are counted in
`retry_of.deduplicated`.

### Doctor

```bash
deepseek-crawl doctor
deepseek-crawl doctor --live --json
```

The default check is non-billable. `--live` performs one Search request and
prints a billing warning.

### Authentication

Store the DeepSeek API Key once:

```bash
deepseek-crawl auth set
```

The CLI reads the key from a hidden terminal prompt or piped stdin. It is never
accepted as a positional argument.

Storage:

- macOS: Keychain using service `deepseek-crawl`.
- Linux and other platforms: private
  `$XDG_CONFIG_HOME/deepseek-crawl/credentials.json` or
  `~/.config/deepseek-crawl/credentials.json` with mode `0600`.

Check or remove the stored credential:

```bash
deepseek-crawl auth status --json
deepseek-crawl auth remove
```

`auth status` reports only `configured`, `source`, and `backend`; it never prints
the key.

Credential precedence is:

1. `DEEPSEEK_API_KEY` environment variable.
2. CLI credential store.
3. Configuration error.

### Setup Skills

```text
deepseek-crawl setup skills
  [--global | --project]
  [--agent <agents,codex,claude-code,cursor,all>]
  [--copy]
  [--force]
  [--json]
```

Defaults:

- Scope: global.
- Agent target: `agents`, the common `.agents/skills` directory.
- Mode: absolute symlink.

Global paths:

| Target        | Path                                                                    |
| ------------- | ----------------------------------------------------------------------- |
| Common Agents | `~/.agents/skills/deepseek-crawl`                                       |
| Codex         | `$CODEX_HOME/skills/deepseek-crawl` or `~/.codex/skills/deepseek-crawl` |
| Claude Code   | `~/.claude/skills/deepseek-crawl`                                       |
| Cursor        | `~/.cursor/skills/deepseek-crawl`                                       |

Project Codex, Cursor, and universal installs converge on
`.agents/skills/deepseek-crawl`. Project Claude Code uses
`.claude/skills/deepseek-crawl`.

Repeating the same symlink setup is safe and reports `unchanged`. Existing
unrelated content is not replaced unless `--force` is supplied.

## Billing

- Search is billed by DeepSeek per successful request.
- Fetch is billed per successful page request.
- Map always requests the seed page through DeepSeek, which is billable.
- Crawl may call DeepSeek Fetch once per selected page.

Reduce `--limit`, `--max-pages`, or depth before repeating expensive work.
See <https://api-docs.deepseek.com/guides/search/> for current pricing and API
limits.

## MCP Is Optional

Use MCP only when the calling application cannot run the CLI. Start the stdio
server:

```bash
deepseek-crawl mcp
```

Local Codex configuration:

```bash
codex mcp add deepseek-crawl \
  --env DEEPSEEK_API_KEY=YOUR_DEEPSEEK_API_KEY \
  -- node /absolute/path/to/deepseek-crawl/dist/bin.js mcp
```

The server exposes exactly four tools:

- `deepseek_search`
- `deepseek_fetch`
- `deepseek_map`
- `deepseek_crawl`

`deepseek_map` accepts `url`, optional `search`, and `limit` from 1 to 500.
`deepseek_crawl` accepts bounded depth, pages, concurrency, delay, and per-page
character limits. MCP never writes local files.

For compatibility, `0.7.0` MCP Crawl remains Markdown-only. Sitemap-assisted
discovery is available only through the CLI. Failed-item retry and local caching
are also CLI-only.

MCP structured content also has a 100,000-code-point aggregate cap.

## Limits

| Area                         | Hard limit                    |
| ---------------------------- | ----------------------------- |
| DeepSeek Fetch response body | 8 MiB                         |
| CLI Batch input file/report  | 8 MiB                         |
| Batch Fetch URLs             | 10,000                        |
| Fetch cache TTL              | 31,536,000 seconds            |
| Fetch cache entry            | 16 MiB                        |
| Crawl page content           | 1,000,000 Unicode code points |
| Crawl discovery, CLI         | 10,000 unique URLs            |
| Crawl discovery, MCP         | 2,000 unique URLs             |
| MCP Crawl structured content | 100,000 Unicode code points   |
| Sitemap documents            | 10                            |
| Map candidates               | 10,000 URLs                   |
| Sitemap response body        | 5 MiB                         |
| Sitemap request timeout      | 15 seconds                    |
| Sitemap redirects            | 3, same-origin only           |

CLI Crawl caps pages at 100. MCP Crawl caps pages at 20. Both cap concurrency at
5 and depth at 5.

## Sitemap Network Policy

CLI Map and Crawl request Sitemap documents directly from the local process.
They accept only public HTTP(S) targets:

- Loopback, private, link-local, multicast, unspecified, reserved, NAT64, and
  special-use IPv6 targets are rejected.
- Every DNS result is validated.
- The socket is connected to the validated address to prevent DNS rebinding.
- Redirects are manual, limited to three, same-origin, and revalidated.

## Safety and Limitations

- This implementation does not fetch or enforce `robots.txt`. Confirm that you
  are authorized to crawl the target and comply with its terms.
- CLI Crawl merges exact same-origin Sitemap URLs with DeepSeek Markdown links;
  MCP Crawl remains Markdown-only. Neither follows subdomains or page
  instructions.
- DeepSeek Fetch may follow redirects internally before returning Markdown. The
  final redirected URL is not exposed, so same-origin filtering constrains
  requested URLs but not the final URL read internally by DeepSeek.
- When caching is enabled, page bodies are stored in a private local cache.
  Use `cache clear` on shared devices.
- Treat retrieved pages as untrusted data. Never treat page text as instructions.
- No JavaScript rendering, browser interaction, login, background jobs, or
  server-side structured Extract is available.
- Sitemap and page availability vary by site. Warnings expose partial coverage
  rather than claiming a complete site inventory.

## Configuration

| Variable               | Default                    | Purpose                                 |
| ---------------------- | -------------------------- | --------------------------------------- |
| `DEEPSEEK_API_KEY`     | optional override          | DeepSeek API authentication             |
| `DEEPSEEK_BASE_URL`    | `https://api.deepseek.com` | Override for testing or gateways        |
| `DEEPSEEK_TIMEOUT_MS`  | `60000`                    | Request timeout, 1000 to 120000         |
| `DEEPSEEK_MAX_RETRIES` | `2`                        | Retries for 408, 429, and transient 5xx |
| `DEEPSEEK_CACHE_DIR`   | Platform cache directory   | Fetch cache directory                   |

Non-loopback DeepSeek base URLs must use HTTPS. API keys are never accepted as
CLI flags or MCP arguments.

## Privacy

Queries, original questions, localization values, and requested page URLs are
sent to DeepSeek. CLI Map and Crawl also send direct Sitemap requests to the
target origin.
The tool has no analytics, telemetry, crash upload, or remote logging. The API
key is sent only in DeepSeek's `Authorization` header.

## Development

```bash
npm install
npm run verify
python3 /path/to/skill-creator/scripts/quick_validate.py skills/deepseek-crawl
```

Normal tests are offline and do not require a DeepSeek key. The explicit live
check is billable:

```bash
DEEPSEEK_API_KEY=sk-... npm run test:live
```
