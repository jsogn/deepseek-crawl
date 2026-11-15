# Firecrawl Fallback Capability Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reject unsupported Firecrawl request options before DeepSeek fallback so advanced semantics are never silently discarded.

**Architecture:** Add a small pure capability-validation module under `src/firecrawl/`, then call it after structural Zod parsing and before any DeepSeek client call in Search, Scrape, Map, and Crawl fallback paths. Firecrawl pass-through remains unchanged.

**Tech Stack:** TypeScript ESM, Zod, Node.js 22+, Vitest, Biome.

**Spec:** `docs/superpowers/specs/2026-11-15-firecrawl-fallback-capability-validation-design.md`

## Global Constraints

- Node.js must remain `>=22.12.0`.
- Do not add dependencies.
- Firecrawl requests selected for upstream pass-through must remain byte-for-byte unchanged.
- Capability validation runs only on the DeepSeek fallback path.
- Unsupported options return HTTP `400` with code `unsupported_fallback_feature`.
- Error messages contain option paths only, never credentials, query strings, URLs, or page content.
- Unsupported checks run before DeepSeek client resolution or execution.
- All tests remain offline and deterministic.
- Do not add Interact, screenshots, structured Extract, Agent, Monitor, Parse, Batch Scrape, or WebSocket fallback.

---

### Task 1: Add shared pure capability guards

**Files:**

- Create: `src/firecrawl/fallback-capabilities.ts`
- Create: `test/unit/fallback-capabilities.test.ts`

**Interfaces:**

- Consumes: `UnsupportedFallbackFeatureError` from `src/gateway/errors.ts`.
- Produces:
  - `collectUnsupportedKeys(value: Record<string, unknown>, allowedKeys: readonly string[], basePath?: string): string[]`
  - `collectUnsupportedFormats(formats: readonly (string | Record<string, unknown>)[] | undefined, basePath: string): string[]`
  - `collectUnsupportedSources(sources: readonly (string | Record<string, unknown>)[] | undefined, basePath: string): string[]`
  - `throwForUnsupportedOptions(paths: readonly string[]): void`

- [x] **Step 1: Write the failing helper tests**

Create `test/unit/fallback-capabilities.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  collectUnsupportedFormats,
  collectUnsupportedKeys,
  collectUnsupportedSources,
  throwForUnsupportedOptions,
} from "../../src/firecrawl/fallback-capabilities.js";

describe("Firecrawl fallback capability guards", () => {
  it("collects unsupported keys in deterministic order", () => {
    expect(
      collectUnsupportedKeys({ zeta: true, actions: [], url: "https://example.com/" }, ["url"]),
    ).toEqual(["actions", "zeta"]);
    expect(
      collectUnsupportedKeys(
        { onlyMainContent: true, formats: ["markdown"] },
        ["formats"],
        "scrapeOptions",
      ),
    ).toEqual(["scrapeOptions.onlyMainContent"]);
  });

  it("rejects non-Markdown formats and extra format keys", () => {
    expect(
      collectUnsupportedFormats(
        ["screenshot", { type: "json", schema: {} }, { type: "markdown", extra: true }],
        "formats",
      ),
    ).toEqual([
      "formats[0]",
      "formats[1].schema",
      "formats[1].type",
      "formats[2].extra",
    ]);
  });

  it("rejects non-web sources and extra source keys", () => {
    expect(
      collectUnsupportedSources(
        ["news", { type: "web" }, { type: "web", categories: ["docs"] }],
        "sources",
      ),
    ).toEqual(["sources[0]", "sources[2].categories"]);
  });

  it("throws one deterministic unsupported-option error", () => {
    expect(() =>
      throwForUnsupportedOptions(["scrapeOptions.actions", "actions", "actions"]),
    ).toThrow(
      "DeepSeek fallback does not support Firecrawl option `actions`.",
    );
    expect(() => throwForUnsupportedOptions([])).not.toThrow();
  });
});
```

- [x] **Step 2: Run the new unit test and confirm it fails**

Run:

```bash
npm test -- test/unit/fallback-capabilities.test.ts
```

Expected: FAIL because `src/firecrawl/fallback-capabilities.ts` does not exist.

- [x] **Step 3: Implement the helper module**

Create `src/firecrawl/fallback-capabilities.ts`:

```ts
import { UnsupportedFallbackFeatureError } from "../gateway/errors.js";

type OptionValue = string | Record<string, unknown>;

function optionPath(basePath: string, key: string): string {
  return basePath ? `${basePath}.${key}` : key;
}

export function collectUnsupportedKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
  basePath = "",
): string[] {
  const allowed = new Set(allowedKeys);
  return Object.keys(value)
    .filter((key) => !allowed.has(key))
    .map((key) => optionPath(basePath, key))
    .sort();
}

export function collectUnsupportedFormats(
  formats: readonly OptionValue[] | undefined,
  basePath: string,
): string[] {
  if (formats === undefined) {
    return [];
  }
  const unsupported: string[] = [];
  formats.forEach((format, index) => {
    const itemPath = `${basePath}[${index}]`;
    if (typeof format === "string") {
      if (format !== "markdown") {
        unsupported.push(itemPath);
      }
      return;
    }
    unsupported.push(...collectUnsupportedKeys(format, ["type"], itemPath));
    if (format.type !== "markdown") {
      unsupported.push(`${itemPath}.type`);
    }
  });
  return unsupported.sort();
}

export function collectUnsupportedSources(
  sources: readonly OptionValue[] | undefined,
  basePath: string,
): string[] {
  if (sources === undefined) {
    return [];
  }
  const unsupported: string[] = [];
  sources.forEach((source, index) => {
    const itemPath = `${basePath}[${index}]`;
    if (typeof source === "string") {
      if (source !== "web") {
        unsupported.push(itemPath);
      }
      return;
    }
    unsupported.push(...collectUnsupportedKeys(source, ["type"], itemPath));
    if (source.type !== "web") {
      unsupported.push(`${itemPath}.type`);
    }
  });
  return unsupported.sort();
}

export function throwForUnsupportedOptions(paths: readonly string[]): void {
  const [first] = [...new Set(paths)].sort();
  if (first === undefined) {
    return;
  }
  throw new UnsupportedFallbackFeatureError(
    `DeepSeek fallback does not support Firecrawl option \`${first}\`.`,
  );
}
```

- [x] **Step 4: Run the focused test and verify it passes**

Run:

```bash
npm test -- test/unit/fallback-capabilities.test.ts
```

Expected: PASS.

- [x] **Step 5: Run formatting, linting, and type checks**

Run:

```bash
npm run format:check
npm run lint
npm run typecheck
npm run typecheck:test
```

Expected: all pass.

- [x] **Step 6: Commit the helper**

```bash
git add src/firecrawl/fallback-capabilities.ts test/unit/fallback-capabilities.test.ts
git commit -m "feat: validate Firecrawl fallback capabilities"
```

---

### Task 2: Apply capability validation to Search, Scrape, and Map

**Files:**

- Modify: `src/firecrawl/compat.ts`
- Modify: `test/unit/firecrawl-compat.test.ts`

**Interfaces:**

- Consumes the four functions produced by Task 1.
- Produces no new public API; fallback functions keep their current signatures.

- [x] **Step 1: Add failing tests for unsupported fallback inputs**

In `test/unit/firecrawl-compat.test.ts`, add these tests inside the existing `describe` block:

```ts
  it("rejects Scrape actions before calling DeepSeek", async () => {
    const client = gateway();
    let fetches = 0;
    client.fetch = async () => {
      fetches += 1;
      return { title: "Example", content: "# Example" };
    };

    await expect(
      firecrawlScrapeFallback(
        {
          url: "https://example.com/",
          formats: ["markdown"],
          actions: [{ type: "click", selector: "#submit" }],
        },
        client,
      ),
    ).rejects.toThrow(
      "DeepSeek fallback does not support Firecrawl option `actions`.",
    );
    expect(fetches).toBe(0);
  });

  it("rejects unsupported Search sources and scrape options", async () => {
    await expect(
      firecrawlSearchFallback(
        {
          query: "DeepSeek",
          sources: [{ type: "news" }],
        },
        gateway(),
      ),
    ).rejects.toThrow("`sources[0].type`");

    await expect(
      firecrawlSearchFallback(
        {
          query: "DeepSeek",
          scrapeOptions: { formats: ["markdown"], onlyMainContent: true },
        },
        gateway(),
      ),
    ).rejects.toThrow("`scrapeOptions.onlyMainContent`");
  });

  it("rejects unsupported Map options", async () => {
    const reader = {
      async read() {
        throw new Error("Unexpected Sitemap read.");
      },
    };

    await expect(
      firecrawlMapFallback(
        {
          url: "https://example.com/",
          ignoreQueryParameters: true,
        },
        gateway(),
        reader,
      ),
    ).rejects.toThrow("`ignoreQueryParameters`");
  });
```

- [x] **Step 2: Run the focused tests and confirm they fail**

Run:

```bash
npm test -- test/unit/firecrawl-compat.test.ts
```

Expected: FAIL because unsupported fields are still ignored.

- [x] **Step 3: Integrate the shared guards**

At the top of `src/firecrawl/compat.ts`, import:

```ts
import {
  collectUnsupportedFormats,
  collectUnsupportedKeys,
  collectUnsupportedSources,
  throwForUnsupportedOptions,
} from "./fallback-capabilities.js";
```

Add constants after the schemas:

```ts
const SEARCH_FALLBACK_KEYS = ["query", "limit", "sources", "scrapeOptions"] as const;
const SCRAPE_FALLBACK_KEYS = ["url", "formats"] as const;
const MAP_FALLBACK_KEYS = ["url", "search", "limit"] as const;
```

At the start of `firecrawlSearchFallback`, immediately after Zod parsing, add:

```ts
  throwForUnsupportedOptions([
    ...collectUnsupportedKeys(parsed, SEARCH_FALLBACK_KEYS),
    ...collectUnsupportedSources(parsed.sources, "sources"),
    ...collectUnsupportedKeys(parsed.scrapeOptions ?? {}, ["formats"], "scrapeOptions"),
    ...collectUnsupportedFormats(parsed.scrapeOptions?.formats, "scrapeOptions.formats"),
  ]);
```

Remove the existing non-web source and non-Markdown format checks.

At the start of `firecrawlScrapeFallback`, immediately after Zod parsing, add:

```ts
  throwForUnsupportedOptions([
    ...collectUnsupportedKeys(parsed, SCRAPE_FALLBACK_KEYS),
    ...collectUnsupportedFormats(parsed.formats, "formats"),
  ]);
```

Remove the existing Markdown-only format check.

At the start of `firecrawlMapFallback`, immediately after Zod parsing, add:

```ts
  throwForUnsupportedOptions(collectUnsupportedKeys(parsed, MAP_FALLBACK_KEYS));
```

- [x] **Step 4: Run the focused compatibility tests**

Run:

```bash
npm test -- test/unit/firecrawl-compat.test.ts test/unit/fallback-capabilities.test.ts
```

Expected: PASS.

- [x] **Step 5: Run type checks**

Run:

```bash
npm run typecheck
npm run typecheck:test
```

Expected: PASS.

- [x] **Step 6: Commit Search, Scrape, and Map validation**

```bash
git add src/firecrawl/compat.ts test/unit/firecrawl-compat.test.ts
git commit -m "fix: fail closed for unsupported search fallback options"
```

---

### Task 3: Apply capability validation to Crawl

**Files:**

- Modify: `src/gateway/crawl-jobs.ts`
- Modify: `test/unit/gateway-crawl-jobs.test.ts`

**Interfaces:**

- Consumes Task 1 helpers.
- Preserves `new CrawlJobManager(...).create(input, client, reader, signal)`.

- [x] **Step 1: Replace the existing Crawl unsupported-option test table**

Replace the current `it.each` block in `test/unit/gateway-crawl-jobs.test.ts` with:

```ts
  it.each([
    [
      { scrapeOptions: { formats: ["screenshot"] } },
      "`scrapeOptions.formats[0]`",
    ],
    [
      { scrapeOptions: { formats: ["markdown"], actions: [{ type: "click" }] } },
      "`scrapeOptions.actions`",
    ],
    [
      { scrapeOptions: { formats: ["markdown"], onlyMainContent: true } },
      "`scrapeOptions.onlyMainContent`",
    ],
    [{ webhook: { url: "https://example.com/hook" } }, "`webhook`"],
    [{ allowExternalLinks: true }, "`allowExternalLinks`"],
    [{ allowSubdomains: true }, "`allowSubdomains`"],
  ])("rejects an unsupported DeepSeek Crawl option %#", (options, message) => {
    const manager = new CrawlJobManager({ idFactory: () => "dsc_unsupported" });
    expect(() =>
      manager.create(
        {
          url: "https://example.com/",
          sitemap: "skip",
          ...options,
        },
        gateway(),
        reader,
      ),
    ).toThrow(message);
  });
```

- [x] **Step 2: Run the focused Crawl tests and confirm they fail**

Run:

```bash
npm test -- test/unit/gateway-crawl-jobs.test.ts
```

Expected: FAIL for actions, nested options, webhook, and the new exact paths.

- [x] **Step 3: Integrate the shared guards**

At the top of `src/gateway/crawl-jobs.ts`, import:

```ts
import {
  collectUnsupportedFormats,
  collectUnsupportedKeys,
  throwForUnsupportedOptions,
} from "../firecrawl/fallback-capabilities.js";
```

Add after `crawlInputSchema`:

```ts
const CRAWL_FALLBACK_KEYS = [
  "url",
  "limit",
  "maxDiscoveryDepth",
  "sitemap",
  "ignoreQueryParameters",
  "includePaths",
  "excludePaths",
  "delay",
  "maxConcurrency",
  "allowExternalLinks",
  "allowSubdomains",
  "scrapeOptions",
] as const;
```

Immediately after `const parsed = crawlInputSchema.parse(input);` in `create`, add:

```ts
    throwForUnsupportedOptions([
      ...collectUnsupportedKeys(parsed, CRAWL_FALLBACK_KEYS),
      ...collectUnsupportedKeys(parsed.scrapeOptions ?? {}, ["formats"], "scrapeOptions"),
      ...collectUnsupportedFormats(parsed.scrapeOptions?.formats, "scrapeOptions.formats"),
      ...(parsed.allowExternalLinks ? ["allowExternalLinks"] : []),
      ...(parsed.allowSubdomains ? ["allowSubdomains"] : []),
    ]);
```

Remove the old format, external-link, and subdomain checks.

- [x] **Step 4: Run the focused Crawl and compatibility tests**

Run:

```bash
npm test -- test/unit/gateway-crawl-jobs.test.ts test/unit/firecrawl-compat.test.ts test/unit/fallback-capabilities.test.ts
```

Expected: PASS.

- [x] **Step 5: Commit Crawl validation**

```bash
git add src/gateway/crawl-jobs.ts test/unit/gateway-crawl-jobs.test.ts
git commit -m "fix: fail closed for unsupported crawl fallback options"
```

---

### Task 4: Prove gateway behavior and document the boundary

**Files:**

- Modify: `test/integration/firecrawl-gateway.test.ts`
- Modify: `README.md`
- Modify: `README.en.md`
- Modify: `docs/operations.md`
- Modify: `docs/operations.zh-CN.md`
- Modify: `skills/deepseek-crawl/references/cli-reference.md`
- Modify: `CHANGELOG.md`

**Interfaces:**

- Consumes the completed Search, Scrape, Map, and Crawl validation.
- Produces no runtime API change beyond the specified error behavior.

- [ ] **Step 1: Add a failing integration test for Firecrawl 402 plus `actions`**

Add near the existing unsupported-feature integration test:

```ts
  it("does not call DeepSeek when fallback Scrape contains actions", async () => {
    let deepSeekCalls = 0;
    let firecrawlCalls = 0;
    const server = await startGatewayServer({
      config: testConfig(),
      env: { FIRECRAWL_API_KEY: "fc-test" },
      deepseekClient: {
        async search() {
          throw new Error("Unexpected Search call.");
        },
        async fetch() {
          deepSeekCalls += 1;
          throw new Error("Unexpected Fetch call.");
        },
      },
      fetchImpl: async () => {
        firecrawlCalls += 1;
        return Response.json(
          { success: false, error: "Payment required." },
          { status: 402 },
        );
      },
    });
    servers.push(server);

    const response = await fetch(new URL("/v2/scrape", server.url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: "https://example.com/",
        formats: ["markdown"],
        actions: [{ type: "click", selector: "#submit" }],
      }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      success: false,
      error: "DeepSeek fallback does not support Firecrawl option `actions`.",
      code: "unsupported_fallback_feature",
    });
    expect(firecrawlCalls).toBe(1);
    expect(deepSeekCalls).toBe(0);
  });
```

- [ ] **Step 2: Add failing tests for no-credential, nested Search, and pass-through**

Add:

```ts
  it("fails closed for Scrape actions without a Firecrawl credential", async () => {
    let deepSeekCalls = 0;
    const server = await startGatewayServer({
      config: testConfig(),
      env: {},
      deepseekClient: {
        async search() {
          throw new Error("Unexpected Search call.");
        },
        async fetch() {
          deepSeekCalls += 1;
          throw new Error("Unexpected Fetch call.");
        },
      },
    });
    servers.push(server);

    const response = await fetch(new URL("/v2/scrape", server.url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: "https://example.com/",
        actions: [{ type: "click" }],
      }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: "unsupported_fallback_feature",
      error: "DeepSeek fallback does not support Firecrawl option `actions`.",
    });
    expect(deepSeekCalls).toBe(0);
  });

  it("fails closed for unsupported Search scrape options", async () => {
    let deepSeekCalls = 0;
    const server = await startGatewayServer({
      config: testConfig(),
      env: {},
      deepseekClient: {
        async search() {
          deepSeekCalls += 1;
          throw new Error("Unexpected Search call.");
        },
        async fetch() {
          throw new Error("Unexpected Fetch call.");
        },
      },
    });
    servers.push(server);

    const response = await fetch(new URL("/v2/search", server.url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: "DeepSeek",
        scrapeOptions: { formats: ["markdown"], onlyMainContent: true },
      }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: "unsupported_fallback_feature",
      error:
        "DeepSeek fallback does not support Firecrawl option `scrapeOptions.onlyMainContent`.",
    });
    expect(deepSeekCalls).toBe(0);
  });

  it("passes advanced Firecrawl options upstream unchanged", async () => {
    let upstreamBody = "";
    let deepSeekCalls = 0;
    const server = await startGatewayServer({
      config: testConfig(),
      env: { FIRECRAWL_API_KEY: "fc-test" },
      deepseekClient: {
        async search() {
          deepSeekCalls += 1;
          throw new Error("Unexpected Search call.");
        },
        async fetch() {
          deepSeekCalls += 1;
          throw new Error("Unexpected Fetch call.");
        },
      },
      fetchImpl: async (_input, init) => {
        upstreamBody = String(init?.body ?? "");
        return Response.json({ success: true, data: { markdown: "# Firecrawl" } });
      },
    });
    servers.push(server);

    const body = {
      url: "https://example.com/",
      formats: ["markdown"],
      actions: [{ type: "click", selector: "#submit" }],
    };
    const response = await fetch(new URL("/v2/scrape", server.url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      data: { markdown: "# Firecrawl" },
    });
    expect(upstreamBody).toBe(JSON.stringify(body));
    expect(deepSeekCalls).toBe(0);
  });
```

- [ ] **Step 3: Run the integration tests**

Run:

```bash
npm test -- test/integration/firecrawl-gateway.test.ts
```

Expected: PASS after the Task 2 and Task 3 integrations. A failure means one
gateway path bypassed the shared validators and must be fixed before continuing.

- [ ] **Step 4: Update user-facing compatibility documentation**

Add this sentence to the Firecrawl compatibility sections in `README.md`:

```markdown
DeepSeek fallback 只接受能够保真的闭集参数；例如 `actions`、等待、DOM 筛选或浏览器选项会返回
`unsupported_fallback_feature`，不会被静默忽略。Firecrawl 正常处理请求时，这些高级选项仍原样透传。
```

Add the aligned English text to `README.en.md`:

```markdown
DeepSeek fallback accepts only a closed set of options it can reproduce faithfully. Options such
as `actions`, waits, DOM filters, or browser controls return `unsupported_fallback_feature` instead
of being silently ignored. Advanced options still pass through unchanged whenever Firecrawl handles
the request.
```

Add the equivalent operational detail after the fallback-route paragraph in
`docs/operations.md` and `docs/operations.zh-CN.md`, and after the Firecrawl
fallback compatibility paragraph in
`skills/deepseek-crawl/references/cli-reference.md`.

- [ ] **Step 5: Add the changelog entry**

At the top of `CHANGELOG.md`, add:

```markdown
## Unreleased

### Fixed

- Reject unsupported Firecrawl options before DeepSeek fallback instead of
  silently dropping advanced semantics such as browser actions.
```

- [ ] **Step 6: Run the full verification suite**

Run:

```bash
npm run verify
```

Expected: formatting, linting, source/test type checks, all Vitest tests, package
creation, and isolated tarball installation all pass.

- [ ] **Step 7: Review the final diff**

Run:

```bash
git diff --check
git status --short --branch
git diff --stat
```

Expected: only the spec status change, helper, compatibility validation, Crawl
validation, tests, documentation, and changelog are present; worktree becomes
clean after the commit.

- [ ] **Step 8: Commit integration and documentation**

```bash
git add README.md README.en.md CHANGELOG.md docs/operations.md \
  docs/operations.zh-CN.md \
  skills/deepseek-crawl/references/cli-reference.md \
  test/integration/firecrawl-gateway.test.ts
git commit -m "test: cover fail-closed Firecrawl fallback"
```

---

## Final Acceptance Checklist

- [ ] Firecrawl-selected requests with advanced options remain unchanged.
- [ ] DeepSeek fallback rejects all fields outside the explicit matrix.
- [ ] `actions` never returns DeepSeek-generated success.
- [ ] Nested Search and Crawl options are checked.
- [ ] Errors return `400 unsupported_fallback_feature` and a deterministic path.
- [ ] No DeepSeek client call occurs after capability validation fails.
- [ ] README and operations docs state the closed-allowlist boundary.
- [ ] `npm run verify` passes.
