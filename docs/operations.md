# Operations, Safety, and MCP

**English** | [简体中文](operations.zh-CN.md) | [Back to README](../README.en.md)

This guide covers billing, MCP, local cache, hard limits, Sitemap network policy,
environment configuration, and privacy.

## Billing

- Search bills successful requests.
- Fetch bills successful page requests.
- Map bills the DeepSeek Fetch used to read the seed page.
- Crawl bills each successfully fetched page.

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
- There is no JavaScript rendering, browser interaction, login, background server,
  or server-side structured Extract.
- Map and Crawl are bounded discovery tools, not complete site inventories.

## Environment

| Variable               | Default                    | Purpose                           |
| ---------------------- | -------------------------- | --------------------------------- |
| `DEEPSEEK_API_KEY`     | optional override          | DeepSeek API credential           |
| `DEEPSEEK_BASE_URL`    | `https://api.deepseek.com` | Test or gateway endpoint          |
| `DEEPSEEK_TIMEOUT_MS`  | `60000`                    | Request timeout, 1000–120000      |
| `DEEPSEEK_MAX_RETRIES` | `2`                        | Retry 408, 429, and transient 5xx |
| `DEEPSEEK_CACHE_DIR`   | platform cache directory   | Fetch cache directory             |

Non-loopback DeepSeek base URLs must use HTTPS. API keys are never accepted as CLI
flags or MCP arguments.

## Privacy

Queries, original questions, localization values, and requested page URLs go to
DeepSeek. Map and Crawl also send direct Sitemap requests to the target origin.
There is no analytics, telemetry, crash upload, or remote logging. The API key is
only sent in DeepSeek's `Authorization` header.
