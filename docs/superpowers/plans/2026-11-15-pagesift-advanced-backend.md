# Optional PageSift Advanced Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in PageSift backend for browser-dependent Firecrawl Scrape and Post-Scrape Interact while preserving the existing default provider chain.

**Architecture:** Keep PageSift external and disabled by default. Route only advanced Scrape requests to PageSift after DeepSeek capability validation fails, rewrite PageSift scrape IDs into bounded `ps_` Gateway sessions, and route those sessions exclusively back to PageSift. Add no new runtime dependencies.

**Tech Stack:** TypeScript ESM, Node.js 22.12+, Zod, Vitest, Node HTTP/fetch, existing Firecrawl-compatible Gateway modules.

**Spec:** `docs/superpowers/specs/2026-11-15-pagesift-advanced-backend-design.md`

## Global Constraints

- Default `gateway install` must remain PageSift-free and perform no PageSift probe.
- PageSift is externally installed and managed; never auto-download, install, start, stop, or update it.
- Advanced backend provider is exactly `pagesift`.
- PageSift is enabled only for `firecrawl-first` and `deepseek-first`; `no-fallback` never uses it.
- Never send incoming Gateway authorization, Firecrawl, DeepSeek, or imported credentials to PageSift.
- Only `PAGESIFT_API_KEY` or the `pagesift` credential store may authenticate PageSift.
- Supported first-release features are advanced v2 Scrape and Scrape-bound POST/DELETE Interact only.
- Do not implement standalone `/v2/interact`, Playwright code, CDP, live view, Parse, Extract, Agent, Monitor, Batch Scrape, Map, Crawl, JSON extraction, profiles, proxies, or JavaScript execution.
- Advanced Scrape uses a closed allowlist and injects `keepSession: true`.
- Public advanced session IDs match `^ps_[0-9a-f]{32}$`, expire after 10 minutes, and never refresh their TTL.
- Session capacity is fixed at 1,000 active reservations; `Retry-After` for capacity exhaustion is exactly 1 second.
- Advanced Scrape JSON buffering is capped at 16 MiB per response, four concurrent buffers, and 64 MiB aggregate.
- PageSift health probes use a 2-second timeout, do not follow redirects, and use `/healthz` plus `GET /v2/crawl/active`.
- Existing output, security, SSRF, crawl, and release gates remain unchanged.
- Do not tag, publish, create a release, or push a release tag without explicit current-task permission.
- Use TDD for every task and run `npm run verify` before final completion.

---

## File Structure

Create:

- `src/firecrawl/advanced-capabilities.ts`: closed PageSift Scrape and Interact request validation.
- `src/gateway/advanced-sessions.ts`: `ps_` session IDs, reservation capacity, TTL, ID rewrite.
- `src/gateway/advanced-backend.ts`: PageSift URL/probe/request adapter and bounded JSON reader.
- `test/unit/firecrawl-advanced-capabilities.test.ts`: pure advanced request tests.
- `test/unit/gateway-advanced-sessions.test.ts`: session ID, TTL, capacity, and rewrite tests.
- `test/unit/gateway-advanced-backend.test.ts`: probe, auth, transport, and response buffer tests.

Modify:

- `src/credentials/store.ts`: add `pagesift`.
- `src/gateway/config.ts`: PageSift URL, credential, and provider config.
- `src/gateway/errors.ts`: advanced backend HTTP error.
- `src/gateway/telemetry.ts`: `pagesift` provider and Interact route normalization.
- `src/gateway/handler.ts`: advanced Scrape and Interact routing.
- `src/gateway/server.ts`: advanced backend injection, runtime state, and health metadata.
- `src/gateway/runtime.ts`: advanced configuration in runtime discovery.
- `src/gateway/service.ts`: managed advanced configuration and preflight.
- `src/cli/parse.ts`: advanced CLI flags and `pagesift` credential.
- `src/cli/run.ts`: foreground configuration, managed install, and status output.
- `test/unit/credentials.test.ts`
- `test/unit/auth-cli.test.ts`
- `test/unit/gateway-config.test.ts`
- `test/unit/cli-parse.test.ts`
- `test/unit/gateway-cli.test.ts`
- `test/unit/gateway-runtime.test.ts`
- `test/unit/gateway-service.test.ts`
- `test/integration/firecrawl-gateway.test.ts`
- `test/integration/firecrawl-sdk-gateway.test.ts`
- `README.md`, `README.en.md`, `docs/operations.md`,
  `docs/operations.zh-CN.md`, `skills/deepseek-crawl/SKILL.md`,
  `skills/deepseek-crawl/references/cli-reference.md`, `llms.txt`,
  `CHANGELOG.md`

---

### Task 1: PageSift Credential And Gateway Configuration

**Files:**
- Modify: `src/credentials/store.ts`
- Modify: `src/gateway/config.ts`
- Modify: `src/cli/parse.ts`
- Modify: `src/cli/run.ts`
- Test: `test/unit/credentials.test.ts`
- Test: `test/unit/auth-cli.test.ts`
- Test: `test/unit/gateway-config.test.ts`
- Test: `test/unit/cli-parse.test.ts`

**Interfaces:**

- Produces:
  - `CredentialName = "deepseek" | "firecrawl" | "gateway" | "pagesift"`
  - `AdvancedBackendConfig`
  - `GatewayConfig.advancedBackend?: AdvancedBackendConfig`
  - `GatewayConfigInput.advancedEnabled?: boolean`
  - `GatewayConfigInput.advancedUrl?: string`
  - `DEFAULT_ADVANCED_BACKEND_URL = "http://127.0.0.1:3002/"`

- [ ] **Step 1: Add failing credential, config, auth, and parse tests**

Append to `test/unit/credentials.test.ts` inside the file-store suite:

```ts
it("stores a PageSift credential separately", async () => {
  const home = await mkdtemp(join(tmpdir(), "deepseek-crawl-auth-"));
  const env = { XDG_CONFIG_HOME: join(home, "config") };
  const options = { platform: "linux" as const, home, env };
  const firecrawl = createCredentialStore({ ...options, credential: "firecrawl" });
  const pagesift = createCredentialStore({ ...options, credential: "pagesift" });
  const path = join(home, "config", "deepseek-crawl", "credentials.json");

  firecrawl.set("firecrawl-secret");
  pagesift.set("pagesift-secret");

  expect(pagesift.get()).toBe("pagesift-secret");
  expect(firecrawl.get()).toBe("firecrawl-secret");
  expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
    firecrawl_api_key: "firecrawl-secret",
    pagesift_api_key: "pagesift-secret",
  });
});
```

Append to `test/unit/gateway-config.test.ts`:

```ts
it("keeps the advanced backend disabled by default", () => {
  expect(loadGatewayConfig({ env: {}, credentialStores: {} }).advancedBackend).toBeUndefined();
});

it("enables a default local PageSift backend", () => {
  expect(
    loadGatewayConfig({
      advancedEnabled: true,
      env: {},
      credentialStores: {},
    }).advancedBackend,
  ).toEqual({
    provider: "pagesift",
    url: new URL("http://127.0.0.1:3002/"),
  });
});

it("uses an explicit or environment PageSift URL", () => {
  expect(
    loadGatewayConfig({
      advancedUrl: "https://explicit.example/pagesift",
      env: { DEEPSEEK_GATEWAY_ADVANCED_URL: "https://env.example" },
      credentialStores: { pagesift: store("pagesift-secret") },
    }),
  ).toThrow(/path|root/i);

  expect(
    loadGatewayConfig({
      advancedUrl: "https://explicit.example/",
      env: { DEEPSEEK_GATEWAY_ADVANCED_URL: "https://env.example/" },
      credentialStores: { pagesift: store("pagesift-secret") },
    }).advancedBackend,
  ).toMatchObject({
    provider: "pagesift",
    url: new URL("https://explicit.example/"),
    apiKey: "pagesift-secret",
  });

  expect(
    loadGatewayConfig({
      env: {
        DEEPSEEK_GATEWAY_ADVANCED_URL: "http://127.0.0.1:3002",
        PAGESIFT_API_KEY: "pagesift-secret",
      },
      credentialStores: {},
    }).advancedBackend,
  ).toEqual({
    provider: "pagesift",
    url: new URL("http://127.0.0.1:3002/"),
    apiKey: "pagesift-secret",
  });
});

it.each([
  ["http://pagesift.example/", /HTTPS/i],
  ["https://user:secret@pagesift.example/", /credentials/i],
  ["https://pagesift.example/?mode=test", /query/i],
  ["https://pagesift.example/#fragment", /fragment/i],
  ["https://pagesift.example/api", /path|root/i],
])("rejects invalid advanced URL %s", (advancedUrl, expected) => {
  expect(() =>
    loadGatewayConfig({
      advancedUrl,
      env: {},
      credentialStores: { pagesift: store("pagesift-secret") },
    }),
  ).toThrow(expected);
});

it("requires a PageSift credential for a non-loopback backend", () => {
  expect(() =>
    loadGatewayConfig({
      advancedUrl: "https://pagesift.example/",
      env: {},
      credentialStores: {},
    }),
  ).toThrow(/PageSift.*credential/i);
});
```

Append to `test/unit/auth-cli.test.ts`:

```ts
it("stores a PageSift credential in its provider store", async () => {
  const pagesift = memoryStore();
  const environment = providerDependencies({ pagesift });

  expect(
    await runCli(["auth", "set", "pagesift"], {
      ...environment.deps,
      secretReader: async () => "pagesift-secret",
    }),
  ).toBe(0);

  expect(pagesift.value()).toBe("pagesift-secret");
  expect(environment.stdout.value()).toContain("PageSift API key saved");
  expect(environment.stdout.value()).not.toContain("pagesift-secret");
});
```

Append to `test/unit/cli-parse.test.ts`:

```ts
it("parses PageSift credential and foreground advanced flags", () => {
  expect(parseCli(["auth", "set", "pagesift"])).toEqual({
    kind: "auth-set",
    credential: "pagesift",
  });
  expect(parseCli(["gateway", "--advanced"])).toEqual({
    kind: "gateway",
    remote: false,
    advanced: true,
  });
  expect(parseCli(["gateway", "--advanced-url", "http://127.0.0.1:3002"])).toEqual({
    kind: "gateway",
    remote: false,
    advanced: true,
    advancedUrl: "http://127.0.0.1:3002",
  });
});
```

- [ ] **Step 2: Run focused tests and confirm they fail**

Run:

```bash
npm test -- test/unit/credentials.test.ts test/unit/auth-cli.test.ts test/unit/gateway-config.test.ts test/unit/cli-parse.test.ts
```

Expected: FAIL because `pagesift` is not a credential and advanced config/flags do not exist.

- [ ] **Step 3: Implement the credential and configuration surface**

In `src/credentials/store.ts`:

```ts
export type CredentialName = "deepseek" | "firecrawl" | "gateway" | "pagesift";

const FILE_FIELDS: Record<CredentialName, string> = {
  deepseek: "api_key",
  firecrawl: "firecrawl_api_key",
  gateway: "gateway_api_key",
  pagesift: "pagesift_api_key",
};

function credentialLabel(credential: CredentialName): string {
  switch (credential) {
    case "deepseek":
      return "DeepSeek API key";
    case "firecrawl":
      return "Firecrawl API key";
    case "gateway":
      return "gateway API key";
    case "pagesift":
      return "PageSift API key";
  }
}
```

In `src/cli/parse.ts`, include `pagesift` in `parseCredential` and add gateway
flags:

```ts
if (!["deepseek", "firecrawl", "gateway", "pagesift"].includes(credential)) {
  throw new CliUsageError("Credential must be deepseek, firecrawl, gateway, or pagesift.");
}
```

```ts
advanced: { type: "boolean" },
"advanced-url": { type: "string" },
```

```ts
const advancedUrl = parsed.values["advanced-url"]?.trim();
if (parsed.values["advanced-url"] !== undefined && !advancedUrl) {
  throw new CliUsageError("Advanced URL is required.");
}
const advanced = parsed.values.advanced ?? advancedUrl !== undefined;
return {
  kind: "gateway",
  remote: parsed.values.remote ?? parsed.values["allow-remote"] ?? false,
  advanced,
  ...(advancedUrl === undefined ? {} : { advancedUrl }),
  // Keep all existing Gateway fields unchanged.
};
```

Add the corresponding fields to the `gateway` `ParsedCommand` union:

```ts
advanced: boolean;
advancedUrl?: string;
```

Update every existing foreground Gateway parse expectation in
`test/unit/cli-parse.test.ts` to include `advanced: false`, because the field is
required on the foreground command and defaults to false.

In `src/gateway/config.ts`, add:

```ts
export const DEFAULT_ADVANCED_BACKEND_URL = "http://127.0.0.1:3002/";

export interface AdvancedBackendConfig {
  provider: "pagesift";
  url: URL;
  apiKey?: string;
}
```

Add `advancedBackend?: AdvancedBackendConfig` to `GatewayConfig`, and:

```ts
advancedEnabled?: boolean;
advancedUrl?: string;
```

to `GatewayConfigInput`.

Extend `CREDENTIAL_ENV`:

```ts
pagesift: "PAGESIFT_API_KEY",
```

Add this resolver:

```ts
function parseAdvancedBackendUrl(value: string, hasCredential: boolean): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("DEEPSEEK_GATEWAY_ADVANCED_URL must be a valid HTTP(S) URL.");
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("DEEPSEEK_GATEWAY_ADVANCED_URL must use HTTP or HTTPS.");
  }
  if (url.username || url.password) {
    throw new Error("DEEPSEEK_GATEWAY_ADVANCED_URL must not contain credentials.");
  }
  if (url.search) {
    throw new Error("DEEPSEEK_GATEWAY_ADVANCED_URL must not contain a query string.");
  }
  if (url.hash) {
    throw new Error("DEEPSEEK_GATEWAY_ADVANCED_URL must not contain a fragment.");
  }
  if (url.pathname !== "/" && url.pathname !== "") {
    throw new Error("DEEPSEEK_GATEWAY_ADVANCED_URL path must be the service root.");
  }
  if (url.protocol === "http:" && !isLoopbackHostname(url.hostname)) {
    throw new Error("DEEPSEEK_GATEWAY_ADVANCED_URL must use HTTPS unless loopback.");
  }
  if (!isLoopbackHostname(url.hostname) && !hasCredential) {
    throw new Error("A non-loopback PageSift backend requires a PageSift credential.");
  }
  url.pathname = "/";
  return url;
}

function resolveAdvancedBackend(
  options: GatewayConfigInput,
  env: NodeJS.ProcessEnv,
  stores: GatewayConfigInput["credentialStores"],
): AdvancedBackendConfig | undefined {
  const environmentUrl = env.DEEPSEEK_GATEWAY_ADVANCED_URL?.trim();
  const requestedUrl = options.advancedUrl ?? environmentUrl;
  const enabled = options.advancedEnabled ?? requestedUrl !== undefined;
  if (!enabled) {
    return undefined;
  }
  const apiKey = resolveCredential(env, "pagesift", stores);
  const url = parseAdvancedBackendUrl(
    requestedUrl || DEFAULT_ADVANCED_BACKEND_URL,
    apiKey !== undefined,
  );
  return {
    provider: "pagesift",
    url,
    ...(apiKey === undefined ? {} : { apiKey }),
  };
}
```

In `loadGatewayConfig`, compute before the return:

```ts
const advancedBackend = resolveAdvancedBackend(options, env, options.credentialStores);
```

Then return it additively:

```ts
...(advancedBackend === undefined ? {} : { advancedBackend }),
```

In `src/cli/run.ts`, extend both credential maps:

```ts
const CREDENTIAL_ENV: Record<CredentialName, string> = {
  deepseek: "DEEPSEEK_API_KEY",
  firecrawl: "FIRECRAWL_API_KEY",
  gateway: "GATEWAY_API_KEY",
  pagesift: "PAGESIFT_API_KEY",
};

const CREDENTIAL_LABEL: Record<CredentialName, string> = {
  deepseek: "DeepSeek API key",
  firecrawl: "Firecrawl API key",
  gateway: "gateway API key",
  pagesift: "PageSift API key",
};
```

- [ ] **Step 4: Run focused tests**

Run:

```bash
npm test -- test/unit/credentials.test.ts test/unit/auth-cli.test.ts test/unit/gateway-config.test.ts test/unit/cli-parse.test.ts
npm run typecheck
npm run typecheck:test
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/credentials/store.ts src/gateway/config.ts src/cli/parse.ts src/cli/run.ts \
  test/unit/credentials.test.ts test/unit/auth-cli.test.ts \
  test/unit/gateway-config.test.ts test/unit/cli-parse.test.ts
git commit -m "feat: configure optional PageSift backend"
```

---

### Task 2: Closed PageSift Capability Validation

**Files:**
- Create: `src/firecrawl/advanced-capabilities.ts`
- Create: `test/unit/firecrawl-advanced-capabilities.test.ts`

**Interfaces:**

- Consumes: `UnsupportedFallbackFeatureError`
- Produces:
  - `preparePageSiftScrape(input: unknown): { body: Record<string, unknown>; serialized: Uint8Array }`
  - `preparePageSiftInteract(input: unknown): Uint8Array`

- [ ] **Step 1: Write the failing capability tests**

Create `test/unit/firecrawl-advanced-capabilities.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  preparePageSiftInteract,
  preparePageSiftScrape,
} from "../../src/firecrawl/advanced-capabilities.js";

describe("PageSift advanced capabilities", () => {
  it("accepts browser Scrape fields and injects keepSession", () => {
    const prepared = preparePageSiftScrape({
      url: "https://example.com/",
      formats: ["markdown", "screenshot"],
      actions: [{ type: "click", selector: "#more" }, { type: "wait", milliseconds: 100 }],
      waitFor: 500,
      onlyMainContent: true,
      headers: { "Accept-Language": "en" },
      timeout: 30_000,
      mobile: true,
      blockAds: true,
      origin: "firecrawl-sdk",
    });

    expect(prepared.body).toMatchObject({
      keepSession: true,
      formats: ["markdown", "screenshot"],
      actions: [{ type: "click", selector: "#more" }, { type: "wait", milliseconds: 100 }],
    });
    expect(JSON.parse(Buffer.from(prepared.serialized).toString("utf8"))).toEqual(prepared.body);
  });

  it.each([
    [{ url: "https://example.com/", formats: [{ type: "screenshot" }] }, /formats\[0\]/],
    [{ url: "https://example.com/", keepSession: false }, /keepSession/],
    [{ url: "https://example.com/", actions: [{ type: "executeJavascript" }] }, /executeJavascript/],
    [{ url: "https://example.com/", json: {} }, /json/],
    [{ url: "https://example.com/", profile: "user" }, /profile/],
    [{ url: "https://example.com/", proxy: "auto" }, /proxy/],
  ])("rejects unsupported Scrape input %#", (input, expected) => {
    expect(() => preparePageSiftScrape(input)).toThrow(expected);
  });

  it("accepts prompt and action Interact bodies", () => {
    expect(
      JSON.parse(
        Buffer.from(
          preparePageSiftInteract({
            prompt: "Click More and summarize the page",
            timeout: 10,
            origin: "firecrawl-sdk",
          }),
        ).toString("utf8"),
      ),
    ).toEqual({
      prompt: "Click More and summarize the page",
      timeout: 10,
      origin: "firecrawl-sdk",
    });
    expect(() =>
      preparePageSiftInteract({ actions: [{ type: "scroll", direction: "down" }] }),
    ).not.toThrow();
  });

  it.each([
    [{ code: "await page.title()" }, /code/],
    [{ language: "node" }, /language/],
    [{ url: "https://example.com/" }, /url/],
    [{ actions: [{ type: "executeJavascript" }] }, /executeJavascript/],
  ])("rejects unsupported Interact input %#", (input, expected) => {
    expect(() => preparePageSiftInteract(input)).toThrow(expected);
  });
});
```

- [ ] **Step 2: Run the test and confirm failure**

Run:

```bash
npm test -- test/unit/firecrawl-advanced-capabilities.test.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement closed validation**

Create `src/firecrawl/advanced-capabilities.ts` with these constants and helpers:

```ts
import { z } from "zod";
import { UnsupportedFallbackFeatureError } from "../gateway/errors.js";

const SCRAPE_KEYS = [
  "url",
  "formats",
  "actions",
  "waitFor",
  "onlyMainContent",
  "includeTags",
  "excludeTags",
  "headers",
  "timeout",
  "mobile",
  "blockAds",
  "origin",
] as const;

const INTERACT_KEYS = ["prompt", "actions", "timeout", "origin"] as const;
const FORMATS = new Set(["markdown", "html", "rawHtml", "links", "images", "screenshot"]);
const ACTIONS = new Set(["wait", "click", "write", "press", "scroll", "screenshot", "scrape", "pdf"]);

const actionSchema = z.object({ type: z.string() }).passthrough();
const formatSchema = z.union([z.string(), z.object({ type: z.string() }).passthrough()]);
const scrapeSchema = z
  .object({
    url: z.string().trim().min(1),
    formats: z.array(formatSchema).optional(),
    actions: z.array(actionSchema).optional(),
    waitFor: z.number().int().nonnegative().optional(),
    onlyMainContent: z.boolean().optional(),
    includeTags: z.array(z.string()).optional(),
    excludeTags: z.array(z.string()).optional(),
    headers: z.record(z.string(), z.string()).optional(),
    timeout: z.number().int().positive().optional(),
    mobile: z.boolean().optional(),
    blockAds: z.boolean().optional(),
    origin: z.string().optional(),
  })
  .passthrough();

function unsupported(path: string): never {
  throw new UnsupportedFallbackFeatureError(
    `PageSift fallback does not support Firecrawl option \`${path}\`.`,
  );
}

function validateActions(actions: z.infer<typeof actionSchema>[] | undefined): void {
  actions?.forEach((action, index) => {
    if (!ACTIONS.has(action.type)) {
      unsupported(`actions[${index}].type`);
    }
  });
}

export function preparePageSiftScrape(input: unknown): {
  body: Record<string, unknown>;
  serialized: Uint8Array;
} {
  const parsed = scrapeSchema.parse(input);
  for (const key of Object.keys(parsed).sort()) {
    if (!SCRAPE_KEYS.includes(key as (typeof SCRAPE_KEYS)[number])) {
      unsupported(key);
    }
  }
  parsed.formats?.forEach((format, index) => {
    if (typeof format !== "string" || !FORMATS.has(format)) {
      unsupported(`formats[${index}]`);
    }
  });
  validateActions(parsed.actions);
  const body = { ...parsed, keepSession: true };
  return {
    body,
    serialized: Buffer.from(JSON.stringify(body)),
  };
}

const interactSchema = z
  .object({
    prompt: z.string().min(1).max(10_000).optional(),
    actions: z.array(actionSchema).optional(),
    timeout: z.number().int().positive().max(300).optional(),
    origin: z.string().optional(),
  })
  .passthrough();

export function preparePageSiftInteract(input: unknown): Uint8Array {
  const parsed = interactSchema.parse(input);
  for (const key of Object.keys(parsed).sort()) {
    if (!INTERACT_KEYS.includes(key as (typeof INTERACT_KEYS)[number])) {
      unsupported(key);
    }
  }
  validateActions(parsed.actions);
  if (parsed.prompt === undefined && parsed.actions === undefined) {
    throw new UnsupportedFallbackFeatureError(
      "PageSift Interact requires a prompt or actions.",
    );
  }
  return Buffer.from(JSON.stringify(parsed));
}
```

- [ ] **Step 4: Run the focused tests**

Run:

```bash
npm test -- test/unit/firecrawl-advanced-capabilities.test.ts
npm run typecheck
npm run typecheck:test
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/firecrawl/advanced-capabilities.ts \
  test/unit/firecrawl-advanced-capabilities.test.ts
git commit -m "feat: validate PageSift advanced capabilities"
```

---

### Task 3: Bounded PageSift Session Mapping

**Files:**
- Create: `src/gateway/advanced-sessions.ts`
- Create: `test/unit/gateway-advanced-sessions.test.ts`

**Interfaces:**

- Consumes: `GatewayCapacityError`
- Produces:
  - `AdvancedSessionLease`
  - `AdvancedSessionStore`
  - `isPageSiftSessionId(value: string): boolean`
  - `readPageSiftScrapeId(value: unknown): string | undefined`
  - `rewritePageSiftScrapeId(value: Record<string, unknown>, publicId: string): Record<string, unknown>`

- [ ] **Step 1: Write failing session tests**

Create `test/unit/gateway-advanced-sessions.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  AdvancedSessionStore,
  isPageSiftSessionId,
  readPageSiftScrapeId,
  rewritePageSiftScrapeId,
} from "../../src/gateway/advanced-sessions.js";

describe("advanced sessions", () => {
  it("reserves, commits, resolves, and removes a ps_ session", () => {
    let now = 1_000;
    const sessions = new AdvancedSessionStore({
      now: () => now,
      randomHex: () => "a".repeat(32),
    });
    const lease = sessions.reserve();
    const publicId = lease.commit("pagesift-upstream-id");

    expect(publicId).toBe("ps_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(isPageSiftSessionId(publicId)).toBe(true);
    expect(sessions.resolve(publicId)).toBe("pagesift-upstream-id");
    now += 600_000;
    expect(sessions.resolve(publicId)).toBeUndefined();
    expect(sessions.size()).toBe(0);
  });

  it("does not refresh TTL on resolve", () => {
    let now = 1_000;
    const sessions = new AdvancedSessionStore({ now: () => now });
    const publicId = sessions.reserve().commit("upstream");
    now += 599_999;
    expect(sessions.resolve(publicId)).toBe("upstream");
    now += 1;
    expect(sessions.resolve(publicId)).toBeUndefined();
  });

  it("rejects new reservations at capacity and releases failed reservations", () => {
    const sessions = new AdvancedSessionStore({ maxSessions: 1 });
    const first = sessions.reserve();
    expect(() => sessions.reserve()).toThrow(
      expect.objectContaining({
        code: "advanced_session_capacity",
        statusCode: 503,
        retryAfterSeconds: 1,
      }),
    );
    first.release();
    expect(sessions.reserve().commit("upstream")).toMatch(/^ps_[0-9a-f]{32}$/);
  });

  it("reads and rewrites the PageSift scrape ID", () => {
    const value = {
      success: true,
      data: { markdown: "# Example", metadata: { scrapeId: "upstream-id" } },
    };
    expect(readPageSiftScrapeId(value)).toBe("upstream-id");
    expect(rewritePageSiftScrapeId(value, "ps_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).toMatchObject({
      data: { metadata: { scrapeId: "ps_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" } },
    });
  });
});
```

- [ ] **Step 2: Run the test and confirm failure**

Run:

```bash
npm test -- test/unit/gateway-advanced-sessions.test.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the bounded session store**

Create `src/gateway/advanced-sessions.ts`:

```ts
import { randomBytes } from "node:crypto";
import { GatewayCapacityError } from "./errors.js";

const DEFAULT_MAX_SESSIONS = 1_000;
const DEFAULT_TTL_MS = 10 * 60_000;
const PUBLIC_ID = /^ps_[0-9a-f]{32}$/;

interface SessionEntry {
  upstreamId: string;
  expiresAt: number;
}

export interface AdvancedSessionLease {
  commit(upstreamId: string): string;
  release(): void;
}

export class AdvancedSessionStore {
  readonly #now: () => number;
  readonly #randomHex: () => string;
  readonly #maxSessions: number;
  readonly #ttlMs: number;
  readonly #entries = new Map<string, SessionEntry>();
  #reservations = 0;

  constructor(
    options: {
      now?: () => number;
      randomHex?: () => string;
      maxSessions?: number;
      ttlMs?: number;
    } = {},
  ) {
    this.#now = options.now ?? Date.now;
    this.#randomHex = options.randomHex ?? (() => randomBytes(16).toString("hex"));
    this.#maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
    this.#ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  }

  reserve(): AdvancedSessionLease {
    this.expire();
    if (this.#entries.size + this.#reservations >= this.#maxSessions) {
      throw new GatewayCapacityError(
        "The advanced session capacity is exhausted.",
        {
          code: "advanced_session_capacity",
          statusCode: 503,
          retryAfterSeconds: 1,
        },
      );
    }
    const createdAt = this.#now();
    this.#reservations += 1;
    let settled = false;
    return {
      commit: (upstreamId: string) => {
        if (settled) {
          throw new Error("Advanced session lease is already settled.");
        }
        settled = true;
        this.#reservations -= 1;
        let publicId = `ps_${this.#randomHex()}`;
        while (!PUBLIC_ID.test(publicId) || this.#entries.has(publicId)) {
          publicId = `ps_${this.#randomHex()}`;
        }
        this.#entries.set(publicId, {
          upstreamId,
          expiresAt: createdAt + this.#ttlMs,
        });
        return publicId;
      },
      release: () => {
        if (!settled) {
          settled = true;
          this.#reservations -= 1;
        }
      },
    };
  }

  resolve(publicId: string): string | undefined {
    this.expire();
    return this.#entries.get(publicId)?.upstreamId;
  }

  remove(publicId: string): boolean {
    return this.#entries.delete(publicId);
  }

  size(): number {
    this.expire();
    return this.#entries.size;
  }

  private expire(): void {
    const now = this.#now();
    for (const [id, entry] of this.#entries) {
      if (entry.expiresAt <= now) {
        this.#entries.delete(id);
      }
    }
  }
}

export function isPageSiftSessionId(value: string): boolean {
  return PUBLIC_ID.test(value);
}

export function readPageSiftScrapeId(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const data = (value as Record<string, unknown>).data;
  if (!data || typeof data !== "object") return undefined;
  const metadata = (data as Record<string, unknown>).metadata;
  if (!metadata || typeof metadata !== "object") return undefined;
  const scrapeId = (metadata as Record<string, unknown>).scrapeId;
  return typeof scrapeId === "string" && scrapeId ? scrapeId : undefined;
}

export function rewritePageSiftScrapeId(
  value: Record<string, unknown>,
  publicId: string,
): Record<string, unknown> {
  const data = value.data;
  const metadata = data && typeof data === "object"
    ? (data as Record<string, unknown>).metadata
    : undefined;
  if (!metadata || typeof metadata !== "object") {
    return value;
  }
  (metadata as Record<string, unknown>).scrapeId = publicId;
  return value;
}
```

- [ ] **Step 4: Run focused tests and type checks**

Run:

```bash
npm test -- test/unit/gateway-advanced-sessions.test.ts
npm run typecheck
npm run typecheck:test
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/gateway/advanced-sessions.ts test/unit/gateway-advanced-sessions.test.ts
git commit -m "feat: add bounded PageSift session mapping"
```

---

### Task 4: PageSift Probe, Transport, And Bounded JSON Reader

**Files:**
- Create: `src/gateway/advanced-backend.ts`
- Create: `test/unit/gateway-advanced-backend.test.ts`

**Interfaces:**

- Consumes: `AdvancedBackendConfig`, native `fetch`
- Produces:
  - `AdvancedBackendStatus`
  - `AdvancedRequest`
  - `AdvancedBackend`
  - `AdvancedBackendError`
  - `disabledAdvancedBackendStatus(): AdvancedBackendStatus`
  - `createPageSiftBackend(config, fetchImpl, timeoutMs?): AdvancedBackend`
  - `probePageSift(config, fetchImpl, signal?): Promise<AdvancedBackendStatus>`

- [ ] **Step 1: Write failing backend tests**

Create `test/unit/gateway-advanced-backend.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  AdvancedBackendError,
  createPageSiftBackend,
  probePageSift,
} from "../../src/gateway/advanced-backend.js";

const config = {
  provider: "pagesift" as const,
  url: new URL("http://127.0.0.1:3002/"),
  apiKey: "pagesift-secret",
};

describe("PageSift backend", () => {
  it("probes health and authenticated active jobs without redirects", async () => {
    const calls: Array<{ url: string; authorization: string | null; redirect: RequestRedirect | undefined }> = [];
    const status = await probePageSift(config, async (input, init) => {
      calls.push({
        url: String(input),
        authorization: new Headers(init?.headers).get("authorization"),
        redirect: init?.redirect,
      });
      return String(input).endsWith("/healthz")
        ? new Response("ok", { status: 200 })
        : Response.json([]);
    });

    expect(status).toEqual({
      enabled: true,
      provider: "pagesift",
      url: "http://127.0.0.1:3002/",
      reachable: true,
      api_ready: true,
      credential_configured: true,
    });
    expect(calls).toEqual([
      {
        url: "http://127.0.0.1:3002/healthz",
        authorization: "Bearer pagesift-secret",
        redirect: "manual",
      },
      {
        url: "http://127.0.0.1:3002/v2/crawl/active",
        authorization: "Bearer pagesift-secret",
        redirect: "manual",
      },
    ]);
  });

  it("reports reachable but not API-ready on active-jobs 401", async () => {
    const status = await probePageSift(config, async (input) =>
      String(input).endsWith("/healthz")
        ? new Response("ok")
        : Response.json({ success: false }, { status: 401 }),
    );
    expect(status).toMatchObject({ reachable: true, api_ready: false });
  });

  it("strips inbound authorization and injects only the PageSift key", async () => {
    let authorization: string | null = null;
    const backend = createPageSiftBackend(config, async (_input, init) => {
      authorization = new Headers(init?.headers).get("authorization");
      return Response.json({ ok: true });
    });
    await backend.request({
      method: "POST",
      path: "/v2/scrape",
      headers: new Headers({ Authorization: "Bearer firecrawl-secret" }),
      body: Buffer.from("{}"),
    });
    expect(authorization).toBe("Bearer pagesift-secret");
  });

  it("reads a bounded scrape JSON response", async () => {
    const backend = createPageSiftBackend(config, async () =>
      Response.json({ success: true, data: { metadata: { scrapeId: "upstream" } } }),
    );
    const response = await backend.request({
      method: "POST",
      path: "/v2/scrape",
      headers: new Headers(),
    });
    await expect(backend.readJsonResponse(response)).resolves.toMatchObject({
      data: { metadata: { scrapeId: "upstream" } },
    });
  });

  it("rejects oversized advanced scrape bodies", async () => {
    const backend = createPageSiftBackend(config, async () =>
      new Response("x".repeat(16 * 1024 * 1024 + 1)),
    );
    const response = await backend.request({
      method: "POST",
      path: "/v2/scrape",
      headers: new Headers(),
    });
    await expect(backend.readJsonResponse(response)).rejects.toMatchObject({
      code: "advanced_backend_response_too_large",
      statusCode: 502,
    } satisfies Partial<AdvancedBackendError>);
  });

  it("allows four JSON buffers and waits for the fifth", async () => {
    const backend = createPageSiftBackend(config, async () => Response.json({}));
    let started = 0;
    const releases: Array<() => void> = [];
    const blocked = () => {
      return new Response(
        new ReadableStream({
          pull(controller) {
            started += 1;
            return new Promise<void>((resolve) => {
              releases.push(() => {
                controller.enqueue(new TextEncoder().encode("{}"));
                controller.close();
                resolve();
              });
            });
          },
        }),
      );
    };

    const reads = Array.from({ length: 5 }, () => backend.readJsonResponse(blocked()));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(started).toBe(4);
    releases.shift()?.();
    while (started < 5) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    for (const release of releases.splice(0)) {
      release();
    }
    await Promise.all(reads);
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run:

```bash
npm test -- test/unit/gateway-advanced-backend.test.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the backend abstraction**

Create `src/gateway/advanced-backend.ts` with these public types:

```ts
import type { AdvancedBackendConfig } from "./config.js";

const PROBE_TIMEOUT_MS = 2_000;
const MAX_JSON_BYTES = 16 * 1024 * 1024;
const MAX_CONCURRENT_JSON = 4;

export interface AdvancedBackendStatus {
  enabled: boolean;
  provider: "pagesift" | null;
  url: string | null;
  reachable: boolean;
  api_ready: boolean;
  credential_configured: boolean;
}

export function disabledAdvancedBackendStatus(): AdvancedBackendStatus {
  return {
    enabled: false,
    provider: null,
    url: null,
    reachable: false,
    api_ready: false,
    credential_configured: false,
  };
}

export interface AdvancedRequest {
  method: string;
  path: string;
  headers: Headers;
  body?: Uint8Array;
  signal?: AbortSignal;
}

export interface AdvancedBackend {
  readonly config: AdvancedBackendConfig;
  request(input: AdvancedRequest): Promise<Response>;
  readJsonResponse(
    response: Response,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>>;
}

export class AdvancedBackendError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly statusCode: number,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "AdvancedBackendError";
  }
}
```

Implement request headers exactly:

```ts
const BLOCKED_REQUEST_HEADERS = new Set([
  "authorization",
  "connection",
  "content-length",
  "expect",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function pageSiftHeaders(source: Headers, apiKey: string | undefined): Headers {
  const headers = new Headers();
  for (const [name, value] of source) {
    if (!BLOCKED_REQUEST_HEADERS.has(name.toLowerCase())) {
      headers.set(name, value);
    }
  }
  if (apiKey) {
    headers.set("authorization", `Bearer ${apiKey}`);
  }
  return headers;
}
```

Implement `probePageSift` with a bounded health reader:

```ts
async function readSmallText(response: Response, limit: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new AdvancedBackendError(
        "The advanced backend health response is too large.",
        "advanced_backend_invalid_response",
        502,
      );
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

export async function probePageSift(
  config: AdvancedBackendConfig,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<AdvancedBackendStatus> {
  const headers = pageSiftHeaders(new Headers(), config.apiKey);
  const probeSignal = () =>
    signal
      ? AbortSignal.any([signal, AbortSignal.timeout(PROBE_TIMEOUT_MS)])
      : AbortSignal.timeout(PROBE_TIMEOUT_MS);
  let health: Response;
  let healthBody: string;
  try {
    health = await fetchImpl(new URL("healthz", config.url), {
      headers,
      redirect: "manual",
      signal: probeSignal(),
    });
    healthBody = await readSmallText(health, 64);
  } catch {
    return {
      enabled: true,
      provider: "pagesift",
      url: config.url.href,
      reachable: false,
      api_ready: false,
      credential_configured: config.apiKey !== undefined,
    };
  }
  if (!health.ok || healthBody.trim() !== "ok") {
    return {
      enabled: true,
      provider: "pagesift",
      url: config.url.href,
      reachable: false,
      api_ready: false,
      credential_configured: config.apiKey !== undefined,
    };
  }
  try {
    const active = await fetchImpl(new URL("v2/crawl/active", config.url), {
      headers,
      redirect: "manual",
      signal: probeSignal(),
    });
    await active.body?.cancel().catch(() => undefined);
    return {
      enabled: true,
      provider: "pagesift",
      url: config.url.href,
      reachable: true,
      api_ready: active.ok,
      credential_configured: config.apiKey !== undefined,
    };
  } catch {
    return {
      enabled: true,
      provider: "pagesift",
      url: config.url.href,
      reachable: true,
      api_ready: false,
      credential_configured: config.apiKey !== undefined,
    };
  }
}
```

Implement a small semaphore and bounded reader:

```ts
class JsonBufferLimiter {
  #active = 0;
  readonly #waiters: Array<() => void> = [];

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (this.#active >= MAX_CONCURRENT_JSON) {
      await new Promise<void>((resolve, reject) => {
        const wake = () => {
          signal?.removeEventListener("abort", abort);
          resolve();
        };
        const abort = () => {
          const index = this.#waiters.indexOf(wake);
          if (index >= 0) this.#waiters.splice(index, 1);
          reject(signal?.reason ?? new Error("Aborted."));
        };
        this.#waiters.push(wake);
        signal?.addEventListener("abort", abort, { once: true });
      });
    }
    this.#active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#active -= 1;
      this.#waiters.shift()?.();
    };
  }
}

async function boundedBytes(
  response: Response,
  limit: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    if (signal?.aborted) {
      await reader.cancel();
      throw signal.reason;
    }
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new AdvancedBackendError(
        "The advanced scrape response is too large to establish session routing.",
        "advanced_backend_response_too_large",
        502,
      );
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
}
```

Implement the factory:

```ts
export function createPageSiftBackend(
  config: AdvancedBackendConfig,
  fetchImpl: typeof fetch,
  timeoutMs = 120_000,
): AdvancedBackend {
  const limiter = new JsonBufferLimiter();
  return {
    config,
    async request(input) {
      const signal = input.signal
        ? AbortSignal.any([input.signal, AbortSignal.timeout(timeoutMs)])
        : AbortSignal.timeout(timeoutMs);
      try {
        return await fetchImpl(new URL(input.path, config.url), {
          method: input.method,
          headers: pageSiftHeaders(input.headers, config.apiKey),
          redirect: "manual",
          signal,
          ...(input.body === undefined ? {} : { body: input.body }),
        });
      } catch (error) {
        if (input.signal?.aborted) {
          throw input.signal.reason;
        }
        throw new AdvancedBackendError(
          "The configured advanced backend is unavailable.",
          "advanced_backend_unavailable",
          503,
        );
      }
    },
    async readJsonResponse(response, signal) {
      const release = await limiter.acquire(signal);
      try {
        const bytes = await boundedBytes(response, MAX_JSON_BYTES, signal);
        let parsed: unknown;
        try {
          parsed = JSON.parse(Buffer.from(bytes).toString("utf8"));
        } catch {
          throw new AdvancedBackendError(
            "The advanced backend returned an invalid scrape response.",
            "advanced_backend_invalid_response",
            502,
          );
        }
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new AdvancedBackendError(
            "The advanced backend returned an invalid scrape response.",
            "advanced_backend_invalid_response",
            502,
          );
        }
        return parsed as Record<string, unknown>;
      } finally {
        release();
      }
    },
  };
}
```

- [ ] **Step 4: Run focused tests**

Run:

```bash
npm test -- test/unit/gateway-advanced-backend.test.ts
npm run typecheck
npm run typecheck:test
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/gateway/advanced-backend.ts test/unit/gateway-advanced-backend.test.ts
git commit -m "feat: add PageSift backend transport"
```

---

### Task 5: Route Advanced Scrape Through PageSift

**Files:**
- Modify: `src/gateway/handler.ts`
- Modify: `src/gateway/server.ts`
- Modify: `src/gateway/telemetry.ts`
- Test: `test/unit/gateway-telemetry.test.ts`
- Test: `test/integration/firecrawl-gateway.test.ts`

**Interfaces:**

- Consumes:
  - `preparePageSiftScrape`
  - `AdvancedSessionStore`
  - `AdvancedBackend`
  - `isPageSiftSessionId`
  - `readPageSiftScrapeId`
  - `rewritePageSiftScrapeId`
- Produces:
  - `GatewayHandlerDependencies.advancedBackend?: AdvancedBackend`
  - `GatewayServerOptions.advancedBackend?: AdvancedBackend`
  - `provider: "pagesift"` in request logs
  - Advancing Scrape routing that preserves existing DeepSeek behavior first.

- [ ] **Step 1: Write failing telemetry and Scrape integration tests**

In `test/unit/gateway-telemetry.test.ts`, add:

```ts
expect(normalizeGatewayRoute("/v2/scrape/ps_abc/interact")).toBe(
  "/v2/scrape/:id/interact",
);
```

In `test/integration/firecrawl-gateway.test.ts`, add a helper fake backend and
the routing test:

```ts
function pageSiftBackend(response: Record<string, unknown>) {
  const requests: Array<{
    method: string;
    path: string;
    authorization: string | null;
    body: Record<string, unknown>;
  }> = [];
  return {
    requests,
    backend: {
      config: {
        provider: "pagesift" as const,
        url: new URL("http://127.0.0.1:3002/"),
        apiKey: "pagesift-secret",
      },
      async request(input) {
        requests.push({
          method: input.method,
          path: input.path,
          authorization: input.headers.get("authorization"),
          body: JSON.parse(Buffer.from(input.body ?? []).toString("utf8")),
        });
        return Response.json(response);
      },
      async readJsonResponse() {
        return response;
      },
    },
  };
}

it("uses PageSift for advanced Scrape after keyed 402 and Keyless 429", async () => {
  const pagesift = pageSiftBackend({
    success: true,
    data: {
      markdown: "# Browser",
      metadata: { scrapeId: "pagesift-upstream" },
      actions: { screenshots: ["data:image/png;base64,..."] },
    },
  });
  let firecrawlCalls = 0;
  const server = await startGatewayServer({
    config: {
      ...testConfig(),
      advancedBackend: pagesift.backend.config,
    },
    env: { FIRECRAWL_API_KEY: "fc-test" },
    fetchImpl: async (_input, init) => {
      firecrawlCalls += 1;
      return new Headers(init?.headers).has("authorization")
        ? Response.json({ success: false }, { status: 402 })
        : Response.json({ success: false }, { status: 429 });
    },
    deepseekClient: {
      async search() {
        throw new Error("Unexpected Search call.");
      },
      async fetch() {
        throw new Error("DeepSeek must not handle an action-bearing Scrape.");
      },
    },
    advancedBackend: pagesift.backend,
  });
  servers.push(server);

  const response = await fetch(new URL("/v2/scrape", server.url), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url: "https://example.com/",
      formats: ["markdown", "screenshot"],
      actions: [{ type: "click", selector: "#more" }],
    }),
  });

  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    success: true,
    data: { metadata: { scrapeId: expect.stringMatching(/^ps_[0-9a-f]{32}$/) } },
  });
  expect(firecrawlCalls).toBe(2);
  expect(pagesift.requests).toEqual([
    {
      method: "POST",
      path: "/v2/scrape",
      authorization: null,
      body: {
        url: "https://example.com/",
        formats: ["markdown", "screenshot"],
        actions: [{ type: "click", selector: "#more" }],
        keepSession: true,
      },
    },
  ]);
});
```

Add mode-specific routing tests:

```ts
it("keeps a common Scrape on DeepSeek when PageSift is configured", async () => {
  let deepSeekCalls = 0;
  const server = await startGatewayServer({
    config: {
      ...testConfig(),
      providerMode: "deepseek-first",
      advancedBackend: {
        provider: "pagesift",
        url: new URL("http://127.0.0.1:3002/"),
      },
    },
    env: {},
    deepseekClient: {
      async search() {
        throw new Error("Unexpected Search call.");
      },
      async fetch() {
        deepSeekCalls += 1;
        return { title: "Common", content: "# Common" };
      },
    },
    advancedBackend: {
      config: {
        provider: "pagesift",
        url: new URL("http://127.0.0.1:3002/"),
      },
      async request() {
        throw new Error("PageSift must not handle common Scrape.");
      },
      async readJsonResponse() {
        throw new Error("PageSift must not handle common Scrape.");
      },
    },
  });
  servers.push(server);

  const response = await fetch(new URL("/v2/scrape", server.url), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url: "https://example.com/",
      formats: ["markdown"],
    }),
  });

  expect(response.status).toBe(200);
  expect(deepSeekCalls).toBe(1);
});

it("uses PageSift for advanced Scrape in deepseek-first mode", async () => {
  let pagesiftCalls = 0;
  const server = await startGatewayServer({
    config: {
      ...testConfig(),
      providerMode: "deepseek-first",
      advancedBackend: {
        provider: "pagesift",
        url: new URL("http://127.0.0.1:3002/"),
      },
    },
    env: {},
    fetchImpl: async () => {
      throw new Error("Firecrawl must not be called in deepseek-first mode.");
    },
    deepseekClient: {
      async search() {
        throw new Error("Unexpected Search call.");
      },
      async fetch() {
        throw new Error("DeepSeek must not handle browser Scrape.");
      },
    },
    advancedBackend: {
      config: {
        provider: "pagesift",
        url: new URL("http://127.0.0.1:3002/"),
      },
      async request() {
        pagesiftCalls += 1;
        return Response.json({
          success: true,
          data: { markdown: "# Browser", metadata: { scrapeId: "upstream" } },
        });
      },
      async readJsonResponse(response) {
        return response.json();
      },
    },
  });
  servers.push(server);

  const response = await fetch(new URL("/v2/scrape", server.url), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url: "https://example.com/",
      actions: [{ type: "click", selector: "#more" }],
    }),
  });

  expect(response.status).toBe(200);
  expect(pagesiftCalls).toBe(1);
});

it("never uses PageSift in no-fallback mode", async () => {
  let pagesiftCalls = 0;
  const server = await startGatewayServer({
    config: {
      ...testConfig(),
      providerMode: "no-fallback",
      advancedBackend: {
        provider: "pagesift",
        url: new URL("http://127.0.0.1:3002/"),
      },
    },
    env: { FIRECRAWL_API_KEY: "fc-test" },
    fetchImpl: async () =>
      Response.json({ success: false, error: "Payment required." }, { status: 402 }),
    advancedBackend: {
      config: {
        provider: "pagesift",
        url: new URL("http://127.0.0.1:3002/"),
      },
      async request() {
        pagesiftCalls += 1;
        return Response.json({ success: true, data: {} });
      },
      async readJsonResponse() {
        throw new Error("Not reached.");
      },
    },
  });
  servers.push(server);

  const response = await fetch(new URL("/v2/scrape", server.url), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url: "https://example.com/",
      actions: [{ type: "click", selector: "#more" }],
    }),
  });

  expect(response.status).toBe(402);
  expect(pagesiftCalls).toBe(0);
});
```

Add a PageSift error pass-through test:

```ts
it("passes PageSift 429 through without calling DeepSeek again", async () => {
  let deepSeekCalls = 0;
  const server = await startGatewayServer({
    config: {
      ...testConfig(),
      advancedBackend: {
        provider: "pagesift",
        url: new URL("http://127.0.0.1:3002/"),
      },
    },
    env: { FIRECRAWL_API_KEY: "fc-test" },
    fetchImpl: async (_input, init) =>
      new Headers(init?.headers).has("authorization")
        ? Response.json({ success: false }, { status: 402 })
        : Response.json({ success: false }, { status: 429 }),
    deepseekClient: {
      async search() {
        throw new Error("Unexpected Search call.");
      },
      async fetch() {
        deepSeekCalls += 1;
        return { title: "Wrong", content: "Wrong" };
      },
    },
    advancedBackend: {
      config: {
        provider: "pagesift",
        url: new URL("http://127.0.0.1:3002/"),
      },
      async request() {
        return Response.json(
          { success: false, code: "RATE_LIMITED", error: "Slow down" },
          { status: 429, headers: { "retry-after": "9" } },
        );
      },
      async readJsonResponse() {
        throw new Error("Error responses must stream through.");
      },
    },
  });
  servers.push(server);

  const response = await fetch(new URL("/v2/scrape", server.url), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url: "https://example.com/",
      formats: ["markdown"],
      actions: [{ type: "click", selector: "#more" }],
    }),
  });

  expect(response.status).toBe(429);
  expect(response.headers.get("retry-after")).toBe("9");
  expect(deepSeekCalls).toBe(0);
});
```

Add:

```ts
it("returns advanced_backend_unavailable when PageSift transport fails", async () => {
  const server = await startGatewayServer({
    config: {
      ...testConfig(),
      advancedBackend: {
        provider: "pagesift",
        url: new URL("http://127.0.0.1:3002/"),
      },
    },
    env: { FIRECRAWL_API_KEY: "fc-test" },
    fetchImpl: async (_input, init) =>
      new Headers(init?.headers).has("authorization")
        ? Response.json({ success: false }, { status: 402 })
        : Response.json({ success: false }, { status: 429 }),
    deepseekClient: {
      async search() {
        throw new Error("Unexpected Search call.");
      },
      async fetch() {
        throw new Error("DeepSeek must not handle browser Scrape.");
      },
    },
    advancedBackend: {
      config: {
        provider: "pagesift",
        url: new URL("http://127.0.0.1:3002/"),
      },
      async request() {
        throw new AdvancedBackendError(
          "The configured advanced backend is unavailable.",
          "advanced_backend_unavailable",
          503,
        );
      },
      async readJsonResponse() {
        throw new Error("Not reached.");
      },
    },
  });
  servers.push(server);

  const response = await fetch(new URL("/v2/scrape", server.url), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url: "https://example.com/",
      formats: ["markdown"],
      actions: [{ type: "click", selector: "#more" }],
    }),
  });

  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({
    code: "advanced_backend_unavailable",
  });
});
```

Add:

```ts
it("rejects a successful PageSift Scrape without a scrapeId", async () => {
  const server = await startGatewayServer({
    config: {
      ...testConfig(),
      advancedBackend: {
        provider: "pagesift",
        url: new URL("http://127.0.0.1:3002/"),
      },
    },
    env: { FIRECRAWL_API_KEY: "fc-test" },
    fetchImpl: async (_input, init) =>
      new Headers(init?.headers).has("authorization")
        ? Response.json({ success: false }, { status: 402 })
        : Response.json({ success: false }, { status: 429 }),
    deepseekClient: {
      async search() {
        throw new Error("Unexpected Search call.");
      },
      async fetch() {
        throw new Error("DeepSeek must not handle browser Scrape.");
      },
    },
    advancedBackend: {
      config: {
        provider: "pagesift",
        url: new URL("http://127.0.0.1:3002/"),
      },
      async request() {
        return Response.json({ success: true, data: { markdown: "# No session" } });
      },
      async readJsonResponse(response) {
        return response.json();
      },
    },
  });
  servers.push(server);

  const response = await fetch(new URL("/v2/scrape", server.url), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url: "https://example.com/",
      actions: [{ type: "click", selector: "#more" }],
    }),
  });

  expect(response.status).toBe(502);
  expect(await response.json()).toMatchObject({
    code: "advanced_backend_session_id_missing",
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run:

```bash
npm test -- test/unit/gateway-telemetry.test.ts test/integration/firecrawl-gateway.test.ts
```

Expected: FAIL because advanced backend injection and routing do not exist.

- [ ] **Step 3: Implement Advanced Scrape routing**

In `src/gateway/telemetry.ts` update the provider union:

```ts
provider:
  | "firecrawl"
  | "firecrawl-keyless"
  | "deepseek"
  | "pagesift"
  | "gateway"
  | "none";
```

Add:

```ts
if (/^\/v2\/scrape\/[^/]+\/interact$/.test(pathname)) {
  return "/v2/scrape/:id/interact";
}
```

In `src/gateway/handler.ts`, add `advancedBackend?: AdvancedBackend` to
`GatewayHandlerDependencies` and create the default backend:

```ts
const advancedBackend =
  dependencies.advancedBackend ??
  (dependencies.config.advancedBackend
    ? createPageSiftBackend(
        dependencies.config.advancedBackend,
        dependencies.fetchImpl,
        dependencies.config.timeoutMs,
      )
    : undefined);
const advancedSessions = new AdvancedSessionStore();
```

Add `advancedBackend` to `GatewayServerOptions` and forward it from
`startGatewayServer`.

Add an advanced Scrape helper:

```ts
async function executeAdvancedScrape(
  body: Uint8Array | undefined,
  headers: Headers,
  backend: AdvancedBackend,
  sessions: AdvancedSessionStore,
  signal?: AbortSignal,
): Promise<
  | { kind: "passthrough"; response: Response }
  | { kind: "success"; body: Record<string, unknown> }
> {
  const lease = sessions.reserve();
  try {
    const prepared = preparePageSiftScrape(parseJsonBody(body));
    const upstream = await backend.request({
      method: "POST",
      path: "/v2/scrape",
      headers,
      body: prepared.serialized,
      signal,
    });
    if (!upstream.ok) {
      lease.release();
      return { kind: "passthrough", response: upstream };
    }
    const value = await backend.readJsonResponse(upstream, signal);
    const upstreamId = readPageSiftScrapeId(value);
    if (!upstreamId) {
      lease.release();
      throw new AdvancedBackendError(
        "The advanced backend did not return a scrape session.",
        "advanced_backend_session_id_missing",
        502,
      );
    }
    const publicId = lease.commit(upstreamId);
    return { kind: "success", body: rewritePageSiftScrapeId(value, publicId) };
  } catch (error) {
    lease.release();
    throw error;
  }
}
```

In the existing `shouldTryDeepSeek` block, catch an unsupported Scrape and
fall through to PageSift:

```ts
try {
  if (!route) {
    throw new UnsupportedFallbackFeatureError("This route has no DeepSeek fallback.");
  }
  const result = await executeFallback(
    route,
    body,
    resolveDeepSeekClient,
    resolveSitemapReader,
    crawlJobs,
    requestController.signal,
  );
  sendJson(response, 200, result);
} catch (error) {
  if (
    error instanceof UnsupportedFallbackFeatureError &&
    route?.kind === "scrape" &&
    advancedBackend &&
    providerMode !== "no-fallback"
  ) {
    provider = "pagesift";
    fallback = true;
    fallbackReason = "pagesift_advanced_scrape";
    try {
      const result = await executeAdvancedScrape(
        body,
        advancedRequestHeaders(request, requestId),
        advancedBackend,
        advancedSessions,
        requestController.signal,
      );
      if (result.kind === "passthrough") {
        await sendUpstream(response, result.response);
      } else {
        sendJson(response, 200, result.body);
      }
    } catch (advancedError) {
      fallbackError(response, advancedError);
    }
    return;
  }
  fallbackError(response, error);
}
```

Add this helper beside `incomingHeaders`:

```ts
function advancedRequestHeaders(
  request: IncomingMessage,
  requestId: string,
): Headers {
  const headers = incomingHeaders(request, true);
  headers.set("content-type", "application/json");
  headers.set("x-request-id", requestId);
  return headers;
}
```

In `fallbackError`, handle `AdvancedBackendError` before generic fallback:

```ts
if (error instanceof AdvancedBackendError) {
  sendJson(
    response,
    error.statusCode,
    {
      success: false,
      error: error.message,
      code: error.code,
    },
    error.retryAfterSeconds === undefined
      ? {}
      : { "retry-after": String(error.retryAfterSeconds) },
  );
  return;
}
```

- [ ] **Step 4: Run focused tests**

Run:

```bash
npm test -- test/unit/gateway-telemetry.test.ts test/integration/firecrawl-gateway.test.ts
npm run typecheck
npm run typecheck:test
```

Expected: PASS. Existing Firecrawl, Keyless, and DeepSeek tests remain green.

- [ ] **Step 5: Commit**

```bash
git add src/gateway/handler.ts src/gateway/server.ts src/gateway/telemetry.ts \
  test/unit/gateway-telemetry.test.ts test/integration/firecrawl-gateway.test.ts
git commit -m "feat: route advanced scrapes to PageSift"
```

---

### Task 6: Route PageSift Interact Sessions

**Files:**
- Modify: `src/gateway/handler.ts`
- Test: `test/integration/firecrawl-gateway.test.ts`
- Test: `test/integration/firecrawl-sdk-gateway.test.ts`

**Interfaces:**

- Consumes:
  - `AdvancedSessionStore.resolve`
  - `AdvancedSessionStore.remove`
  - `isPageSiftSessionId`
  - `preparePageSiftInteract`
- Produces:
  - PageSift-owned POST/DELETE Interact
  - `advanced_session_not_found`
  - Official Firecrawl SDK acceptance of rewritten `ps_` scrape IDs.

- [ ] **Step 1: Write failing Interact tests**

Add a reusable PageSift session fixture:

```ts
function advancedSessionBackend() {
  const requests: Array<{
    method: string;
    path: string;
    authorization: string | null;
    body: Record<string, unknown> | null;
  }> = [];
  return {
    requests,
    backend: {
      config: {
        provider: "pagesift" as const,
        url: new URL("http://127.0.0.1:3002/"),
        apiKey: "pagesift-secret",
      },
      async request(input) {
        requests.push({
          method: input.method,
          path: input.path,
          authorization: input.headers.get("authorization"),
          body:
            input.body === undefined
              ? null
              : JSON.parse(Buffer.from(input.body).toString("utf8")),
        });
        if (input.path === "/v2/scrape") {
          return Response.json({
            success: true,
            data: {
              markdown: "# Browser",
              metadata: { scrapeId: "pagesift-upstream" },
            },
          });
        }
        return Response.json({ success: true, output: "Page summary" });
      },
      async readJsonResponse(response: Response) {
        return response.json();
      },
    },
  };
}

async function startAdvancedSessionGateway() {
  const pagesift = advancedSessionBackend();
  const server = await startGatewayServer({
    config: {
      ...testConfig(),
      advancedBackend: pagesift.backend.config,
    },
    env: { FIRECRAWL_API_KEY: "fc-test" },
    fetchImpl: async (_input, init) =>
      new Headers(init?.headers).has("authorization")
        ? Response.json({ success: false }, { status: 402 })
        : Response.json({ success: false }, { status: 429 }),
    deepseekClient: {
      async search() {
        throw new Error("Unexpected Search call.");
      },
      async fetch() {
        throw new Error("DeepSeek must not handle browser Scrape.");
      },
    },
    advancedBackend: pagesift.backend,
  });
  servers.push(server);
  return { pagesift, server };
}

async function createAdvancedSession(server: TestServer): Promise<string> {
  const response = await fetch(new URL("/v2/scrape", server.url), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url: "https://example.com/",
      formats: ["markdown"],
      actions: [{ type: "click", selector: "#more" }],
    }),
  });
  return (await response.json()).data.metadata.scrapeId;
}
```

Add the Interact test:

```ts
it("routes PageSift-owned Interact back to PageSift", async () => {
  const { pagesift, server } = await startAdvancedSessionGateway();
  const publicId = await createAdvancedSession(server);

  const interact = await fetch(
    new URL(`/v2/scrape/${publicId}/interact`, server.url),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "Summarize this page" }),
    },
  );

  expect(interact.status).toBe(200);
  expect(await interact.json()).toEqual({ success: true, output: "Page summary" });
  expect(pagesift.requests.at(-1)).toEqual({
    method: "POST",
    path: "/v2/scrape/pagesift-upstream/interact",
    authorization: null,
    body: { prompt: "Summarize this page" },
  });
});
```

Add DELETE cleanup coverage:

```ts
it("removes a PageSift session after DELETE", async () => {
  const { pagesift, server } = await startAdvancedSessionGateway();
  const publicId = await createAdvancedSession(server);
  const path = new URL(`/v2/scrape/${publicId}/interact`, server.url);

  expect((await fetch(path, { method: "DELETE" })).status).toBe(200);
  expect((await fetch(path, { method: "DELETE" })).status).toBe(404);
  expect(pagesift.requests).toHaveLength(2);
});
```

Add:

```ts
it("fails closed for PageSift code Interact", async () => {
  const { pagesift, server } = await startAdvancedSessionGateway();
  const publicId = await createAdvancedSession(server);
  const response = await fetch(
    new URL(`/v2/scrape/${publicId}/interact`, server.url),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "await page.title()", language: "node" }),
    },
  );
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({
    success: false,
    error: "PageSift fallback does not support Firecrawl option `code`.",
    code: "unsupported_fallback_feature",
  });
  expect(pagesift.requests).toHaveLength(1);
});
```

Add unknown-ID coverage:

```ts
it("never sends an unknown ps_ session to Firecrawl", async () => {
  let firecrawlCalls = 0;
  const server = await startGatewayServer({
    config: testConfig(),
    env: { FIRECRAWL_API_KEY: "fc-test" },
    fetchImpl: async () => {
      firecrawlCalls += 1;
      return Response.json({ success: false }, { status: 404 });
    },
  });
  servers.push(server);

  const response = await fetch(
    new URL("/v2/scrape/ps_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/interact", server.url),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "Continue" }),
    },
  );

  expect(response.status).toBe(404);
  expect(await response.json()).toMatchObject({ code: "advanced_session_not_found" });
  expect(firecrawlCalls).toBe(0);
});
```

In `test/integration/firecrawl-sdk-gateway.test.ts`, add a complete SDK test:

```ts
it("accepts a rewritten PageSift scrape ID through the official SDK", async () => {
  const pagesiftResponse = {
    success: true,
    data: {
      markdown: "# Browser",
      metadata: { scrapeId: "pagesift-upstream" },
    },
  };
  const gateway = await startGatewayServer({
    config: {
      ...testConfig(new URL("https://api.firecrawl.dev/")),
      advancedBackend: {
        provider: "pagesift",
        url: new URL("http://127.0.0.1:3002/"),
      },
    },
    env: { FIRECRAWL_API_KEY: "fc-test" },
    fetchImpl: async (_input, init) =>
      new Headers(init?.headers).has("authorization")
        ? Response.json({ success: false }, { status: 402 })
        : Response.json({ success: false }, { status: 429 }),
    deepseekClient: {
      async search() {
        throw new Error("Unexpected Search call.");
      },
      async fetch() {
        throw new Error("DeepSeek must not handle browser Scrape.");
      },
    },
    advancedBackend: {
      config: {
        provider: "pagesift",
        url: new URL("http://127.0.0.1:3002/"),
      },
      async request() {
        return Response.json(pagesiftResponse);
      },
      async readJsonResponse() {
        return pagesiftResponse;
      },
    },
  });
  servers.push(gateway);
  const client = new Firecrawl({
    apiKey: "fc-test",
    apiUrl: gateway.url.href.replace(/\/$/, ""),
  });

  const scraped = await client.scrape("https://example.com/", {
    formats: ["markdown"],
    actions: [{ type: "click", selector: "#more" }],
  });
  expect(
    (scraped.metadata as { scrapeId?: string } | undefined)?.scrapeId,
  ).toMatch(/^ps_[0-9a-f]{32}$/);
});
```

- [ ] **Step 2: Run and confirm failure**

Run:

```bash
npm test -- test/integration/firecrawl-gateway.test.ts test/integration/firecrawl-sdk-gateway.test.ts
```

Expected: FAIL because `ps_` Interact routing is not implemented.

- [ ] **Step 3: Implement session-first Interact routing**

In `createGatewayHandler`, after request body parsing and before the existing
`fallbackRoute` logic, add:

```ts
const interactMatch = requestUrl.pathname.match(/^\/v2\/scrape\/([^/]+)\/interact$/);
const interactId = interactMatch ? decodeURIComponent(interactMatch[1] ?? "") : undefined;
if (
  (method === "POST" || method === "DELETE") &&
  interactId !== undefined &&
  isPageSiftSessionId(interactId)
) {
  const upstreamId = advancedSessions.resolve(interactId);
  if (!upstreamId || !advancedBackend) {
    fallbackError(
      response,
      new AdvancedBackendError(
        "The advanced scrape session is not available.",
        "advanced_session_not_found",
        404,
      ),
    );
    return;
  }
  provider = "pagesift";
  fallback = true;
  fallbackReason = "pagesift_advanced_interact";
  try {
    const upstream = await advancedBackend.request({
      method,
      path: `/v2/scrape/${encodeURIComponent(upstreamId)}/interact`,
      headers: advancedRequestHeaders(request, requestId),
      ...(method === "POST"
        ? { body: preparePageSiftInteract(parseJsonBody(body)) }
        : {}),
      signal: requestController.signal,
    });
    if (upstream.status === 404 || upstream.status === 410) {
      advancedSessions.remove(interactId);
      await upstream.body?.cancel().catch(() => undefined);
      throw new AdvancedBackendError(
        "The advanced scrape session is not available.",
        "advanced_session_not_found",
        404,
      );
    }
    if (method === "DELETE" && upstream.ok) {
      advancedSessions.remove(interactId);
    }
    await sendUpstream(response, upstream);
  } catch (error) {
    fallbackError(response, error);
  }
  return;
}
```

- [ ] **Step 4: Run focused tests**

Run:

```bash
npm test -- test/integration/firecrawl-gateway.test.ts test/integration/firecrawl-sdk-gateway.test.ts
npm run typecheck
npm run typecheck:test
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/gateway/handler.ts test/integration/firecrawl-gateway.test.ts \
  test/integration/firecrawl-sdk-gateway.test.ts
git commit -m "feat: route PageSift interact sessions"
```

---

### Task 7: Foreground CLI, Gateway Health, Runtime, And Status

**Files:**
- Modify: `src/cli/parse.ts`
- Modify: `src/cli/run.ts`
- Modify: `src/gateway/server.ts`
- Modify: `src/gateway/runtime.ts`
- Test: `test/unit/cli-parse.test.ts`
- Test: `test/unit/gateway-cli.test.ts`
- Test: `test/unit/gateway-runtime.test.ts`
- Test: `test/integration/firecrawl-gateway.test.ts`

**Interfaces:**

- Consumes:
  - `GatewayConfig.advancedBackend`
  - `disabledAdvancedBackendStatus`
  - `probePageSift`
- Produces:
  - Foreground `gateway --advanced` and `--advanced-url`.
  - Non-secret `/healthz.advanced_backend`.
  - Runtime state advanced fields.
  - `gateway status` `advanced_backend` per instance.

- [ ] **Step 1: Write failing CLI, health, runtime, and status tests**

In `test/unit/cli-parse.test.ts`, add invalid combinations:

```ts
expect(() => parseCli(["gateway", "--advanced-url", "   "])).toThrow(/advanced url/i);
```

In `test/unit/gateway-runtime.test.ts`, extend the healthy instance with:

```ts
advancedBackend: {
  provider: "pagesift",
  url: "http://127.0.0.1:3002/",
},
```

and make the health response:

```ts
advanced_backend: {
  provider: "pagesift",
  configured: true,
},
```

Assert it is retained in `pruned.running[0]`.

In `test/integration/firecrawl-gateway.test.ts`, add:

```ts
it("reports configured advanced backend without probing it", async () => {
  let calls = 0;
  const server = await startGatewayServer({
    config: {
      ...testConfig(),
      advancedBackend: {
        provider: "pagesift",
        url: new URL("http://127.0.0.1:3002/"),
      },
    },
    env: {},
    fetchImpl: async () => {
      calls += 1;
      throw new Error("Healthz must not probe PageSift.");
    },
  });
  servers.push(server);

  const health = await (await fetch(new URL("/healthz", server.url))).json();
  expect(health.advanced_backend).toEqual({
    provider: "pagesift",
    configured: true,
  });
  expect(calls).toBe(0);
});
```

In `test/unit/gateway-cli.test.ts`, add a status test whose `fetchImpl` returns:

- Gateway health for the local Gateway URL.
- `ok` for PageSift `/healthz`.
- JSON for `/v2/crawl/active`.

Assert:

```ts
expect(JSON.parse(stdout.value()).instances[0].advanced_backend).toEqual({
  enabled: true,
  provider: "pagesift",
  url: "http://127.0.0.1:3002/",
  reachable: true,
  api_ready: true,
  credential_configured: false,
});
```

- [ ] **Step 2: Run and confirm failure**

Run:

```bash
npm test -- test/unit/cli-parse.test.ts test/unit/gateway-runtime.test.ts \
  test/unit/gateway-cli.test.ts test/integration/firecrawl-gateway.test.ts
```

Expected: FAIL because runtime and status do not expose advanced configuration.

- [ ] **Step 3: Implement foreground/runtime/status behavior**

In `runGateway`, pass:

```ts
...(command.advanced || command.advancedUrl !== undefined
  ? { advancedEnabled: true }
  : {}),
...(command.advancedUrl === undefined ? {} : { advancedUrl: command.advancedUrl }),
```

Update `COMMAND_HELP.gateway` and the main credential help to include:

```text
  --advanced
  --advanced-url <http(s)-url>
```

```text
  auth set [credential]          Store deepseek, firecrawl, gateway, or pagesift credentials
```

Print:

```ts
deps.stdout.write(
  config.advancedBackend
    ? `Advanced backend: pagesift ${config.advancedBackend.url.href}\n`
    : "Advanced backend: disabled\n",
);
```

In Gateway `/healthz`, add:

```ts
advanced_backend: config.advancedBackend
  ? { provider: "pagesift", configured: true }
  : { provider: null, configured: false },
```

Extend `GatewayRuntimeState`:

```ts
advancedBackend?: {
  provider: "pagesift";
  url: string;
};
```

Retain and validate the optional object in runtime state parsing. Do not add the
URL to `GatewayHealth` or `/healthz`; the URL lives only in the private runtime
state file and the runtime health response confirms only provider/configured
metadata. Write the private state from `startGatewayServer`:

```ts
...(options.config.advancedBackend
  ? {
      advancedBackend: {
        provider: "pagesift",
        url: options.config.advancedBackend.url.href,
      },
    }
  : {}),
```

In `runGatewayStatus`, build the per-instance object:

```ts
async function advancedStatus(
  state: GatewayRuntimeState,
  deps: CliDependencies,
) {
  if (!state.advancedBackend) {
    return disabledAdvancedBackendStatus();
  }
  const config = loadGatewayConfig({
    advancedUrl: state.advancedBackend.url,
    env: deps.env,
    ...(deps.credentialStores === undefined
      ? {}
      : { credentialStores: deps.credentialStores }),
  }).advancedBackend;
  if (!config) {
    throw new Error("Advanced runtime state did not resolve to a backend.");
  }
  return probePageSift(config, deps.fetchImpl);
}
```

Include `advanced_backend: await advancedStatus(state, deps)` in each
`instances.map`.

Add `pagesift` to the machine credential summary:

```ts
const credentials = {
  deepseek: authStatus(deps.env, resolvedCredentialStore(deps, "deepseek"), "deepseek"),
  firecrawl: authStatus(deps.env, resolvedCredentialStore(deps, "firecrawl"), "firecrawl"),
  gateway_auth: authStatus(deps.env, resolvedCredentialStore(deps, "gateway"), "gateway"),
  pagesift: authStatus(deps.env, resolvedCredentialStore(deps, "pagesift"), "pagesift"),
};
```

Add `PageSift:` to human status output using
`credentials.pagesift.configured/source/backend`.

- [ ] **Step 4: Run focused tests**

Run:

```bash
npm test -- test/unit/cli-parse.test.ts test/unit/gateway-runtime.test.ts \
  test/unit/gateway-cli.test.ts test/integration/firecrawl-gateway.test.ts
npm run typecheck
npm run typecheck:test
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/parse.ts src/cli/run.ts src/gateway/server.ts src/gateway/runtime.ts \
  test/unit/cli-parse.test.ts test/unit/gateway-runtime.test.ts \
  test/unit/gateway-cli.test.ts test/integration/firecrawl-gateway.test.ts
git commit -m "feat: expose PageSift Gateway status"
```

---

### Task 8: Managed Service Persistence And Preflight

**Files:**
- Modify: `src/gateway/service.ts`
- Modify: `src/cli/parse.ts`
- Modify: `src/cli/run.ts`
- Test: `test/unit/cli-parse.test.ts`
- Test: `test/unit/gateway-cli.test.ts`
- Test: `test/unit/gateway-service.test.ts`

**Interfaces:**

- Consumes:
  - `DEFAULT_ADVANCED_BACKEND_URL`
  - `loadGatewayConfig`
  - `probePageSift`
- Produces:
  - Managed install options `advanced`, `advancedUrl`, `noAdvanced`.
  - `GatewayServiceContext.credentialStores?: Partial<Record<CredentialName, CredentialStore>>`.
  - Optional managed state:

```ts
advancedBackend?: {
  provider: "pagesift";
  url: string;
};
```

- `GatewayServiceStatus.advanced_backend: AdvancedBackendStatus`.

- [ ] **Step 1: Write failing managed-service tests**

In `test/unit/cli-parse.test.ts`, add:

```ts
expect(
  parseCli(["gateway", "install", "--advanced", "--json"]),
).toEqual({
  kind: "gateway-install",
  advanced: true,
  json: true,
});
expect(
  parseCli(["gateway", "install", "--advanced-url", "http://127.0.0.1:3002"]),
).toEqual({
  kind: "gateway-install",
  advanced: true,
  advancedUrl: "http://127.0.0.1:3002",
  json: false,
});
expect(parseCli(["gateway", "install", "--no-advanced"])).toEqual({
  kind: "gateway-install",
  noAdvanced: true,
  json: false,
});
```

Add invalid cases:

```ts
[["gateway", "install", "--advanced", "--no-advanced"], /mutually exclusive/i],
[["gateway", "install", "--advanced-url", "http://127.0.0.1:3002", "--no-advanced"], /mutually exclusive/i],
[["gateway", "--no-advanced"], /unknown option/i],
```

In `test/unit/gateway-cli.test.ts`, add:

```ts
it("passes advanced install options to the service manager", async () => {
  const directory = await runtimeDirectory();
  const lifecycle = dependencies(directory);
  let received: Parameters<GatewayServiceManager["install"]>[0] | undefined;
  lifecycle.deps.gatewayServiceManager = {
    async install(options) {
      received = options;
      return serviceStatus();
    },
    async start() {
      throw new Error("Unexpected start.");
    },
    async stop() {
      throw new Error("Unexpected stop.");
    },
    async uninstall() {
      throw new Error("Unexpected uninstall.");
    },
    async status() {
      return serviceStatus();
    },
  } satisfies GatewayServiceManager;

  expect(
    await runCli(
      [
        "gateway",
        "install",
        "--advanced-url",
        "http://127.0.0.1:3002",
        "--json",
      ],
      lifecycle.deps,
    ),
  ).toBe(0);
  expect(received).toMatchObject({
    advanced: true,
    advancedUrl: "http://127.0.0.1:3002",
  });
});
```

In `test/unit/gateway-service.test.ts`, add an advanced fixture fetch router:

```ts
function advancedFetch(gatewayHealth: () => Response): typeof fetch {
  return async (input) => {
    const url = String(input);
    if (url === "http://127.0.0.1:3002/healthz") return new Response("ok");
    if (url === "http://127.0.0.1:3002/v2/crawl/active") return Response.json([]);
    return gatewayHealth();
  };
}
```

Add the default-no-probe test:

```ts
it("does not probe PageSift for a default install", async () => {
  const { context } = await fixture();
  const calls: string[] = [];
  context.fetchImpl = async (input) => {
    calls.push(String(input));
    return Response.json({ status: "ok", pid: 4242, provider_mode: "firecrawl-first" });
  };

  await installGatewayService(context, {
    providerMode: "firecrawl-first",
    port: 8787,
  });

  expect(calls.every((url) => !url.includes(":3002"))).toBe(true);
});
```

Add:

```ts
it("persists advanced settings and passes them to the managed process", async () => {
  const { context, paths } = await fixture();
  context.fetchImpl = advancedFetch(() =>
    Response.json({ status: "ok", pid: 4242, provider_mode: "firecrawl-first" }),
  );

  const status = await installGatewayService(context, {
    providerMode: "firecrawl-first",
    port: 8787,
    advanced: true,
    advancedUrl: "http://127.0.0.1:3002",
  });

  expect(status.advanced_backend).toMatchObject({
    enabled: true,
    provider: "pagesift",
    api_ready: true,
  });
  expect(await readFile(paths.launcherPath, "utf8")).toContain(
    "--advanced --advanced-url 'http://127.0.0.1:3002'",
  );
  expect(JSON.parse(await readFile(paths.statePath, "utf8"))).toMatchObject({
    advancedBackend: {
      provider: "pagesift",
      url: "http://127.0.0.1:3002/",
    },
  });
});
```

Add preflight-failure coverage asserting no state or Firecrawl mutation occurs:

```ts
it("does not modify install state when PageSift preflight fails", async () => {
  const { context, paths } = await fixture();
  context.fetchImpl = async (input) => {
    if (String(input).endsWith("/healthz")) {
      return new Response("not pagesift");
    }
    return Response.json({ status: "ok", pid: 4242 });
  };

  await expect(
    installGatewayService(context, {
      providerMode: "firecrawl-first",
      port: 8787,
      advanced: true,
    }),
  ).rejects.toThrow(/PageSift/i);

  await expect(lstat(paths.statePath)).rejects.toMatchObject({ code: "ENOENT" });
  expect(JSON.parse(await readFile(paths.firecrawlCredentialsPath, "utf8")).apiUrl).toBe(
    CLOUD_API_URL,
  );
});
```

Add reinstall-preservation coverage:

```ts
it("preserves advanced settings when reinstall omits advanced flags", async () => {
  const { context, paths } = await fixture();
  context.fetchImpl = advancedFetch(() =>
    Response.json({ status: "ok", pid: 4242, provider_mode: "firecrawl-first" }),
  );

  await installGatewayService(context, {
    providerMode: "firecrawl-first",
    port: 8787,
    advanced: true,
    advancedUrl: "http://127.0.0.1:3002",
  });
  await installGatewayService(context, {
    providerMode: "firecrawl-first",
    port: 8787,
  });

  expect(JSON.parse(await readFile(paths.statePath, "utf8"))).toMatchObject({
    advancedBackend: {
      provider: "pagesift",
      url: "http://127.0.0.1:3002/",
    },
  });
});
```

Add explicit disable coverage:

```ts
it("removes advanced settings with noAdvanced", async () => {
  const { context, paths } = await fixture();
  context.fetchImpl = advancedFetch(() =>
    Response.json({ status: "ok", pid: 4242, provider_mode: "firecrawl-first" }),
  );

  await installGatewayService(context, {
    providerMode: "firecrawl-first",
    port: 8787,
    advanced: true,
    advancedUrl: "http://127.0.0.1:3002",
  });
  await installGatewayService(context, {
    providerMode: "firecrawl-first",
    port: 8787,
    noAdvanced: true,
  });

  const state = JSON.parse(await readFile(paths.statePath, "utf8"));
  expect(state.advancedBackend).toBeUndefined();
  expect(await readFile(paths.launcherPath, "utf8")).not.toContain("--advanced");
});
```

Add Windows launcher parity:

```ts
it("passes advanced settings to the Windows launcher", async () => {
  const { context, paths } = await windowsFixture();
  context.fetchImpl = advancedFetch(() =>
    Response.json({ status: "ok", pid: 5151, provider_mode: "firecrawl-first" }),
  );

  await installGatewayService(context, {
    providerMode: "firecrawl-first",
    port: 8787,
    advanced: true,
    advancedUrl: "http://127.0.0.1:3002",
  });

  expect(await readFile(paths.launcherPath, "utf8")).toContain(
    '--advanced --advanced-url "http://127.0.0.1:3002/"',
  );
});
```

- [ ] **Step 2: Run and confirm failure**

Run:

```bash
npm test -- test/unit/cli-parse.test.ts test/unit/gateway-cli.test.ts \
  test/unit/gateway-service.test.ts
```

Expected: FAIL because managed install does not accept or persist advanced
settings.

- [ ] **Step 3: Implement managed advanced state and preflight**

Extend `GatewayServiceManager.install` options:

```ts
install(options: {
  providerMode: GatewayProviderMode;
  port: number;
  advanced?: boolean;
  advancedUrl?: string;
  noAdvanced?: boolean;
}): Promise<GatewayServiceStatus>;
```

Extend `GatewayServiceContext`:

```ts
credentialStores?: Partial<Record<CredentialName, CredentialStore>>;
```

In `gatewayServiceManager(deps)`, pass:

```ts
...(deps.credentialStores === undefined
  ? {}
  : { credentialStores: deps.credentialStores }),
```

Add imports for `CredentialName`, `CredentialStore`,
`disabledAdvancedBackendStatus`, and `AdvancedBackendStatus`.

In `parseCli`, add install-only flags:

```ts
advanced: { type: "boolean" },
"advanced-url": { type: "string" },
"no-advanced": { type: "boolean" },
```

Reject conflicting flags before constructing the command:

```ts
const advancedUrl = parsed.values["advanced-url"]?.trim();
if (parsed.values["advanced-url"] !== undefined && !advancedUrl) {
  throw new CliUsageError("Advanced URL is required.");
}
if (
  parsed.values["no-advanced"] &&
  (parsed.values.advanced || parsed.values["advanced-url"] !== undefined)
) {
  throw new CliUsageError("--no-advanced cannot be combined with advanced options.");
}
```

Update `COMMAND_HELP["gateway install"]` with:

```text
  --advanced                    Enable the default loopback PageSift backend
  --advanced-url <http(s)-url>  Enable PageSift at an explicit root URL
  --no-advanced                 Disable a previously configured PageSift backend
```

Return:

```ts
{
  kind: "gateway-install",
  ...(providerMode === undefined ? {} : { providerMode }),
  ...(port === undefined ? {} : { port }),
  ...(parsed.values.advanced || advancedUrl !== undefined ? { advanced: true } : {}),
  ...(advancedUrl === undefined ? {} : { advancedUrl }),
  ...(parsed.values["no-advanced"] ? { noAdvanced: true } : {}),
  json: parsed.values.json ?? false,
}
```

In `installGatewayService`, resolve the target state before writing files:

```ts
const previous = existing?.advancedBackend;
const requestedUrl =
  options.advancedUrl ??
  (options.advanced
    ? context.env.DEEPSEEK_GATEWAY_ADVANCED_URL?.trim() || DEFAULT_ADVANCED_BACKEND_URL
    : undefined);
let advanced =
  options.noAdvanced === true
    ? undefined
    : requestedUrl === undefined
      ? previous
      : {
          provider: "pagesift" as const,
          url: new URL(requestedUrl).href,
        };
```

Build the advanced config through shared Gateway config validation and probe it:

```ts
if (advanced) {
  const resolved = loadGatewayConfig({
    advancedUrl: advanced.url,
    env: context.env,
    ...(context.credentialStores === undefined
      ? {}
      : { credentialStores: context.credentialStores }),
  }).advancedBackend;
  if (!resolved) {
    throw new Error("PageSift configuration did not resolve.");
  }
  const probe = await probePageSift(resolved, context.fetchImpl ?? fetch);
  if (!probe.reachable || !probe.api_ready) {
    throw new Error("PageSift preflight failed: service or credential is unavailable.");
  }
  advanced = {
    provider: "pagesift",
    url: resolved.url.href,
  };
}
```

Set `state.advancedBackend = advanced`. Store only provider and normalized URL,
never the key.

Keep managed service state version `1` because the field is additive. Extend
`readServiceState` to retain and validate it:

```ts
function validateAdvancedBackend(value: unknown) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object") {
    throw new Error("Gateway service state contains invalid advanced backend data.");
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.provider !== "pagesift" || typeof candidate.url !== "string") {
    throw new Error("Gateway service state contains invalid advanced backend data.");
  }
  const url = new URL(candidate.url);
  if (url.pathname !== "/" || url.search || url.hash || url.username || url.password) {
    throw new Error("Gateway service state contains invalid advanced backend URL.");
  }
  return { provider: "pagesift" as const, url: url.href };
}
```

Return:

```ts
...(advanced === undefined ? {} : { advancedBackend: advanced }),
```

When writing macOS and Windows launchers, append:

```ts
const advancedArgs = state.advancedBackend
  ? ` --advanced --advanced-url ${shellQuote(state.advancedBackend.url)}`
  : "";
```

Use `advancedArgs` for the shell launcher. For Windows, use the equivalent
double-quoted URL argument and preserve `cmd.exe` escaping.

Extend `GatewayServiceStatus` and `getGatewayServiceStatus`:

```ts
advanced_backend: AdvancedBackendStatus;
```

If enabled, run `probePageSift`. If disabled, return
`disabledAdvancedBackendStatus()`. Add the same field to `unsupportedStatus()`
and every not-installed/stopped return path. If preflight-capable config cannot
resolve, return `api_ready: false` and add a service issue without exposing the
key. Update the `serviceStatus()` test helper to include the disabled status by
default so existing tests remain explicit.

Use this helper inside `getGatewayServiceStatus`:

```ts
async function serviceAdvancedStatus(
  context: GatewayServiceContext,
  state: GatewayServiceState,
): Promise<AdvancedBackendStatus> {
  if (!state.advancedBackend) {
    return disabledAdvancedBackendStatus();
  }
  try {
    const config = loadGatewayConfig({
      advancedUrl: state.advancedBackend.url,
      env: context.env,
      ...(context.credentialStores === undefined
        ? {}
        : { credentialStores: context.credentialStores }),
    }).advancedBackend;
    if (!config) {
      throw new Error("PageSift configuration did not resolve.");
    }
    return await probePageSift(config, context.fetchImpl ?? fetch);
  } catch {
    let credentialConfigured = Boolean(context.env.PAGESIFT_API_KEY?.trim());
    try {
      credentialConfigured =
        credentialConfigured || context.credentialStores?.pagesift?.get() !== undefined;
    } catch {
      credentialConfigured = Boolean(context.env.PAGESIFT_API_KEY?.trim());
    }
    return {
      enabled: true,
      provider: "pagesift",
      url: state.advancedBackend.url,
      reachable: false,
      api_ready: false,
      credential_configured: credentialConfigured,
    };
  }
}
```

Add to `formatGatewayServiceStatus`:

```ts
lines.push(
  status.advanced_backend.enabled
    ? `Advanced backend: pagesift (${status.advanced_backend.api_ready ? "ready" : "unavailable"})`
    : "Advanced backend: disabled",
);
```

Update `runGatewayInstall` to pass:

```ts
...(command.advanced === undefined ? {} : { advanced: command.advanced }),
...(command.advancedUrl === undefined ? {} : { advancedUrl: command.advancedUrl }),
...(command.noAdvanced === undefined ? {} : { noAdvanced: command.noAdvanced }),
```

- [ ] **Step 4: Run focused tests**

Run:

```bash
npm test -- test/unit/cli-parse.test.ts test/unit/gateway-cli.test.ts \
  test/unit/gateway-service.test.ts
npm run typecheck
npm run typecheck:test
```

Expected: PASS on macOS and Windows service fixtures.

- [ ] **Step 5: Commit**

```bash
git add src/gateway/service.ts src/cli/parse.ts src/cli/run.ts \
  test/unit/cli-parse.test.ts test/unit/gateway-cli.test.ts \
  test/unit/gateway-service.test.ts
git commit -m "feat: manage optional PageSift configuration"
```

---

### Task 9: Documentation, Packaging Contract, And Full Verification

**Files:**
- Modify: `README.md`
- Modify: `README.en.md`
- Modify: `docs/operations.md`
- Modify: `docs/operations.zh-CN.md`
- Modify: `skills/deepseek-crawl/SKILL.md`
- Modify: `skills/deepseek-crawl/references/cli-reference.md`
- Modify: `llms.txt`
- Modify: `CHANGELOG.md`
- Modify: `.env.example`
- Modify: `docker-compose.yml`

**Interfaces:**

- Consumes: all prior task behavior.
- Produces: user-facing opt-in instructions, exact limitations, and release-ready
  package verification.

- [ ] **Step 1: Add documentation consistency assertions**

Add this test to `test/unit/package.test.ts`:

```ts
it("documents the optional PageSift backend contract", async () => {
  const [llms, skill, cliReference, operations] = await Promise.all([
    readProjectFile("llms.txt"),
    readProjectFile("skills/deepseek-crawl/SKILL.md"),
    readProjectFile("skills/deepseek-crawl/references/cli-reference.md"),
    readProjectFile("docs/operations.md"),
  ]);

  expect(llms).toContain("PageSift is not installed or managed");
  expect(skill).toContain("deepseek-crawl gateway install --advanced");
  expect(cliReference).toContain("--no-advanced");
  expect(cliReference).toContain("DEEPSEEK_GATEWAY_ADVANCED_URL");
  expect(cliReference).toContain("PAGESIFT_API_KEY");
  expect(operations).toContain("advanced_session_not_found");
});
```

- [ ] **Step 2: Run the assertion and confirm failure**

Run:

```bash
npm test -- test/unit/package.test.ts
```

Expected: FAIL until packaging documentation is updated.

- [ ] **Step 3: Update documentation**

Add a concise optional advanced section to both READMEs:

````markdown
### 可选 PageSift 高级后端

普通用户无需安装 PageSift。需要浏览器型高级 Scrape 和 Scrape 后 Interact 时，先自行
运行 PageSift，然后：

```bash
deepseek-crawl gateway install --advanced
```

网关默认连接 `http://127.0.0.1:3002`，不会安装、启动或停止 PageSift。
````

English equivalent:

````markdown
### Optional PageSift advanced backend

Normal users do not need PageSift. To enable browser-dependent advanced Scrape
and Post-Scrape Interact, run PageSift externally and then:

```bash
deepseek-crawl gateway install --advanced
```

The Gateway connects to `http://127.0.0.1:3002` by default. It never installs,
starts, or stops PageSift.
````

Operations docs must include:

- `--advanced`, `--advanced-url`, and install-only `--no-advanced`.
- `DEEPSEEK_GATEWAY_ADVANCED_URL`.
- `PAGESIFT_API_KEY` and `auth set pagesift`.
- `/healthz` plus `/v2/crawl/active` preflight.
- Compatibility is tested against PageSift `1.4.2`; runtime version pinning is
  not possible through the PageSift health endpoint.
- Supported action types and output formats.
- Interact `prompt` requires the PageSift operator to configure an
  OpenAI-compatible LLM; deterministic Interact action arrays do not.
- No object formats, `executeJavascript`, JSON, profiles, proxies, Parse,
  standalone Browser Sandbox, CDP, or Playwright code.
- `ps_` sessions, 10-minute TTL, restart loss, 1,000-session capacity.
- PageSift cluster gateways do not support kept sessions; advanced Scrape must
  target a standalone PageSift server with Chrome.
- 16 MiB response, four buffers, 64 MiB aggregate.
- `gateway stop` and `gateway uninstall` do not touch PageSift.
- Remote URL HTTPS and credential requirements.
- The `pagesift` npm native binding is not bundled or used.

Update `llms.txt` with:

```text
PageSift is not installed or managed by DeepSeek Crawl. An existing PageSift
service may be connected explicitly with `gateway install --advanced`; normal
installation must remain zero-dependency.
```

Add a `CHANGELOG.md` entry:

```markdown
### Added

- Add an opt-in PageSift advanced backend for browser-dependent Firecrawl
  Scrape and Scrape-bound Interact, with bounded `ps_` sessions and automatic
  fail-closed errors.
```

Add optional deployment variables:

```dotenv
# Optional PageSift advanced backend
DEEPSEEK_GATEWAY_ADVANCED_URL=
PAGESIFT_API_KEY=
```

Forward both variables through `docker-compose.yml`:

```yaml
DEEPSEEK_GATEWAY_ADVANCED_URL: ${DEEPSEEK_GATEWAY_ADVANCED_URL:-}
PAGESIFT_API_KEY: ${PAGESIFT_API_KEY:-}
```

Deployment documentation must state that a Docker-network URL such as
`http://pagesift:3002` is non-loopback and therefore requires an HTTPS endpoint.

- [ ] **Step 4: Run documentation/package tests**

Run:

```bash
npm run format:check
npm run lint
npm test -- test/unit/package.test.ts
npm run verify:package
git diff --check
```

Expected: PASS, including installed package CLI, Skill, and `llms.txt`.

- [ ] **Step 5: Run the full verification suite**

Run:

```bash
npm run verify
```

Expected:

- Formatting and lint pass.
- Source and test type checks pass.
- All offline Vitest tests pass.
- The package tarball installs successfully and exposes the Gateway.

- [ ] **Step 6: Commit**

```bash
git add README.md README.en.md docs/operations.md docs/operations.zh-CN.md \
  skills/deepseek-crawl/SKILL.md \
  skills/deepseek-crawl/references/cli-reference.md \
  llms.txt CHANGELOG.md .env.example docker-compose.yml test/unit/package.test.ts
git commit -m "docs: document optional PageSift backend"
```

---

## Review Gates

After each task:

1. Confirm the focused tests failed for the expected reason before implementation.
2. Confirm the focused tests and type checks pass after implementation.
3. Review the task diff for credential leaks and accidental default behavior.
4. Confirm the commit contains only that task's files.

Before final completion:

1. Confirm a fresh `gateway install` does not probe or mention PageSift as required.
2. Confirm advanced Scrape and Interact work through a fake PageSift server.
3. Confirm `no-fallback` never calls PageSift.
4. Confirm PageSift and Firecrawl credentials never cross backend boundaries.
5. Confirm `gateway status` reports disabled, reachable, and API-not-ready states.
6. Confirm package installation includes the updated Skill and `llms.txt`.
7. Run `git status --short` and verify only expected tracked changes remain.
