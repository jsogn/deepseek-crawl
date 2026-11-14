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
deepseek-crawl gateway --remote
```

Clients set `FIRECRAWL_API_URL` or the SDK `apiUrl` to the gateway root. The
gateway process uses only `FIRECRAWL_UPSTREAM_URL` for its Firecrawl upstream,
preventing a loop back into itself.

Local mode searches from `8787` for an available port; explicit `--port` and
remote mode use strict fixed ports. Provider credentials come from environment
variables first, then the Keychain/file stores populated by
`deepseek-crawl auth set [deepseek|firecrawl|gateway]`.
`deepseek-crawl auth import firecrawl` can copy an existing Firecrawl CLI login
into that store while displaying only a masked hint.

`DEEPSEEK_GATEWAY_PROVIDER_MODE` or `gateway --provider-mode` selects provider
policy:

- `firecrawl-first`: default; use Firecrawl, then fall back after `402`.
- `deepseek-first`: use DeepSeek directly for common routes.
- `no-fallback`: keep common routes on Firecrawl and pass `402` through.

`gateway --credits-cooldown` or
`DEEPSEEK_GATEWAY_CREDITS_COOLDOWN_SECONDS` controls the `firecrawl-first`
exhausted-credit cooldown from 0–3600 seconds. The default is 60 seconds; zero
retries Firecrawl on every request. Other provider modes ignore this value.

Gateway capacity is independently bounded for HTTP requests, in-flight Provider
requests, running Crawl jobs, and retained jobs. Expired Crawl jobs are swept
periodically even when clients never poll them again. Provider limits apply to
both foreground fallback requests and background Crawl jobs.

Remote mode requires a stored `gateway` token. Clients supply it as the Firecrawl
SDK `apiKey`; the gateway strips it and uses its own Firecrawl provider
credential upstream. Never configure the gateway token as the Firecrawl upstream
key. Upstream responses are streamed, and gateway shutdown cancels active
process-local Crawl jobs.

CLI gateway stderr uses one JSON object per request with `x-request-id`,
normalized `route`, status, duration, provider, and fallback reason. API keys,
request bodies, query strings, and full URLs are excluded. Add global rate limits
and trusted source handling at a reverse proxy when deployed behind one.

The WebSocket `Watcher` is outside the supported compatibility surface. Upgrade
requests receive `426 websocket_not_supported`; the official SDK emits `error`
quickly rather than waiting indefinitely. Crawl polling, errors, cancellation,
and convenience Crawl methods remain supported.

DeepSeek fallback covers `POST /v2/search`, `POST /v2/scrape`, `POST /v2/map`,
`POST /v2/crawl`, and status, errors, and cancellation for local `dsc_` Crawl
jobs.

In the default `firecrawl-first` mode, the gateway switches to DeepSeek only
after a Firecrawl `402`, while exhausted credits are in the short local
cooldown, or when no Firecrawl credential is configured. `deepseek-first` skips
Firecrawl for common routes; `no-fallback` passes Firecrawl errors through.
`429`, `401/403`, invalid requests, and `5xx` retain Firecrawl behavior.
Advanced Firecrawl capabilities return a structured error instead of pretending
a DeepSeek fallback succeeded.

If Firecrawl cannot be reached or times out before returning a response, the
gateway returns `502 upstream_unavailable` without switching providers. This
keeps temporary Firecrawl outages from silently changing the provider or result
shape.

Maintainers can run `npm run test:live:gateway -- --billable` from a source
checkout to verify Firecrawl passthrough and DeepSeek fallback with two
single-page Scrapes. The command refuses to run without that explicit flag.
Add `--matrix` to include Search and Map for both providers, for six bounded
operations total.
Add `--crawl` to include one-page Crawls with `limit=1`,
`maxDiscoveryDepth=0`, and Sitemap discovery disabled.

DeepSeek Crawl jobs live only in the current gateway process and expire after 24
hours. Restarting the gateway does not restore them. One gateway process can
serve multiple local Firecrawl clients.

Runtime state lives in `DEEPSEEK_GATEWAY_RUNTIME_DIR`, otherwise
`$XDG_RUNTIME_DIR/deepseek-crawl/gateway`, otherwise a `gateway/runtime`
directory under the platform cache. Directories use `0700`; state files use
`0600` and contain only PID, URL, start time, and mode. `gateway status` verifies
the PID through public `/healthz` without exposing provider keys, request data,
or cache contents. It also summarizes each instance's provider mode and
cooldown, plus DeepSeek, Firecrawl, and gateway-auth readiness and source without
credential values.

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

| Area                          | Hard limit                    |
| ----------------------------- | ----------------------------- |
| DeepSeek Fetch response body  | 8 MiB                         |
| CLI Batch input/report        | 8 MiB                         |
| Batch Fetch URLs              | 10,000                        |
| Fetch Cache TTL               | 31,536,000 seconds            |
| Fetch Cache entry             | 16 MiB                        |
| Crawl page content            | 1,000,000 Unicode code points |
| CLI Crawl URL discovery       | 10,000                        |
| MCP Crawl URL discovery       | 2,000                         |
| MCP Crawl structured text     | 100,000 Unicode code points   |
| Sitemap documents             | 10                            |
| Map candidate URLs            | 10,000                        |
| Sitemap response body         | 5 MiB                         |
| Sitemap request timeout       | 15 seconds                    |
| Sitemap redirects             | 3, same-origin only           |
| Gateway inbound request body  | 8 MiB                         |
| Gateway upstream timeout      | 120 seconds                   |
| DeepSeek Crawl job retention  | 24 hours, process-local       |
| Gateway HTTP requests         | 100, configurable             |
| Gateway Provider requests     | 100, configurable             |
| Active Gateway Crawl jobs     | 10, configurable              |
| Retained Gateway Crawl jobs   | 100, configurable             |
| Authentication failure window | 5 failures in 60 seconds      |
| Authentication lockout        | 60 seconds, by source address |
| Gateway header timeout        | 15 seconds                    |
| Gateway keep-alive timeout    | 5 seconds                     |

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

| Variable                                    | Default                     | Purpose                           |
| ------------------------------------------- | --------------------------- | --------------------------------- |
| `DEEPSEEK_API_KEY`                          | optional override           | DeepSeek API credential           |
| `DEEPSEEK_BASE_URL`                         | `https://api.deepseek.com`  | Test or gateway endpoint          |
| `DEEPSEEK_TIMEOUT_MS`                       | `60000`                     | Request timeout, 1000–120000      |
| `DEEPSEEK_MAX_RETRIES`                      | `2`                         | Retry 408, 429, and transient 5xx |
| `DEEPSEEK_CACHE_DIR`                        | platform cache directory    | Fetch cache directory             |
| `DEEPSEEK_GATEWAY_RUNTIME_DIR`              | platform runtime/cache      | Gateway instance state dir        |
| `FIRECRAWL_API_KEY`                         | none                        | Firecrawl upstream credential     |
| `FIRECRAWL_UPSTREAM_URL`                    | `https://api.firecrawl.dev` | Gateway Firecrawl upstream        |
| `DEEPSEEK_GATEWAY_PROVIDER_MODE`            | `firecrawl-first`           | Provider selection policy         |
| `DEEPSEEK_GATEWAY_CREDITS_COOLDOWN_SECONDS` | `60`                        | Firecrawl 402 cooldown seconds    |
| `DEEPSEEK_GATEWAY_MAX_CONCURRENT_REQUESTS`  | `100`                       | Concurrent HTTP requests          |
| `DEEPSEEK_GATEWAY_MAX_PROVIDER_REQUESTS`    | `100`                       | Concurrent Provider requests      |
| `DEEPSEEK_GATEWAY_MAX_CRAWL_JOBS`           | `10`                        | Running Crawl jobs                |
| `DEEPSEEK_GATEWAY_MAX_RETAINED_CRAWL_JOBS`  | `100`                       | Retained Crawl jobs               |
| `DEEPSEEK_GATEWAY_MAX_RETAINED_CRAWL_BYTES` | `268435456`                 | Retained Crawl document bytes     |
| `GATEWAY_API_KEY`                           | none                        | Remote gateway Bearer token       |

Environment variables override the local credential store. Non-loopback DeepSeek
base URLs must use HTTPS. API keys are never accepted as CLI flags or MCP
arguments.

The retained byte budget counts serialized Crawl documents, including Markdown
and metadata. When a job-count or byte threshold is reached, the oldest terminal
job is evicted first. Capacity remains unavailable only while active jobs hold
it. A running job that would exceed the global byte budget evicts reclaimable
terminal pages before failing; it retains no rejected page. Expiration and
eviction release the accounted bytes immediately. The retained job limit must
be greater than or equal to the active Crawl job limit.

Clients use the `FIRECRAWL_API_URL` printed at startup to reach the gateway. The
gateway does not read `FIRECRAWL_API_URL`; it reads only
`FIRECRAWL_UPSTREAM_URL`.

## Privacy

Queries, original questions, localization values, and requested page URLs go to
DeepSeek. Map and Crawl also send direct Sitemap requests to the target origin.
The Firecrawl-compatible gateway sends requests to Firecrawl and sends fallback
requests to DeepSeek. There is no analytics, telemetry, crash upload, or remote
logging. Each API key is sent only to its corresponding upstream in the
`Authorization` header.
