# Firecrawl Keyless Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an automatic local-only Firecrawl Keyless tier between keyed Firecrawl and DeepSeek fallback.

**Architecture:** Add a focused policy module for Keyless routes and cooldown handling, extend the Firecrawl upstream helper with an explicit credential mode, and integrate the staged provider decision in the gateway handler. Remote gateways and explicit non-Firecrawl-first modes remain unchanged.

**Tech Stack:** TypeScript ESM, Node.js 22+, Zod, Vitest, Biome.

**Spec:** `docs/superpowers/specs/2026-11-15-firecrawl-keyless-fallback-design.md`

## Global Constraints

- Node.js remains `>=22.12.0`.
- Do not add dependencies.
- Keyless is enabled only for loopback gateways with `allowRemote: false` and provider mode `firecrawl-first`.
- Keyless requests must contain no `Authorization` header.
- Keyless never forwards a client, environment, Keychain, or gateway credential.
- Never rotate IPs or bypass Firecrawl `429` limits.
- Keyless `429` uses a 15-minute default cooldown unless a valid `Retry-After` is present.
- Keyless-only routes return a structured `429 keyless_rate_limited` during cooldown.
- `deepseek-first`, `no-fallback`, remote gateways, Crawl, Map, Extract, Batch, Agent, and job-status routes do not use Keyless.
- No live Keyless request is required in automated tests.

---

### Task 1: Add Keyless route and cooldown policy

**Files:**

- Create: `src/gateway/keyless.ts`
- Create: `test/unit/gateway-keyless.test.ts`

**Interfaces:**

- Consumes: `GatewayConfig` from `src/gateway/config.ts`.
- Produces:
  - `DEFAULT_KEYLESS_COOLDOWN_MS = 900_000`
  - `isKeylessEnabled(config: Pick<GatewayConfig, "allowRemote" | "providerMode">): boolean`
  - `isKeylessRoute(method: string, pathname: string): boolean`
  - `parseRetryAfter(value: string | null, nowMs: number): number | undefined`
  - `class KeylessCooldown`
    - `block(nowMs: number, retryAfter: string | null): void`
    - `remainingMs(nowMs: number): number`
    - `retryAfterSeconds(nowMs: number): number`

- [x] **Step 1: Write the failing Keyless policy tests**

Create `test/unit/gateway-keyless.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  DEFAULT_KEYLESS_COOLDOWN_MS,
  isKeylessEnabled,
  isKeylessRoute,
  KeylessCooldown,
  parseRetryAfter,
} from "../../src/gateway/keyless.js";

describe("Firecrawl Keyless policy", () => {
  it("enables Keyless only for local firecrawl-first gateways", () => {
    expect(isKeylessEnabled({ allowRemote: false, providerMode: "firecrawl-first" })).toBe(true);
    expect(isKeylessEnabled({ allowRemote: false })).toBe(true);
    expect(isKeylessEnabled({ allowRemote: true, providerMode: "firecrawl-first" })).toBe(false);
    expect(isKeylessEnabled({ allowRemote: false, providerMode: "deepseek-first" })).toBe(false);
    expect(isKeylessEnabled({ allowRemote: false, providerMode: "no-fallback" })).toBe(false);
  });

  it("matches only documented Keyless routes", () => {
    for (const [method, path] of [
      ["POST", "/v2/scrape"],
      ["POST", "/v2/search"],
      ["POST", "/v2/parse"],
      ["POST", "/v2/parse/upload-url"],
      ["POST", "/v2/scrape/job_1/interact"],
      ["DELETE", "/v2/scrape/job_1/interact"],
      ["POST", "/v1/scrape"],
      ["POST", "/v1/search"],
      ["POST", "/v2/search/developer"],
      ["POST", "/v2/search/research"],
      ["POST", "/v2/search/government"],
      ["POST", "/v2/search/gov"],
    ] as const) {
      expect(isKeylessRoute(method, path)).toBe(true);
    }

    for (const [method, path] of [
      ["POST", "/v2/crawl"],
      ["POST", "/v2/map"],
      ["POST", "/v2/extract"],
      ["POST", "/v2/batch/scrape"],
      ["POST", "/v2/agent"],
      ["GET", "/v2/crawl/id"],
      ["POST", "/v2/interact"],
      ["GET", "/v2/scrape"],
    ] as const) {
      expect(isKeylessRoute(method, path)).toBe(false);
    }
  });

  it("parses Retry-After seconds and HTTP dates", () => {
    const now = Date.parse("2026-11-15T00:00:00Z");
    expect(parseRetryAfter("120", now)).toBe(120_000);
    expect(parseRetryAfter("Sun, 15 Nov 2026 00:02:00 GMT", now)).toBe(120_000);
    expect(parseRetryAfter("0", now)).toBe(0);
    expect(parseRetryAfter("-1", now)).toBeUndefined();
    expect(parseRetryAfter("invalid", now)).toBeUndefined();
    expect(parseRetryAfter(null, now)).toBeUndefined();
  });

  it("applies and expires the default Keyless cooldown", () => {
    const cooldown = new KeylessCooldown();
    cooldown.block(1_000, null);
    expect(cooldown.remainingMs(1_000)).toBe(DEFAULT_KEYLESS_COOLDOWN_MS);
    expect(cooldown.retryAfterSeconds(2_000)).toBe(899);
    expect(cooldown.remainingMs(1_000 + DEFAULT_KEYLESS_COOLDOWN_MS)).toBe(0);
  });

  it("uses Retry-After when blocking", () => {
    const cooldown = new KeylessCooldown();
    cooldown.block(1_000, "30");
    expect(cooldown.remainingMs(1_000)).toBe(30_000);
    expect(cooldown.retryAfterSeconds(20_000)).toBe(11);
  });
});
```

- [x] **Step 2: Run the policy test and verify it fails**

Run:

```bash
npm test -- test/unit/gateway-keyless.test.ts
```

Expected: FAIL because `src/gateway/keyless.ts` does not exist.

- [x] **Step 3: Implement the Keyless policy module**

Create `src/gateway/keyless.ts`:

```ts
import type { GatewayConfig } from "./config.js";

export const DEFAULT_KEYLESS_COOLDOWN_MS = 15 * 60_000;

const KEYLESS_EXACT_ROUTES = new Set([
  "POST /v2/scrape",
  "POST /v2/search",
  "POST /v2/parse",
  "POST /v2/parse/upload-url",
  "POST /v1/scrape",
  "POST /v1/search",
  "POST /v2/search/developer",
  "POST /v2/search/research",
  "POST /v2/search/government",
  "POST /v2/search/gov",
]);

const KEYLESS_INTERACT_ROUTE = /^\/v2\/scrape\/[^/]+\/interact$/;

export function isKeylessEnabled(
  config: Pick<GatewayConfig, "allowRemote" | "providerMode">,
): boolean {
  return !config.allowRemote && (config.providerMode ?? "firecrawl-first") === "firecrawl-first";
}

export function isKeylessRoute(method: string, pathname: string): boolean {
  const route = `${method.toUpperCase()} ${pathname}`;
  if (KEYLESS_EXACT_ROUTES.has(route)) {
    return true;
  }
  return (method === "POST" || method === "DELETE") && KEYLESS_INTERACT_ROUTE.test(pathname);
}

export function parseRetryAfter(value: string | null, nowMs: number): number | undefined {
  const normalized = value?.trim();
  if (!normalized) {
    return undefined;
  }
  if (/^\d+$/.test(normalized)) {
    return Number(normalized) * 1000;
  }
  const deadline = Date.parse(normalized);
  return Number.isFinite(deadline) ? Math.max(0, deadline - nowMs) : undefined;
}

export class KeylessCooldown {
  #untilMs = 0;

  block(nowMs: number, retryAfter: string | null): void {
    const delayMs = parseRetryAfter(retryAfter, nowMs) ?? DEFAULT_KEYLESS_COOLDOWN_MS;
    this.#untilMs = nowMs + delayMs;
  }

  remainingMs(nowMs: number): number {
    return Math.max(0, this.#untilMs - nowMs);
  }

  retryAfterSeconds(nowMs: number): number {
    return Math.ceil(this.remainingMs(nowMs) / 1000);
  }
}
```

- [x] **Step 4: Run the focused test**

Run:

```bash
npm test -- test/unit/gateway-keyless.test.ts
```

Expected: PASS.

- [x] **Step 5: Run type checks and formatting**

```bash
npm run format:check
npm run lint
npm run typecheck
npm run typecheck:test
```

- [x] **Step 6: Commit Keyless policy**

```bash
git add src/gateway/keyless.ts test/unit/gateway-keyless.test.ts \
  docs/superpowers/plans/2026-11-15-firecrawl-keyless-fallback.md
git commit -m "feat: add Firecrawl keyless policy"
```

---

### Task 2: Add an explicit Keyless credential mode upstream

**Files:**

- Modify: `src/firecrawl/upstream.ts`
- Modify: `test/unit/firecrawl-upstream.test.ts`

**Interfaces:**

- Consumes: existing `requestFirecrawlUpstream`.
- Produces:
  - `type FirecrawlCredentialMode = "configured" | "keyless"`
  - `FirecrawlUpstreamRequest.credentialMode?: FirecrawlCredentialMode`

- [x] **Step 1: Add failing upstream authorization tests**

Append to `test/unit/firecrawl-upstream.test.ts`:

```ts
  it("preserves configured credentials by default", async () => {
    let authorization: string | null = "unset";
    await requestFirecrawlUpstream(
      {
        method: "POST",
        path: "/v2/scrape",
        headers: new Headers({ authorization: "Bearer caller-key" }),
      },
      {
        config,
        env: { FIRECRAWL_API_KEY: "fc-environment" },
        fetchImpl: async (_input, init) => {
          authorization = new Headers(init?.headers).get("authorization");
          return Response.json({ success: true });
        },
      },
    );
    expect(authorization).toBe("Bearer caller-key");
  });

  it("strips every authorization source in keyless mode", async () => {
    let authorization: string | null = "unset";
    await requestFirecrawlUpstream(
      {
        method: "POST",
        path: "/v2/scrape",
        headers: new Headers({ authorization: "Bearer caller-key" }),
        credentialMode: "keyless",
      },
      {
        config: { ...config, firecrawlApiKey: "fc-configured" },
        env: { FIRECRAWL_API_KEY: "fc-environment" },
        fetchImpl: async (_input, init) => {
          authorization = new Headers(init?.headers).get("authorization");
          return Response.json({ success: true });
        },
      },
    );
    expect(authorization).toBeNull();
  });
```

- [x] **Step 2: Run the upstream tests and verify failure**

```bash
npm test -- test/unit/firecrawl-upstream.test.ts
```

Expected: FAIL because `credentialMode` is not implemented.

- [x] **Step 3: Implement credential mode**

In `src/firecrawl/upstream.ts`:

```ts
export type FirecrawlCredentialMode = "configured" | "keyless";
```

Add to `FirecrawlUpstreamRequest`:

```ts
  credentialMode?: FirecrawlCredentialMode;
```

Change `upstreamHeaders` signature to accept a mode:

```ts
function upstreamHeaders(
  source: Headers,
  env: NodeJS.ProcessEnv,
  configuredKey: string | undefined,
  credentialMode: FirecrawlCredentialMode,
): Headers {
  const headers = new Headers();
  for (const [name, value] of source) {
    if (!BLOCKED_REQUEST_HEADERS.has(name.toLowerCase())) {
      headers.set(name, value);
    }
  }

  if (credentialMode === "keyless") {
    headers.delete("authorization");
    return headers;
  }

  const upstreamKey = configuredKey?.trim() || env.FIRECRAWL_API_KEY?.trim();
  if (upstreamKey && !headers.has("authorization")) {
    if (/[\r\n]/.test(upstreamKey)) {
      throw new Error("FIRECRAWL_API_KEY must not contain a newline.");
    }
    headers.set("authorization", `Bearer ${upstreamKey}`);
  }
  return headers;
}
```

Pass `input.credentialMode ?? "configured"` from `requestFirecrawlUpstream`.

- [x] **Step 4: Run upstream tests**

```bash
npm test -- test/unit/firecrawl-upstream.test.ts
```

Expected: PASS.

- [x] **Step 5: Commit upstream credential mode**

```bash
git add src/firecrawl/upstream.ts test/unit/firecrawl-upstream.test.ts
git commit -m "feat: support Firecrawl keyless upstream requests"
```

---

### Task 3: Integrate staged Keyless routing in the gateway

**Files:**

- Modify: `src/gateway/telemetry.ts`
- Modify: `src/gateway/handler.ts`
- Modify: `test/integration/firecrawl-gateway.test.ts`

**Interfaces:**

- Consumes:
  - `isKeylessEnabled`, `isKeylessRoute`, `KeylessCooldown`
  - `credentialMode: "keyless"`
- Produces:
  - `provider: "firecrawl-keyless"` telemetry
  - Keyless fallback reasons defined in the spec

- [ ] **Step 1: Extend the telemetry provider union**

In `src/gateway/telemetry.ts`:

```ts
  provider: "firecrawl" | "firecrawl-keyless" | "deepseek" | "gateway" | "none";
```

- [ ] **Step 2: Add failing no-key and 402-to-Keyless integration tests**

In `test/integration/firecrawl-gateway.test.ts`, add:

```ts
  it("uses keyless Firecrawl before DeepSeek when no credential exists", async () => {
    let authorization: string | null = "unset";
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
      fetchImpl: async (_input, init) => {
        authorization = new Headers(init?.headers).get("authorization");
        return Response.json({ success: true, data: { markdown: "# Keyless" } });
      },
    });
    servers.push(server);

    const response = await fetch(new URL("/v2/scrape", server.url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://example.com/", formats: ["markdown"] }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      data: { markdown: "# Keyless" },
    });
    expect(authorization).toBeNull();
    expect(deepSeekCalls).toBe(0);
  });

  it("tries keyless Firecrawl after a keyed 402 before DeepSeek", async () => {
    const authorizations: Array<string | null> = [];
    let deepSeekCalls = 0;
    const server = await startGatewayServer({
      config: testConfig(),
      env: { FIRECRAWL_API_KEY: "fc-keyed" },
      deepseekClient: {
        async search() {
          throw new Error("Unexpected Search call.");
        },
        async fetch() {
          deepSeekCalls += 1;
          throw new Error("Unexpected Fetch call.");
        },
      },
      fetchImpl: async (_input, init) => {
        authorizations.push(new Headers(init?.headers).get("authorization"));
        return authorizations.length === 1
          ? Response.json({ success: false, error: "Payment required." }, { status: 402 })
          : Response.json({ success: true, data: { markdown: "# Keyless" } });
      },
    });
    servers.push(server);

    const response = await fetch(new URL("/v2/scrape", server.url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://example.com/", formats: ["markdown"] }),
    });

    expect(response.status).toBe(200);
    expect(authorizations).toEqual(["Bearer fc-keyed", null]);
    expect(deepSeekCalls).toBe(0);
  });
```

- [ ] **Step 3: Run the focused integration tests and verify failure**

```bash
npm test -- test/integration/firecrawl-gateway.test.ts
```

Expected: FAIL because the handler still sends no-key Scrape to DeepSeek and 402 directly to fallback.

- [ ] **Step 4: Integrate Keyless routing**

At handler scope, create:

```ts
  const keylessCooldown = new KeylessCooldown();
```

Inside the request handler, compute:

```ts
    const keylessEnabled =
      isKeylessEnabled(dependencies.config) && isKeylessRoute(method, requestUrl.pathname);
    const keylessCoolingDown = keylessCooldown.remainingMs(now()) > 0;
```

Create one local helper that sends a Firecrawl request in a selected credential mode. The helper uses the existing request body, request signal, upstream URL, and response streaming. It returns the `Response` without sending it to the client.

The final routing order must be:

1. Local DeepSeek crawl job routes use local job handling.
2. `deepseek-first` common routes use DeepSeek.
3. `no-fallback` missing-credential behavior remains unchanged.
4. If a Firecrawl credential exists, try configured Firecrawl.
5. On configured Firecrawl `402` in `firecrawl-first`, set the existing credit cooldown.
6. If Keyless is enabled and not cooling down, try Keyless with `credentialMode: "keyless"`.
7. Keyless success or non-`429` error is passed through unchanged.
8. Keyless `429` blocks the Keyless cooldown using `response.headers.get("retry-after")`.
9. After Keyless `429`, use DeepSeek when the route has fallback; otherwise pass the Keyless `429` through.
10. If Keyless is cooling down and the route has DeepSeek fallback, use DeepSeek.
11. If Keyless is cooling down and the route has no DeepSeek fallback, return `429`:

```json
{
  "success": false,
  "error": "Firecrawl Keyless is cooling down after rate limiting.",
  "code": "keyless_rate_limited"
}
```

with `Retry-After` set to `keylessCooldown.retryAfterSeconds(now())`.

Set telemetry:

```ts
provider = "firecrawl-keyless";
fallback = true;
fallbackReason = hasFirecrawl
  ? "firecrawl_keyless_after_credits"
  : "firecrawl_keyless_no_credential";
```

When Keyless is skipped or rate-limited and DeepSeek runs, use:

```ts
fallbackReason = keylessCoolingDown
  ? "firecrawl_keyless_cooldown"
  : "firecrawl_keyless_rate_limited";
```

- [ ] **Step 5: Run the focused integration tests**

```bash
npm test -- test/integration/firecrawl-gateway.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit staged routing**

```bash
git add src/gateway/telemetry.ts src/gateway/handler.ts \
  test/integration/firecrawl-gateway.test.ts \
  docs/superpowers/plans/2026-11-15-firecrawl-keyless-fallback.md
git commit -m "feat: route local gateways through Firecrawl keyless"
```

---

### Task 4: Prove advanced, cooldown, remote, and documentation behavior

**Files:**

- Modify: `test/integration/firecrawl-gateway.test.ts`
- Modify: `test/integration/firecrawl-sdk-gateway.test.ts`
- Modify: `README.md`
- Modify: `README.en.md`
- Modify: `docs/operations.md`
- Modify: `docs/operations.zh-CN.md`
- Modify: `skills/deepseek-crawl/references/cli-reference.md`
- Modify: `CHANGELOG.md`

**Interfaces:**

- Consumes all prior tasks.
- Produces no additional public API.

- [ ] **Step 1: Add Keyless cooldown and advanced-route tests**

Add integration cases:

```ts
  it("uses DeepSeek after keyless 429 and does not retry Keyless during cooldown", async () => {
    let keylessCalls = 0;
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
          return { title: "Example", content: "# DeepSeek" };
        },
      },
      fetchImpl: async () => {
        keylessCalls += 1;
        return Response.json(
          { success: false, error: "Rate limited." },
          { status: 429, headers: { "retry-after": "60" } },
        );
      },
    });
    servers.push(server);

    const body = JSON.stringify({ url: "https://example.com/", formats: ["markdown"] });
    for (let index = 0; index < 2; index += 1) {
      const response = await fetch(new URL("/v2/scrape", server.url), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      expect(response.status).toBe(200);
    }

    expect(keylessCalls).toBe(1);
    expect(deepSeekCalls).toBe(2);
  });

  it("passes Keyless Parse through without authorization", async () => {
    let authorization: string | null = "unset";
    const server = await startGatewayServer({
      config: testConfig(),
      env: {},
      fetchImpl: async (_input, init) => {
        authorization = new Headers(init?.headers).get("authorization");
        return Response.json({ success: true, data: { markdown: "# Parsed" } });
      },
    });
    servers.push(server);

    const response = await fetch(new URL("/v2/parse", server.url), {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: "document",
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      data: { markdown: "# Parsed" },
    });
    expect(authorization).toBeNull();
  });

  it("passes Post-Scrape Interact through without authorization", async () => {
    let captured: { path: string; authorization: string | null } | undefined;
    const server = await startGatewayServer({
      config: testConfig(),
      env: {},
      fetchImpl: async (input, init) => {
        captured = {
          path: new URL(String(input)).pathname,
          authorization: new Headers(init?.headers).get("authorization"),
        };
        return Response.json({ success: true, stdout: "clicked", stderr: "" });
      },
    });
    servers.push(server);

    const response = await fetch(
      new URL("/v2/scrape/job_1/interact", server.url),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: "await page.click('#submit')", language: "node" }),
      },
    );

    expect(response.status).toBe(200);
    expect(captured).toEqual({
      path: "/v2/scrape/job_1/interact",
      authorization: null,
    });
  });

  it("returns 429 for a keyless-only route during cooldown", async () => {
    let keylessCalls = 0;
    const server = await startGatewayServer({
      config: testConfig(),
      env: {},
      fetchImpl: async () => {
        keylessCalls += 1;
        return Response.json(
          { success: false, error: "Rate limited." },
          { status: 429, headers: { "retry-after": "60" } },
        );
      },
    });
    servers.push(server);

    const request = () =>
      fetch(new URL("/v2/parse", server.url), {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: "document",
      });
    expect((await request()).status).toBe(429);
    const second = await request();
    expect(second.status).toBe(429);
    expect(second.headers.get("retry-after")).toBeTruthy();
    expect(await second.json()).toMatchObject({ code: "keyless_rate_limited" });
    expect(keylessCalls).toBe(1);
  });
```

- [ ] **Step 2: Add remote-mode and official-SDK no-key tests**

Add remote mode coverage:

```ts
  it("never uses keyless Firecrawl for a remote gateway", async () => {
    let firecrawlCalls = 0;
    let deepSeekCalls = 0;
    const server = await startGatewayServer({
      config: {
        ...testConfig(),
        allowRemote: true,
        gatewayApiKey: "gateway-token",
      },
      env: {},
      deepseekClient: {
        async search() {
          throw new Error("Unexpected Search call.");
        },
        async fetch() {
          deepSeekCalls += 1;
          return { title: "Example", content: "# DeepSeek" };
        },
      },
      fetchImpl: async () => {
        firecrawlCalls += 1;
        return Response.json({ success: true });
      },
    });
    servers.push(server);

    const response = await fetch(new URL("/v2/scrape", server.url), {
      method: "POST",
      headers: {
        Authorization: "Bearer gateway-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ url: "https://example.com/", formats: ["markdown"] }),
    });

    expect(response.status).toBe(200);
    expect(firecrawlCalls).toBe(0);
    expect(deepSeekCalls).toBe(1);
  });
```

Add this SDK no-key Scrape test:

```ts
  it("uses the official SDK against Keyless Firecrawl without an API key", async () => {
    const upstream = await startMockUpstream(() => ({
      body: {
        success: true,
        data: {
          markdown: "# Keyless",
          metadata: {
            title: "Example",
            sourceURL: "https://example.com/",
            url: "https://example.com/",
            statusCode: 200,
          },
        },
      },
    }));
    const gateway = await startGatewayServer({
      config: testConfig(upstream.url),
      env: {},
      fetchImpl: fetch,
    });
    servers.push(gateway);
    const client = new Firecrawl({
      apiUrl: gateway.url.href.replace(/\/$/, ""),
    });

    const scraped = await client.scrape("https://example.com/", {
      formats: ["markdown"],
    });

    expect(scraped.markdown).toBe("# Keyless");
    expect(upstream.requests).toHaveLength(1);
    expect(upstream.requests[0]?.authorization).toBeUndefined();
  });
```

Existing tests that use `env: {}` to verify intentional DeepSeek behavior must
set `providerMode: "deepseek-first"` unless they are testing Keyless. Audit them
with:

```bash
rg -n 'env: \\{\\}' test/integration/firecrawl-gateway.test.ts
```

Preserve each test's original intent rather than changing expectations to
Keyless accidentally.

- [ ] **Step 3: Run focused advanced tests**

```bash
npm test -- test/integration/firecrawl-gateway.test.ts \
  test/integration/firecrawl-sdk-gateway.test.ts
```

Expected: PASS.

- [ ] **Step 4: Update documentation**

README tables become:

```text
Firecrawl with credential
  -> Keyless Firecrawl (local only)
  -> DeepSeek fallback
```

Document:

- Supported Keyless routes.
- Keyless is free but IP/day rate-limited.
- No Authorization is sent.
- 429 defaults to a 15-minute cooldown.
- Remote gateways and `deepseek-first`/`no-fallback` do not use Keyless.
- Crawl, Map, Extract, Batch, Agent, and status are not keyless.

Update both operations guides and the CLI reference with the same contract.

- [ ] **Step 5: Add changelog**

At the top of `CHANGELOG.md`:

```markdown
## Unreleased

### Added

- Use Firecrawl's free Keyless tier as an automatic intermediate provider for
  supported local routes before DeepSeek fallback.
```

- [ ] **Step 6: Run full verification**

```bash
npm run verify
```

- [ ] **Step 7: Review diff and commit**

```bash
git diff --check
git status --short --branch
git diff --stat
git add README.md README.en.md CHANGELOG.md docs/operations.md \
  docs/operations.zh-CN.md \
  skills/deepseek-crawl/references/cli-reference.md \
  test/integration/firecrawl-gateway.test.ts \
  test/integration/firecrawl-sdk-gateway.test.ts
git commit -m "test: cover Firecrawl keyless fallback"
```

---

## Final Acceptance Checklist

- [ ] Local `firecrawl-first` uses Keyless before DeepSeek for supported routes.
- [ ] Keyed `402` tries Keyless next.
- [ ] Keyless requests never contain Authorization.
- [ ] Keyless `429` uses Retry-After or a 15-minute default cooldown.
- [ ] Keyless-only cooldown returns `429 keyless_rate_limited`.
- [ ] Remote gateways never use Keyless.
- [ ] Existing provider modes remain unchanged.
- [ ] Advanced Parse and Post-Scrape Interact pass through.
- [ ] No IP rotation or bypass behavior exists.
- [ ] README, operations, CLI reference, and changelog are aligned.
- [ ] `npm run verify` passes.
