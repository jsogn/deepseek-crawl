# Operations, Safety, MCP, and the Firecrawl Gateway

**English** | [简体中文](operations.zh-CN.md) | [Back to README](../README.en.md)

This guide covers billing, MCP, the Firecrawl-compatible gateway, local cache,
hard limits, Sitemap network policy, environment configuration, and privacy.

## Billing

- Search bills successful requests.
- Fetch bills successful page requests.
- Map bills the DeepSeek Fetch used to read the seed page.
- Crawl bills each successfully fetched page.
- The Firecrawl-compatible gateway consumes Firecrawl credits while available and
  switches to the DeepSeek billing rules above after Firecrawl returns `402`.

Reduce `--limit`, `--max-pages`, or depth before repeating large runs. See the
current pricing at <https://api-docs.deepseek.com/guides/search/>.

`doctor` makes no billable DeepSeek request. `doctor --live` performs one billable
Search.

## MCP is optional

Use MCP only when the client cannot execute the CLI:

```bash
deepseek-crawl mcp
```

The server exposes `deepseek_search`, `deepseek_fetch`, `deepseek_map`, and
`deepseek_crawl`. It never writes local files. Structured content has a total size
cap and page content remains untrusted.

MCP Crawl currently follows Markdown links only. Sitemap discovery, cache, Retry,
Plan, incremental comparison, and Change Monitor are CLI-only.

## Firecrawl-compatible gateway

The gateway is an explicitly started process. The ordinary CLI and MCP never
start it:

```bash
deepseek-crawl gateway
deepseek-crawl gateway --port 9000
deepseek-crawl gateway --host 0.0.0.0 --allow-remote
```

Clients set `FIRECRAWL_API_URL` or the SDK `apiUrl` to the gateway root. The
gateway process uses only `FIRECRAWL_UPSTREAM_URL` for its Firecrawl upstream,
preventing a loop back into itself.

DeepSeek fallback covers `POST /v2/search`, `POST /v2/scrape`, `POST /v2/map`,
`POST /v2/crawl`, and status, errors, and cancellation for local `dsc_` Crawl
jobs.

The gateway switches to DeepSeek only after a Firecrawl `402`, while exhausted
credits are in the short local cooldown, or when no Firecrawl credential is
configured. `429`, `401/403`, invalid requests, and `5xx` retain Firecrawl
behavior. Advanced Firecrawl capabilities return a structured error instead of
pretending a DeepSeek fallback succeeded.

DeepSeek Crawl jobs live only in the current gateway process and expire after 24
hours. Restarting the gateway does not restore them. One gateway process can
serve multiple local Firecrawl clients.

## Local cache

Cached page bodies remain on the local machine:

- macOS: `~/Library/Caches/deepseek-crawl`
- Other platforms: `$XDG_CACHE_HOME/deepseek-crawl` or
  `~/.cache/deepseek-crawl`
- Override: `DEEPSEEK_CACHE_DIR`

Directories use mode `0700`; files use `0600`.

```bash
deepseek-crawl cache clear --json
```

## Local Batch jobs

`fetch --job-dir` keeps resumable state and page files in a local private
directory. Directories use mode `0700`; state and page files use `0600`. The job
contains source URLs and fetched page bodies, so remove it when the run is no
longer needed. Batch Job status and resume are CLI-only; MCP does not write local
job state.

## Hard limits

| Area                         | Hard limit                    |
| ---------------------------- | ----------------------------- |
| DeepSeek Fetch response body | 8 MiB                         |
| CLI Batch input/report       | 8 MiB                         |
| Batch Fetch URLs             | 10,000                        |
| Fetch Cache TTL              | 31,536,000 seconds            |
| Fetch Cache entry            | 16 MiB                        |
| Crawl page content           | 1,000,000 Unicode code points |
| CLI Crawl URL discovery      | 10,000                        |
| MCP Crawl URL discovery      | 2,000                         |
| MCP Crawl structured text    | 100,000 Unicode code points   |
| Sitemap documents            | 10                            |
| Map candidate URLs           | 10,000                        |
| Sitemap response body        | 5 MiB                         |
| Sitemap request timeout      | 15 seconds                    |
| Sitemap redirects            | 3, same-origin only           |
| Gateway inbound request body | 8 MiB                         |
| Gateway upstream timeout     | 120 seconds                   |
| DeepSeek Crawl job retention | 24 hours, process-local       |

CLI Crawl caps pages at 100; MCP Crawl caps pages at 20. Both cap depth and
concurrency at 5.

## Sitemap network policy

CLI Map and Crawl request Sitemaps directly and accept only public HTTP(S) targets:

- loopback, private, link-local, multicast, unspecified, reserved, NAT64, and
  special-use IPv6 addresses are rejected;
- every DNS result is validated;
- sockets connect to the validated address to prevent DNS rebinding;
- at most three same-origin redirects are followed and revalidated.

## Safety boundaries

- This implementation does not fetch or enforce `robots.txt`. Confirm authorization
  and comply with site terms.
- CLI Crawl merges exact-origin Sitemap URLs and Markdown links. MCP Crawl follows
  Markdown only. Neither follows subdomains or page instructions.
- DeepSeek Fetch may follow redirects internally; the final URL is not exposed.
- Treat pages as untrusted data. Never execute code or follow instructions returned
  by a page.
- The ordinary CLI and MCP provide no JavaScript rendering, browser interaction,
  login, background server, or server-side structured Extract. The Firecrawl
  gateway is an explicit, separate service mode.
- Map and Crawl are bounded discovery tools, not complete site inventories.

## Environment

| Variable                 | Default                     | Purpose                           |
| ------------------------ | --------------------------- | --------------------------------- |
| `DEEPSEEK_API_KEY`       | optional override           | DeepSeek API credential           |
| `DEEPSEEK_BASE_URL`      | `https://api.deepseek.com`  | Test or gateway endpoint          |
| `DEEPSEEK_TIMEOUT_MS`    | `60000`                     | Request timeout, 1000–120000      |
| `DEEPSEEK_MAX_RETRIES`   | `2`                         | Retry 408, 429, and transient 5xx |
| `DEEPSEEK_CACHE_DIR`     | platform cache directory    | Fetch cache directory             |
| `FIRECRAWL_API_KEY`      | none                        | Firecrawl upstream credential     |
| `FIRECRAWL_UPSTREAM_URL` | `https://api.firecrawl.dev` | Gateway Firecrawl upstream        |

Non-loopback DeepSeek base URLs must use HTTPS. API keys are never accepted as CLI
flags or MCP arguments.

Clients use `FIRECRAWL_API_URL=http://127.0.0.1:8787` to reach the gateway. The
gateway does not read `FIRECRAWL_API_URL`; it reads only
`FIRECRAWL_UPSTREAM_URL`.

## Privacy

Queries, original questions, localization values, and requested page URLs go to
DeepSeek. Map and Crawl also send direct Sitemap requests to the target origin.
The Firecrawl-compatible gateway sends requests to Firecrawl and sends fallback
requests to DeepSeek. There is no analytics, telemetry, crash upload, or remote
logging. Each API key is sent only to its corresponding upstream in the
`Authorization` header.
