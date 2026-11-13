# Batch Fetch and Crawl Path Filters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `deepseek-crawl@0.6.0` with batch Fetch input and Crawl path/query filters.

**Architecture:** Add a batch application service and staged output writer, plus a small pure path-filter module shared by Crawl. Expose both through the existing CLI without changing MCP.

**Spec:** `docs/superpowers/specs/2026-11-14-batch-fetch-path-filters-design.md`

## Global Constraints

- Target version `0.6.0`.
- Batch defaults: concurrency 3, delay 250 ms, max chars 0.
- Batch input supports Map JSON, URL arrays, URL objects, and newline text.
- Batch output directory is required, atomic, and no-clobber.
- Invalid URLs and page failures are structured failures.
- Crawl path matching uses pathname prefix and `*`/`?` wildcards.
- Include filters require one match; exclude filters always win.
- Seed URL bypasses path filters.
- `--ignore-query-parameters` applies to seed and links before dedupe/fetch.
- No new runtime dependencies; MCP unchanged.

---

### Task 1: Version 0.6.0

- Modify `package.json`, `package-lock.json`, `src/version.ts`.
- Update smoke and package executable assertions to `0.6.0`.
- Run focused tests, then commit `chore: prepare v0.6.0 discovery tools`.

---

### Task 2: Crawl Filter Module

**Files:**

- Create: `src/crawl/filters.ts`
- Create: `test/unit/crawl-filters.test.ts`
- Modify: `src/application/crawl.ts`
- Modify: `src/crawl/types.ts`
- Modify: `test/unit/crawl.test.ts`

**Interfaces:**

```ts
export interface CrawlUrlFilterOptions {
  includePaths: string[];
  excludePaths: string[];
  ignoreQueryParameters: boolean;
}

export function canonicalizeCrawlUrl(
  value: string | URL,
  base?: URL,
  ignoreQueryParameters?: boolean,
): URL | undefined;

export function createCrawlPathFilter(
  includePaths: string[],
  excludePaths: string[],
): (url: URL) => boolean;
```

Crawl options gain:

```ts
includePaths: string[];
excludePaths: string[];
ignoreQueryParameters: boolean;
```

Implementation:

- Normalize patterns, reject empty entries.
- No wildcard means prefix with path-segment boundary.
- Convert `*` and `?` to anchored regex.
- Apply canonicalization to seed.
- Apply path filters only to discovered links.
- Deduplicate query variants when enabled.
- Preserve default behavior with empty filters and `false`.

Tests:

- Prefix and wildcard include/exclude.
- Include OR and exclude precedence.
- Seed bypass.
- Query stripping and dedupe.

Commit `feat: add crawl path and query filters`.

---

### Task 3: Batch Fetch Application

**Files:**

- Create: `src/batch/types.ts`
- Create: `src/application/batch.ts`
- Create: `test/unit/batch.test.ts`
- Modify: `src/application/index.ts`
- Modify: `src/index.ts`

**Interfaces:**

```ts
export interface BatchFetchOptions {
  concurrency: number;
  delayMs: number;
  maxChars: number;
  now?: () => Date;
}

export interface BatchFetchPage {
  index: number;
  url: string;
  title: string;
  content: string;
  contentTruncated: boolean;
  contentOriginalLength: number;
}

export interface BatchFetchResult {
  version: 1;
  source: string;
  started_at: string;
  finished_at: string;
  settings: {
    concurrency: number;
    delay_ms: number;
    max_chars: number;
  };
  stats: {
    input: number;
    unique: number;
    fetched: number;
    failed: number;
  };
  pages: BatchFetchPageSummary[];
  failures: BatchFetchFailure[];
}

export function parseBatchFetchInput(text: string): string[];

export async function executeBatchFetch(
  client: DeepSeekGateway,
  inputText: string,
  source: string,
  options: BatchFetchOptions,
  onPage: (page: BatchFetchPage) => Promise<void>,
  signal?: AbortSignal,
): Promise<BatchFetchResult>;
```

Implementation:

- Structured JSON parsing with newline fallback.
- Normalize/dedupe URLs; invalid inputs become `invalid_url` failures.
- Use `runLayeredTasks`.
- Bounded DeepSeek Fetch and 1,000,000-code-point page cap.
- Partial failures do not abort.
- All failures still return a result; CLI decides exit 1.

Tests cover every input format, dedupe, invalid URLs, concurrency order, partial
and total failure.

Commit `feat: add batch fetch application`.

---

### Task 4: Batch Output Writer

**Files:**

- Create: `src/output/batch.ts`
- Create: `test/unit/batch-output.test.ts`

**Interfaces:**

- `createBatchFetchOutputWriter(finalDirectory)` returning
  `{ writePage, finish, abort }`.
- `finish(result)` augments page summaries with paths and returns a
  `BatchFetchOutputResult`.

Behavior:

- Reject existing directories.
- Stage under a hidden sibling.
- Stable `pages/NNNN-slug.md` names.
- Write `fetch.json`.
- Atomic final rename.
- Idempotent abort.

Commit `feat: write batch fetch output atomically`.

---

### Task 5: CLI Batch Fetch and Crawl Options

**Files:**

- Modify: `src/cli/parse.ts`
- Modify: `src/cli/run.ts`
- Modify: `test/unit/cli-parse.test.ts`
- Modify: `test/unit/cli-run.test.ts`

**CLI:**

```text
deepseek-crawl fetch <url> [existing options]

deepseek-crawl fetch --input <path|->
  --output-dir <dir>
  [--concurrency <1..5>]
  [--delay-ms <0..5000>]
  [--max-chars <0..1000000>]
  [--json]

deepseek-crawl crawl ... 
  [--include-paths <patterns>]
  [--exclude-paths <patterns>]
  [--ignore-query-parameters]
```

Parsing:

- Exactly one of URL or `--input`.
- Batch requires output-dir.
- Batch stdin is read from `CliDependencies.stdin`.
- Batch all-fail exits 1 after publishing report.
- Human output prints counts and output path; JSON prints result.

Tests cover parser validation, injected stdin, batch success/partial/all-fail,
Crawl option forwarding.

Commit `feat: expose batch fetch and crawl filters`.

---

### Task 6: Docs, Skill, Verification, Release

**Files:**

- Modify `README.md`, `README.en.md`, `skills/deepseek-crawl/SKILL.md`,
  `skills/deepseek-crawl/references/cli-reference.md`,
  `test/unit/package.test.ts`.

Document:

- Map JSON feeding Batch Fetch.
- `fetch --input -`.
- `--output-dir`.
- Crawl path examples.
- Query-parameter dedupe.

Skill workflow:

```text
Map --search → Fetch --input map.json --output-dir ...
Crawl docs with --include-paths /docs
```

Run:

```bash
npm run verify
python3 <skill-creator>/scripts/quick_validate.py skills/deepseek-crawl
```

Run live smoke:

- Map DeepSeek docs with `--json`.
- Batch Fetch from Map JSON into a temp no-clobber directory.
- Crawl root with `--include-paths /guides --max-pages 2`.

Commit docs, merge to `main`, push, wait for CI, and publish GitHub release
`v0.6.0`.

## Acceptance Checklist

- [ ] Map JSON works as Batch Fetch input.
- [ ] Batch output is atomic and partial failures are preserved.
- [ ] Crawl include/exclude and wildcard rules work.
- [ ] Query-ignored variants deduplicate.
- [ ] CLI and Skill document the new workflows.
- [ ] Version is `0.6.0`.
- [ ] Offline and live verification pass.
- [ ] `main`, CI, and GitHub Release are updated.
