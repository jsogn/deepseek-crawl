# Firecrawl-Compatible Gateway Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an optional `deepseek-crawl gateway` mode that is Firecrawl-compatible for common operations and falls back to DeepSeek after Firecrawl credit exhaustion.

**Architecture:** A Node HTTP compatibility handler receives `/v2/*` requests. Supported routes first attempt a Firecrawl upstream call and switch to the existing DeepSeek application functions on `402`; other routes are transparently passed through.

**Tech Stack:** TypeScript ESM, Node.js HTTP/fetch, Zod, Vitest, Biome.

**Spec:** `docs/superpowers/specs/2026-11-14-firecrawl-compatible-gateway-design.md`

## Global Constraints

- Do not publish or release the package.
- Do not make live Firecrawl or DeepSeek requests in tests.
- Preserve existing CLI and MCP behavior.
- Default gateway host is `127.0.0.1`; non-loopback binding requires `--allow-remote`.
- The gateway reads `FIRECRAWL_UPSTREAM_URL`, never `FIRECRAWL_API_URL`.
- Never log API keys or authorization headers.
- Keep gateway and Firecrawl protocol imports out of core application modules.
- Use test-driven development: watch each focused test fail before production code.

---

### Task 1: Gateway Configuration And CLI Mode

**Files:**
- Create: `src/gateway/config.ts`
- Modify: `src/cli/parse.ts`
- Modify: `src/cli/run.ts`
- Test: `test/unit/gateway-config.test.ts`
- Test: `test/unit/cli-parse.test.ts`

**Interfaces:**
- Produces: `loadGatewayConfig(options): GatewayConfig`
- Produces: `ParsedCommand` variant `{ kind: "gateway"; host: string; port: number; allowRemote: boolean }`

- [ ] **Step 1: Write failing gateway config tests**

```ts
it("defaults to loopback port 8787", () => {
  expect(loadGatewayConfig({ env: {} })).toMatchObject({
    host: "127.0.0.1",
    port: 8787,
    allowRemote: false,
  });
});

it("rejects a non-loopback host without --allow-remote", () => {
  expect(() =>
    loadGatewayConfig({ host: "0.0.0.0", port: 8787, allowRemote: false, env: {} }),
  ).toThrow(/allow-remote/i);
});

it("does not use FIRECRAWL_API_URL as the upstream", () => {
  expect(
    loadGatewayConfig({
      env: {
        FIRECRAWL_API_URL: "http://127.0.0.1:8787",
        FIRECRAWL_UPSTREAM_URL: "https://firecrawl.example",
      },
    }).upstreamUrl.href,
  ).toBe("https://firecrawl.example/");
});
```

- [ ] **Step 2: Add failing parser tests**

```ts
it("parses gateway options", () => {
  expect(parseCli(["gateway", "--host", "127.0.0.1", "--port", "9000"])).toEqual({
    kind: "gateway",
    host: "127.0.0.1",
    port: 9000,
    allowRemote: false,
  });
});
```

- [ ] **Step 3: Run focused tests and confirm missing behavior**

Run:

```bash
npm test -- test/unit/gateway-config.test.ts test/unit/cli-parse.test.ts
```

Expected: FAIL because the gateway module and CLI variant do not exist.

- [ ] **Step 4: Implement gateway config and CLI parsing**

The config interface must be:

```ts
export interface GatewayConfig {
  host: string;
  port: number;
  allowRemote: boolean;
  upstreamUrl: URL;
  requestBodyLimit: number;
  timeoutMs: number;
}
```

Port validation is `1..65535`. Upstream validation requires HTTP(S), no
credentials, no query, and HTTPS unless loopback.

- [ ] **Step 5: Run focused and type tests**

```bash
npm test -- test/unit/gateway-config.test.ts test/unit/cli-parse.test.ts
npm run typecheck:test
```

- [ ] **Step 6: Commit**

```bash
git add src/gateway/config.ts src/cli/parse.ts src/cli/run.ts test/unit/gateway-config.test.ts test/unit/cli-parse.test.ts
git commit -m "feat: add gateway configuration and CLI mode"
```

---

### Task 2: Firecrawl Pass-Through Handler And HTTP Server

**Files:**
- Create: `src/firecrawl/types.ts`
- Create: `src/firecrawl/upstream.ts`
- Create: `src/gateway/errors.ts`
- Create: `src/gateway/handler.ts`
- Create: `src/gateway/server.ts`
- Modify: `src/cli/run.ts`
- Modify: `src/bin.ts`
- Test: `test/integration/firecrawl-gateway.test.ts`

**Interfaces:**
- Produces: `createGatewayHandler(deps): (request: Request) => Promise<Response>`
- Produces: `startGatewayServer(options): Promise<GatewayServer>`
- Produces: `GatewayServer.close(): Promise<void>`

- [ ] **Step 1: Write failing pass-through tests**

Use a local HTTP server for the gateway and implement the injected `fetchImpl`
as a deterministic fake upstream. Assert:

```ts
const response = await fetch("http://127.0.0.1:PORT/v2/scrape", {
  method: "POST",
  headers: { Authorization: "Bearer fc-test", "Content-Type": "application/json" },
  body: JSON.stringify({ url: "https://example.com" }),
});

expect(response.status).toBe(200);
expect(await response.json()).toEqual(upstreamFixture);
expect(upstreamRequest.url).toBe("https://api.firecrawl.dev/v2/scrape");
expect(upstreamRequest.headers.get("authorization")).toBe("Bearer fc-test");
```

- [ ] **Step 2: Run test and confirm failure**

```bash
npm test -- test/integration/firecrawl-gateway.test.ts
```

Expected: FAIL because the server and handler do not exist.

- [ ] **Step 3: Implement buffered transparent upstream forwarding**

Requirements:

- Read the inbound body up to 8 MiB.
- Preserve query strings and HTTP methods.
- Resolve the upstream key from incoming Bearer auth, then
  `FIRECRAWL_API_KEY`.
- Do not forward `host`, `connection`, `content-length`, `transfer-encoding`,
  or `expect`.
- Forward upstream `status`, selected safe headers, and body.

- [ ] **Step 4: Implement `deepseek-crawl gateway` startup**

`runCli` starts the gateway and resolves after abort or server close. `bin.ts`
adds `gateway` to signal-aware commands and prints one nonsecret listening line.

- [ ] **Step 5: Run focused and full unit tests**

```bash
npm test -- test/integration/firecrawl-gateway.test.ts
npm run typecheck:test
```

- [ ] **Step 6: Commit**

```bash
git add src/firecrawl src/gateway src/cli/run.ts src/bin.ts test/integration/firecrawl-gateway.test.ts
git commit -m "feat: add Firecrawl-compatible gateway server"
```

---

### Task 3: Search And Scrape DeepSeek Fallback

**Files:**
- Create: `src/firecrawl/compat.ts`
- Modify: `src/gateway/handler.ts`
- Modify: `src/gateway/errors.ts`
- Test: `test/unit/firecrawl-compat.test.ts`
- Test: `test/integration/firecrawl-gateway.test.ts`

**Interfaces:**
- Produces: `firecrawlSearchFallback(input, client, options): Promise<unknown>`
- Produces: `firecrawlScrapeFallback(input, client, options): Promise<unknown>`
- Produces: `UnsupportedFallbackFeatureError`

- [ ] **Step 1: Write failing Search compatibility test**

```ts
const result = await firecrawlSearchFallback(
  { query: "DeepSeek", limit: 1, scrapeOptions: { formats: ["markdown"] } },
  gateway,
  { maxMarkdownChars: 0 },
);

expect(result).toEqual({
  success: true,
  data: {
    web: [
      {
        title: "Result",
        description: "Snippet",
        url: "https://example.com/result",
        markdown: "# Result",
        metadata: {
          title: "Result",
          description: "Snippet",
          sourceURL: "https://example.com/result",
          url: "https://example.com/result",
        },
      },
    ],
  },
  creditsUsed: 0,
});
```

- [ ] **Step 2: Write failing unsupported-format test**

```ts
await expect(
  firecrawlScrapeFallback(
    { url: "https://example.com", formats: ["screenshot"] },
    gateway,
  ),
).rejects.toMatchObject({ code: "unsupported_fallback_feature" });
```

- [ ] **Step 3: Run tests and confirm failure**

```bash
npm test -- test/unit/firecrawl-compat.test.ts
```

- [ ] **Step 4: Implement Search and Scrape mapping**

Use the existing `executeSearch` and `executeFetch`. Only support web Search and
markdown output. Return Firecrawl-shaped success responses with
`creditsUsed: 0` for Search.

- [ ] **Step 5: Route Firecrawl `402` to the fallback**

On a supported route:

- `402` triggers fallback.
- No Firecrawl credential triggers fallback.
- Other statuses remain transparent.
- Exhausted state lasts 60 seconds.

- [ ] **Step 6: Run focused tests**

```bash
npm test -- test/unit/firecrawl-compat.test.ts test/integration/firecrawl-gateway.test.ts
```

- [ ] **Step 7: Commit**

```bash
git add src/firecrawl/compat.ts src/gateway test/unit/firecrawl-compat.test.ts test/integration/firecrawl-gateway.test.ts
git commit -m "feat: add DeepSeek fallback for Firecrawl search and scrape"
```

---

### Task 4: Map Fallback

**Files:**
- Modify: `src/firecrawl/compat.ts`
- Modify: `src/gateway/handler.ts`
- Test: `test/unit/firecrawl-compat.test.ts`

**Interfaces:**
- Produces: `firecrawlMapFallback(input, client, reader, options): Promise<unknown>`

- [ ] **Step 1: Write failing Map mapping test**

```ts
expect(
  await firecrawlMapFallback(
    { url: "https://example.com", search: "docs", limit: 2 },
    gateway,
    reader,
    { discoveryLimit: 10000 },
  ),
).toEqual({
  success: true,
  links: [{ url: "https://example.com/docs" }],
});
```

- [ ] **Step 2: Run test and confirm failure**

```bash
npm test -- test/unit/firecrawl-compat.test.ts
```

- [ ] **Step 3: Implement `executeMap` mapping**

Validate URL and limit, use the existing Map implementation, and preserve
deterministic URL order.

- [ ] **Step 4: Run tests**

```bash
npm test -- test/unit/firecrawl-compat.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/firecrawl/compat.ts src/gateway/handler.ts test/unit/firecrawl-compat.test.ts
git commit -m "feat: add DeepSeek fallback for Firecrawl map"
```

---

### Task 5: DeepSeek-Backed Crawl Jobs

**Files:**
- Create: `src/gateway/crawl-jobs.ts`
- Modify: `src/firecrawl/compat.ts`
- Modify: `src/gateway/handler.ts`
- Test: `test/unit/gateway-crawl-jobs.test.ts`
- Test: `test/integration/firecrawl-gateway.test.ts`

**Interfaces:**
- Produces: `CrawlJobManager.create(input, client, reader, options): { id, url }`
- Produces: `CrawlJobManager.status(id): FirecrawlCrawlStatus`
- Produces: `CrawlJobManager.errors(id): FirecrawlCrawlErrors`
- Produces: `CrawlJobManager.cancel(id): boolean`

- [ ] **Step 1: Write failing job lifecycle tests**

```ts
const created = manager.create(
  { url: "https://example.com", limit: 2 },
  gateway,
  reader,
  options,
);

expect(created.id).toMatch(/^dsc_/);
await manager.waitForIdle(created.id);
expect(manager.status(created.id)).toMatchObject({
  status: "completed",
  completed: 1,
  total: 1,
  creditsUsed: 0,
});
```

- [ ] **Step 2: Run test and confirm failure**

```bash
npm test -- test/unit/gateway-crawl-jobs.test.ts
```

- [ ] **Step 3: Implement in-memory jobs**

Start `executeCrawl` in the background, update completed pages through its
`onPage` callback, store failures, and expose cancellation through an
`AbortController`. Use a 24-hour expiry.

- [ ] **Step 4: Add HTTP lifecycle tests**

Cover create, status, errors, cancel, missing ID, and Firecrawl-ID pass-through.
The status response must include top-level `success: true`, as required by the
official Node SDK.

- [ ] **Step 5: Run focused tests**

```bash
npm test -- test/unit/gateway-crawl-jobs.test.ts test/integration/firecrawl-gateway.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add src/gateway/crawl-jobs.ts src/firecrawl/compat.ts src/gateway/handler.ts test/unit/gateway-crawl-jobs.test.ts test/integration/firecrawl-gateway.test.ts
git commit -m "feat: add DeepSeek-backed Firecrawl crawl jobs"
```

---

### Task 6: Documentation, Packaging, And Full Verification

**Files:**
- Modify: `README.md`
- Modify: `README.en.md`
- Modify: `docs/operations.zh-CN.md`
- Modify: `docs/operations.md`
- Modify: `skills/deepseek-crawl/SKILL.md`
- Modify: `skills/deepseek-crawl/references/cli-reference.md`
- Modify: `CHANGELOG.md`
- Modify: `src/index.ts`
- Test: `test/unit/package.test.ts`
- Test: `test/integration/package-install.test.ts`

- [ ] **Step 1: Write a failing packaged-command test**

Assert that a packed installation exposes the `gateway` help text and the
built server module without requiring a separate package.

- [ ] **Step 2: Run the package-focused test and confirm failure**

```bash
npm test -- test/unit/package.test.ts test/integration/package-install.test.ts
```

- [ ] **Step 3: Export the gateway library surface and update help/docs**

Document:

- `FIRECRAWL_API_URL=http://127.0.0.1:8787` for clients.
- `FIRECRAWL_UPSTREAM_URL` for the gateway process.
- Supported fallback operations and unsupported advanced features.
- Loopback default and remote binding requirement.
- One process can serve multiple local clients.
- No install-time daemon is started.

- [ ] **Step 4: Run formatting and focused package tests**

```bash
npm run format
npm test -- test/unit/package.test.ts test/integration/package-install.test.ts
```

- [ ] **Step 5: Run full verification**

```bash
npm run verify
```

Expected: every formatter, linter, type check, unit and integration test, and
tarball installation check passes.

- [ ] **Step 6: Commit**

```bash
git add README.md README.en.md docs/operations.md docs/operations.zh-CN.md skills/deepseek-crawl CHANGELOG.md src/index.ts test
git commit -m "docs: document Firecrawl-compatible gateway"
```
