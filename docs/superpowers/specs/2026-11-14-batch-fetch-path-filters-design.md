# Batch Fetch and Crawl Path Filters Design

Date: 2026-11-14

Status: Approved

Target version: `0.6.0`

## Summary

Add two CLI-first capabilities that reduce the gap with common Firecrawl
workflows:

1. Batch Fetch a known URL list from a file or stdin.
2. Restrict Crawl with include/exclude path patterns and optional query-parameter
   deduplication.

MCP remains unchanged in this release. The primary consumer is the CLI and the
bundled Agent Skill.

## Goals

- Let an Agent feed Map JSON directly into Batch Fetch without shell loops.
- Produce per-URL Markdown files, a machine-readable index, and partial failures.
- Let Crawl target a docs path or exclude irrelevant sections.
- Provide simple Firecrawl-style path controls without adding a crawler library.
- Preserve deterministic ordering, bounded concurrency, no-clobber output, and
  existing DeepSeek API usage.
- Keep normal verification offline.

## Non-goals

- Async server jobs, job IDs, webhooks, or cloud storage.
- Browser automation, JavaScript rendering, or page interaction.
- Cross-origin or subdomain crawling.
- Structured Extract.
- MCP Batch Fetch in this version.
- Regex path expressions.

## Batch Fetch

### Command

```text
deepseek-crawl fetch --input <path|->
  --output-dir <dir>
  [--concurrency <1..5>]
  [--delay-ms <0..5000>]
  [--max-chars <0..1000000>]
  [--json]
```

Defaults:

- concurrency: `3`
- delay: `250 ms`
- max chars: `0` (no per-page truncation beyond existing API limits)

The positional URL form is unchanged. `--input` and a positional URL cannot be
used together. Batch mode requires `--output-dir`.

### Input Formats

Accept:

- A Map result object with `urls: [{ "url": "..." }]`.
- A JSON array of strings.
- A JSON array of objects containing `url`.
- A single object containing `url`.
- A newline-separated text list.

`-` reads stdin.

Fragments are removed. Duplicate normalized URLs are fetched once. Invalid,
credential-bearing, or non-HTTP(S) entries become failed records rather than
silently disappearing.

### Output

Required target directory must not exist. Output uses a hidden staging directory
and is published atomically:

```text
<dir>/
  fetch.json
  pages/
    0001-example.md
    0002-docs.md
```

`fetch.json`:

```json
{
  "version": 1,
  "source": ".deepseek-crawl/map.json",
  "started_at": "2026-11-14T00:00:00.000Z",
  "finished_at": "2026-11-14T00:00:01.000Z",
  "settings": {
    "concurrency": 3,
    "delay_ms": 250,
    "max_chars": 0
  },
  "stats": {
    "input": 3,
    "unique": 2,
    "fetched": 1,
    "failed": 1
  },
  "pages": [
    {
      "index": 1,
      "url": "https://example.com/",
      "title": "Example",
      "path": "pages/0001-page.md",
      "content_length": 1200,
      "content_truncated": false
    }
  ],
  "failures": [
    {
      "url": "https://example.com/broken",
      "kind": "not_found",
      "message": "DeepSeek could not extract usable page content."
    }
  ]
}
```

Indexes are assigned in first-seen normalized input order. Success page metadata
is sorted by index.

If at least one page succeeds, partial failures produce exit `0` and are stored
in `fetch.json`. If every entry fails, output is still published for diagnosis
and the command exits `1`.

## Crawl Path Filters

Add:

```text
--include-paths <patterns>
--exclude-paths <patterns>
--ignore-query-parameters
```

Patterns are comma-separated.

Matching rules:

- Match the URL pathname, not the full URL.
- A pattern without `*` or `?` is a prefix match: `/docs` matches `/docs` and
  `/docs/...`.
- `*` matches any characters and `?` matches one character.
- Patterns are case-sensitive.
- Include filters are ORed. A non-empty include set requires at least one match.
- Exclude filters are ORed. Any exclude match wins.
- The seed URL is always fetched and is not rejected by path filters.
- Filters apply only before a newly discovered URL is enqueued.

`--ignore-query-parameters` removes the URL query string before deduplication and
fetching. It applies to the seed and discovered URLs.

## Architecture

New modules:

```text
src/batch/
  types.ts
src/application/
  batch.ts
src/crawl/
  filters.ts
src/output/
  batch.ts
```

Responsibilities:

- `batch/types.ts`: Batch Fetch page, summary, failure, and result contracts.
- `application/batch.ts`: input parsing, normalization, bounded fan-out, partial
  failures.
- `crawl/filters.ts`: path matching and URL canonicalization.
- `output/batch.ts`: staging, page/index writing, no-clobber publication.
- CLI parser/runner adapts arguments and output.
- Existing `runLayeredTasks` provides concurrency and start spacing.

No new runtime dependency is added.

## CLI and Skill

The Skill workflow becomes:

```text
Map --search → Fetch --input map.json --output-dir ...
Crawl docs section with --include-paths /docs
```

Update README and Skill references with examples.

## Error Handling

- Missing/unknown batch input and output options exit `2`.
- Missing input file or malformed structured JSON exits `1`.
- Existing output directory exits `1`.
- Invalid URLs become structured failures.
- DeepSeek page failures become structured failures.
- Cancellation removes staging and exits `130`.
- Filter parsing rejects empty comma entries.

## Testing

Offline tests cover:

- Each batch input format and stdin.
- Normalization, dedupe, invalid entries.
- Concurrency, partial failures, all-failed exit.
- Atomic output and no-clobber behavior.
- Path prefix, wildcard, include/exclude precedence.
- Query-parameter dedupe for seed and links.
- CLI parsing/help/output.
- Skill docs and full verification.

## Acceptance Criteria

- Map JSON can be passed directly to `fetch --input`.
- Batch Fetch writes page Markdown and `fetch.json`.
- Crawl path filters restrict discovered URLs without blocking the seed.
- Query-ignored Crawl deduplicates variants.
- Version is `0.6.0`.
- `npm run verify`, Skill validation, and live smoke tests pass.
