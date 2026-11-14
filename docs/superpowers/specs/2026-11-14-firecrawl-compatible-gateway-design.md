# Firecrawl-Compatible Gateway Design

Date: 2026-11-14

Status: Approved

Target version: `0.13.0`

## Summary

Add an optional, process-local Firecrawl-compatible gateway to the existing
`deepseek-crawl` npm package. A Firecrawl SDK or HTTP client can point its API
base URL at the gateway. Common Firecrawl operations are forwarded to
Firecrawl while credits are available and fulfilled by DeepSeek after
Firecrawl reports exhausted credits.

The gateway is a separate runtime mode, not part of normal CLI and MCP startup:

```text
deepseek-crawl gateway [--host 127.0.0.1] [--port 8787]
```

The existing CLI and MCP surfaces remain DeepSeek-only.

## Goals

- Let unmodified Firecrawl v2 clients use common operations by changing only
  their API base URL.
- Preserve Firecrawl request and response behavior while Firecrawl can execute
  the request.
- Fall back to DeepSeek for supported common operations when Firecrawl reports
  insufficient credits.
- Reuse the existing DeepSeek Search, Fetch, Map, and Crawl implementations.
- Keep Firecrawl protocol code isolated from the existing CLI, MCP, application,
  cache, and DeepSeek transport modules.
- Require one npm installation and no install-time background service.
- Bind to loopback by default and never print API keys.

## Non-goals

- Full Firecrawl semantic compatibility for every option and endpoint.
- Browser actions, interactive sessions, screenshots, structured extraction,
  zero data retention, or provider-specific tool discovery on the DeepSeek
  fallback path.
- Multi-tenant authentication, billing, quota accounting, or a public hosted
  service.
- Persistent Crawl jobs across a gateway restart in the first version.
- Firecrawl API compatibility on the existing `deepseek-crawl search`,
  `deepseek-crawl fetch`, `deepseek-crawl map`, `deepseek-crawl crawl`, or MCP
  commands.
- Replacing or wrapping the normal Firecrawl API URL through DNS or TLS
  interception.

## Supported Firecrawl Surface

The gateway implements these v2 routes:

```text
POST   /v2/search
POST   /v2/scrape
POST   /v2/map
POST   /v2/crawl
GET    /v2/crawl/:id
GET    /v2/crawl/:id/errors
DELETE /v2/crawl/:id
```

Other `/v2/*` routes are passed through to Firecrawl when an upstream key is
available. No DeepSeek fallback is attempted for an unsupported route.

## Client Integration

The gateway accepts the normal Firecrawl base URL convention. For example, the
Node SDK should receive the local gateway root printed at startup, not a URL
ending in `/v2`, because the SDK appends `/v2/*` itself. Local mode starts at
`8787` and automatically tries subsequent ports. Explicit `--port` and remote
mode remain strict.

The gateway does not read `FIRECRAWL_API_URL`, because that variable identifies
the gateway to clients. Its Firecrawl upstream is configured separately:

```text
FIRECRAWL_UPSTREAM_URL=https://api.firecrawl.dev
```

Firecrawl credentials are resolved in this order:

1. The incoming `Authorization: Bearer ...` header.
2. `FIRECRAWL_API_KEY`.
3. No Firecrawl credential; supported routes go directly to DeepSeek.

DeepSeek credentials use the existing `loadConfig` resolution order.

Non-loopback listeners require `GATEWAY_API_KEY`. Clients pass this token as the
Firecrawl SDK `apiKey`. The gateway validates it with a constant-time comparison,
strips the incoming Authorization value, and uses only `FIRECRAWL_API_KEY` for
the Firecrawl upstream. Loopback mode without `GATEWAY_API_KEY` preserves local
BYOK passthrough.

Provider credentials resolve from environment variables first, then the
provider-specific Keychain/file store populated by `auth set firecrawl` or
`auth set gateway`.

## Routing

For a supported route:

1. If no Firecrawl credential is available, execute the DeepSeek-compatible
   implementation.
2. Otherwise, attempt Firecrawl.
3. If Firecrawl returns a successful response or an error other than `402`,
   return the upstream status, content type, and body.
4. On `402`, record a short local exhausted state and execute the supported
   DeepSeek-compatible implementation.
5. While the exhausted state is active, send supported requests directly to
   DeepSeek. The state expires after 60 seconds so renewed or topped-up credits
   are discovered without a restart.

Firecrawl `429`, `5xx`, authentication errors, and invalid requests do not
silently switch providers. They are returned to the caller.

## Request And Response Limits

- Maximum inbound request body: 8 MiB.
- Maximum DeepSeek fallback response body: existing DeepSeek limits plus
  Firecrawl response bounding.
- Default request timeout: 120 seconds.
- Host defaults to `127.0.0.1`.
- `--remote` enables authenticated remote mode and defaults to a fixed public
  listener on port 8787.
- A non-loopback host also requires `GATEWAY_API_KEY`.
- Hop-by-hop headers and `Host` are not forwarded upstream.
- Authorization headers are never logged.
- Firecrawl upstream response bodies stream to the client without whole-body
  buffering.

## DeepSeek Compatibility Mapping

### Search

Supported input:

- `query`
- `limit` mapped to DeepSeek `count`, clamped to DeepSeek's maximum of 50
- `scrapeOptions.formats` containing only `markdown`
- no non-web `sources`

Response:

```json
{
  "success": true,
  "data": {
    "web": [
      {
        "title": "Example",
        "description": "Snippet",
        "url": "https://example.com/",
        "markdown": "# Example",
        "metadata": {
          "title": "Example",
          "description": "Snippet",
          "sourceURL": "https://example.com/",
          "url": "https://example.com/"
        }
      }
    ]
  },
  "creditsUsed": 0
}
```

`markdown` is omitted when the request did not ask to scrape result content.

### Scrape

Supported input:

- `url`
- absent `formats`, or `formats` containing only `markdown`

Response:

```json
{
  "success": true,
  "data": {
    "markdown": "# Example",
    "metadata": {
      "title": "Example",
      "sourceURL": "https://example.com/",
      "url": "https://example.com/"
    }
  }
}
```

### Map

Supported input:

- `url`
- `search`
- `limit`, clamped to the existing Map limit of 1000

Response:

```json
{
  "success": true,
  "links": [
    {
      "url": "https://example.com/docs"
    }
  ]
}
```

### Crawl

Supported input:

- `url`
- `limit`, clamped to the existing Crawl maximum of 100 pages
- `maxDiscoveryDepth`, clamped to 0 through 5
- `sitemap` mapped to `skip`, `include`, or `only`
- `includePaths`
- `excludePaths`
- `ignoreQueryParameters`
- `delay` converted from seconds to milliseconds
- `maxConcurrency`

DeepSeek-backed Crawl IDs use the prefix `dsc_`. IDs without that prefix are
treated as Firecrawl IDs and their status, errors, and cancellation requests are
passed through to Firecrawl.

Crawl creation returns:

```json
{
  "success": true,
  "id": "dsc_...",
  "url": "https://example.com/"
}
```

Crawl status uses Firecrawl's status shape with `scraping`, `completed`,
`failed`, or `cancelled`, a top-level `success: true` required by the official
Node SDK, page documents, page counts, timestamps, and `creditsUsed: 0`.

DeepSeek Crawl jobs are held in process memory and expire after 24 hours.

## Unsupported Fallback Features

If a supported route requires an option or output format that DeepSeek cannot
provide, the gateway returns a Firecrawl-shaped error:

```json
{
  "success": false,
  "error": "This Firecrawl option is not supported by the DeepSeek fallback.",
  "code": "unsupported_fallback_feature"
}
```

The status is `400`. Unsupported behavior is never silently ignored.

## Architecture

New modules:

```text
src/gateway/
  config.ts
  server.ts
  handler.ts
  errors.ts
  route.ts
  crawl-jobs.ts
  runtime.ts
src/firecrawl/
  types.ts
  upstream.ts
  compat.ts
```

Responsibilities:

- `src/gateway/config.ts` parses and validates gateway-only configuration.
- `src/gateway/server.ts` owns the Node HTTP listener and graceful shutdown.
- `src/gateway/handler.ts` dispatches routes and owns fallback decisions.
- `src/firecrawl/upstream.ts` forwards requests to Firecrawl.
- `src/firecrawl/compat.ts` translates supported Firecrawl requests and
  responses to and from the existing DeepSeek application functions.
- `src/gateway/crawl-jobs.ts` owns in-memory DeepSeek-backed Crawl jobs.
- `src/gateway/runtime.ts` owns per-instance runtime state, URL discovery, PID and
  health validation, and stale-state cleanup.

The gateway may import application and DeepSeek modules. None of those modules
may import the gateway or Firecrawl modules.

`GatewayServer.close()` cancels all active process-local Crawl jobs before
closing the listener.

The gateway exposes unauthenticated `GET /healthz` with only status, version,
PID, and local/remote mode. Runtime files contain the same nonsecret metadata
and are stored with user-only permissions.

`gateway status --json` lists healthy instances using `started_at` and summarizes
nonsecret credential readiness for DeepSeek, Firecrawl, and gateway
authentication. The top-level help is grouped by Core, Gateway, Credentials,
Jobs, and Integration.

## Testing

Tests remain offline and deterministic.

Required coverage:

- CLI parsing and help for `gateway`.
- Loopback default and explicit remote binding gate.
- Firecrawl pass-through preserves method, path, body, authorization, status,
  content type, and response body.
- Supported routes fall back on Firecrawl `402`.
- Missing Firecrawl credentials go directly to DeepSeek.
- Unsupported routes do not fall back.
- Search, Scrape, Map, and Crawl fallback response shapes.
- Unsupported fallback features return a structured `400`.
- Local Crawl status, errors, cancellation, and expiry.
- Request body limit and upstream timeout.
- Official `firecrawl` 4.54.0 Node SDK calls against a local mock upstream for
  passthrough and DeepSeek fallback.
- Existing full verification continues to pass.

Live Firecrawl and DeepSeek calls are not part of the required test suite.

## Documentation

- Add gateway onboarding to both README files and the bundled Skill.
- Document `FIRECRAWL_API_URL` for clients and
  `FIRECRAWL_UPSTREAM_URL` for the gateway process separately.
- Add operational limits and security notes to both operations documents.
- Add the user-visible feature to `CHANGELOG.md`.
