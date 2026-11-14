# Batch and Crawl Workflows

**English** | [简体中文](workflows.zh-CN.md) | [Back to README](../README.en.md)

This guide covers Batch Fetch, Crawl Plan, incremental comparison, Change Monitor,
resumable jobs, and failed-item retry. A single known page only needs `fetch`.

## Choose the workflow

| Goal                                | Recommended path                      |
| ----------------------------------- | ------------------------------------- |
| Fetch a known URL list              | `map --search`, then Batch Fetch      |
| Inspect a docs area before fetching | `crawl --plan-only`                   |
| Read one bounded docs area          | bounded `crawl`                       |
| Compare two crawls                  | `crawl --baseline` or `crawl monitor` |
| Recover an interrupted long crawl   | `crawl resume`                        |
| Retry only failed items             | Batch Retry or Crawl Retry            |

A known URL list usually costs less than a site-wide Crawl. Crawl is for discovery
and traversal, always constrained by origin, depth, pages, concurrency, and path
filters.

## Batch Fetch

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

`--input` accepts Map JSON, a URL string array, an object array with `url`, one URL
per line, or `-` for stdin. `--output-dir` must not exist.

The output directory contains `fetch.json` and stable `pages/*.md` paths. Partial
failure preserves successful pages. If every page fails, the diagnostic report is
still published and the command exits with code `1`.

### Discover with Map, then read

```bash
deepseek-crawl map "https://api-docs.deepseek.com/" \
  --search guides \
  --json \
  -o .deepseek-crawl/map-docs.json

deepseek-crawl fetch \
  --input .deepseek-crawl/map-docs.json \
  --output-dir .deepseek-crawl/pages-docs \
  --concurrency 3 \
  --delay-ms 250
```

### Cache

Caching is off by default. Enable an explicit TTL when revisiting pages:

```bash
deepseek-crawl fetch "https://api-docs.deepseek.com/" \
  --cache-ttl 3600 \
  --json
```

`--fresh` forces a DeepSeek request and refreshes the entry. Only successful
responses are cached. Cache hits bypass API scheduling and do not consume
`--delay-ms` or network concurrency.

Default cache locations:

- macOS: `~/Library/Caches/deepseek-crawl`
- Other platforms: `$XDG_CACHE_HOME/deepseek-crawl` or
  `~/.cache/deepseek-crawl`
- Override with `DEEPSEEK_CACHE_DIR`

Directories use mode `0700`; files use `0600`.

```bash
deepseek-crawl cache clear --json
```

### Retry failures only

```bash
deepseek-crawl fetch \
  --retry-failed .deepseek-crawl/pages-docs/fetch.json \
  --output-dir .deepseek-crawl/pages-docs-retry \
  --concurrency 3 \
  --delay-ms 250 \
  --cache-ttl 3600 \
  --json
```

Batch Retry ignores successful pages and requests only normalized failures. The
new report preserves `retry_of`, original indexes, and previous errors.

## Crawl Plan

Preview an initial frontier before reading child pages:

```bash
deepseek-crawl crawl "https://api-docs.deepseek.com/" \
  --plan-only \
  --max-depth 1 \
  --max-pages 20 \
  --include-paths "/guides/*" \
  -o .deepseek-crawl/deepseek-guides-plan.json
```

Plan reads the seed and Sitemap only. `-o` is a single JSON path and must not exist.
`urls` can feed Batch Fetch. `deferred` lists page-limit deferrals; `filtered` lists
cross-origin, path, or discovery exclusions. `diagnostics_truncated` indicates a
truncated diagnostic candidate window.

## Run a bounded Crawl

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
  [--cache-ttl <1..31536000>]
  [--fresh]
  [--json]
```

Defaults are depth `2`, 20 pages, concurrency `2`, and a `250 ms` request delay.
The seed is depth `0`. Traversal is deterministic and restricted to the exact seed
origin.

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

Sitemap modes are `include` (default), `only`, and `skip`. Sitemap URLs start at
depth `1` and obey the same traversal limits. Sitemap failures are warnings; seed
failures are fatal.

Path patterns use segment-prefix matching when no wildcard is present. `*` matches
any characters and `?` matches one character. Includes are ORed; excludes take
priority. The seed is always read.

Output is atomic:

```text
.deepseek-crawl/crawl-deepseek-guides/
  crawl.json
  pages/
    0001-page.md
    0002-example-docs.md
```

The destination must not exist. SIGINT aborts requests, removes staging, and exits
with code `130`. `crawl.json` stores settings, stats, failures, warnings, sources,
content hashes, and stable page paths without duplicating page bodies.

## Incremental comparison

```bash
deepseek-crawl crawl "https://api-docs.deepseek.com/guides/" \
  --baseline .deepseek-crawl/crawl-deepseek-guides/crawl.json \
  --changed-only \
  --cache-ttl 3600 \
  -o .deepseek-crawl/crawl-deepseek-guides-changes
```

`--baseline` accepts a previous `crawl.json` or its directory. Changes are `added`,
`modified`, `unchanged`, or `removed`. `--changed-only` writes added and modified
pages only; unchanged pages remain in the report and baseline. The current version
still reads content or uses cache to calculate hashes; Sitemap `lastmod` skipping
is a later optimization.

## Persistent Change Monitor

Monitor runs once and exits, so cron, CI, system timers, or Agent Automation can
invoke it repeatedly:

```bash
deepseek-crawl crawl monitor "https://api-docs.deepseek.com/guides/" \
  --monitor-dir .deepseek-crawl/monitor/deepseek-guides \
  --max-depth 1 \
  --max-pages 20 \
  --include-paths "/guides/*" \
  --cache-ttl 3600 \
  --fail-on-change \
  -o .deepseek-crawl/monitor/deepseek-guides-runs \
  --json
```

The first successful run creates the baseline. Later runs create timestamped output
directories and atomically rotate `state.json` only after publishing succeeds.
Scope parameters are fixed after initialization; reset before changing them.

```bash
deepseek-crawl crawl monitor status \
  .deepseek-crawl/monitor/deepseek-guides \
  --json

deepseek-crawl crawl monitor reset \
  .deepseek-crawl/monitor/deepseek-guides \
  --json
```

`--fail-on-change` exits with code `3` when a selected change is found.
`--ignore-removed` ignores removals. `--only-modified` triggers and writes only
modified pages. A monitor directory has one writer and recovers stale PID locks.

## Resumable Crawl jobs

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

`--job-dir` stores versioned `job.json`, pages, frontier, failures, and
`writer.lock`. Checkpoints are atomic. Resume skips completed discovery and pages.
It cannot currently combine with `--plan-only`, `--baseline`, or Retry.

## Retry failed Crawl pages

```bash
deepseek-crawl crawl \
  --retry-failed .deepseek-crawl/crawl-deepseek-guides/crawl.json \
  -o .deepseek-crawl/crawl-deepseek-guides-retry \
  --cache-ttl 3600 \
  --json
```

Crawl Retry requests only same-origin failures inside the original depth and page
limits. Original indexes, depth, sources, and errors are preserved. Invalid or
out-of-scope entries appear in `retry_of.skipped`.
