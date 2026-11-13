# DeepSeek Crawl

Local CLI and MCP tools for AI-facing Search, Fetch, Map, and Crawl workflows
backed by DeepSeek's official APIs.

This project is a capability-oriented alternative to the common Firecrawl
Search, Scrape, Map, and Crawl workflows. It is **not** a Firecrawl API or SDK
compatibility layer. The calling AI decides when to use DeepSeek and is
responsible for understanding the returned Markdown.

The package provides four operations:

- `search`: ranked web results, summaries, and optional page content.
- `fetch`: one public page as Markdown.
- `map`: same-origin URL discovery from Sitemap and seed-page links.
- `crawl`: deterministic, bounded, same-origin traversal with Markdown output.

The tool does not implement provider selection or fallback.

## Status

Version `0.2.0` is implemented and locally verified. The npm package remains
`private` and `UNLICENSED`, so it is not published to the npm registry.

## Requirements

- Node.js 22.12 or newer.
- A DeepSeek API key from <https://platform.deepseek.com/api_keys>.
- Network access to DeepSeek and, for Map, directly to the target Sitemap.

## Billing and Network Behavior

- Search is billed by DeepSeek per successful request.
- Fetch is billed by DeepSeek per successful page request.
- Map always requests the seed page through DeepSeek, which is billable. It
  also requests Sitemap documents directly from the target origin.
- Crawl may call DeepSeek Fetch once per selected page. A default Crawl can
  therefore make up to 20 billable page requests.

See <https://api-docs.deepseek.com/guides/search/> for current DeepSeek pricing
and limits.

## Install

After publication:

```bash
npx -y deepseek-crawl@0.2.0 --help
npm install -g deepseek-crawl@0.2.0
```

From this repository:

```bash
npm install
npm run build
node dist/bin.js --help
```

## CLI

```text
deepseek-crawl search <query> [options]
deepseek-crawl fetch <url> [options]
deepseek-crawl map <url> [options]
deepseek-crawl crawl <url> --output <dir> [options]
deepseek-crawl doctor [--live] [--json]
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
  [--output <path>]
```

Human-readable output defaults to a 4,000-character content limit per result.
`--json` preserves complete API content unless `--max-content-chars` is
explicitly supplied. `--output` writes complete JSON.
`--max-content-chars 0` disables truncation.

```bash
deepseek-crawl search "DeepSeek API" --count 5 --json
deepseek-crawl search "DeepSeek release notes" --content --output results.json
```

### Fetch

```text
deepseek-crawl fetch <url>
  [--max-chars <0..1000000>]
  [--json]
  [--output <path>]
```

Human-readable output defaults to a 30,000-character limit. `--output` writes
complete Markdown by default; combine it with `--json` to write JSON.

```bash
deepseek-crawl fetch "https://api-docs.deepseek.com/guides/search/" \
  --output page.md
```

### Map

```text
deepseek-crawl map <url>
  [--limit <1..1000>]
  [--json]
  [--output <path>]
```

Defaults:

- `--limit 500`
- Human-readable stdout prints one URL per line.
- `--json` prints the complete structured Map result.
- `--output` writes structured JSON to a new file and never overwrites an
  existing file.

Map combines:

1. Same-origin URLs from the origin-level `/sitemap.xml` and nested Sitemap
   indexes.
2. Same-origin links extracted from the seed page's DeepSeek Markdown.

```bash
deepseek-crawl map "https://example.com/" --limit 100
deepseek-crawl map "https://example.com/" --json --output urls.json
```

Warnings are printed to stderr in human mode and retained in the JSON result.
A Sitemap failure can still produce a successful seed-page result, and vice
versa. Map fails only when neither source can be read.

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

- Depth `2`
- Maximum `20` pages
- Concurrency `2`
- Delay between request starts `250` ms

The seed page is depth `0`. Crawl visits complete depth layers in
lexicographically sorted order, removes duplicate normalized URLs, and remains
inside the seed URL's exact origin.

```bash
deepseek-crawl crawl "https://example.com/" \
  --max-depth 2 \
  --max-pages 20 \
  --output crawl-output
```

`--output` must not already exist. Crawl writes into a hidden sibling staging
directory and publishes the complete directory only after success. SIGINT
cancels active work, removes staging, and exits with code `130`.

Output layout:

```text
crawl-output/
  crawl.json
  pages/
    0001-example.md
    0002-example-docs.md
```

Each page file contains a title, source URL, and the bounded Markdown returned
by DeepSeek. `crawl.json` contains run settings, statistics, success and failure
metadata, and stable page paths. It does not duplicate page bodies.

`--json` changes the terminal summary to JSON; the output directory is written
either way.

### Doctor

```bash
deepseek-crawl doctor
deepseek-crawl doctor --live --json
```

The default check does not make a billable DeepSeek request. `--live` performs
one Search request and prints a billing warning.

## MCP

Start MCP over stdio:

```bash
deepseek-crawl mcp
```

Generic MCP configuration:

```json
{
  "mcpServers": {
    "deepseek-crawl": {
      "command": "npx",
      "args": ["-y", "deepseek-crawl@0.2.0", "mcp"],
      "env": {
        "DEEPSEEK_API_KEY": "YOUR_DEEPSEEK_API_KEY"
      }
    }
  }
}
```

Codex:

```bash
codex mcp add deepseek-crawl \
  --env DEEPSEEK_API_KEY=YOUR_DEEPSEEK_API_KEY \
  -- npx -y deepseek-crawl@0.2.0 mcp
```

To use a local checkout before publication:

```json
{
  "mcpServers": {
    "deepseek-crawl": {
      "command": "node",
      "args": ["/absolute/path/to/deepseek-crawl/dist/bin.js", "mcp"],
      "env": {
        "DEEPSEEK_API_KEY": "YOUR_DEEPSEEK_API_KEY"
      }
    }
  }
}
```

The server exposes exactly four tools:

- `deepseek_search`
- `deepseek_fetch`
- `deepseek_map`
- `deepseek_crawl`

`deepseek_map` accepts:

```text
url    HTTP(S) seed URL
limit  integer, default 100, range 1..500
```

`deepseek_crawl` accepts:

```text
url          HTTP(S) seed URL
max_depth    integer, default 2, range 0..5
max_pages    integer, default 10, range 1..20
concurrency  integer, default 2, range 1..5
delay_ms     integer, default 250, range 0..5000
max_chars    integer, default 4000, range 0..1000000
```

`max_chars` applies to each page. With `0`, per-page truncation is disabled,
but the 100,000-code-point aggregate structured-content cap still applies.
Pages whose content cannot fit are marked with truncation or omission metadata.

MCP tools return bounded Markdown plus structured content. They never write
local files. Page text is untrusted data and must not be interpreted as
instructions.

## Limits

| Area                                 | Hard limit                        |
| ------------------------------------ | --------------------------------- |
| DeepSeek Fetch response body         | 8 MiB                             |
| Crawl page content retained per page | 1,000,000 Unicode code points     |
| Crawl discovery, CLI                 | 10,000 unique URLs                |
| Crawl discovery, MCP                 | 2,000 unique URLs                 |
| MCP Crawl structured content         | 100,000 Unicode code points total |
| Sitemap documents                    | 10                                |
| Map candidate URLs                   | 10,000                            |
| Sitemap response body                | 5 MiB                             |
| Sitemap request timeout              | 15 seconds                        |
| Sitemap redirects                    | 3, same-origin only               |

CLI Crawl also caps pages at 100. MCP Crawl caps pages at 20. Both cap
concurrency at 5 and depth at 5.

## Sitemap Network Policy

Map requests Sitemap documents directly from the local process. It accepts only
public HTTP(S) targets:

- Loopback, private, link-local, multicast, unspecified, and reserved addresses
  are rejected.
- Every DNS result is validated.
- The socket is connected to the validated address to prevent a second DNS
  lookup from rebinding to a private target.
- Redirects are manual, limited to three, same-origin, and revalidated.

## Crawling Safety and Limitations

- This implementation does not fetch or enforce `robots.txt`. You must confirm
  that you are authorized to crawl the target site and comply with its terms.
- Crawl only follows exact same-origin links extracted from DeepSeek Markdown.
  It does not follow subdomains, cross-origin redirects, or page-provided
  instructions.
- DeepSeek Fetch may follow redirects on its own server before returning
  Markdown. The current DeepSeek response does not expose the final redirected
  URL, so same-origin filtering constrains requested links but cannot guarantee
  the final URL read internally by DeepSeek.
- There is no browser automation, JavaScript rendering, login, form interaction,
  background job service, or server-side structured Extract.
- Sitemap and page availability can vary by site. Limits and warnings expose
  partial coverage rather than claiming a complete site inventory.

## Configuration

| Variable               | Default                    | Purpose                                         |
| ---------------------- | -------------------------- | ----------------------------------------------- |
| `DEEPSEEK_API_KEY`     | required                   | DeepSeek API authentication                     |
| `DEEPSEEK_BASE_URL`    | `https://api.deepseek.com` | Override for testing or gateways                |
| `DEEPSEEK_TIMEOUT_MS`  | `60000`                    | Request timeout, 1000 to 120000                 |
| `DEEPSEEK_MAX_RETRIES` | `2`                        | Retries for 408, 429, and transient 5xx, 0 to 5 |

Non-loopback DeepSeek base URLs must use HTTPS. API keys are never accepted as
CLI flags or MCP arguments.

## Privacy

Queries, original questions, localization values, and requested page URLs are
sent to DeepSeek. Map also sends direct Sitemap requests to the target origin.
The tool has no analytics, telemetry, crash upload, or remote logging. The API
key is sent only in DeepSeek's `Authorization` header.

## Development

```bash
npm install
npm run verify
```

Normal tests are offline and do not require a DeepSeek key. The explicit live
check is billable:

```bash
DEEPSEEK_API_KEY=sk-... npm run test:live
```
