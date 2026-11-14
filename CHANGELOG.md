# Changelog

## 0.13.0 - 2026-11-14

### Added

- Add the optional `deepseek-crawl gateway` mode for Firecrawl v2-compatible
  Search, Scrape, Map, and asynchronous Crawl clients.
- Add Provider-specific `auth set|status|remove` support for `deepseek`,
  `firecrawl`, and `gateway` credentials.
- Add `auth import firecrawl` to copy an existing Firecrawl CLI credential into
  the private DeepSeek Crawl credential store with a masked hint.
- Add an explicit opt-in live Gateway smoke command that verifies Scrape, plus
  optional Search/Map matrix and bounded Crawl coverage, for Firecrawl
  passthrough and DeepSeek fallback through the official SDK.
- Add `firecrawl-first`, `deepseek-first`, and `no-fallback` provider policies
  through `--provider-mode` and `DEEPSEEK_GATEWAY_PROVIDER_MODE`.
- Add `gateway url`, `gateway status`, `/healthz`, and multi-instance runtime
  discovery with stale-state cleanup.
- Forward common Firecrawl requests to the Firecrawl upstream while preserving
  method, request body, authentication, status, and JSON response behavior.
- Fall back to DeepSeek Search, Fetch, Map, and Crawl when Firecrawl reports
  exhausted credits or no Firecrawl credential is configured.
- Expose local DeepSeek-backed Crawl jobs through Firecrawl job status, errors,
  expiration, and cancellation routes.
- Add non-root Docker, Compose, systemd, and Nginx deployment assets plus bilingual
  deployment guidance.

### Security

- Bind the gateway to loopback by default and require `--allow-remote` for a
  non-loopback listener.
- Require `GATEWAY_API_KEY` for non-loopback listeners and never forward the
  gateway token to the Firecrawl upstream.
- Rate-limit repeated authentication failures and cap concurrent gateway
  requests.
- Keep the Firecrawl upstream origin pinned independently of client request
  targets.
- Limit inbound gateway request bodies to 8 MiB and never log credentials.
- Stream Firecrawl upstream responses and cancel active local Crawl jobs during
  gateway shutdown.
- Add request IDs, bounded HTTP timeouts, and sanitized structured request logs.
- Return an explicit `426 websocket_not_supported` for SDK Watcher upgrades.

### Changed

- Local gateway mode starts at port `8787` and automatically selects the next
  available port; explicit ports and remote mode stay strict.
- Replace the multi-flag remote setup with `gateway --remote`, which requires a
  stored or environment-provided gateway token.
- Let local Firecrawl SDK clients use only the gateway URL while the gateway
  injects a stored provider credential.
- Group main help by user workflow, add subcommand help, mark DeepSeek-specific
  commands, and make `gateway status` report all credential readiness.

### Testing

- Verify the gateway against the official `firecrawl` 4.54.0 Node SDK for
  Search, Scrape, Map, Crawl, fallback, and structured error behavior.

## 0.12.0 - 2026-11-14

### Added

- Add `deepseek-crawl balance [--json] [-o <path>]` for non-billable
  account-balance and availability checks.
- Add resumable Batch Fetch jobs with `--job-dir`, `fetch status`, and
  `fetch resume`.

### Changed

- Make the DeepSeek Crawl Skill description provider-neutral: it applies only
  when the user or workflow selects DeepSeek, without ranking other providers.
- Harden resumable Batch Fetch recovery with disjoint job/output paths,
  URL-based request identity, atomic page publication, and an append-only
  recovery journal.

## 0.11.0 - 2026-11-14

### Added

- Add `deepseek-crawl init` to reuse or prompt for credentials, install the
  bundled Agent Skill, and run one aggregate non-billable doctor check.

### Changed

- Clarify first-run installation and `npx` Skill setup in the bilingual READMEs.

## 0.10.0 - 2026-11-14

### Breaking

- Crawl reports and baselines require schema version 2 with complete page
  metadata; version 1 baselines are rejected.
- Crawl Monitor state and resumable job checkpoints require schema version 2;
  version 1 state is rejected.
- Sitemap readers return only `entries`; the duplicate `urls`/`entries` shape is
  removed.

### Changed

- Baseline comparison uses one required page map instead of parallel hash-only
  and metadata compatibility structures.

## 0.9.0 - 2026-11-14

### Added

- Incremental Crawl and Change Monitor can reuse unchanged deepest-frontier
  Sitemap pages when their `lastmod` matches the stored baseline, avoiding
  unnecessary Fetch requests.
- Reports expose `stats.sitemap_lastmod_skipped`.

### Changed

- Baseline and monitor state retain page summaries and Sitemap `lastmod`
  metadata while remaining compatible with older reports and state.

## 0.8.1 - 2026-11-14

### Changed

- Reworked the Chinese and English READMEs around quick start, operation
  selection, and a smaller documentation map.
- Split advanced Crawl workflows and operational safety details into focused
  bilingual guides.
- Tag releases now publish through GitHub Actions Trusted Publishing with npm
  provenance.

### Fixed

- Package installation verification supports both npm 10 and npm 12 pack output.

## 0.8.0 - 2026-11-14

### Added

- Crawl Plan previews the initial frontier before child pages are fetched.
- Batch Fetch imports Map JSON directly and records per-page failures.
- Failed Batch Fetch and Crawl items can be retried from existing reports.
- Fetch, Batch, Crawl, Plan, and Retry support an explicit-TTL local page cache.
- Stable page `content_hash` values support baseline comparisons and changed-only output.
- Crawl jobs persist checkpoints and can be inspected or resumed after interruption.
- Crawl Change Monitor persists a baseline and emits one incremental report per run.

### Changed

- Resource bounds are enforced consistently across Batch, Crawl, Plan, and Retry.
- Cached Fetch scheduling and text processing reduce repeated API work.
- Test sources participate in TypeScript checking, and package installation is verified from the published artifact.
- CI covers Ubuntu and macOS with Node.js 22 and 24.

### Distribution

- Initial public npm release used staged publishing before the OIDC trusted
  publisher was configured.
