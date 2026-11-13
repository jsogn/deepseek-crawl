# Firecrawl Capability Replacement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add bounded Map and Crawl capabilities to the existing DeepSeek CLI and MCP server, producing a capability-oriented alternative to Firecrawl without API compatibility.

**Architecture:** Keep DeepSeek HTTP access isolated in the existing client, add a deterministic layered BFS application service, and share Map/Crawl results between CLI and MCP. Sitemap discovery uses a separately validated public-network reader; CLI file output and MCP bounded aggregation remain transport concerns.

**Tech Stack:** Node.js 22.12+, strict TypeScript/ESM, Zod, MCP SDK, Vitest, Biome, `markdown-it@15.0.3`, and `fast-xml-parser@5.12.1`.

**Spec:** `docs/superpowers/specs/2026-11-13-firecrawl-capability-replacement-design.md`

## Global Constraints

- Target package version is exactly `0.2.0`; package remains `private: true` and `UNLICENSED`.
- Node.js floor is `>=22.12.0`.
- Runtime dependencies remain pinned; add only `markdown-it@15.0.3` and `fast-xml-parser@5.12.1`.
- Preserve existing Search, Fetch, Doctor, and stdio MCP behavior unless the spec extends it.
- Firecrawl API/SDK compatibility is not a goal.
- Do not add browser automation, JavaScript rendering, server-side Extract, job queues, or cross-origin traversal.
- Do not fetch or enforce `robots.txt`.
- CLI Crawl defaults: depth 2, 20 pages, concurrency 2, delay 250 ms, discovery cap 10,000, page content cap 1,000,000 Unicode code points.
- MCP Crawl defaults: depth 2, 10 pages, concurrency 2, delay 250 ms, discovery cap 2,000, per-page content default 4,000, aggregate content cap 100,000.
- Map defaults: CLI limit 500, MCP limit 100; hard limits 1,000 and 500 respectively.
- DeepSeek Fetch response body hard limit is 8 MiB.
- Sitemap limits: 10 documents, 10,000 candidates, 5 MiB per response, 15 second request timeout, three same-origin redirects.
- Direct Sitemap access is public-network-only and must connect to the validated address.
- CLI Map output is a new file; CLI Crawl output is a new directory; neither overwrites existing paths.
- MCP never writes files.
- SIGINT exits with code `130`; usage errors exit `2`; other failures exit `1`.
- All normal tests are offline and use fixtures or injected dependencies.

---

## File Structure

Create:

- `src/deepseek/gateway.ts`: shared DeepSeek gateway interface without application-layer coupling.
- `src/crawl/types.ts`: Crawl, Map warning, and result contracts.
- `src/crawl/links.ts`: Markdown link extraction and URL normalization.
- `src/crawl/queue.ts`: deterministic layered concurrency and delay scheduler.
- `src/application/crawl.ts`: Crawl validation, BFS policy, and result assembly.
- `src/application/map.ts`: Sitemap plus seed-page Map orchestration.
- `src/sitemap/network-policy.ts`: public-address validation and safe request target resolution.
- `src/sitemap/reader.ts`: Sitemap HTTP, redirect, size, XML, and index handling.
- `src/output/crawl.ts`: Crawl directory staging, page files, summaries, and formatting.
- `src/output/map.ts`: Map file/human formatting helpers.
- `test/unit/links.test.ts`
- `test/unit/crawl-queue.test.ts`
- `test/unit/crawl.test.ts`
- `test/unit/crawl-output.test.ts`
- `test/unit/network-policy.test.ts`
- `test/unit/sitemap.test.ts`
- `test/unit/map.test.ts`
- `test/unit/map-output.test.ts`
- `test/fixtures/sitemap-urlset.xml`
- `test/fixtures/sitemap-index.xml`

Modify:

- `package.json`
- `package-lock.json`
- `src/version.ts`
- `src/deepseek/errors.ts`
- `src/deepseek/client.ts`
- `src/application/index.ts`
- `src/output/files.ts`
- `src/cli/parse.ts`
- `src/cli/run.ts`
- `src/bin.ts`
- `src/mcp/server.ts`
- `src/index.ts`
- `test/smoke.test.ts`
- `test/unit/package.test.ts`
- `test/unit/client.test.ts`
- `test/unit/files.test.ts`
- `test/unit/cli-parse.test.ts`
- `test/unit/cli-run.test.ts`
- `test/unit/mcp.test.ts`
- `test/integration/mcp-stdio.test.ts`
- `README.md`

---

### Task 1: Version, Dependencies, and Gateway Boundary

**Files:**

- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `src/version.ts`
- Modify: `src/application/index.ts`
- Create: `src/deepseek/gateway.ts`
- Modify: `test/smoke.test.ts`
- Modify: `test/unit/package.test.ts`

**Interfaces:**

- Consumes: existing `SearchInput`, `FetchInput`, `RawSearchResponse`, `RawFetchResponse`.
- Produces: `DeepSeekGateway` from `src/deepseek/gateway.ts`; `packageVersion === "0.2.0"`.

- [ ] **Step 1: Write failing version tests**

Update `test/smoke.test.ts` and `test/unit/package.test.ts` so both expect `0.2.0`.

```ts
expect(packageName).toBe("deepseek-crawl");
expect(packageVersion).toBe("0.2.0");
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npm run test -- test/smoke.test.ts test/unit/package.test.ts`

Expected: FAIL because `packageVersion` is still `0.1.0`.

- [ ] **Step 3: Add package metadata and gateway interface**

Run:

```bash
npm install --save-exact markdown-it@15.0.3 fast-xml-parser@5.12.1
```

Set the package version and description in `package.json`:

```json
{
  "name": "deepseek-crawl",
  "version": "0.2.0",
  "description": "AI-facing CLI and MCP tools for DeepSeek Search, Fetch, Map, and Crawl",
  "private": true,
  "license": "UNLICENSED"
}
```

Set `src/version.ts`:

```ts
export const packageVersion = "0.2.0";
```

Move the interface from `src/application/index.ts` into `src/deepseek/gateway.ts`:

```ts
import type {
  FetchInput,
  RawFetchResponse,
  RawSearchResponse,
  SearchInput,
} from "../types.js";

export interface DeepSeekGateway {
  search(input: SearchInput, signal?: AbortSignal): Promise<RawSearchResponse>;
  fetch(input: FetchInput, signal?: AbortSignal): Promise<RawFetchResponse>;
}
```

Import and re-export the type from `src/application/index.ts` so existing imports remain valid:

```ts
export type { DeepSeekGateway } from "../deepseek/gateway.js";
```

- [ ] **Step 4: Run focused and baseline tests**

Run: `npm run test -- test/smoke.test.ts test/unit/package.test.ts`

Expected: PASS.

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json src/version.ts src/deepseek/gateway.ts src/application/index.ts test/smoke.test.ts test/unit/package.test.ts
git commit -m "chore: prepare v0.2.0 crawl capabilities"
```

---

### Task 2: Limit DeepSeek Fetch Response Bodies

**Files:**

- Modify: `src/deepseek/errors.ts`
- Modify: `src/deepseek/client.ts`
- Modify: `test/unit/client.test.ts`

**Interfaces:**

- Consumes: existing `DeepSeekClientOptions`.
- Produces: `fetchResponseByteLimit?: number` on `DeepSeekClientOptions`, defaulting to `8 * 1024 * 1024`.
- Produces: `DeepSeekErrorKind` includes `"resource_limit"`.

- [ ] **Step 1: Write failing response-limit tests**

Add tests to `test/unit/client.test.ts` using a small injected limit:

```ts
it("rejects Fetch bodies above the configured byte limit", async () => {
  const { client } = createClient(
    async () =>
      new Response(JSON.stringify({ title: "Large", content: "x".repeat(100) }), {
        headers: { "content-type": "application/json" },
      }),
    { fetchResponseByteLimit: 32 },
  );

  await expect(client.fetch({ url: "https://example.com" })).rejects.toMatchObject({
    kind: "resource_limit",
  });
});

it("does not apply the Fetch byte limit to Search", async () => {
  const { client } = createClient(async () => Response.json(searchResponse), {
    fetchResponseByteLimit: 1,
  });

  await expect(
    client.search({ query: "test", count: 1, need_content: false }),
  ).resolves.toEqual(searchResponse);
});
```

- [ ] **Step 2: Run the new tests to verify failure**

Run: `npm run test -- test/unit/client.test.ts`

Expected: FAIL because the option and error kind do not exist.

- [ ] **Step 3: Implement bounded body reading**

Add `resource_limit` to `DeepSeekErrorKind`.

Add the option and private field:

```ts
export interface DeepSeekClientOptions {
  apiKey: string;
  baseUrl: URL;
  timeoutMs: number;
  maxRetries: number;
  fetchImpl?: typeof fetch;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
  fetchResponseByteLimit?: number;
}

readonly #fetchResponseByteLimit: number;
this.#fetchResponseByteLimit = options.fetchResponseByteLimit ?? 8 * 1024 * 1024;
```

Implement a helper that reads `response.body` through a `ReadableStream` reader, counts byte length, cancels the stream once the limit is crossed, decodes UTF-8, and parses JSON:

```ts
async function readJsonWithByteLimit<T>(
  response: Response,
  maxBytes: number,
  schema: z.ZodType<T>,
): Promise<T> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new DeepSeekError("DeepSeek response exceeded the 8 MiB Fetch limit.", {
      kind: "resource_limit",
    });
  }
  if (!response.body) {
    return schema.parse(JSON.parse(await response.text()));
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    total += chunk.value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new DeepSeekError("DeepSeek response exceeded the 8 MiB Fetch limit.", {
        kind: "resource_limit",
      });
    }
    chunks.push(chunk.value);
  }

  const body = Buffer.concat(chunks).toString("utf8");
  return schema.parse(JSON.parse(body));
}
```

In the success path, use this helper only when `operation === "fetch"`; preserve `schema.parse(await response.json())` for Search.

- [ ] **Step 4: Run tests and verify timeout behavior remains intact**

Run: `npm run test -- test/unit/client.test.ts`

Expected: PASS, including the existing timeout-while-reading test.

- [ ] **Step 5: Commit**

```bash
git add src/deepseek/errors.ts src/deepseek/client.ts test/unit/client.test.ts
git commit -m "feat: bound DeepSeek fetch responses"
```

---

### Task 3: Extract and Normalize Markdown Links

**Files:**

- Create: `src/crawl/types.ts`
- Create: `src/crawl/links.ts`
- Create: `test/unit/links.test.ts`

**Interfaces:**

- Produces: `normalizeHttpUrl(value: string, base?: URL): URL | undefined`.
- Produces: `extractMarkdownLinks(markdown: string, base: URL): URL[]`.
- Produces: `sameOrigin(left: URL, right: URL): boolean`.
- Produces: `safePageSlug(url: URL): string`.

- [ ] **Step 1: Write failing link tests with all approved sources**

Create `test/unit/links.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  extractMarkdownLinks,
  normalizeHttpUrl,
  safePageSlug,
  sameOrigin,
} from "../../src/crawl/links.js";

const base = new URL("https://example.com/docs/start");

describe("extractMarkdownLinks", () => {
  it("extracts inline, reference, and automatic links", () => {
    const markdown = [
      "[Inline](/a)",
      "[Reference][docs]",
      "https://example.com/bare",
      "[docs]: /reference",
    ].join("\n");
    expect(extractMarkdownLinks(markdown, base).map(String)).toEqual([
      "https://example.com/a",
      "https://example.com/reference",
      "https://example.com/bare",
    ]);
  });

  it("ignores images, raw HTML, malformed, credentials, and non-HTTP URLs", () => {
    const markdown = [
      "![image](/image.png)",
      '<a href="/html">HTML</a>',
      "[mail](mailto:test@example.com)",
      "[file](file:///etc/passwd)",
      "[credential](https://user:pass@example.com/)",
    ].join("\n");
    expect(extractMarkdownLinks(markdown, base)).toEqual([]);
  });

  it("removes fragments", () => {
    expect(normalizeHttpUrl("/page#part", base)?.href).toBe("https://example.com/page");
  });
});

describe("sameOrigin and safePageSlug", () => {
  it("uses exact scheme, host, and port", () => {
    expect(sameOrigin(new URL("https://example.com/a"), new URL("https://example.com/b"))).toBe(
      true,
    );
    expect(sameOrigin(new URL("https://example.com"), new URL("http://example.com"))).toBe(false);
  });

  it("creates stable ASCII file slugs", () => {
    expect(safePageSlug(new URL("https://example.com/docs/Hello%20World.html"))).toBe(
      "hello-world",
    );
    expect(safePageSlug(new URL("https://example.com/"))).toBe("page");
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npm run test -- test/unit/links.test.ts`

Expected: FAIL because `src/crawl/links.ts` does not exist.

- [ ] **Step 3: Implement link and URL helpers**

Create `src/crawl/links.ts`:

```ts
import MarkdownIt from "markdown-it";

const markdown = new MarkdownIt({ linkify: true, html: false });

export function normalizeHttpUrl(value: string, base?: URL): URL | undefined {
  try {
    const url = base ? new URL(value, base) : new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || !url.hostname) return undefined;
    if (url.username || url.password) return undefined;
    url.hash = "";
    return url;
  } catch {
    return undefined;
  }
}

export function sameOrigin(left: URL, right: URL): boolean {
  return left.origin === right.origin;
}

export function extractMarkdownLinks(value: string, base: URL): URL[] {
  const seen = new Set<string>();
  const links: URL[] = [];
  for (const token of markdown.parse(value, {})) {
    if (token.type !== "link_open") continue;
    const href = token.attrGet("href");
    if (!href) continue;
    const url = normalizeHttpUrl(href, base);
    if (!url || seen.has(url.href)) continue;
    seen.add(url.href);
    links.push(url);
  }
  return links;
}

export function safePageSlug(url: URL): string {
  const raw = url.pathname.split("/").filter(Boolean).at(-1) ?? "";
  let segment = raw;
  try {
    segment = decodeURIComponent(raw);
  } catch {
    segment = raw;
  }
  const withoutExtension = segment.replace(/\.[a-z0-9]{1,10}$/i, "");
  const normalized = withoutExtension
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return normalized || "page";
}
```

Create the first `src/crawl/types.ts` declarations needed by later tasks:

```ts
export type MapWarningCode =
  | "sitemap_unavailable"
  | "sitemap_invalid"
  | "sitemap_limit_reached"
  | "seed_page_failed";

export interface MapWarning {
  code: MapWarningCode;
  message: string;
}
```

- [ ] **Step 4: Run link tests**

Run: `npm run test -- test/unit/links.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/crawl/types.ts src/crawl/links.ts test/unit/links.test.ts
git commit -m "feat: extract crawl links from Markdown"
```

---

### Task 4: Deterministic Layered Crawl Engine

**Files:**

- Modify: `src/crawl/types.ts`
- Create: `src/crawl/queue.ts`
- Create: `src/application/crawl.ts`
- Create: `test/unit/crawl-queue.test.ts`
- Create: `test/unit/crawl.test.ts`
- Modify: `src/application/index.ts`
- Modify: `src/index.ts`

**Interfaces:**

- Consumes: `DeepSeekGateway`, `boundFetchOutput`, `extractMarkdownLinks`, `normalizeHttpUrl`, `sameOrigin`.
- Produces: `CrawlPage`, `CrawlPageSummary`, `CrawlRunResult`, and `CrawlOptions`.
- Produces: `runLayeredTasks<TResult>()`.
- Produces: `executeCrawl(client, input, options, onPage?, signal?): Promise<CrawlRunResult>`.

- [ ] **Step 1: Write failing scheduler tests**

Create `test/unit/crawl-queue.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { runLayeredTasks } from "../../src/crawl/queue.js";

describe("runLayeredTasks", () => {
  it("preserves result order while bounding concurrency", async () => {
    let active = 0;
    let maximum = 0;
    const results = await runLayeredTasks(["a", "b", "c", "d"], {
      concurrency: 2,
      delayMs: 0,
      run: async (value) => {
        active += 1;
        maximum = Math.max(maximum, active);
        await new Promise((resolve) => setTimeout(resolve, value === "a" ? 10 : 1));
        active -= 1;
        return value.toUpperCase();
      },
    });

    expect(results).toEqual(["A", "B", "C", "D"]);
    expect(maximum).toBeLessThanOrEqual(2);
  });

  it("does not start items after cancellation", async () => {
    const controller = new AbortController();
    const run = vi.fn(async () => {
      controller.abort();
      throw new DOMException("Aborted", "AbortError");
    });
    await expect(
      runLayeredTasks(["a", "b"], {
        concurrency: 1,
        delayMs: 0,
        signal: controller.signal,
        run,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(run).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run scheduler tests to verify failure**

Run: `npm run test -- test/unit/crawl-queue.test.ts`

Expected: FAIL because `runLayeredTasks` does not exist.

- [ ] **Step 3: Implement deterministic layered task execution**

Create `src/crawl/queue.ts` with an ordered-result scheduler. Use a promise chain as the shared start gate so no two workers start within `delayMs`:

```ts
export interface LayeredTaskOptions<T, R> {
  concurrency: number;
  delayMs: number;
  signal?: AbortSignal;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  run: (item: T, index: number) => Promise<R>;
}

function defaultWait(milliseconds: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function runLayeredTasks<T, R>(
  items: readonly T[],
  options: LayeredTaskOptions<T, R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let startGate = Promise.resolve();
  let nextStartAt = 0;

  const start = async () => {
    let release: () => void = () => undefined;
    const previous = startGate;
    startGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      options.signal?.throwIfAborted();
      const remaining = Math.max(0, nextStartAt - Date.now());
      if (remaining > 0) {
        await (options.sleep ?? defaultWait)(remaining, options.signal);
      }
      nextStartAt = Date.now() + options.delayMs;
    } finally {
      release();
    }
  };

  const worker = async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      await start();
      options.signal?.throwIfAborted();
      const item = items[index];
      if (item === undefined) return;
      results[index] = await options.run(item, index);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(options.concurrency, items.length) }, () => worker()),
  );
  return results;
}
```

- [ ] **Step 4: Run scheduler tests**

Run: `npm run test -- test/unit/crawl-queue.test.ts`

Expected: PASS.

- [ ] **Step 5: Write failing Crawl behavior tests**

Create `test/unit/crawl.test.ts` with a fake gateway that maps URL to Markdown and one failing page:

```ts
import { describe, expect, it, vi } from "vitest";
import { executeCrawl } from "../../src/application/crawl.js";
import { DeepSeekError } from "../../src/deepseek/errors.js";

const options = {
  maxDepth: 2,
  maxPages: 20,
  concurrency: 2,
  delayMs: 0,
  discoveryLimit: 100,
  pageContentLimit: 1000,
};

function client() {
  return {
    search: vi.fn(),
    fetch: vi.fn(async ({ url }: { url: string }) => {
      if (url === "https://example.com/broken") {
        throw new DeepSeekError("broken", { kind: "not_found" });
      }
      return {
        title: url,
        content:
          url === "https://example.com/"
            ? "[A](/b) [B](/a) [Broken](/broken) [Outside](https://other.example/) [Hash](/a#part)"
            : "[Root](/)[Deep](/c)",
      };
    }),
  };
}

describe("executeCrawl", () => {
  it("traverses deterministically, deduplicates, and records failures", async () => {
    const pages = new Map<number, string>();
    const result = await executeCrawl(
      client(),
      { url: "https://example.com/" },
      options,
      async (page) => {
        pages.set(page.index, page.url);
      },
    );

    expect([...pages.entries()].sort(([left], [right]) => left - right).map(([, url]) => url)).toEqual([
      "https://example.com/",
      "https://example.com/a",
      "https://example.com/b",
      "https://example.com/c",
    ]);
    expect(result.pages.map((page) => page.url)).toEqual([
      "https://example.com/",
      "https://example.com/a",
      "https://example.com/b",
      "https://example.com/c",
    ]);
    expect(result.stats.failed).toBe(1);
    expect(result.failures).toEqual([
      expect.objectContaining({
        url: "https://example.com/broken",
        kind: "not_found",
      }),
    ]);
  });

  it("stops at max_pages and sets limit_reached", async () => {
    const result = await executeCrawl(
      client(),
      { url: "https://example.com/" },
      { ...options, maxPages: 2 },
    );
    expect(result.pages.map((page) => page.url)).toEqual([
      "https://example.com/",
      "https://example.com/a",
    ]);
    expect(result.stats.limit_reached).toBe(true);
  });

  it("fails when the seed page fails", async () => {
    const gateway = { search: vi.fn(), fetch: vi.fn(async () => Promise.reject(new Error("seed"))) };
    await expect(
      executeCrawl(gateway, { url: "https://example.com/" }, options),
    ).rejects.toThrow("seed");
  });
});
```

- [ ] **Step 6: Run Crawl tests to verify failure**

Run: `npm run test -- test/unit/crawl.test.ts`

Expected: FAIL because `executeCrawl` does not exist.

- [ ] **Step 7: Implement Crawl contracts and application service**

Extend `src/crawl/types.ts`:

```ts
export interface CrawlInput {
  url: string;
}

export interface CrawlOptions {
  maxDepth: number;
  maxPages: number;
  concurrency: number;
  delayMs: number;
  discoveryLimit: number;
  pageContentLimit: number;
  now?: () => Date;
}

export interface CrawlPage {
  index: number;
  url: string;
  title: string;
  depth: number;
  content: string;
  content_truncated: boolean;
  content_original_length: number;
}

export interface CrawlPageSummary {
  index: number;
  url: string;
  title: string;
  depth: number;
  content_length: number;
  content_truncated: boolean;
  content_original_length?: number;
}

export interface CrawlPageIndex extends CrawlPageSummary {
  path: string;
}

export interface CrawlFailure {
  url: string;
  depth: number;
  kind: string;
  message: string;
}

export interface CrawlRunResult {
  version: 1;
  seed_url: string;
  started_at: string;
  finished_at: string;
  settings: {
    max_depth: number;
    max_pages: number;
    concurrency: number;
    delay_ms: number;
  };
  stats: {
    discovered: number;
    fetched: number;
    failed: number;
    content_truncated: number;
    limit_reached: boolean;
    discovery_limit_reached: boolean;
  };
  pages: CrawlPageSummary[];
  failures: CrawlFailure[];
}

export interface CrawlOutputResult extends Omit<CrawlRunResult, "pages"> {
  pages: CrawlPageIndex[];
}
```

Implement `executeCrawl` with these exact rules:

```ts
export async function executeCrawl(
  client: DeepSeekGateway,
  input: unknown,
  options: CrawlOptions,
  onPage?: (page: CrawlPage) => Promise<void>,
  signal?: AbortSignal,
): Promise<CrawlRunResult>
```

Implementation algorithm:

1. Parse `input` with `fetchInputSchema`; normalize with `normalizeHttpUrl`; reject missing URL.
2. Initialize `frontier = [seed.href]`, `seen = new Set(frontier)`, `index = 1`, counters, and success/failure arrays.
3. For depth `0`, select only the seed. For later layers, sort `frontier` lexicographically and take up to `maxPages - fetched`.
4. Mark `limit_reached` when a selected layer is smaller than the sorted frontier.
5. Assign indexes before fetching; failed pages leave index gaps.
6. Run `runLayeredTasks` with Crawl concurrency and delay.
7. Each worker calls `client.fetch({ url }, signal)`, then `boundFetchOutput({ ...response, url }, pageContentLimit)`.
8. Convert bounded output to `CrawlPage`; call `onPage` inside the worker so CLI files are written during the crawl.
9. Extract links from bounded content, normalize them, keep exact same-origin and depth-eligible URLs, and return them with the page outcome.
10. Catch any fetch, bounding, or link-extraction failure as a structured page
    failure. Use `DeepSeekError.kind` when available and `crawl` otherwise.
    Re-throw cancellation and any `onPage` callback failure because neither can
    produce a valid completed output.
11. After the layer barrier, merge links in sorted order, add to `seen` until `discoveryLimit`; set `discovery_limit_reached` when more remain.
12. Stop when frontier is empty or the next depth exceeds `maxDepth`.
13. If the seed failed, throw its error. A successful seed may return a partial result when child pages fail.
14. Sort page summaries by index and failures by depth then URL; include `finished_at` and `stats`.

Export `executeCrawl` and the Crawl types from `src/application/index.ts` and `src/index.ts`.

- [ ] **Step 8: Run Crawl and regression tests**

Run: `npm run test -- test/unit/crawl-queue.test.ts test/unit/crawl.test.ts`

Expected: PASS.

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/crawl src/application/crawl.ts src/application/index.ts src/index.ts test/unit/crawl-queue.test.ts test/unit/crawl.test.ts
git commit -m "feat: add deterministic bounded crawl engine"
```

---

### Task 5: Crawl Directory and No-Clobber Output Writers

**Files:**

- Modify: `src/output/files.ts`
- Create: `src/output/crawl.ts`
- Create: `test/unit/crawl-output.test.ts`
- Modify: `test/unit/files.test.ts`

**Interfaces:**

- Produces: `writeFileAtomicNoClobber(path, content)`.
- Produces: `createCrawlOutputWriter(finalDirectory)` returning
  `{ writePage, finish, abort }`; `finish` returns `CrawlOutputResult`.
- Produces: `formatCrawlHuman(result, outputDirectory)`.

- [ ] **Step 1: Write failing no-clobber tests**

Add to `test/unit/files.test.ts`:

```ts
it("does not overwrite an existing file", async () => {
  const root = await mkdtemp(join(tmpdir(), "deepseek-crawl-"));
  const path = join(root, "result.json");
  await writeFile(path, "original", "utf8");
  await expect(writeFileAtomicNoClobber(path, "replacement")).rejects.toMatchObject({
    code: "EEXIST",
  });
  expect(await readFile(path, "utf8")).toBe("original");
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `npm run test -- test/unit/files.test.ts`

Expected: FAIL because `writeFileAtomicNoClobber` does not exist.

- [ ] **Step 3: Implement no-clobber file writing**

Write the temporary file, create the destination with `link(temp, destination)`, and remove the temporary file after the hard link succeeds. On platforms where hard links are unavailable, do not fall back to rename; surface the error.

- [ ] **Step 4: Write failing Crawl writer tests**

Create `test/unit/crawl-output.test.ts`:

```ts
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createCrawlOutputWriter } from "../../src/output/crawl.js";

it("stages pages and renames the completed directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "deepseek-crawl-output-"));
  const output = join(root, "result");
  const writer = await createCrawlOutputWriter(output);
  const page = {
    index: 1,
    url: "https://example.com/",
    title: "Example",
    depth: 0,
    content: "# Example",
    content_truncated: false,
    content_original_length: 9,
  };
  expect(await writer.writePage(page)).toBe("pages/0001-example.md");
  await writer.finish({
    version: 1,
    seed_url: page.url,
    started_at: "2026-11-13T00:00:00.000Z",
    finished_at: "2026-11-13T00:00:01.000Z",
    settings: { max_depth: 2, max_pages: 20, concurrency: 2, delay_ms: 250 },
    stats: {
      discovered: 1,
      fetched: 1,
      failed: 0,
      content_truncated: 0,
      limit_reached: false,
      discovery_limit_reached: false,
    },
    pages: [{
      index: 1,
      url: page.url,
      title: page.title,
      depth: 0,
      content_length: 9,
      content_truncated: false,
    }],
    failures: [],
  });
  expect(await readFile(join(output, "pages", "0001-example.md"), "utf8")).toContain(
    "Source: https://example.com/",
  );
});
```

Add a second test asserting `createCrawlOutputWriter(existingDirectory)` rejects and an aborted writer removes its staging directory.

- [ ] **Step 5: Run Crawl output tests to verify failure**

Run: `npm run test -- test/unit/crawl-output.test.ts`

Expected: FAIL because the writer does not exist.

- [ ] **Step 6: Implement Crawl staging writer**

Create a staging directory as a sibling of the requested output with `mkdtemp`. Check the final path with `lstat` before creating staging. Write each page as:

```md
# <title>

Source: <url>

<content>
```

`finish(result)` adds each page's `path` using the same stable index and slug
used by `writePage`, writes pretty-printed `crawl.json` with the resulting
`CrawlOutputResult`, and renames staging to the final directory. `abort()`
removes staging recursively. Missing final paths only are accepted; any existing
path is an error.

Implement `formatCrawlHuman` with seed URL, settings, success/failure counts, truncation flags, and output path.

- [ ] **Step 7: Run output tests and baseline tests**

Run: `npm run test -- test/unit/files.test.ts test/unit/crawl-output.test.ts`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/output/files.ts src/output/crawl.ts test/unit/files.test.ts test/unit/crawl-output.test.ts
git commit -m "feat: write crawl output atomically without overwrite"
```

---

### Task 6: CLI Crawl Command and SIGINT Cancellation

**Files:**

- Modify: `src/cli/parse.ts`
- Modify: `src/cli/run.ts`
- Modify: `src/bin.ts`
- Modify: `test/unit/cli-parse.test.ts`
- Modify: `test/unit/cli-run.test.ts`

**Interfaces:**

- Consumes: `executeCrawl`, `createCrawlOutputWriter`, `formatCrawlHuman`.
- Produces: `ParsedCommand` variant `{ kind: "crawl"; ... }`.
- Produces: `CliDependencies.signal?: AbortSignal`.

- [ ] **Step 1: Write failing parser tests**

Add:

```ts
expect(
  parseCli([
    "crawl",
    "https://example.com",
    "--max-depth",
    "1",
    "--max-pages",
    "4",
    "--concurrency",
    "2",
    "--delay-ms",
    "0",
    "--output",
    "out",
    "--json",
  ]),
).toEqual({
  kind: "crawl",
  url: "https://example.com",
  maxDepth: 1,
  maxPages: 4,
  concurrency: 2,
  delayMs: 0,
  output: "out",
  json: true,
});
```

Add rejection cases for missing `--output`, depth `6`, pages `0`, concurrency `6`, and delay `5001`.

- [ ] **Step 2: Run parser tests to verify failure**

Run: `npm run test -- test/unit/cli-parse.test.ts`

Expected: FAIL because Crawl is an unknown command.

- [ ] **Step 3: Implement Crawl parsing and help**

Add a `crawl` variant with defaults:

```ts
{
  kind: "crawl",
  url: string,
  maxDepth: number,
  maxPages: number,
  concurrency: number,
  delayMs: number,
  output: string,
  json: boolean,
}
```

Use `parseInteger` with exact ranges. Update `MAIN_HELP` and `COMMAND_HELP` to list `crawl`.

- [ ] **Step 4: Write failing CLI Crawl tests**

Add a test that injects a fake gateway through `CliDependencies.crawlClient` and a temporary output path, then asserts `crawl.json` and a page file exist. Add an aborted-signal test asserting the output directory does not exist.

Use dependency fields:

```ts
interface CliDependencies {
  env: NodeJS.ProcessEnv;
  fetchImpl: typeof fetch;
  stdout: { write(value: string): unknown };
  stderr: { write(value: string): unknown };
  signal?: AbortSignal;
  crawlClient?: DeepSeekGateway;
  mapClient?: DeepSeekGateway;
  sitemapReader?: SitemapReader;
}
```

Use this assertion in the cancellation test:

```ts
const root = await mkdtemp(join(tmpdir(), "deepseek-crawl-cancel-"));
const output = join(root, "result");
const controller = new AbortController();
controller.abort();
const { deps } = dependencies(vi.fn() as unknown as typeof fetch, {
  DEEPSEEK_API_KEY: "key",
});

expect(
  await runCli(
    ["crawl", "https://example.com", "--output", output],
    { ...deps, signal: controller.signal },
  ),
).toBe(130);
await expect(stat(output)).rejects.toMatchObject({ code: "ENOENT" });
```

- [ ] **Step 5: Run CLI tests to verify failure**

Run: `npm run test -- test/unit/cli-run.test.ts`

Expected: FAIL because dispatch and output do not exist.

- [ ] **Step 6: Implement CLI Crawl execution and SIGINT**

In `runCli`, add `case "crawl"`. `runCrawl` must:

1. Load config and use `deps.crawlClient` or construct a `DeepSeekClient`.
2. Import signal or `deps.signal`.
3. Create the Crawl output writer.
4. Call `executeCrawl` with `onPage = writer.writePage`.
5. On success call `writer.finish`, print the returned human or JSON summary,
   and return `0`.
6. On error call `writer.abort` before rethrowing.
7. In the existing outer `runCli` catch, return `130` whenever
   `deps.signal?.aborted` is true; use the existing `1`/`2` behavior otherwise.

In `src/bin.ts`:

```ts
const controller = new AbortController();
const onSigint = () => controller.abort();
process.once("SIGINT", onSigint);
try {
  process.exitCode = await runCli(process.argv.slice(2), { signal: controller.signal });
} finally {
  process.removeListener("SIGINT", onSigint);
}
```

- [ ] **Step 7: Run CLI tests and regressions**

Run: `npm run test -- test/unit/cli-parse.test.ts test/unit/cli-run.test.ts`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/cli/parse.ts src/cli/run.ts src/bin.ts test/unit/cli-parse.test.ts test/unit/cli-run.test.ts
git commit -m "feat: add CLI crawl command"
```

---

### Task 7: MCP Crawl Tool

**Files:**

- Modify: `src/mcp/server.ts`
- Modify: `test/unit/mcp.test.ts`
- Modify: `test/integration/mcp-stdio.test.ts`

**Interfaces:**

- Consumes: `executeCrawl` and its page callback.
- Produces: MCP tool `deepseek_crawl`.
- Produces: `McpServerOptions.crawl` defaults and optional dependency injection.

- [ ] **Step 1: Write failing MCP Crawl tests**

Update the tool-list expectation for this intermediate task to exactly:

```ts
["deepseek_crawl", "deepseek_fetch", "deepseek_search"]
```

Crawl tests:

```ts
const result = await client.callTool({
  name: "deepseek_crawl",
  arguments: { url: "https://example.com/", max_pages: 2, delay_ms: 0 },
});
expect(result.isError).toBeUndefined();
expect(result.structuredContent).toMatchObject({
  seed_url: "https://example.com/",
  pages: [{ url: "https://example.com/" }],
});
```

Add this aggregate-budget test:

```ts
it("never returns more than 100,000 aggregate content characters", async () => {
  const { client, gateway } = await connectedServer();
  gateway.fetch.mockImplementation(async ({ url }) => {
    const path = new URL(url).pathname;
    const links =
      path === "/"
        ? Array.from({ length: 19 }, (_, index) => `[Page ${index + 1}](/${index + 1})`).join(" ")
        : "";
    return {
      title: path,
      content: `${"x".repeat(6000)}\n${links}`,
    };
  });

  const result = await client.callTool({
    name: "deepseek_crawl",
    arguments: {
      url: "https://example.com/",
      max_depth: 1,
      max_pages: 20,
      max_chars: 6000,
      delay_ms: 0,
    },
  });
  const structured = result.structuredContent as {
    pages: Array<{ content: string; content_omitted?: boolean }>;
  };
  expect(structured.pages.reduce((total, page) => total + [...page.content].length, 0))
    .toBeLessThanOrEqual(100000);
  expect(structured.pages.some((page) => page.content_omitted === true)).toBe(true);
});
```

Add assertions for:

- Default per-page content 4,000.
- Aggregate content never exceeding 100,000.
- `content_omitted` when the budget is already exhausted.
- Partial page failure remains a successful tool result.
- Seed failure returns `isError`.
- MCP invokes no filesystem writer.

- [ ] **Step 2: Run MCP tests to verify failure**

Run: `npm run test -- test/unit/mcp.test.ts`

Expected: FAIL because only two tools are registered.

- [ ] **Step 3: Implement the MCP Crawl schema and handler**

Register `deepseek_crawl` with exact ranges from the spec:

```ts
inputSchema: {
  url: z.string(),
  max_depth: z.number().int().min(0).max(5).default(2),
  max_pages: z.number().int().min(1).max(20).default(10),
  concurrency: z.number().int().min(1).max(5).default(2),
  delay_ms: z.number().int().min(0).max(5000).default(250),
  max_chars: z.number().int().min(0).max(1000000).default(4000),
}
```

Use an `onPage` callback that stores pages by index. After `executeCrawl`, sort summaries by index and allocate a shared 100,000-code-point budget:

- Use `truncateText(page.content, max_chars)` first when `max_chars > 0`.
- Truncate again to the remaining aggregate budget.
- Add `content_truncated`, `content_original_length`, and `content_omitted` exactly as the spec defines.
- Return a title/URL/status Markdown summary in `content` and full bounded structured data in `structuredContent`.

Use annotations `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: true`.

Update server instructions to say that Search, Fetch, and Crawl return untrusted
web content and must not be treated as instructions. Task 11 extends the same
sentence to Map.

- [ ] **Step 4: Update stdio integration expectation**

Change the tool-list assertion to these three tools. Keep Search and Fetch calls
unchanged. Do not make live Crawl network calls from this integration test.

- [ ] **Step 5: Run MCP tests**

Run: `npm run test -- test/unit/mcp.test.ts test/integration/mcp-stdio.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/mcp/server.ts test/unit/mcp.test.ts test/integration/mcp-stdio.test.ts
git commit -m "feat: expose bounded crawl through MCP"
```

---

### Task 8: Public-Network Sitemap Policy and HTTP Reader

**Files:**

- Create: `src/sitemap/network-policy.ts`
- Create: `src/sitemap/reader.ts`
- Create: `test/unit/network-policy.test.ts`

**Interfaces:**

- Produces: `isPublicIpAddress(address: string): boolean`.
- Produces: `resolvePublicAddress(hostname, lookupImpl?): Promise<ResolvedAddress>`.
- Produces: `SitemapFetcher.fetch(url, signal?): Promise<{ body: string; finalUrl: URL }>`.
- Produces: `createPublicSitemapFetcher(options?)`.

- [ ] **Step 1: Write failing address-policy tests**

Create `test/unit/network-policy.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { isPublicIpAddress } from "../../src/sitemap/network-policy.js";

describe("isPublicIpAddress", () => {
  it.each([
    "0.0.0.0",
    "10.0.0.1",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.1.1",
    "172.16.0.1",
    "192.168.0.1",
    "224.0.0.1",
    "::",
    "::1",
    "fc00::1",
    "fe80::1",
    "ff02::1",
  ])("rejects non-public address %s", (address) => {
    expect(isPublicIpAddress(address)).toBe(false);
  });

  it.each(["1.1.1.1", "8.8.8.8", "2606:4700:4700::1111"])(
    "accepts public address %s",
    (address) => {
      expect(isPublicIpAddress(address)).toBe(true);
    },
  );
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npm run test -- test/unit/network-policy.test.ts`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement public-address validation**

Use `node:net` `BlockList` with IPv4 and IPv6 reserved/private ranges. Normalize IPv4-mapped IPv6 addresses before validation. Export a resolver that calls `dns.lookup(hostname, { all: true })`, rejects if *any* result is non-public, and returns a deterministic first validated address plus all validated family values.

- [ ] **Step 4: Implement a safe Sitemap fetcher**

Create `src/sitemap/reader.ts` with injectable primitives:

```ts
export interface SitemapFetcher {
  fetch(url: URL, signal?: AbortSignal): Promise<{ body: string; finalUrl: URL }>;
}

export interface PublicSitemapFetcherOptions {
  resolve?: (hostname: string) => Promise<ResolvedAddress>;
  request?: (url: URL, address: ResolvedAddress, signal?: AbortSignal) =>
    Promise<{ status: number; location?: string; body: string }>;
  timeoutMs?: number;
  bodyLimitBytes?: number;
  maxRedirects?: number;
}

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}
```

The default request uses `node:http` or `node:https` with:

- The validated address supplied through the `lookup` callback.
- `Host`/SNI preserved from the original hostname.
- A 15,000 ms timeout tied to the supplied signal.
- Streaming body accumulation that fails at 5 MiB.
- `redirect: manual` semantics: status 301, 302, 303, 307, or 308 reads `location`.
- No more than three redirects.
- Each redirect target re-resolved and required to share the original origin.

- [ ] **Step 5: Add fetcher tests**

Use injected `resolve` and `request` callbacks to cover redirect success, cross-origin redirect rejection, redirect limit, body limit, and private-address rejection. Do not make a real external network call.

Include this exact cross-origin assertion:

```ts
import { createPublicSitemapFetcher } from "../../src/sitemap/reader.js";

it("rejects a cross-origin sitemap redirect", async () => {
  const fetcher = createPublicSitemapFetcher({
    resolve: async () => ({ address: "1.1.1.1", family: 4 }),
    request: async () => ({
      status: 302,
      location: "https://other.example/sitemap.xml",
      body: "",
    }),
  });

  await expect(fetcher.fetch(new URL("https://example.com/sitemap.xml"))).rejects.toThrow(
    /same origin/i,
  );
});
```

- [ ] **Step 6: Run tests**

Run: `npm run test -- test/unit/network-policy.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/sitemap/network-policy.ts src/sitemap/reader.ts test/unit/network-policy.test.ts
git commit -m "feat: add safe public sitemap fetching"
```

---

### Task 9: Parse Sitemaps and Nested Sitemap Indexes

**Files:**

- Modify: `src/sitemap/reader.ts`
- Create: `test/unit/sitemap.test.ts`
- Create: `test/fixtures/sitemap-urlset.xml`
- Create: `test/fixtures/sitemap-index.xml`

**Interfaces:**

- Produces: `SitemapReader.read(seedUrl, options, signal?)`.
- Produces: `new SitemapReader({ fetcher?: SitemapFetcher })`.
- Produces: `SitemapDiscovery { urls: URL[]; warnings: MapWarning[]; truncated: boolean }`.

```ts
export interface SitemapReadOptions {
  maxDocuments: number;
  maxCandidates: number;
}

export interface SitemapDiscovery {
  urls: URL[];
  warnings: MapWarning[];
  truncated: boolean;
}
```

- [ ] **Step 1: Add XML fixtures and failing parser tests**

`test/fixtures/sitemap-urlset.xml`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://example.com/a</loc></url>
  <url><loc>https://example.com/b#fragment</loc></url>
</urlset>
```

`test/fixtures/sitemap-index.xml`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>https://example.com/sitemap-pages.xml</loc></sitemap>
</sitemapindex>
```

Tests assert:

- URL sets produce normalized same-origin links.
- Sitemap indexes are followed.
- Cycles only fetch once.
- At most 10 documents and 10,000 candidates are retained.
- Invalid XML becomes `sitemap_invalid`.
- Missing/failed root becomes `sitemap_unavailable`.
- Candidate overflow sets `sitemap_limit_reached` and `truncated`.

Use this fixture-backed parser test:

```ts
import { readFile } from "node:fs/promises";
import { vi } from "vitest";
import { SitemapReader } from "../../src/sitemap/reader.js";

it("normalizes URL sets returned by the sitemap fetcher", async () => {
  const body = await readFile(
    new URL("../fixtures/sitemap-urlset.xml", import.meta.url),
    "utf8",
  );
  const reader = new SitemapReader({
    fetcher: {
      fetch: vi.fn(async () => ({
        body,
        finalUrl: new URL("https://example.com/sitemap.xml"),
      })),
    },
  });

  const result = await reader.read(new URL("https://example.com/"), {
    maxDocuments: 10,
    maxCandidates: 100,
  });
  expect(result.urls.map(String)).toEqual([
    "https://example.com/a",
    "https://example.com/b",
  ]);
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npm run test -- test/unit/sitemap.test.ts`

Expected: FAIL because `SitemapReader` does not exist.

- [ ] **Step 3: Implement XML parsing and traversal**

Use `XMLParser` with explicit array handling:

```ts
const parser = new XMLParser({
  ignoreAttributes: true,
  trimValues: true,
  parseTagValue: false,
  isArray: (name) => name === "url" || name === "sitemap",
});
```

Implement exact document type detection:

- `urlset.url[].loc` yields page candidates.
- `sitemapindex.sitemap[].loc` yields nested Sitemap URLs.
- Normalize locations with `normalizeHttpUrl(location, documentUrl)`.
- Discard cross-origin nested documents and candidates.
- Deduplicate document URLs before fetching.
- Convert parser failures into warnings without throwing when another source can still produce results.

- [ ] **Step 4: Run Sitemap tests**

Run: `npm run test -- test/unit/sitemap.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sitemap/reader.ts test/unit/sitemap.test.ts test/fixtures/sitemap-urlset.xml test/fixtures/sitemap-index.xml
git commit -m "feat: parse bounded sitemap discovery"
```

---

### Task 10: Map Application Service

**Files:**

- Modify: `src/crawl/types.ts`
- Create: `src/application/map.ts`
- Create: `test/unit/map.test.ts`
- Modify: `src/application/index.ts`
- Modify: `src/index.ts`

**Interfaces:**

- Consumes: `DeepSeekGateway`, `SitemapReader`, `extractMarkdownLinks`, `normalizeHttpUrl`, `sameOrigin`.
- Produces: `MapOptions { limit: number; discoveryLimit: number; pageContentLimit?: number; now?: () => Date }`.
- Produces: `executeMap(client, reader, input, options, signal?): Promise<MapResult>`.

When omitted, `pageContentLimit` is `1_000_000`.

- [ ] **Step 1: Write failing Map tests**

Create `test/unit/map.test.ts` with a fake reader and gateway:

```ts
import { describe, expect, it, vi } from "vitest";
import { executeMap } from "../../src/application/map.js";
import { DeepSeekError } from "../../src/deepseek/errors.js";

it("merges sitemap and seed-page sources deterministically", async () => {
  const reader = {
    read: vi.fn(async () => ({
      urls: [new URL("https://example.com/b"), new URL("https://example.com/a")],
      warnings: [],
      truncated: false,
    })),
  };
  const client = {
    search: vi.fn(),
    fetch: vi.fn(async () => ({
      title: "Seed",
      content: "[Home](/a) [Docs](/docs) [Outside](https://other.example/)",
    })),
  };
  const result = await executeMap(
    client,
    reader,
    { url: "https://example.com/" },
    { limit: 10, discoveryLimit: 100 },
  );
  expect(result.urls.map((item) => item.url)).toEqual([
    "https://example.com/",
    "https://example.com/a",
    "https://example.com/b",
    "https://example.com/docs",
  ]);
});
```

Add tests for:

- Sitemap failure with seed success yields warning and seed result.
- Seed failure with Sitemap success yields `seed_page_failed`.
- Both sources failing throws.
- Limit truncation is based on sorted candidates.
- Seed URL is always included with source `seed_url`.
- A clean seed page with no links still succeeds.

Use this partial-source test:

```ts
it("keeps sitemap results when seed-page discovery fails", async () => {
  const reader = {
    read: vi.fn(async () => ({
      urls: [new URL("https://example.com/from-sitemap")],
      warnings: [],
      truncated: false,
    })),
  };
  const client = {
    search: vi.fn(),
    fetch: vi.fn(async () => {
      throw new DeepSeekError("seed unavailable", { kind: "network" });
    }),
  };
  const result = await executeMap(
    client,
    reader,
    { url: "https://example.com/" },
    { limit: 10, discoveryLimit: 100 },
  );
  expect(result.urls).toEqual([
    { url: "https://example.com/", sources: ["seed_url"] },
    { url: "https://example.com/from-sitemap", sources: ["sitemap"] },
  ]);
  expect(result.warnings[0]?.code).toBe("seed_page_failed");
});
```

Add a second test where `reader.read` rejects and the gateway succeeds; assert
the seed URL and page links remain plus a `sitemap_unavailable` warning. Add a
limit test with mandatory seed URL plus discovered `c`, `a`, `b`, limit `2`, and
assert the seed URL and `a` are returned with `truncated: true`.

- [ ] **Step 2: Run Map tests to verify failure**

Run: `npm run test -- test/unit/map.test.ts`

Expected: FAIL because `executeMap` does not exist.

- [ ] **Step 3: Add Map result contracts**

Extend `src/crawl/types.ts`:

```ts
export interface MapUrl {
  url: string;
  sources: Array<"seed_url" | "seed_page" | "sitemap">;
}

export interface MapResult {
  version: 1;
  seed_url: string;
  generated_at: string;
  limit: number;
  total: number;
  truncated: boolean;
  urls: MapUrl[];
  warnings: MapWarning[];
}
```

- [ ] **Step 4: Implement `executeMap`**

Use `Promise.allSettled` for Sitemap and seed-page calls. Convert rejected sources into warnings only when the other source succeeds. Merge by normalized `.href`, union sources, sort URLs lexicographically, retain `seed_url`, and apply the requested limit and discovery cap. Use a fakeable `now?: () => Date` option for deterministic `generated_at`.

Export `executeMap` and its types from `src/application/index.ts` and `src/index.ts`.

- [ ] **Step 5: Run Map and regression tests**

Run: `npm run test -- test/unit/map.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/crawl/types.ts src/application/map.ts src/application/index.ts src/index.ts test/unit/map.test.ts
git commit -m "feat: merge sitemap and page URL discovery"
```

---

### Task 11: Map CLI and MCP Integration

**Files:**

- Create: `src/output/map.ts`
- Create: `test/unit/map-output.test.ts`
- Modify: `src/cli/parse.ts`
- Modify: `src/cli/run.ts`
- Modify: `src/mcp/server.ts`
- Modify: `test/unit/cli-parse.test.ts`
- Modify: `test/unit/cli-run.test.ts`
- Modify: `test/unit/mcp.test.ts`
- Modify: `test/integration/mcp-stdio.test.ts`

**Interfaces:**

- Consumes: `executeMap`, `writeFileAtomicNoClobber`, `SitemapReader`.
- Produces: CLI `map` command and MCP `deepseek_map`.

- [ ] **Step 1: Write failing CLI parser tests**

Add parsing expectations for:

```ts
parseCli(["map", "https://example.com", "--limit", "25", "--json", "--output", "urls.json"]);
```

Expected:

```ts
{
  kind: "map",
  url: "https://example.com",
  limit: 25,
  json: true,
  output: "urls.json",
}
```

Reject limits `0` and `1001`, and unknown Map options.

- [ ] **Step 2: Run parser tests to verify failure**

Run: `npm run test -- test/unit/cli-parse.test.ts`

Expected: FAIL because `map` is unknown.

- [ ] **Step 3: Implement Map parser and CLI dispatch**

Defaults are `limit: 500`, `json: false`, no output path. Add `runMap`:

1. Load config.
2. Use injected `mapClient` or construct `DeepSeekClient`.
3. Use injected `sitemapReader` or `new SitemapReader()`.
4. Call `executeMap`.
5. Print warnings to stderr.
6. Human output: one URL per line.
7. JSON output: complete Map result.
8. With `--output`, write JSON via `writeFileAtomicNoClobber` and print only the path confirmation.

Add command help containing every option and default.

- [ ] **Step 4: Write failing Map CLI tests**

Cover human output, JSON output, no-clobber failure, warnings to stderr, and exact option forwarding. Use fake gateway and Sitemap reader injected through `CliDependencies`.

Include this exact human-output assertion:

```ts
const sitemapReader = {
  read: vi.fn(async () => ({
    urls: [new URL("https://example.com/a")],
    warnings: [],
    truncated: false,
  })),
};
const mapClient = {
  search: vi.fn(),
  fetch: vi.fn(async () => ({ title: "Seed", content: "[Docs](/docs)" })),
};
const { deps, stdout, stderr } = dependencies(vi.fn() as unknown as typeof fetch);
expect(
  await runCli(
    ["map", "https://example.com/"],
    { ...deps, mapClient, sitemapReader },
  ),
).toBe(0);
expect(stdout.value()).toBe(
  "https://example.com/\nhttps://example.com/a\nhttps://example.com/docs\n",
);
expect(stderr.value()).toBe("");
```

- [ ] **Step 5: Write failing MCP Map tests**

Expect the in-memory tool listing to contain exactly four tools. Update the
stdio integration tool-list assertion to four tools without making live
Map/Crawl network calls. Call `deepseek_map` with a fake reader and assert
structured URL/source data, default limit 100, maximum 500, and partial-source
warnings.

Use this tool-call assertion:

```ts
const result = await client.callTool({
  name: "deepseek_map",
  arguments: { url: "https://example.com/" },
});
expect(result.isError).toBeUndefined();
expect(result.structuredContent).toMatchObject({
  total: 3,
  urls: [
    { url: "https://example.com/", sources: ["seed_url"] },
    { url: "https://example.com/a", sources: ["sitemap"] },
    { url: "https://example.com/docs", sources: ["seed_page"] },
  ],
});
```

- [ ] **Step 6: Implement MCP Map tool**

Register `deepseek_map` with:

```ts
inputSchema: {
  url: z.string(),
  limit: z.number().int().min(1).max(500).default(100),
}
```

Extend transport options to:

```ts
export interface McpServerOptions {
  client: DeepSeekGateway;
  sitemapReader: SitemapReader;
}
```

Update the `mcp` CLI dispatch to pass a default `new SitemapReader()` and update
every test server constructor to pass a fake reader.

Return a compact Markdown URL list in `content` and `MapResult` in `structuredContent`. Use read-only/open-world annotations. MCP must not call any file writer.

- [ ] **Step 7: Implement Map output helpers**

Create `src/output/map.ts` with `formatMapUrls(result)` and `formatMapWarnings(result)`. The URL formatter returns `result.urls.map((item) => item.url).join("\n")`; the warning formatter returns one `code: message` line per warning.

- [ ] **Step 8: Run focused tests**

Run: `npm run test -- test/unit/cli-parse.test.ts test/unit/cli-run.test.ts test/unit/map-output.test.ts test/unit/mcp.test.ts`

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/output/map.ts src/cli/parse.ts src/cli/run.ts src/mcp/server.ts test/unit/map-output.test.ts test/unit/cli-parse.test.ts test/unit/cli-run.test.ts test/unit/mcp.test.ts test/integration/mcp-stdio.test.ts
git commit -m "feat: expose map through CLI and MCP"
```

---

### Task 12: Documentation, End-to-End Verification, and Final Audit

**Files:**

- Modify: `README.md`
- Modify: `test/integration/mcp-stdio.test.ts`
- Possibly modify: `test/unit/cli-run.test.ts`
- Verify: all source and test files

**Interfaces:**

- Consumes: all prior tasks.
- Produces: documented `0.2.0` capability surface and final verified package.

- [ ] **Step 1: Add a failing documentation assertion**

Add a package test or CI shell check that requires README to contain all of:

```ts
import { readFile } from "node:fs/promises";

const readme = await readFile(new URL("../../README.md", import.meta.url), "utf8");
for (const text of [
  "deepseek-crawl map",
  "deepseek-crawl crawl",
  "deepseek_map",
  "deepseek_crawl",
  "robots.txt",
  "Firecrawl",
]) {
  expect(readme).toContain(text);
}
```

- [ ] **Step 2: Run the documentation test to verify failure**

Run: `npm run test -- test/unit/package.test.ts`

Expected: FAIL because the new commands and MCP tools are not documented.

- [ ] **Step 3: Update README completely**

Document:

- Capability replacement scope and Firecrawl API incompatibility.
- Search, Fetch, Map, and Crawl CLI syntax and examples.
- Four MCP tools and their exact ranges.
- `crawl.json` and page directory format.
- All page/discovery/response/MCP content limits.
- Public-network-only Sitemap access.
- DeepSeek redirect limitation.
- Billing for seed and crawl page fetches.
- No `robots.txt` enforcement and user authorization responsibility.

- [ ] **Step 4: Run full verification**

Run: `npm run verify`

Expected:

- Formatting passes.
- Biome reports no issues.
- TypeScript passes.
- All unit and integration tests pass.
- `npm pack --dry-run` reports `deepseek-crawl@0.2.0` with no unintended files.

- [ ] **Step 5: Perform a manual CLI smoke test with mocked environment**

Run the packaged executable help commands:

```bash
node dist/bin.js --version
node dist/bin.js help
node dist/bin.js help map
node dist/bin.js help crawl
```

Expected: version `0.2.0`; help lists all six commands and exact ranges.

- [ ] **Step 6: Audit the implementation against the spec**

Check each spec section against a concrete test:

- Map CLI/MCP limits and source merging.
- Crawl CLI/MCP bounds, deterministic order, failures, and content budgets.
- Public-address and redirect validation.
- Sitemap index, cycle, XML, and size behavior.
- No-clobber and atomic output behavior.
- SIGINT and MCP cancellation.
- Version and documentation.

Fix any gap and rerun `npm run verify`.

- [ ] **Step 7: Commit**

```bash
git add README.md test/unit/package.test.ts test/integration/mcp-stdio.test.ts
git commit -m "docs: document Firecrawl capability replacement"
```

---

## Spec Coverage Review

- Public Surface and result contracts: Tasks 4, 5, 7, 10, and 11.
- URL/link and redirect limitations: Tasks 3 and 12.
- Map Sitemap, public-network, warning, and truncation behavior: Tasks 8-11.
- Deterministic Crawl, page/discovery limits, failures, and cancellation:
  Tasks 4-7.
- Response-body, page-content, and MCP aggregate limits: Tasks 2, 4, 5, and 7.
- No-clobber/atomic outputs: Tasks 5 and 11.
- Privacy, untrusted content, no `robots.txt`, and documentation: Tasks 12.
- Dependencies, version, and package identity: Task 1.
- Offline test strategy and regressions: every task, with full verification in
  Task 12.

The plan has no unresolved implementation choice: limits, interfaces, ordering,
error behavior, and test commands are fixed above.

## Final Acceptance Checklist

- [ ] `deepseek-crawl map <url>` discovers Sitemap and seed-page URLs with stable JSON.
- [ ] `deepseek-crawl crawl <url> --output <dir>` writes deterministic bounded Markdown.
- [ ] MCP exposes exactly `deepseek_search`, `deepseek_fetch`, `deepseek_map`, and `deepseek_crawl`.
- [ ] Direct Sitemap requests reject private addresses and revalidate redirects.
- [ ] No new output command overwrites an existing path.
- [ ] Search, Fetch, Doctor, and stdio MCP regressions pass.
- [ ] Normal tests are offline.
- [ ] `npm run verify` passes from a clean worktree.
- [ ] Package identifies as `deepseek-crawl@0.2.0`.
