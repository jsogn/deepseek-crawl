# Changelog

## Unreleased

### Added

- Add `deepseek-crawl balance [--json] [-o <path>]` for non-billable
  account-balance and availability checks.
- Add resumable Batch Fetch jobs with `--job-dir`, `fetch status`, and
  `fetch resume`.

### Changed

- Make the DeepSeek Crawl Skill description provider-neutral: it applies only
  when the user or workflow selects DeepSeek, without ranking other providers.

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
