# Changelog

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
