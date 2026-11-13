# Firecrawl Capability Replacement Design

Date: 2026-11-13

Status: Decided

Target version: `0.2.0`

## Summary

`deepseek-crawl` will provide a capability-oriented replacement for Firecrawl
inside CLI and MCP workflows. The goal is not API or SDK compatibility. Instead,
an AI caller will be able to search, read, map, and crawl web content through
four stable tools:

- `search`: discover ranked web results.
- `fetch`: read one public page as Markdown.
- `map`: discover URLs for one site without reading every page body.
- `crawl`: traverse a bounded same-origin site and retain page Markdown.

The calling AI is responsible for understanding the returned content. Server
side structured extraction is outside this version.

## Goals

- Replace the common Search, Scrape, Map, and Crawl capabilities an AI needs
  when using Firecrawl.
- Keep one provider: DeepSeek's official Search and Fetch APIs.
- Work consistently from the CLI and MCP.
- Bound every operation so an AI cannot create an unbounded crawl by accident.
- Return stable JSON while retaining human-readable CLI and MCP output.
- Keep page content untrusted and never execute page HTML or JavaScript.
- Make repeated runs deterministic enough to test and audit.
- Preserve the existing package's small, dependency-light design.

## Non-goals

- Firecrawl HTTP API, SDK, request, or response compatibility.
- Browser automation, JavaScript rendering, clicking, form filling, or login.
- Server-side structured extraction using a chat model.
- Background jobs, queues, databases, persisted crawl resumption, or a web UI.
- Cross-origin crawling, subdomain crawling, or distributed crawling.
- Sitemap or page discovery outside the seed URL's origin.
- Reading or enforcing `robots.txt`. The caller is responsible for confirming
  that it is authorized to crawl the target site.
- Provider selection or fallback to another search or crawl provider.
- Guaranteeing full site coverage. Limits and unavailable sources produce
  explicit truncation and warning metadata.

## Public Surface

The package remains one executable named `deepseek-crawl`.

```text
deepseek-crawl search <query> [options]
deepseek-crawl fetch <url> [options]
deepseek-crawl map <url> [options]
deepseek-crawl crawl <url> [options]
deepseek-crawl doctor [--live] [--json]
deepseek-crawl mcp
```

The existing `search`, `fetch`, `doctor`, and `mcp` behavior remains compatible
unless this specification explicitly extends it.

### Map

```text
deepseek-crawl map <url>
  [--limit <1..1000>]
  [--json]
  [--output <path>]
```

Defaults:

- `--limit 500`
- Human-readable stdout prints one normalized URL per line.
- JSON stdout prints the complete Map result object.
- `--output` writes the JSON result using an atomic file write.

Map uses two discovery sources:

1. The origin-level `/sitemap.xml` and any same-origin nested sitemap indexes.
2. Links extracted from the seed page's Markdown returned by DeepSeek Fetch.

Direct sitemap HTTP requests do not use the DeepSeek API. The seed page request
does use DeepSeek Fetch and is billable.

### Crawl

```text
deepseek-crawl crawl <url>
  [--max-depth <0..5>]
  [--max-pages <1..100>]
  [--concurrency <1..5>]
  [--delay-ms <0..5000>]
  --output <dir>
  [--json]
```

Defaults:

- `--max-depth 2`
- `--max-pages 20`
- `--concurrency 2`
- `--delay-ms 250`
- `--output` is required.

The seed page has depth `0`. A link from the seed has depth `1`. Links are not
queued when their depth would exceed `max_depth`.

The CLI creates:

```text
<output>/
  crawl.json
  pages/
    0001-example.md
    0002-example-docs.md
```

Each page file contains a Markdown title, source URL, and the complete Markdown
returned by DeepSeek Fetch. `crawl.json` contains metadata and page indexes but
does not duplicate page bodies.

`--output` must identify a path that does not exist. The crawler writes into a
hidden temporary sibling directory and atomically renames it into place after
the crawl finishes. A failed run removes its own temporary directory and does
not leave a partially valid output directory.

`--json` changes only the terminal summary. Output files are written in either
case.

### MCP

The MCP server exposes:

- `deepseek_search`
- `deepseek_fetch`
- `deepseek_map`
- `deepseek_crawl`

`deepseek_map` accepts:

```text
url: string
limit: integer, default 100, range 1..500
```

`deepseek_crawl` accepts:

```text
url: string
max_depth: integer, default 2, range 0..5
max_pages: integer, default 10, range 1..20
concurrency: integer, default 2, range 1..5
delay_ms: integer, default 250, range 0..5000
max_chars: integer, default 4000, range 0..1000000
```

`max_chars` applies to each page's `content`. A value of `0` disables per-page
truncation. The MCP hard cap of 20 pages remains in force.

MCP tools return:

- Human-readable Markdown in `content`.
- Machine-readable data in `structuredContent`.
- Per-page truncation metadata when content is shortened.
- Partial failures without hiding successful pages.

MCP does not write local files. Crawl and Map remain read-only with respect to
the caller's filesystem, but they perform open-world network requests. Page
content is untrusted data and must not be interpreted as instructions.

## Result Contracts

### Map Result

```json
{
  "version": 1,
  "seed_url": "https://example.com/",
  "generated_at": "2026-11-13T12:00:00.000Z",
  "limit": 500,
  "total": 2,
  "truncated": false,
  "urls": [
    {
      "url": "https://example.com/",
      "sources": ["seed_url"]
    },
    {
      "url": "https://example.com/docs",
      "sources": ["seed_page", "sitemap"]
    }
  ],
  "warnings": []
}
```

Rules:

- `sources` contains unique values from `seed_url`, `seed_page`, and `sitemap`.
- URLs are sorted lexicographically after normalization.
- `total` is the number of returned URLs after applying `limit`.
- `truncated` is true when a valid source produced URLs beyond the limit.
- Warnings use `{ "code": string, "message": string }`.
- Sitemap failures produce warnings when seed-page discovery succeeds.
- If neither the Sitemap nor the seed page can be read, Map returns an error.
- A readable seed page with no links still produces a successful result
  containing at least the seed URL.

### Crawl CLI Result

`crawl.json` uses:

```json
{
  "version": 1,
  "seed_url": "https://example.com/",
  "started_at": "2026-11-13T12:00:00.000Z",
  "finished_at": "2026-11-13T12:00:02.000Z",
  "settings": {
    "max_depth": 2,
    "max_pages": 20,
    "concurrency": 2,
    "delay_ms": 250
  },
  "stats": {
    "discovered": 7,
    "fetched": 6,
    "failed": 1,
    "limit_reached": false
  },
  "pages": [
    {
      "index": 1,
      "url": "https://example.com/",
      "title": "Example",
      "depth": 0,
      "path": "pages/0001-example.md",
      "content_length": 1200
    }
  ],
  "failures": [
    {
      "url": "https://example.com/broken",
      "depth": 1,
      "kind": "not_found",
      "message": "DeepSeek could not extract usable page content."
    }
  ]
}
```

Pages are sorted by depth and then normalized URL before stable indexes and
paths are assigned. `content_length` is measured in Unicode code points.
`discovered` counts unique in-scope URLs that entered the queue. `limit_reached`
is true when another in-scope URL was discovered but not queued because of the
page limit.

The human summary prints the seed URL, parameters, success and failure counts,
and output directory. The `--json` summary omits page Markdown and prints the
same metadata object persisted in `crawl.json`.

### Crawl MCP Result

MCP structured content uses the same settings and statistics as the CLI result.
Its `pages` entry contains:

```json
{
  "url": "https://example.com/",
  "title": "Example",
  "depth": 0,
  "content": "# Example",
  "content_truncated": true,
  "content_original_length": 5000
}
```

The truncation fields are omitted when the page was not shortened. MCP does not
include output paths or write files.

## URL and Link Rules

All seed URLs must use HTTP or HTTPS, contain a host, and contain no username or
password. Fragment identifiers are removed before deduplication.

The scope origin is the exact tuple of scheme, hostname, and port from the
normalized seed URL. A URL is in scope only when `new URL(candidate).origin`
equals that tuple. Query strings and trailing slashes are preserved because
they can identify different page content.

Links are extracted with `markdown-it@15.0.3` configured with `linkify: true`
and `html: false`. The crawler considers `link_open` destinations, including
regular links, reference-style links, and parser-generated automatic links.
Images and raw HTML anchors are not traversal sources. Non-HTTP(S),
credential-bearing, malformed, out-of-scope, and already-seen URLs are ignored.

No page-provided instruction, navigation text, or link label changes crawl
policy.

## Map Discovery

The Sitemap reader requests `new URL("/sitemap.xml", seedUrl.origin)`.

- Sitemap documents are parsed with `fast-xml-parser@5.12.1`.
- Both `urlset` and `sitemapindex` documents are supported.
- Nested sitemap locations must remain on the seed origin.
- Sitemap cycles are removed by normalized document URL.
- At most 10 sitemap documents are read.
- Each Sitemap response body is limited to 5 MiB.
- Each direct HTTP request has a 15 second timeout.
- Redirects are followed manually, up to three times, and every target must
  remain on the original origin.
- Discovery stops reading additional Sitemap documents once the Map limit has
  been exceeded, but records that truncation occurred.
- Invalid XML, unsupported document types, HTTP errors, and truncated Sitemaps
  become warnings when another discovery source succeeds.

After Sitemap discovery, the seed page is fetched through DeepSeek and parsed
with the same Markdown link extractor. Both sources are merged and deduplicated.

## Crawl Scheduling

Crawl uses a breadth-first queue with these rules:

- The seed is fetched first. If it fails, the crawl fails.
- Up to `concurrency` page requests may be active.
- A shared scheduler inserts `delay_ms` between request starts.
- Once an active request begins, worker completion order does not define output
  order.
- Newly discovered URLs receive `parent_depth + 1`.
- URLs beyond `max_depth` are excluded.
- The queue never contains duplicate normalized URLs.
- No more than `max_pages` unique pages are fetched.
- A failed child page is recorded and does not stop other workers.
- A crawl with at least one successful page is a successful partial result even
  when some child pages fail.
- Cancellation stops scheduling, aborts active DeepSeek requests through the
  supplied `AbortSignal`, removes temporary output, and returns an error.

DeepSeek API concurrency is bounded independently from link parsing. Markdown
parsing is synchronous and occurs only after a successful page response.

## Architecture

```text
CLI arguments ─┐
               ├─> executeMap / executeCrawl
MCP tool call ─┘          │
                         ├─> link extraction and URL normalization
                         ├─> bounded queue and scheduler
                         ├─> DeepSeekGateway.fetch
                         └─> SitemapReader (Map only)
                                      │
                                      └─> direct same-origin HTTP GET
```

Planned modules:

```text
src/
  application/
    map.ts
    crawl.ts
  crawl/
    links.ts
    queue.ts
    types.ts
  sitemap/
    reader.ts
  output/
    crawl.ts
    map.ts
```

Responsibilities:

- `application/map.ts` merges Sitemap and seed-page discoveries.
- `application/crawl.ts` owns traversal policy and result construction.
- `crawl/links.ts` owns Markdown link extraction and URL normalization.
- `crawl/queue.ts` owns concurrency, delay, cancellation, depth, and page limits.
- `sitemap/reader.ts` is the only module allowed to request sitemap URLs.
- `output/*` owns serialization and filesystem writes.
- CLI modules parse arguments and select terminal/file output.
- MCP modules validate tool arguments and map application results to MCP
  payloads.
- `deepseek/client.ts` remains the only module that calls DeepSeek endpoints.

Existing application and transport boundaries remain intact. The implementation
must not add a general-purpose crawler framework or a second page extraction
provider.

## Dependencies

Add two pinned runtime dependencies:

- `markdown-it@15.0.3`
- `fast-xml-parser@5.12.1`

Both packages ship TypeScript declarations. No native modules are introduced.
Existing `zod` and MCP SDK versions remain unchanged.

## Configuration

No new environment variables are required. Existing DeepSeek settings continue
to apply to Fetch requests used by Map and Crawl:

- `DEEPSEEK_API_KEY`
- `DEEPSEEK_BASE_URL`
- `DEEPSEEK_TIMEOUT_MS`
- `DEEPSEEK_MAX_RETRIES`

Map and Crawl do not accept API keys as CLI flags or tool arguments.

## Error Handling

- Invalid CLI options exit with code `2`.
- Configuration, DeepSeek, Sitemap, output, and crawl failures exit with code
  `1`.
- Help and successful commands, including partial Crawl results with at least
  one successful page, exit with code `0`.
- DeepSeek errors retain their existing kind, status, and request ID mapping.
- Sitemap source errors are warnings only when the seed page remains usable.
- Existing filesystem paths are never overwritten.
- Errors and warnings never include `DEEPSEEK_API_KEY`.
- MCP returns tool errors only when the operation cannot produce a valid result.
  Child Crawl failures remain structured data in a successful tool result.

## Privacy and Safety

- Crawl URLs and page requests are sent to DeepSeek and are billable.
- Sitemap URLs are requested directly by the local process.
- The tool sends no analytics, telemetry, or page content to another provider.
- Page text is returned only as untrusted data.
- The crawler does not execute HTML or JavaScript.
- The implementation does not fetch or interpret `robots.txt`.
- The README must warn users to verify site authorization and applicable terms
  before crawling.
- MCP never writes files.

## Testing

Offline automated coverage must include:

- Link extraction for inline, reference-style, relative, automatic, image, raw
  HTML, malformed, and out-of-origin links.
- URL normalization, query preservation, fragment removal, and deduplication.
- BFS depth limits, page limits, delays, and maximum observed concurrency.
- Child request failures and partial successful results.
- Cancellation and temporary-directory cleanup.
- Sitemap URL sets, sitemap indexes, cycles, nested limits, invalid XML, HTTP
  failures, same-origin redirects, and body-size limits.
- Map source merging, warning behavior, sorting, and truncation.
- CLI parsing, help, JSON output, human output, existing-directory rejection,
  and atomic final directory creation.
- MCP listing of exactly four tools, input and output schemas, page truncation,
  partial failures, and no filesystem writes.
- Package version identity for `0.2.0`.
- Existing Search, Fetch, Doctor, and MCP tests remain green.

Tests use injected fetch implementations, Markdown and Sitemap fixtures, and fake
DeepSeek gateways. Normal verification must not require network access or make a
billable request.

## Documentation and Release

README additions must document:

- Map and Crawl commands with examples.
- The four MCP tools.
- Default and maximum limits.
- Directory and JSON result formats.
- DeepSeek billing caused by seed and page fetches.
- The absence of `robots.txt` enforcement.
- The capability-replacement scope and API incompatibility with Firecrawl.

The target package version is `0.2.0`. The package remains private and
unlicensed with no npm publication in this scope.
