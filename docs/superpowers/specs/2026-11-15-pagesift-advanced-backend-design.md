# Optional PageSift Advanced Backend Design

Date: 2026-11-15

Status: Approved

Target release: next minor release after implementation

## Summary

Add one optional, externally managed PageSift backend to the transparent
Firecrawl Gateway. The default installation remains unchanged and gains no new
runtime dependency.

When a caller explicitly enables the advanced backend, unsupported
browser-dependent Firecrawl operations may use PageSift after keyed Firecrawl
and Firecrawl Keyless can no longer serve the request:

```text
Common operation:
  Keyed Firecrawl -> Firecrawl Keyless -> DeepSeek

Browser-dependent advanced operation:
  Keyed Firecrawl -> Firecrawl Keyless -> PageSift -> explicit failure
```

PageSift is a bring-your-own backend. The gateway does not download, install,
start, stop, or update it. The existing `gateway` lifecycle commands continue to
manage only the DeepSeek Crawl Gateway.

The first release covers:

- Advanced Firecrawl v2 Scrape requests that require browser behavior.
- Firecrawl v2 Post-Scrape Interact for sessions created through PageSift.

This design deliberately does not add Steel, an in-house browser runtime,
standalone Browser Sandbox, Playwright code execution, CDP, or Live View.

## Goals

- Keep the default product lightweight and cross-platform.
- Add meaningful advanced-operation coverage without integrating Chromium into
  this repository.
- Preserve the existing Keyed Firecrawl and Keyless pass-through behavior.
- Use DeepSeek for common operations even when PageSift is configured.
- Use PageSift only for an explicit, closed compatibility subset.
- Keep advanced configuration to one optional flag and one backend URL.
- Give every browser-bound scrape session an unambiguous owning provider.
- Fail closed when PageSift is absent, unhealthy, or unable to preserve
  semantics.
- Expose advanced backend readiness through existing Gateway status surfaces.
- Avoid forwarding Gateway or Firecrawl credentials to PageSift.

## Non-goals

- Full Firecrawl semantic or behavioral compatibility.
- Installing or managing PageSift, Chrome, Docker, or another service.
- Supporting PageSift through a bundled npm dependency.
- Standalone Browser Sandbox routes such as `POST /v2/interact`.
- Playwright, Puppeteer, Selenium, raw CDP, browser code execution, live view,
  persistent profiles, or interactive live view URLs.
- Firecrawl Agent, Monitor, Extract, Batch Scrape, Crawl, Map, or job-status
  fallback through PageSift in the first release.
- Firecrawl Parse or Parse upload-url fallback through PageSift in the first
  release.
- Structured JSON extraction through PageSift in the first release.
- `/v2/parse/upload-url`, `/v2/scrape/stream`, v1 advanced Scrape, or WebSocket
  Watcher support.
- Automatically rewriting a Firecrawl-owned session onto PageSift.
- Proxy rotation, stealth escalation, CAPTCHA solving, or bypassing site or
  provider restrictions.

## Alternatives Considered

### Keep Fail-Closed Only

This is the lightest option and preserves the current product exactly. It does
not improve the advanced-operation gap after Keyless is exhausted.

Rejected because it leaves a clear product opportunity unused.

### Optional PageSift Backend

This adds one external service only for users who request advanced behavior.
PageSift already exposes a Firecrawl-shaped Scrape and Interact surface, is
Apache-2.0, and can run without adding Browserbase-style account dependencies.

Selected because it provides the most capability per unit of product and
operational complexity.

### PageSift Plus Steel

This can cover standalone CDP and browser code execution in addition to
PageSift, but requires two external backends, two compatibility adapters, two
sets of session semantics, and significantly more testing and support.

Rejected for the first release. Steel is not part of the product architecture
unless real demand later justifies another independently approved design.

### Backend Packaging Boundary

The design targets PageSift `1.4.2` during compatibility testing. Runtime
version detection is not added because PageSift `/healthz` reports only
reachability.

The npm `pagesift` native binding is not bundled. It adds a platform-specific
native package of roughly 27-31 MiB, does not expose PageSift Interact, and
would make this Gateway responsible for a second native dependency in every
installation.

The Gateway therefore connects to an existing PageSift HTTP service. PageSift
installation, Chrome installation, Docker, and service management remain
outside this repository.

## User Experience

### Default Installation

There is no user-visible change:

```bash
deepseek-crawl gateway install
```

PageSift is disabled. No port is probed and no additional credential is read.

### Enable PageSift

The user starts PageSift independently. If it uses its default loopback endpoint,
the user enables the advanced backend with one flag:

```bash
deepseek-crawl gateway install --advanced
```

The default advanced URL is:

```text
http://127.0.0.1:3002
```

An existing PageSift deployment can be selected explicitly:

```bash
deepseek-crawl gateway install --advanced-url http://127.0.0.1:3002
```

`--advanced-url` implies `--advanced`.

For foreground mode:

```bash
deepseek-crawl gateway --advanced
```

The URL can also be supplied through the process environment:

```bash
DEEPSEEK_GATEWAY_ADVANCED_URL=https://pagesift.example.com \
  deepseek-crawl gateway --advanced
```

Reinstalling with neither `--advanced`, `--advanced-url`, nor `--no-advanced`
preserves the current advanced configuration. A fresh installation defaults to
disabled. `--no-advanced` explicitly disables and removes the advanced URL.

`--no-advanced` is mutually exclusive with `--advanced` and `--advanced-url`.
`--no-advanced` applies only to `gateway install`; foreground mode is disabled
by omitting `--advanced` and `--advanced-url`.

### Managed Install Preflight

A managed installation that enables PageSift must first:

1. Resolve the URL from the command or `DEEPSEEK_GATEWAY_ADVANCED_URL`.
2. Validate the URL security rules.
3. Require a configured `pagesift` credential when the URL is non-loopback.
4. Request PageSift `/healthz` without following redirects.
5. Require HTTP 200 and a body whose trimmed text is exactly `ok`.
6. Request `GET /v2/crawl/active` with the PageSift credential, without
   following redirects.
7. Require a successful response from the active-jobs endpoint.

Each preflight request uses a 2-second timeout.

If preflight fails, managed service state, Firecrawl CLI configuration, and any
existing Gateway installation remain unchanged.

The active-jobs probe is non-billable, starts no work, and does not access a
target website. It verifies that the service exposes the expected PageSift API
surface and that the supplied credential is accepted. A `401` requires
`deepseek-crawl auth set pagesift`; a `404` indicates a non-compatible backend
or version.

Foreground `gateway --advanced` does not abort when PageSift is initially
unreachable. It logs an actionable warning, and advanced requests fail until the
backend becomes reachable. This preserves normal Gateway availability.

PageSift `/healthz` is unauthenticated and reports no version. The active-jobs
probe provides the API and credential check. Neither probe reports Chrome or LLM
readiness.

### PageSift Credential

PageSift may run without authentication on a private loopback address. When it
requires a bearer token, use the existing secure credential flow:

```bash
deepseek-crawl auth set pagesift
```

`PAGESIFT_API_KEY` remains the non-interactive environment override. The key is
never accepted as a CLI argument, stored in the PageSift URL, or printed.

### Status

`gateway status` and `gateway status --json` report for each running instance
and for the managed service:

- Whether the advanced backend is configured.
- Provider name `pagesift`.
- Configured URL without credentials.
- PageSift `/healthz` reachability when enabled.
- Whether a PageSift credential is configured, without exposing its value.

The JSON status shape is additive within each Gateway instance entry:

```json
{
  "instances": [
    {
      "url": "http://127.0.0.1:8787",
      "advanced_backend": {
        "enabled": true,
        "provider": "pagesift",
        "url": "http://127.0.0.1:3002",
        "reachable": true,
        "api_ready": true,
        "credential_configured": false
      }
    }
  ]
}
```

The object is present with `enabled: false`, `provider: null`, `url: null`,
`reachable: false`, `api_ready: false`, and the actual credential flag when the
advanced backend is disabled. The top-level credential status adds `pagesift`
alongside the existing providers.

An unreachable PageSift backend is an advanced-backend issue, not a Gateway
health failure. Common operations continue through the existing provider chain.
`gateway status` uses the same two non-billable probes with a 2-second timeout
per request.

`gateway stop` and `gateway uninstall` never stop, modify, or remove an
externally managed PageSift process.

## Configuration

Add the following Gateway configuration:

```text
DEEPSEEK_GATEWAY_ADVANCED_URL
PAGESIFT_API_KEY
```

The advanced backend is enabled when an advanced URL is configured and the
provider mode is `firecrawl-first` or `deepseek-first`.

`no-fallback` disables PageSift and DeepSeek fallback. Firecrawl errors pass
through unchanged.

For foreground mode, `DEEPSEEK_GATEWAY_ADVANCED_URL` enables the backend even
without `--advanced`. For managed installation, a command flag is required;
the environment supplies only the URL value when `--advanced` is used without
`--advanced-url`. An explicit `--advanced-url` overrides the environment.
`--no-advanced` ignores the environment and disables the backend.

The URL validation rules are:

- Only HTTP and HTTPS are accepted.
- HTTP is allowed only for loopback hosts.
- Non-loopback backends require HTTPS.
- A non-loopback backend requires a configured PageSift credential.
- Username, password, query string, and fragment are rejected.
- The path must be `/`; a trailing slash is normalized without silently
  discarding a configured path prefix.
- No URL redirects are followed during health checks.

The provider type is fixed to `pagesift` in this release. No generic plugin
registry is introduced.

## Routing

Routing remains capability-specific rather than a single fixed chain.

### Common Operations

Existing DeepSeek-compatible Search, Scrape, Map, Crawl, and local Crawl job
routes keep their current provider order.

PageSift is never selected for a request that DeepSeek can reproduce
faithfully.

### Browser-Dependent Scrape

For `POST /v2/scrape` in an enabled provider mode:

1. Try the existing keyed Firecrawl and Keyless route logic.
2. If neither backend can serve the request, validate the body against the
   PageSift advanced capability matrix.
3. If the request is not advanced, use the existing DeepSeek allowlist.
4. If the request is advanced and PageSift is configured and healthy, use
   PageSift.
5. If the request is advanced and PageSift is unavailable, return a structured
   advanced-backend error.
6. If neither DeepSeek nor PageSift supports the request, retain the existing
   `unsupported_fallback_feature` failure.

An upstream PageSift response is authoritative. The gateway must not try
DeepSeek after PageSift returns an HTTP response.

### Scrape-Bound Interact

`POST` and `DELETE /v2/scrape/:id/interact` use the session owner recorded when
the Scrape was created.

- A Firecrawl-owned session continues through the Firecrawl path.
- A PageSift-owned session continues through PageSift.
- An unknown local advanced session ID returns `404
  advanced_session_not_found`.
- The gateway never replays a Firecrawl session on PageSift.

PageSift Interact supports `prompt` and PageSift action arrays in this release.
The closed top-level Interact allowlist is:

- `prompt`
- `actions`
- `timeout`
- `origin`

Interact action objects use the same allowed action types as advanced Scrape.
Requests containing `code`, `language`, `url`, or an unknown field return
`unsupported_fallback_feature`. The `url` extension is excluded because it can
replace session semantics with a new page load.

The Interact path parser runs before normal Firecrawl and Keyless provider
selection. A `ps_` ID is never sent to Firecrawl, DeepSeek, or an unrecognized
backend.

Prompt Interact requires the PageSift operator to configure a compatible LLM.
If PageSift reports that no LLM is configured, its error is returned explicitly.
The Gateway does not infer LLM readiness from `/healthz`.

### Other Routes

All other advanced routes remain outside the compatibility surface. In
particular, standalone Interact, Agent, Monitor, Extract, Batch Scrape, Crawl,
Map, Parse, and job operations do not use PageSift.

## Advanced Scrape Capability Matrix

The advanced allowlist is intentionally closed. Unknown fields and unknown
values fail closed.

Allowed top-level fields:

- `url`
- `formats`
- `actions`
- `waitFor`
- `onlyMainContent`
- `includeTags`
- `excludeTags`
- `headers`
- `timeout`
- `mobile`
- `blockAds`
- `origin`

Allowed string formats:

- `markdown`
- `html`
- `rawHtml`
- `links`
- `images`

Object formats and the `screenshot` format string are rejected in this release.
Screenshots are supported only through the `screenshot` action after live
PageSift `1.4.2` validation showed that its Scrape format allowlist does not
include a screenshot format.

Allowed action types:

- `wait`
- `click`
- `write`
- `press`
- `scroll`
- `screenshot`
- `scrape`
- `pdf`

`executeJavascript` is excluded because PageSift disables it by default and
enabling arbitrary page code would expand the security boundary.

The following are explicitly excluded:

- `json`, `summary`, `question`, `query`, `highlights`, `audio`, and `video`
  formats.
- `location`, `profile`, `proxy`, `zeroDataRetention`, and
  `checkPromptInjection`.
- DOM attributes, change tracking, branding, cache controls, and any future
  field not added to this matrix.

The Gateway must not turn a capability mismatch into a successful response.

## PageSift Scrape Sessions

Firecrawl Scrape may return a `scrapeId` that can later be used by Interact.
PageSift provides the same post-scrape interaction concept, but keeps the exact
rendered page only when its `keepSession` extension is `true`.

For every Gateway-selected advanced Scrape:

1. Parse the JSON request body.
2. Validate the advanced allowlist.
3. Reject a client-supplied `keepSession` field as unsupported Firecrawl input.
4. Reserve one local session slot or fail before contacting PageSift.
5. Inject `keepSession: true` before forwarding to PageSift.

This makes the session semantics closer to Firecrawl and avoids a hidden replay
when the first Interact call arrives. A PageSift deployment without Chrome
returns its explicit unsupported error, which the Gateway preserves.

The reserved slot is released when PageSift returns an error, the response is
invalid, or no PageSift scrape ID is returned.

### Session IDs

PageSift session IDs must not be confused with Firecrawl or DeepSeek IDs.

When an advanced Scrape succeeds with `data.metadata.scrapeId`, the Gateway:

1. Generates `ps_` followed by a cryptographically random 128-bit lowercase hex
   value.
2. Stores a process-local mapping from the public ID to the PageSift scrape ID.
3. Rewrites `data.metadata.scrapeId` to the public ID.
4. Returns the rewritten response to the client.

The mapping has:

- A hard maximum number of entries.
- A ten-minute default TTL, matching Firecrawl's documented default session
  lifetime and PageSift's default total session lifetime.
- A TTL measured from Scrape creation and not extended by Interact.
- Immediate removal on a successful DELETE Interact.
- Deterministic removal of expired entries before a new session is admitted.

The limit is fixed in this release at 1,000 sessions. A mapping-capacity failure
returns an explicit `503 advanced_session_capacity` response instead of
returning an ID the Gateway cannot route. Active sessions are never evicted to
make room for a new one.

Session maps are process-local. Gateway restart loses public `ps_` IDs, and a
later Interact request returns `404 advanced_session_not_found`.

If PageSift returns `404` or `410` for a mapped upstream session, the Gateway
removes the mapping and returns `404 advanced_session_not_found` without
revealing the PageSift ID.

### Response Rewriting Limit

To rewrite the session ID safely, advanced Scrape JSON is buffered before it is
sent to the client.

The mapping buffer limit is 16 MiB. A larger successful response returns
`502 advanced_backend_response_too_large` and is not published partially.

At most four advanced Scrape responses are buffered concurrently, for a fixed
64 MiB aggregate ceiling. Additional advanced Scrapes wait for a buffer slot and
remain cancellation-aware. Slots are released on success, failure, timeout, or
client disconnect.

This limit is a Gateway compatibility boundary, not a PageSift limit.

## Error Semantics

New Firecrawl-shaped errors:

### Backend Unavailable

```json
{
  "success": false,
  "error": "The configured advanced backend is unavailable.",
  "code": "advanced_backend_unavailable"
}
```

HTTP status: `503`.

### Session Capacity

```json
{
  "success": false,
  "error": "The advanced session capacity is exhausted.",
  "code": "advanced_session_capacity"
}
```

HTTP status: `503`, with a short `Retry-After`.
`Retry-After` is exactly `1` second.

### Unknown Session

```json
{
  "success": false,
  "error": "The advanced scrape session is not available.",
  "code": "advanced_session_not_found"
}
```

HTTP status: `404`.

This code is also used when PageSift reports that a mapped upstream session is
gone.

### Oversized Session Response

```json
{
  "success": false,
  "error": "The advanced scrape response is too large to establish session routing.",
  "code": "advanced_backend_response_too_large"
}
```

HTTP status: `502`.

### Invalid Advanced Response

```json
{
  "success": false,
  "error": "The advanced backend returned an invalid scrape response.",
  "code": "advanced_backend_invalid_response"
}
```

HTTP status: `502`.

### Missing Session ID

```json
{
  "success": false,
  "error": "The advanced backend did not return a scrape session.",
  "code": "advanced_backend_session_id_missing"
}
```

HTTP status: `502`.

A successful advanced Scrape that cannot be parsed as JSON uses
`advanced_backend_invalid_response`. A parsed successful response without
`data.metadata.scrapeId` uses `advanced_backend_session_id_missing`.

PageSift HTTP errors for authentication, rate limiting, invalid input, unsupported
options, and server failures pass through without a DeepSeek retry.

A transport failure before PageSift returns a response uses
`advanced_backend_unavailable`.

If PageSift is not configured, existing `unsupported_fallback_feature` behavior
is unchanged.

## Architecture

Add focused modules:

```text
src/gateway/advanced-backend.ts
src/gateway/advanced-sessions.ts
src/firecrawl/advanced-capabilities.ts
```

Responsibilities:

- `advanced-backend.ts`
  - Normalize and validate the PageSift base URL.
  - Probe PageSift `/healthz` and `GET /v2/crawl/active`.
  - Forward bounded method/path requests.
  - Strip Gateway and Firecrawl authorization.
  - Apply only the PageSift credential.
  - Convert transport failures into the advanced-backend error contract.
- `advanced-sessions.ts`
  - Own the bounded process-local session map.
  - Generate public `ps_` IDs.
  - Rewrite PageSift scrape IDs in JSON responses.
  - Resolve POST and DELETE Interact paths.
  - Expire and evict entries.
- `advanced-capabilities.ts`
  - Own the closed Scrape allowlist.
  - Validate action types, formats, and excluded fields.
  - Return deterministic unsupported field paths.

Modify:

- `src/gateway/config.ts`
  - Parse and validate advanced URL configuration.
- `src/gateway/handler.ts`
  - Delegate advanced routing to focused helpers rather than adding more inline
    provider branches.
- `src/gateway/service.ts`
  - Persist advanced settings in managed service state.
  - Include them in managed launch arguments.
- `src/gateway/runtime.ts`
  - Include nonsecret advanced configuration in runtime discovery.
- `src/gateway/telemetry.ts`
  - Add the `pagesift` provider and fallback reasons.
- `src/credentials/store.ts`
  - Add the `pagesift` credential name.
- `src/cli/parse.ts`
  - Add `--advanced`, `--advanced-url`, and `--no-advanced`.
- `src/cli/run.ts`
  - Preserve existing settings on reinstall unless an advanced flag overrides
    them.
  - Report advanced readiness in human and JSON status.

The handler remains the owner of provider order. The advanced backend helper
must not import CLI, MCP, application, crawl-job, or DeepSeek orchestration
modules.

## Security

- Incoming `Authorization` is never forwarded to PageSift.
- `FIRECRAWL_API_KEY`, `DEEPSEEK_API_KEY`, `GATEWAY_API_KEY`, and imported
  Firecrawl credentials are never forwarded to PageSift.
- Only `PAGESIFT_API_KEY` from the environment or `pagesift` credential store
  can become the PageSift bearer token.
- The PageSift URL must not contain credentials.
- Non-loopback PageSift URLs require HTTPS and a credential.
- Health checks and advanced requests do not follow redirects.
- The Gateway continues to reject hop-by-hop headers.
- Target-page SSRF, robots, rate-limit, and network policy remain PageSift's
  responsibility. This design does not add PageSift features that disable those
  protections.
- `executeJavascript`, proxy configuration, persistent profiles, and stealth
  escalation are outside the allowlist.
- Request logs exclude request bodies, page content, headers, target URLs, and
  PageSift credentials.
- `gateway stop` and `gateway uninstall` do not take ownership of PageSift.

## Observability

Request logs add:

- `provider: "pagesift"` for an advanced backend response.
- `fallback_reason: "pagesift_advanced_scrape"`.
- `fallback_reason: "pagesift_advanced_interact"`.
- `fallback_reason: "pagesift_unavailable"`.

The Gateway `/healthz` response adds only nonsecret configuration and readiness
metadata:

```json
{
  "advanced_backend": {
    "provider": "pagesift",
    "configured": true
  }
}
```

It does not synchronously probe PageSift in the Gateway health endpoint.
`gateway status` performs the external health probe with a short timeout.

## Testing

All required tests are offline and deterministic.

### Unit Tests

- Advanced URL accepts loopback HTTP and remote HTTPS.
- Advanced URL rejects remote HTTP, credentials, query strings, and fragments.
- `--advanced` expands to the PageSift default URL.
- `--advanced-url` enables the backend.
- `--no-advanced` disables it.
- `--no-advanced` rejects both `--advanced` and `--advanced-url`.
- `--no-advanced` is rejected by foreground `gateway`.
- Reinstall without advanced flags preserves current settings.
- Advanced Scrape accepts each supported action and output.
- Unknown fields, JSON formats, `executeJavascript`, proxies, profiles, and code
  controls fail closed with deterministic paths.
- Invalid JSON and a missing PageSift scrape ID return the documented errors.
- Session IDs use `ps_` plus lowercase random hex, expire after ten minutes, and
  remove deterministically.
- Capacity uses only expired slots and returns `Retry-After: 1` when full.
- The four-slot response buffer releases capacity on success, error, abort, and
  timeout.

### Upstream Tests

- PageSift requests never receive incoming Gateway or Firecrawl authorization.
- Configured `PAGESIFT_API_KEY` is injected only for PageSift requests.
- Redirects are not followed.
- Hop-by-hop headers are stripped.
- Health probes accept only HTTP 200 with body `ok`.
- The active-jobs probe is unauthenticated when no PageSift key is configured
  and authenticated when one is available.
- A `401` or `404` from the active-jobs probe fails managed preflight.
- Managed preflight failure leaves Gateway and Firecrawl configuration unchanged.

### Integration Tests

- Common Scrape still uses DeepSeek when advanced is configured.
- Advanced Scrape uses PageSift only after keyed Firecrawl and Keyless cannot
  serve it.
- `deepseek-first` uses PageSift for advanced Scrape and DeepSeek for common
  Scrape.
- `no-fallback` never uses PageSift.
- A PageSift 429 or 500 passes through without a DeepSeek retry.
- An unavailable PageSift backend returns `503 advanced_backend_unavailable`.
- An advanced Scrape response receives a rewritten `ps_` ID.
- An invalid or sessionless PageSift success returns the documented `502`.
- POST and DELETE Interact route a `ps_` ID only to PageSift.
- Interact requests containing `code` or `language` fail closed.
- Unknown `ps_` IDs return `404 advanced_session_not_found`.
- PageSift `404` or `410` for a mapped session removes the mapping and returns
  `404 advanced_session_not_found`.
- Firecrawl session IDs never enter the PageSift path.
- Official Firecrawl SDK Scrape responses continue to parse after session ID
  rewriting.

### CLI And Service Tests

- Managed install passes advanced flags into the launch command.
- `gateway status` reports configured, reachable, and credential-configured
  states.
- Disabled status includes `advanced_backend.enabled: false`.
- `gateway stop` leaves a fake PageSift process untouched.
- `gateway uninstall` removes only Gateway-owned state.
- Human and JSON outputs remain deterministic.

No live PageSift, Firecrawl, or DeepSeek request is required in the automated
suite.

## Documentation

Update:

- `README.md` and `README.en.md` with the optional advanced route and one-command
  enablement.
- `docs/operations*.md` with PageSift configuration, supported capabilities,
  session behavior, error semantics, and security boundaries.
- `skills/deepseek-crawl/SKILL.md` with when to recommend the advanced backend.
- `skills/deepseek-crawl/references/cli-reference.md` with the new flags,
  environment variable, credential name, and status fields.
- `llms.txt` with the explicit PageSift installation boundary.
- `CHANGELOG.md` with the new optional capability.

Documentation must state:

- PageSift is not installed or managed by DeepSeek Crawl.
- PageSift is not required for the normal product.
- PageSift advanced mode does not provide full Firecrawl compatibility.
- Standalone Browser Sandbox, CDP, Playwright code, Agent, Monitor, Extract,
  Batch Scrape, Parse, and JSON extraction are not part of this release.

## Rollout

This is an opt-in minor feature. Existing users receive no behavioral change
unless they install with `--advanced` or provide an advanced URL.

Release notes must describe:

- The new optional PageSift backend.
- Its exact supported routes and features.
- The need to run PageSift externally.
- The absence of automatic PageSift or Chrome lifecycle management.
- The security boundary for PageSift credentials and remote URLs.

## Acceptance Criteria

- A fresh `gateway install` remains zero-configuration and does not probe
  PageSift.
- One optional flag enables a healthy local PageSift backend.
- Common operations remain on their existing provider chain.
- Advanced browser-dependent Scrape can use PageSift after Keyless fails.
- PageSift-created sessions remain owned by PageSift through Interact and stop.
- Firecrawl-owned sessions are never replayed on PageSift.
- Unsupported advanced operations fail explicitly.
- No PageSift or Firecrawl credential crosses the wrong backend boundary.
- Existing Gateway lifecycle commands do not manage external PageSift state.
- The full offline verification suite passes without PageSift running.
