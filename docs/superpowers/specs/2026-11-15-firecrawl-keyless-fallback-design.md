# Firecrawl Keyless Fallback Design

Date: 2026-11-15

Status: Pending spec review

Target release: next patch release after implementation

## Summary

Firecrawl provides a keyless free tier for selected endpoints. The gateway will
use that tier automatically as an intermediate provider when running as a local
loopback service in `firecrawl-first` mode.

Provider order:

```text
Firecrawl with credential
  -> Firecrawl Keyless
  -> DeepSeek fallback
```

Keyless is not a new user-visible provider mode. It is a transport tier inside
the existing `firecrawl-first` policy.

Remote gateways, `deepseek-first`, and `no-fallback` do not use Keyless.

## Goals

- Use Firecrawl's official free tier for supported operations without an API
  key.
- Use Keyless after a keyed Firecrawl `402`, before switching to DeepSeek.
- Support Post-Scrape Interact and Parse without integrating a browser runtime.
- Never forward or leak a client, environment, Keychain, or gateway credential
  on a Keyless request.
- Stop using Keyless immediately after `429` and enter a bounded cooldown.
- Preserve existing behavior for remote gateways and explicit provider modes.

## Non-goals

- IP rotation, proxy pools, header spoofing, or any attempt to bypass Keyless
  limits.
- Enabling Keyless on remote or non-loopback gateways.
- Keyless Crawl, Map, Extract, Batch Scrape, Agent, or job-status routes.
- Standalone Browser Sandbox creation through `POST /v2/interact`.
- Caching Keyless responses.
- Changing Firecrawl prices, plans, or account quota behavior.

## Local-Only Policy

Keyless is enabled only when all are true:

- Provider mode is `firecrawl-first`.
- The gateway listener is loopback-only.
- `config.allowRemote` is `false`.

The feature is disabled when:

- `--remote` or a non-loopback host is used.
- Provider mode is `deepseek-first`.
- Provider mode is `no-fallback`.

A remote deployment's source IP represents every caller. Automatic Keyless use
there would create a shared, unpredictable free quota and is outside this
design.

## Supported Keyless Routes

The gateway attempts Keyless only for the documented Firecrawl free surface:

- `POST /v2/scrape`
- `POST /v2/search`
- `POST /v2/parse`
- `POST /v2/parse/upload-url`
- `POST /v2/scrape/:id/interact`
- `DELETE /v2/scrape/:id/interact`
- `POST /v1/scrape`
- `POST /v1/search`
- `POST /v2/search/developer`
- `POST /v2/search/research`
- `POST /v2/search/government`
- `POST /v2/search/gov`

The route matcher is an explicit method-and-path allowlist. It is independent
of the DeepSeek fallback route table because Keyless supports some advanced
routes that have no DeepSeek equivalent.

All other routes never enter Keyless. In particular, Crawl, Map, Extract, Batch
Scrape, Agent, and job-status paths require a credential.

The existing 8 MiB gateway request-body limit continues to apply to Parse and
all other Keyless requests.

## Routing

### No Firecrawl Credential

For a local `firecrawl-first` request with no usable Firecrawl credential:

1. If the route supports Keyless, try Firecrawl Keyless.
2. If Keyless succeeds, return its response unchanged.
3. If Keyless returns `429`, record its cooldown and use the existing DeepSeek
   fallback when the route supports it.
4. If the route is keyless-only with no DeepSeek fallback, return the Keyless
   response.
5. If the route does not support Keyless, preserve the existing DeepSeek or
   unsupported-route behavior.

### Keyed Firecrawl Returns 402

For a local `firecrawl-first` request:

1. Try Firecrawl with the available credential.
2. On `402`, set the existing Firecrawl credit cooldown.
3. If the route supports Keyless, try Firecrawl Keyless without authorization.
4. If Keyless succeeds, return its response unchanged.
5. If Keyless returns `429`, set the Keyless cooldown and use DeepSeek fallback
   where available.
6. If Keyless is not supported for the route, use the existing fallback path.

### Active Cooldowns

During the existing keyed Firecrawl credit cooldown, a supported local route
tries Keyless before DeepSeek.

During the Keyless cooldown, no Keyless request is attempted. The gateway uses
DeepSeek fallback where available and returns the unsupported-route behavior
otherwise.

## Credential Handling

The upstream request helper gains two explicit credential modes:

- `configured`: preserve the current behavior and inject a configured key only
  when the caller did not send authorization.
- `keyless`: copy normal request headers, then remove `Authorization` entirely.

In Keyless mode the helper must not:

- Forward an incoming `Authorization` header.
- Inject `config.firecrawlApiKey`.
- Inject `FIRECRAWL_API_KEY`.
- Inject the remote gateway token.

The request body, method, path, query string, and non-authorization headers are
unchanged.

## Keyless 429 Cooldown

The gateway keeps a process-local Keyless cooldown:

- Prefer a valid `Retry-After` response header.
- Accept either delta-seconds or HTTP-date syntax.
- If no valid header exists, use 15 minutes.
- Do not make another Keyless request until the cooldown expires.
- Do not retry the same Keyless request after falling back to DeepSeek.

A Keyless `429` middleware or concurrency-limit response remains visible when
the route has no DeepSeek fallback.

## Non-429 Errors

- Keyless success: pass the status, content type, headers, and body through.
- Keyless `401`, `403`, `404`, invalid request, or `5xx`: pass through without
  DeepSeek fallback.
- Keyless transport failure before a response: return `502
  upstream_unavailable`, matching the existing Firecrawl transport behavior.

These rules keep authentication and upstream availability failures visible.

## Architecture

Add one focused module:

```text
src/gateway/keyless.ts
```

Responsibilities:

- Match supported method/path pairs.
- Parse `Retry-After`.
- Own a small `KeylessCooldown` abstraction with injected `now`.

Modify:

- `src/firecrawl/upstream.ts`
  - Add the explicit `credentialMode` request option.
  - Strip authorization in Keyless mode.
- `src/gateway/handler.ts`
  - Integrate the intermediate Keyless attempt after keyed Firecrawl `402`,
    during credit cooldown, or when no credential exists.
  - Preserve DeepSeek routing after Keyless `429`.
  - Record provider and fallback reason.

The route matcher knows nothing about DeepSeek capabilities. The handler owns
the ordering because only it knows whether a route has a DeepSeek fallback.

## Observability

Request logs use:

- `provider: "firecrawl-keyless"` on a Keyless response.
- `fallback: true` when Keyless replaces a keyed Firecrawl attempt.
- `fallback_reason: "firecrawl_keyless_no_credential"` when no key was present.
- `fallback_reason: "firecrawl_keyless_after_credits"` after keyed `402`.
- `fallback_reason: "firecrawl_keyless_cooldown"` when Keyless is skipped
  because of its cooldown and DeepSeek handles the request.
- `fallback_reason: "firecrawl_keyless_rate_limited"` when Keyless returns
  `429` and DeepSeek handles the request.

Logs never include authorization, request bodies, query strings, page content,
or full target URLs.

Existing `/healthz` fields remain unchanged. Keyless availability is derived
from local loopback and provider mode rather than a credential.

## Testing

All tests are offline and deterministic.

Unit tests:

- Route matcher accepts the exact Keyless allowlist.
- Route matcher rejects Crawl, Map, Extract, Batch, Agent, status, and
  standalone `/v2/interact`.
- `Retry-After` parser accepts seconds and HTTP dates.
- Invalid or missing `Retry-After` uses 15 minutes.
- Cooldown expires with injected time.

Upstream tests:

- `credentialMode: "configured"` preserves existing authorization behavior.
- `credentialMode: "keyless"` removes incoming authorization.
- Keyless mode never injects configured or environment credentials.

Integration tests:

- Local no-key Scrape uses Keyless and does not call DeepSeek.
- Keyed Firecrawl `402` followed by Keyless success does not call DeepSeek.
- Keyless `429` followed by DeepSeek fallback avoids another Keyless call during
  cooldown.
- Keyless-only Parse and Post-Scrape Interact responses pass through.
- Keyless-only `429` passes through when DeepSeek has no fallback.
- Remote mode never emits a Keyless request.
- `deepseek-first` and `no-fallback` retain existing behavior.
- Crawl and Map do not attempt Keyless without a credential.
- Official SDK tests continue to pass for keyed and DeepSeek fallback.

No live Keyless request is required in the automated suite.

## Documentation

Update:

- README and README.en.md provider strategy tables.
- Operations guides with the loopback-only rule and Keyless cooldown.
- CLI reference with supported Keyless routes.
- Agent installation contract only if behavior differs from its current
  no-credential guidance.
- CHANGELOG with the intermediate Firecrawl Keyless tier.

Documentation must state that Keyless is free but per-IP rate-limited, is not
available in remote mode, and must not be treated as unlimited production
capacity.

## Rollout

This is a feature-level provider routing change. It does not change the public
provider-mode enum or managed service lifecycle.

Release notes must describe:

- Local `firecrawl-first` gateways may now use Firecrawl Keyless before
  DeepSeek.
- Keyless quota is shared by the machine's public IP and bounded by Firecrawl.
- Remote gateways never use Keyless automatically.
