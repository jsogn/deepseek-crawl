# Firecrawl Fallback Capability Validation Design

Date: 2026-11-15

Status: Pending spec review

Target release: next patch release

## Summary

The Firecrawl-compatible gateway currently validates output formats before
using a DeepSeek fallback, but it passes through and ignores several request
options that DeepSeek cannot reproduce. In particular, a Scrape request that
contains browser `actions` can return `success: true` from DeepSeek without
performing the actions.

This change makes fallback capability validation a closed allowlist. A request
may use DeepSeek fallback only when every input field has an explicit,
semantically faithful mapping. Otherwise the gateway returns a Firecrawl-shaped
`unsupported_fallback_feature` error without calling DeepSeek.

Firecrawl requests that remain on the upstream path are unchanged.

## Goals

- Prevent unsupported Firecrawl options from being silently ignored during
  DeepSeek fallback.
- Fail closed before any DeepSeek request when a fallback request contains an
  unknown or unsupported field.
- Report the unsupported field path in the error message.
- Share validation rules between Search, Scrape, Map, and Crawl fallback code.
- Preserve normal Firecrawl pass-through when Firecrawl is selected.
- Keep validation deterministic and fully offline-testable.

## Non-goals

- Adding browser interaction, screenshots, structured Extract, Agent, Monitor,
  Parse, or Batch Scrape fallback.
- Emulating browser sessions or WebSocket/CDP traffic.
- Rejecting advanced options while a request is still being sent to Firecrawl.
- Changing provider selection, cooldown behavior, routing, or remote gateway
  authentication.
- Adding compatibility shims for previously silently ignored fallback options.

## Routing Invariant

Capability validation runs only after the gateway has decided to use DeepSeek
fallback.

The existing routing rules remain unchanged:

1. In `firecrawl-first` mode, try Firecrawl first.
2. Enter fallback only for a supported route after Firecrawl returns `402`,
   while the exhausted-credit cooldown is active, or when no Firecrawl
   credential is configured.
3. Pass unknown Firecrawl routes through to Firecrawl and never attempt
   DeepSeek fallback for them.
4. If Firecrawl stays selected, send the original request body without
   capability filtering.

This ensures that advanced Firecrawl requests continue to work with their full
upstream semantics while credits are available.

## Fallback Input Matrix

### Search

Allowed top-level fields:

- `query`
- `limit`
- `sources`
- `scrapeOptions`

Allowed `sources` entries:

- The string `web`
- An object containing only `type: "web"`

Allowed `scrapeOptions` fields:

- `formats`, containing only `markdown` strings or objects containing only
  `type: "markdown"`

### Scrape

Allowed top-level fields:

- `url`
- `formats`, containing only `markdown` strings or objects containing only
  `type: "markdown"`

An absent `formats` field remains supported because the current fallback returns
Markdown by default.

### Map

Allowed top-level fields:

- `url`
- `search`
- `limit`

### Crawl

Allowed top-level fields:

- `url`
- `limit`
- `maxDiscoveryDepth`
- `sitemap`
- `ignoreQueryParameters`
- `includePaths`
- `excludePaths`
- `delay`
- `maxConcurrency`
- `allowExternalLinks`
- `allowSubdomains`
- `scrapeOptions`

`allowExternalLinks` and `allowSubdomains` may be absent or `false`. Existing
behavior rejects `true`.

Allowed `scrapeOptions` fields:

- `formats`, containing only `markdown` strings or objects containing only
  `type: "markdown"`

All other top-level or nested fields are unsupported for fallback. This includes
`actions`, `waitFor`, DOM inclusion/exclusion, proxy and location controls,
webhooks, screenshots, structured JSON formats, and any future option not
explicitly added to this matrix.

The official Node SDK sends only caller-provided Scrape options; it does not
materialize `maxAge`, `onlyMainContent`, `storeInCache`, or similar defaults onto
the wire. SDK-only options such as `autoResume` are also excluded from the
request body. Therefore default SDK calls remain compatible with the strict
allowlist, while an explicitly supplied advanced option fails closed only when
DeepSeek fallback is selected.

## Validation Architecture

Add one focused module:

```text
src/firecrawl/fallback-capabilities.ts
```

It owns pure capability guards shared by `src/firecrawl/compat.ts` and
`src/gateway/crawl-jobs.ts`:

- Assert that a record contains only an allowed set of keys.
- Assert Markdown-only format arrays.
- Assert web-only Search sources.
- Produce deterministic field paths such as `actions` or
  `scrapeOptions.onlyMainContent`.

Existing Zod schemas continue to validate field types and required values.
Capability validation runs after structural parsing and throws
`UnsupportedFallbackFeatureError` for unsupported field names or values.

Validation order:

1. Structural parsing rejects malformed JSON and invalid field types.
2. Capability validation rejects unsupported fields and values.
3. Only after both checks pass may a DeepSeek application call start.

The shared helper does not know about HTTP, either provider, or response
formatting.

## Error Contract

Unsupported fallback input returns HTTP `400` with Firecrawl-shaped JSON:

```json
{
  "success": false,
  "error": "DeepSeek fallback does not support Firecrawl option `actions`.",
  "code": "unsupported_fallback_feature"
}
```

Nested fields include their path:

```json
{
  "success": false,
  "error": "DeepSeek fallback does not support Firecrawl option `scrapeOptions.onlyMainContent`.",
  "code": "unsupported_fallback_feature"
}
```

If multiple fields are unsupported, report the lexicographically first field
path so repeated requests produce deterministic errors.

Malformed types and missing required fields continue to use the existing
`invalid_request` error.

## Safety

- No supported route may return a DeepSeek-generated success for a request
  containing unsupported semantics.
- Unsupported capability checks happen before DeepSeek client resolution or
  request execution.
- Error messages contain option paths only, never page content, query strings,
  credentials, or full target URLs.

## Testing

All tests are offline and deterministic.

Unit tests:

- Scrape `actions` is rejected with `unsupported_fallback_feature`.
- Scrape unknown fields and non-Markdown formats are rejected.
- Search non-web sources, unsupported nested `scrapeOptions` fields, and format
  object extras are rejected.
- Map unknown fields are rejected.
- Crawl `scrapeOptions.actions`, unknown nested fields, and unknown top-level
  fields are rejected.
- Supported Markdown and mapped Crawl inputs continue to work.
- Multiple unsupported fields produce a deterministic field path.

Integration tests:

- A `402` Scrape response with `actions` returns `400` and does not call the
  DeepSeek client.
- A no-credential Scrape request with `actions` follows the same fail-closed
  path.
- Search and Crawl fallback reject unsupported nested `scrapeOptions`.
- A request with advanced options but available Firecrawl credentials is still
  forwarded unchanged and can return the Firecrawl response.
- Gateway logs continue to exclude bodies, credentials, query strings, and full
  URLs.

No live provider test is required for this change.

## Documentation

Update the operations and CLI compatibility documentation to state:

- Advanced options pass through only while Firecrawl handles the request.
- DeepSeek fallback uses a closed allowlist.
- Unsupported options fail closed with `unsupported_fallback_feature`.

Do not describe the gateway as capable of browser interaction or full Firecrawl
parity.

## Rollout

This is a patch-level correctness change. It intentionally stops returning
false-positive success for previously ignored fallback options.

Release notes must state that advanced options now pass through unchanged when
Firecrawl is available, but are rejected rather than ignored when DeepSeek
fallback cannot preserve their semantics.
