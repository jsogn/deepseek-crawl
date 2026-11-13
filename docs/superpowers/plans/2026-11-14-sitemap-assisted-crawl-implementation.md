# Sitemap-Assisted Crawl Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `deepseek-crawl@0.7.0` with Sitemap-assisted CLI Crawl.

**Architecture:** Extend Crawl options with an optional Sitemap reader and mode, seed the frontier from Sitemap before layered BFS, and propagate warnings. CLI defaults to `include`; MCP remains `skip`.

**Spec:** `docs/superpowers/specs/2026-11-14-sitemap-assisted-crawl-design.md`

## Global Constraints

- Target version `0.7.0`.
- CLI Sitemap modes: `include` default, `only`, `skip`.
- Sitemap candidate depth is `1`.
- Preserve same-origin, path, query, page, depth, and discovery limits.
- Sitemap errors warn; seed errors remain fatal.
- MCP output contract and behavior remain backward compatible.
- No new dependencies.

---

### Task 1: Version 0.7.0

- Update package, lock, source version, smoke/package tests to `0.7.0`.
- Commit `chore: prepare v0.7.0 sitemap crawl`.

---

### Task 2: Sitemap-Aware Crawl Application

**Files:**

- Modify `src/crawl/types.ts`
- Modify `src/application/crawl.ts`
- Modify `test/unit/crawl.test.ts`

**Types:**

```ts
export type CrawlSitemapMode = "include" | "only" | "skip";

export interface CrawlSitemapReader {
  read(
    seedUrl: URL,
    options: { maxDocuments: number; maxCandidates: number },
    signal?: AbortSignal,
  ): Promise<{
    urls: URL[];
    warnings: MapWarning[];
    truncated: boolean;
  }>;
}
```

`CrawlOptions` adds `sitemapMode` and `sitemapReader`. Result settings/stats gain
optional Sitemap metadata; `warnings` is always present.

Implementation:

- Fetch seed.
- If mode not `skip`, read Sitemap.
- Canonicalize/filter Sitemap URLs like Markdown links.
- Seed Sitemap candidates at depth `1`.
- Include mode merges both sources; only ignores seed links; skip does not call
  reader.
- Sitemap failure becomes warning.
- Preserve deterministic bounded collection.

Tests cover all three modes, filters, warnings, and no reader call in skip mode.

Commit `feat: add sitemap-assisted crawl discovery`.

---

### Task 3: CLI and MCP Compatibility

**Files:**

- Modify `src/cli/parse.ts`
- Modify `src/cli/run.ts`
- Modify `test/unit/cli-parse.test.ts`
- Modify `test/unit/cli-run.test.ts`
- Verify `src/mcp/server.ts`
- Modify MCP tests only if optional result fields require it.

CLI:

```text
--sitemap <include|only|skip>
```

Default `include`.

CLI passes `new SitemapReader()` to Crawl. MCP calls application without these
options, preserving `skip` behavior.

Tests cover parser/help/forwarding, Sitemap success/failure, and MCP unchanged.

Commit `feat: expose sitemap-assisted crawl in CLI`.

---

### Task 4: Docs, Skill, Verification, Release

Update Chinese/English README and Skill CLI reference:

- Sitemap-assisted Crawl default.
- `only`/`skip` semantics.
- Warnings/candidate stats.
- Live docs example.

Run:

```bash
npm run verify
python3 <skill-creator>/scripts/quick_validate.py skills/deepseek-crawl
deepseek-crawl crawl "https://api-docs.deepseek.com/" \
  --max-depth 1 --max-pages 2 \
  --include-paths /guides --ignore-query-parameters \
  -o .deepseek-crawl/v0.7-live/crawl
```

Expected: seed plus at least one Sitemap-discovered `/guides` page.

Merge to `main`, push, wait for CI, create `v0.7.0` GitHub Release.

## Acceptance Checklist

- [ ] CLI Crawl defaults to Sitemap include.
- [ ] `include`, `only`, and `skip` work.
- [ ] Same-origin/path/query limits apply to Sitemap URLs.
- [ ] Sitemap failures are warnings.
- [ ] MCP remains Markdown-only and backward compatible.
- [ ] Version `0.7.0`, tests, Skill validation, live smoke, CI, and Release pass.
