# DeepSeek Websearch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a dependency-light npm CLI and stdio MCP server for DeepSeek Search and Fetch.

**Architecture:** One TypeScript package exposes one executable with `search`, `fetch`, `doctor`, and `mcp` commands. CLI and MCP adapters share application services, a single DeepSeek HTTP client, bounded output formatting, and atomic CLI file output.

**Tech Stack:** Node.js 22, strict TypeScript/ESM, official MCP TypeScript SDK, Zod, Vitest, Biome, npm.

**Spec:** `docs/superpowers/specs/2026-11-13-deepseek-websearch-design.md`

## Global Constraints

- Node.js engine floor is `>=22.12.0`.
- Runtime dependencies are exactly `@modelcontextprotocol/sdk@1.32.2` and `zod@4.6.7`.
- The package and executable are both named `deepseek-websearch`.
- The package remains `private: true` and `UNLICENSED` until the owner chooses a license.
- Normal tests never call DeepSeek and never require `DEEPSEEK_API_KEY`.
- No provider abstraction, fallback policy, HTTP service, database, telemetry, or local MCP file writes.
- MCP tool names are exactly `deepseek_search` and `deepseek_fetch`.
- MCP stdout contains protocol data only; diagnostics use stderr.
- API key input is `DEEPSEEK_API_KEY` only.
- Search query length is 1 to 128 Unicode code points.
- Search count is 1 to 50.
- Fetch URL length is 1 to 8192 characters.
- Inline defaults are 4000 characters per Search content field and 30000 characters per Fetch body.
- Explicit content limit `0` means unlimited; limits above 1000000 are rejected.
- HTTP retries are limited to status 408, 429, 500, 502, 503, and 504.
- Network errors and local timeouts are not automatically retried.
- The project commits after every independently testable task.

---

### Task 1: Create the Node.js and TypeScript Skeleton

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `biome.json`
- Modify: `.gitignore`
- Create: `src/index.ts`
- Create: `src/version.ts`
- Create: `test/smoke.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: npm scripts `build`, `typecheck`, `test`, `lint`, `format`, `verify`, and a compileable ESM source tree.

**Step 1: Add the package and compiler configuration**

`package.json`:

```json
{
  "name": "deepseek-websearch",
  "version": "0.1.0",
  "description": "CLI and MCP tools for DeepSeek Search and Fetch",
  "type": "module",
  "private": true,
  "license": "UNLICENSED",
  "bin": {
    "deepseek-websearch": "dist/bin.js"
  },
  "exports": {
    ".": "./dist/index.js"
  },
  "files": [
    "dist",
    "README.md"
  ],
  "engines": {
    "node": ">=22.12.0"
  },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "pretest": "npm run build",
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "biome check .",
    "format": "biome check --write .",
    "format:check": "biome format .",
    "prepack": "npm run build",
    "verify": "npm run format:check && npm run lint && npm run typecheck && npm test && npm pack --dry-run"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "1.32.2",
    "zod": "4.6.7"
  },
  "devDependencies": {
    "@biomejs/biome": "2.6.7",
    "@types/node": "22.20.5",
    "typescript": "7.0.2",
    "vitest": "5.1.0"
  }
}
```

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ES2023"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "rootDir": "src",
    "outDir": "dist",
    "declaration": true,
    "sourceMap": true,
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "verbatimModuleSyntax": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["src/**/*.ts"]
}
```

`biome.json`:

```json
{
  "$schema": "https://biomejs.dev/schemas/2.6.7/schema.json",
  "formatter": {
    "enabled": true,
    "indentStyle": "space",
    "indentWidth": 2,
    "lineWidth": 100
  },
  "linter": {
    "enabled": true,
    "rules": {
      "recommended": true
    }
  },
  "files": {
    "includes": ["**", "!dist", "!coverage"]
  }
}
```

Append to `.gitignore`:

```text
.DS_Store
*.tgz
```

**Step 2: Write the failing smoke test**

`src/index.ts` starts as:

```ts
export const packageName = "deepseek-websearch";
```

`src/version.ts` starts as:

```ts
export const packageVersion = "0.1.0";
```

`test/smoke.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { packageName } from "../src/index.js";
import { packageVersion } from "../src/version.js";

describe("package", () => {
  it("uses the public package name", () => {
    expect(packageName).toBe("deepseek-websearch");
    expect(packageVersion).toBe("0.1.0");
  });
});
```

**Step 3: Install and verify the skeleton**

Run:

```bash
npm install
npm run typecheck
npm test
npm run build
```

Expected:

- One smoke test passes.
- `dist/index.js` and `dist/index.d.ts` exist.
- `npm install` creates and commits `package-lock.json`.

**Step 4: Commit**

```bash
git add package.json package-lock.json tsconfig.json biome.json .gitignore src test
git commit -m "build: scaffold TypeScript npm package"
```

---

### Task 2: Add Configuration and Stable Errors

**Files:**
- Create: `src/config.ts`
- Create: `src/deepseek/errors.ts`
- Create: `test/unit/config.test.ts`
- Create: `test/unit/errors.test.ts`

**Interfaces:**
- Consumes: Node environment variables.
- Produces:

```ts
export interface RuntimeConfig {
  apiKey: string;
  baseUrl: URL;
  timeoutMs: number;
  maxRetries: number;
}

export function loadConfig(env?: NodeJS.ProcessEnv): RuntimeConfig;

export type DeepSeekErrorKind =
  | "config"
  | "invalid_request"
  | "auth"
  | "balance"
  | "forbidden"
  | "not_found"
  | "rate_limit"
  | "server"
  | "network"
  | "timeout"
  | "cancelled"
  | "invalid_response";

export class DeepSeekError extends Error {
  readonly kind: DeepSeekErrorKind;
  readonly status?: number;
  readonly requestId?: string;
  constructor(
    message: string,
    options: {
      kind: DeepSeekErrorKind;
      status?: number;
      requestId?: string;
      cause?: unknown;
    },
  );
}
```

**Step 1: Write failing config tests**

`test/unit/config.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";

describe("loadConfig", () => {
  it("uses defaults", () => {
    const config = loadConfig({ DEEPSEEK_API_KEY: "test-key" });
    expect(config.baseUrl.href).toBe("https://api.deepseek.com/");
    expect(config.timeoutMs).toBe(60000);
    expect(config.maxRetries).toBe(2);
  });

  it("allows HTTP only for loopback", () => {
    expect(() =>
      loadConfig({
        DEEPSEEK_API_KEY: "test-key",
        DEEPSEEK_BASE_URL: "http://127.0.0.1:8080",
      }),
    ).not.toThrow();

    expect(() =>
      loadConfig({
        DEEPSEEK_API_KEY: "test-key",
        DEEPSEEK_BASE_URL: "http://example.com",
      }),
    ).toThrow(/HTTPS/);
  });

  it.each([
    [{}, /DEEPSEEK_API_KEY/],
    [{ DEEPSEEK_API_KEY: "a\nb" }, /newline/],
    [{ DEEPSEEK_API_KEY: "key", DEEPSEEK_TIMEOUT_MS: "999" }, /timeout/i],
    [{ DEEPSEEK_API_KEY: "key", DEEPSEEK_MAX_RETRIES: "6" }, /retries/i],
  ])("rejects invalid environment %#", (env, message) => {
    expect(() => loadConfig(env)).toThrow(message);
  });
});
```

**Step 2: Write failing error tests**

`test/unit/errors.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { DeepSeekError } from "../../src/deepseek/errors.js";

describe("DeepSeekError", () => {
  it("retains stable metadata", () => {
    const error = new DeepSeekError("rate limited", {
      kind: "rate_limit",
      status: 429,
      requestId: "req-1",
    });
    expect(error.name).toBe("DeepSeekError");
    expect(error.kind).toBe("rate_limit");
    expect(error.status).toBe(429);
    expect(error.requestId).toBe("req-1");
  });
});
```

**Step 3: Run tests and verify failure**

Run: `npm test -- test/unit/config.test.ts test/unit/errors.test.ts`

Expected: FAIL because `src/config.ts` and `src/deepseek/errors.ts` do not exist.

**Step 4: Implement configuration**

`src/config.ts` must:

- Require a trimmed, nonempty, single-line API key.
- Parse the base URL and reject credentials, non-HTTP(S), and non-loopback HTTP.
- Parse integer timeout and retry overrides.
- Normalize loopback hosts `localhost`, `127.0.0.0/8`, and `::1`.
- Return a URL ending with `/`.

`src/deepseek/errors.ts` must implement the exact class from the interface block, set `name = "DeepSeekError"`, preserve `cause`, and set optional properties only when present.

**Step 5: Run tests**

Run: `npm test -- test/unit/config.test.ts test/unit/errors.test.ts`

Expected: PASS.

**Step 6: Commit**

```bash
git add src/config.ts src/deepseek/errors.ts test/unit
git commit -m "feat: validate runtime configuration"
```

---

### Task 3: Define API and Application Types

**Files:**
- Create: `src/deepseek/schemas.ts`
- Create: `src/types.ts`
- Create: `test/unit/schemas.test.ts`

**Interfaces:**
- Consumes: Zod and `node:net` IP validation.
- Produces:

```ts
export const searchInputSchema: z.ZodType<SearchInput>;
export const fetchInputSchema: z.ZodType<FetchInput>;
export const searchResponseSchema: z.ZodType<RawSearchResponse>;
export const fetchResponseSchema: z.ZodType<RawFetchResponse>;

export interface SearchInput {
  query: string;
  count: number;
  ori_question?: string | null;
  localization?: string;
  need_content: boolean;
}

export interface FetchInput {
  url: string;
}
```

Application result types in `src/types.ts`:

```ts
export interface SearchResultItem extends Record<string, unknown> {
  title: string;
  url: string;
  snippet: string;
  summary: string;
  content: string;
  content_truncated?: boolean;
  content_original_length?: number;
}

export interface SearchOutput {
  results: SearchResultItem[];
  truncation?: {
    content_limit: number;
    truncated_results: number;
  };
}

export interface FetchOutput extends Record<string, unknown> {
  title: string;
  url: string;
  content: string;
  truncated?: boolean;
  original_length?: number;
}
```

**Step 1: Write failing schema tests**

`test/unit/schemas.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { fetchInputSchema, searchInputSchema } from "../../src/deepseek/schemas.js";

describe("searchInputSchema", () => {
  it("applies defaults", () => {
    expect(searchInputSchema.parse({ query: "hello" })).toEqual({
      query: "hello",
      count: 10,
      need_content: false,
    });
  });

  it.each([
    {},
    { query: " " },
    { query: "x".repeat(129) },
    { query: "x", count: 0 },
    { query: "x", count: 51 },
    { query: "x", count: 1.5 },
    { query: "x", localization: "not-an-ip" },
  ])("rejects invalid input %#", (input) => {
    expect(() => searchInputSchema.parse(input)).toThrow();
  });

  it("accepts IPv4 and IPv6 localization", () => {
    expect(searchInputSchema.parse({ query: "x", localization: "203.0.113.7" }).localization).toBe(
      "203.0.113.7",
    );
    expect(searchInputSchema.parse({ query: "x", localization: "2001:db8::1" }).localization).toBe(
      "2001:db8::1",
    );
  });
});

describe("fetchInputSchema", () => {
  it.each(["file:///etc/passwd", "https://user:pass@example.com", "not a url"])(
    "rejects %s",
    (url) => {
      expect(() => fetchInputSchema.parse({ url })).toThrow();
    },
  );

  it("accepts an HTTP URL", () => {
    expect(fetchInputSchema.parse({ url: "https://example.com/a?b=1" }).url).toBe(
      "https://example.com/a?b=1",
    );
  });
});
```

**Step 2: Run tests and verify failure**

Run: `npm test -- test/unit/schemas.test.ts`

Expected: FAIL because the schema module is missing.

**Step 3: Implement schemas and types**

Use `[...value].length` for Unicode code-point length. Use `isIP` from `node:net` for localization. Use `z.looseObject()` on response result objects to preserve unknown upstream fields. The fetch URL refinement must check protocol, hostname, username, password, and string length.

**Step 4: Run tests**

Run: `npm test -- test/unit/schemas.test.ts`

Expected: PASS.

**Step 5: Commit**

```bash
git add src/deepseek/schemas.ts src/types.ts test/unit/schemas.test.ts
git commit -m "feat: define DeepSeek request schemas"
```

---

### Task 4: Implement Bounded Output and Atomic Files

**Files:**
- Create: `src/output/bounds.ts`
- Create: `src/output/files.ts`
- Create: `test/unit/bounds.test.ts`
- Create: `test/unit/files.test.ts`

**Interfaces:**
- Consumes: `SearchOutput`, `FetchOutput`.
- Produces:

```ts
export interface TextBound {
  value: string;
  truncated: boolean;
  originalLength: number;
}

export function truncateText(value: string, limit: number): TextBound;

export function boundSearchOutput(
  output: SearchOutput,
  maxContentChars: number,
): SearchOutput;

export function boundFetchOutput(output: FetchOutput, maxChars: number): FetchOutput;

export async function writeFileAtomic(
  outputPath: string,
  content: string,
): Promise<void>;
```

**Step 1: Write failing truncation tests**

`test/unit/bounds.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { boundFetchOutput, truncateText } from "../../src/output/bounds.js";

describe("truncateText", () => {
  it("does not split Unicode code points", () => {
    expect(truncateText("A😀B", 2)).toEqual({
      value: "A😀",
      truncated: true,
      originalLength: 3,
    });
  });

  it("treats zero as unlimited", () => {
    expect(truncateText("hello", 0)).toEqual({
      value: "hello",
      truncated: false,
      originalLength: 5,
    });
  });
});

describe("boundFetchOutput", () => {
  it("adds truncation metadata", () => {
    expect(
      boundFetchOutput({ title: "T", url: "https://example.com", content: "123456" }, 4),
    ).toEqual({
      title: "T",
      url: "https://example.com",
      content: "1234",
      truncated: true,
      original_length: 6,
    });
  });
});
```

**Step 2: Write failing atomic file tests**

`test/unit/files.test.ts`:

```ts
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { writeFileAtomic } from "../../src/output/files.js";

describe("writeFileAtomic", () => {
  it("creates parents and leaves no temporary file", async () => {
    const root = await mkdtemp(join(tmpdir(), "deepseek-websearch-"));
    const path = join(root, "nested", "result.md");
    await writeFileAtomic(path, "# Result\n");
    expect(await readFile(path, "utf8")).toBe("# Result\n");
    expect(await readdir(join(root, "nested"))).toEqual(["result.md"]);
  });
});
```

**Step 3: Run tests and verify failure**

Run: `npm test -- test/unit/bounds.test.ts test/unit/files.test.ts`

Expected: FAIL because the output modules do not exist.

**Step 4: Implement output modules**

- `truncateText` uses `Array.from(value)` for code-point counting.
- Limit `0` disables truncation.
- `boundSearchOutput` truncates each non-empty `content`, adds per-result metadata, and adds top-level truncation metadata only when at least one field changed.
- Preserve all unknown fields.
- `writeFileAtomic` creates parent directories, writes to `<target>.<random>.tmp` in the same directory, renames atomically, and removes the temporary file on failure.

**Step 5: Run tests**

Run: `npm test -- test/unit/bounds.test.ts test/unit/files.test.ts`

Expected: PASS.

**Step 6: Commit**

```bash
git add src/output test/unit/bounds.test.ts test/unit/files.test.ts
git commit -m "feat: bound output and write files atomically"
```

---

### Task 5: Implement the DeepSeek HTTP Client

**Files:**
- Create: `src/deepseek/client.ts`
- Create: `test/unit/client.test.ts`

**Interfaces:**
- Consumes: `RuntimeConfig`, Zod response schemas, `DeepSeekError`.
- Produces:

```ts
export interface DeepSeekClientOptions {
  apiKey: string;
  baseUrl: URL;
  timeoutMs: number;
  maxRetries: number;
  fetchImpl?: typeof fetch;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
}

export class DeepSeekClient {
  constructor(options: DeepSeekClientOptions);
  search(input: SearchInput, signal?: AbortSignal): Promise<RawSearchResponse>;
  fetch(input: FetchInput, signal?: AbortSignal): Promise<RawFetchResponse>;
}
```

**Step 1: Write failing request tests**

`test/unit/client.test.ts` must contain tests for:

```ts
it("posts search input and parses the response");
it("posts fetch input and parses the response");
it("redirects disabled");
it("retries exactly 408, 429, 500, 502, 503, and 504");
it("does not retry 400, 401, 402, 403, 404, or 413");
it("honors Retry-After seconds and caps it at 5000 ms");
it("does not retry caller cancellation");
it("does not retry local timeout");
it("rejects malformed JSON and schema-invalid success bodies");
it("never includes request bodies in errors");
```

Use a mock `fetchImpl` that returns `Response.json(...)`. Inject:

```ts
const delays: number[] = [];
const client = new DeepSeekClient({
  apiKey: "test-key",
  baseUrl: new URL("https://api.deepseek.com/"),
  timeoutMs: 60000,
  maxRetries: 2,
  fetchImpl,
  sleep: async (milliseconds) => {
    delays.push(milliseconds);
  },
  random: () => 0,
});
```

**Step 2: Run test and verify failure**

Run: `npm test -- test/unit/client.test.ts`

Expected: FAIL because `DeepSeekClient` does not exist.

**Step 3: Implement request, retry, and error mapping**

Implementation requirements:

- Build endpoint with `new URL(\`v1/tools/${operation}\`, baseUrl)`.
- Send headers exactly as specified in the design.
- Pass `redirect: "error"`.
- Combine caller signal and a per-attempt timeout with `AbortSignal.any`.
- Clear each timeout in `finally`.
- Parse safe `x-request-id`.
- Parse only short `error.message` from failed responses.
- Map statuses to the exact `DeepSeekErrorKind`.
- Retry only 408, 429, 500, 502, 503, and 504.
- Retry delays for non-429 failures are `250ms` and `750ms`, doubled when `random()` is zero and halved when it is one.
- For 429, use `Retry-After` seconds or an HTTP date when present; cap at 5000 ms; otherwise use the bounded retry delay.
- Do not retry network errors, local timeouts, or caller cancellation.
- Validate successful JSON with `searchResponseSchema` or `fetchResponseSchema`.

**Step 4: Run tests**

Run: `npm test -- test/unit/client.test.ts`

Expected: PASS.

**Step 5: Commit**

```bash
git add src/deepseek/client.ts test/unit/client.test.ts
git commit -m "feat: add resilient DeepSeek client"
```

---

### Task 6: Add Search and Fetch Application Services

**Files:**
- Create: `src/application/search.ts`
- Create: `src/application/fetch.ts`
- Create: `src/output/format.ts`
- Create: `test/unit/application.test.ts`
- Create: `test/unit/format.test.ts`

**Interfaces:**
- Consumes: `DeepSeekClient`, input schemas, output bounds.
- Produces:

```ts
export async function executeSearch(
  client: DeepSeekClient,
  input: unknown,
  options: { maxContentChars: number },
  signal?: AbortSignal,
): Promise<SearchOutput>;

export async function executeFetch(
  client: DeepSeekClient,
  input: unknown,
  options: { maxChars: number },
  signal?: AbortSignal,
): Promise<FetchOutput>;

export function formatSearchHuman(output: SearchOutput): string;
export function formatFetchHuman(output: FetchOutput): string;
```

**Step 1: Write failing application tests**

`test/unit/application.test.ts`:

```ts
it("validates search input before calling the client");
it("preserves unknown response fields");
it("bounds search content using maxContentChars");
it("returns empty search results without error");
it("validates fetch input before calling the client");
it("adds the fetched source URL to the result");
it("bounds fetch content using maxChars");
```

Use a fake object with the same methods as `DeepSeekClient` to avoid HTTP.

**Step 2: Write failing formatter tests**

Assert that:

- Search Markdown includes rank, title, URL, summary, and a content truncation marker.
- Fetch Markdown includes title, source URL, and body.
- `null` dates do not print `null`.

**Step 3: Run tests and verify failure**

Run: `npm test -- test/unit/application.test.ts test/unit/format.test.ts`

Expected: FAIL because application and formatting modules are missing.

**Step 4: Implement services and formatting**

- `executeSearch` parses with `searchInputSchema`, calls `client.search`, then applies `boundSearchOutput`.
- `executeFetch` parses with `fetchInputSchema`, calls `client.fetch`, then adds the validated URL and applies `boundFetchOutput`.
- Human formatting is plain Markdown with no ANSI escapes.
- Search human output omits null fields.
- Truncated content includes a visible marker with original length.

**Step 5: Run tests**

Run: `npm test -- test/unit/application.test.ts test/unit/format.test.ts`

Expected: PASS.

**Step 6: Commit**

```bash
git add src/application src/output/format.ts test/unit/application.test.ts test/unit/format.test.ts
git commit -m "feat: add search and fetch services"
```

---

### Task 7: Implement the CLI

**Files:**
- Create: `src/cli/parse.ts`
- Create: `src/cli/run.ts`
- Create: `src/cli/doctor.ts`
- Create: `test/unit/cli-parse.test.ts`
- Create: `test/unit/cli-run.test.ts`
- Create: `src/bin.ts`
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: application services, format functions, atomic file writer, `loadConfig`.
- Produces:

```ts
export interface CliDependencies {
  env: NodeJS.ProcessEnv;
  fetchImpl: typeof fetch;
  stdout: Pick<NodeJS.WriteStream, "write">;
  stderr: Pick<NodeJS.WriteStream, "write">;
}

export async function runCli(
  argv: string[],
  dependencies?: Partial<CliDependencies>,
): Promise<number>;
```

CLI behavior must be:

```text
deepseek-websearch search <query> [--count N] [--content]
  [--max-content-chars N] [--ori-question TEXT]
  [--localization IP] [--json] [--output PATH]

deepseek-websearch fetch <url> [--max-chars N] [--json] [--output PATH]
deepseek-websearch doctor [--live] [--json]
```

Task 8 adds the `mcp` command.

**Step 1: Write failing parser tests**

Cover:

- Numeric conversions.
- Default values.
- Missing positional errors.
- Unknown flags.
- `--help` and `--version`.
- Zero content limits as valid.
- Negative limits as invalid.

**Step 2: Write failing CLI behavior tests**

Cover:

- Search human output.
- Search `--json`.
- Search `--output` writes complete JSON and does not truncate the file.
- Fetch default Markdown.
- Fetch `--json`.
- Fetch `--output` writes complete Markdown.
- API error goes to stderr and exits `1`.
- Usage error goes to stderr and exits `2`.
- Missing key goes to stderr without printing any existing key.
- Doctor default performs no billable POST.
- Doctor `--live` calls Search with `count: 1`.

**Step 3: Run tests and verify failure**

Run: `npm test -- test/unit/cli-parse.test.ts test/unit/cli-run.test.ts`

Expected: FAIL because CLI modules do not exist.

**Step 4: Implement CLI and entry point**

`src/bin.ts` begins with:

```ts
#!/usr/bin/env node

import { runCli } from "./cli/run.js";

process.exitCode = await runCli(process.argv.slice(2));
```

Implementation requirements:

- Use `node:util` `parseArgs`; add no CLI dependency.
- Keep all errors on stderr and success content on stdout.
- Search `--json` and `--output` use normalized `SearchOutput`.
- Fetch default output and `--output` use Markdown.
- Fetch `--json` uses normalized `FetchOutput`.
- Doctor connectivity uses an unauthenticated GET to the base URL and accepts any HTTP status as connectivity.
- Doctor default never sends `DEEPSEEK_API_KEY` in a request.
- Doctor `--live` writes a billable-warning line to stderr before request execution.
- Task 8 extends the parser and dispatch with the `mcp` command.

**Step 5: Run tests and build**

Run:

```bash
npm test -- test/unit/cli-parse.test.ts test/unit/cli-run.test.ts
npm run build
node dist/bin.js --help
```

Expected: tests pass and help exits successfully.

**Step 6: Commit**

```bash
git add src/bin.ts src/cli src/index.ts test/unit/cli-parse.test.ts test/unit/cli-run.test.ts
git commit -m "feat: add command line interface"
```

---

### Task 8: Implement MCP over stdio

**Files:**
- Create: `src/mcp/server.ts`
- Create: `test/unit/mcp.test.ts`
- Modify: `src/cli/parse.ts`
- Modify: `src/cli/run.ts`

**Interfaces:**
- Consumes: `DeepSeekClient`, application services, Zod input schemas, formatting.
- Produces:

```ts
export interface McpServerOptions {
  client: DeepSeekClient;
}

export function createMcpServer(options: McpServerOptions): McpServer;
export async function runMcpServer(options: McpServerOptions): Promise<void>;
```

**Step 1: Write failing MCP tests**

Use the official SDK in-memory transport:

```ts
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await server.connect(serverTransport);
await client.connect(clientTransport);
```

Tests cover:

- Tool discovery lists exactly `deepseek_search` and `deepseek_fetch`.
- Both tools expose output schemas and read-only annotations.
- CLI help lists `mcp`.
- `deepseek-websearch mcp` dispatches to the stdio server.
- `deepseek_search` forwards `need_content` but does not forward `max_content_chars`.
- Search defaults `max_content_chars` to 4000.
- Search response includes Markdown `content` and structured data.
- `deepseek_fetch` defaults `max_chars` to 30000.
- Invalid input is a tool error and makes no client call.
- API failures return `isError: true`.
- Server instructions identify web content as untrusted.
- No tool writes to the local filesystem.

**Step 2: Run test and verify failure**

Run: `npm test -- test/unit/mcp.test.ts`

Expected: FAIL because the MCP server module is missing.

**Step 3: Implement MCP server**

Implementation requirements:

- Use `McpServer` and `StdioServerTransport` from `@modelcontextprotocol/sdk`.
- Register the exact tool names and descriptions from the design.
- Set `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`, and `openWorldHint: true`.
- Use `looseObject` output schemas.
- Do not expose secrets, local paths, or stack traces.
- In stdio mode, never write protocol output to stderr and never write logs to stdout.

**Step 4: Run tests**

Run: `npm test -- test/unit/mcp.test.ts`

Expected: PASS.

**Step 5: Commit**

```bash
git add src/mcp/server.ts src/cli/parse.ts src/cli/run.ts test/unit/mcp.test.ts
git commit -m "feat: expose DeepSeek tools over MCP"
```

---

### Task 9: Add Package Documentation, Live Smoke, and CI

**Files:**
- Modify: `README.md`
- Create: `scripts/live-smoke.mjs`
- Create: `.github/workflows/ci.yml`
- Create: `test/fixtures/search-success.json`
- Create: `test/fixtures/fetch-success.json`
- Modify: `package.json`

**Interfaces:**
- Consumes: built `dist/bin.js`.
- Produces: user installation instructions, opt-in billable smoke test, and automated offline CI.

**Step 1: Add live smoke**

`scripts/live-smoke.mjs` must:

- Exit before serving or building if `DEEPSEEK_API_KEY` is absent.
- Print a billable-request warning.
- Spawn `node dist/bin.js doctor --live --json`.
- Fail on nonzero exit.
- Never print the API key or full environment.

Add:

```json
"test:live": "npm run build && node scripts/live-smoke.mjs"
```

**Step 2: Add CI**

`.github/workflows/ci.yml` runs on pull requests and `main`:

- `actions/checkout`
- `actions/setup-node` with Node 22 and npm cache
- `npm ci`
- `npm run verify`

The workflow must not reference `DEEPSEEK_API_KEY` and must not run `test:live`.

**Step 3: Update README**

Document:

- What the tool does and does not do.
- DeepSeek API pricing link and per-successful-request billing warning.
- `npx` examples.
- Global installation example.
- Codex, Claude Desktop, and generic MCP configuration examples with paths represented as placeholders.
- The exact MCP environment variable.
- Human, JSON, and `--output` examples.
- `doctor` and `doctor --live` distinction.
- Data sent to DeepSeek and the absence of telemetry.
- Node 22 requirement.

**Step 4: Commit**

```bash
git add README.md package.json scripts .github test/fixtures
git commit -m "docs: add package usage and CI"
```

---

### Task 10: Complete End-to-End Verification

**Files:**
- Modify: `src/cli/run.ts`
- Create: `test/unit/package.test.ts`
- Create: `test/integration/mcp-stdio.test.ts`

**Interfaces:**
- Consumes: all previous modules.
- Produces: verified package artifact and executable behavior.

**Step 1: Add the package version test**

Create `test/unit/package.test.ts` that runs:

```ts
const result = spawnSync(process.execPath, ["dist/bin.js", "--version"], {
  encoding: "utf8",
});
expect(result.status).toBe(0);
expect(result.stdout.trim()).toBe("0.1.0");
```

Run: `npm run build && npm test -- test/unit/package.test.ts`

Expected: PASS because Task 7 uses `packageVersion`.

**Step 2: Add the stdio integration test**

The test spawns:

```ts
spawn(process.execPath, ["dist/bin.js", "mcp"], {
  env: {
    ...process.env,
    DEEPSEEK_API_KEY: "offline-test-key",
    DEEPSEEK_BASE_URL: mockServer.url,
  },
  stdio: ["pipe", "pipe", "pipe"],
});
```

Connect with `StdioClientTransport`, list tools, and verify both tools. The mock server returns the fixture responses.

**Step 3: Run the full offline verification**

Run:

```bash
npm run verify
```

Expected:

- Formatting passes.
- Lint passes.
- Type checking passes.
- All offline tests pass.
- Build succeeds.
- `npm pack --dry-run` includes `dist` and README, and no source tests, secrets, lockfile copies, or generated state.

**Step 4: Run package-level CLI smoke tests**

Run:

```bash
node dist/bin.js --version
node dist/bin.js --help
env -u DEEPSEEK_API_KEY node dist/bin.js search "DeepSeek" --count 1 --json
```

Expected:

- Version is `0.1.0`.
- Help lists all four commands.
- Without `DEEPSEEK_API_KEY`, Search exits `1`, prints an actionable stderr message, and prints no secret.

**Step 5: Commit**

```bash
git add src/cli/run.ts test/unit/package.test.ts test/integration/mcp-stdio.test.ts
git commit -m "test: verify CLI and MCP package"
```

---

## Plan Self-Review

- Every design section has an implementation task.
- Runtime dependencies are pinned and limited to the MCP SDK and Zod.
- CLI and MCP share application services.
- No normal test or CI path makes a billable request.
- The implementation keeps DeepSeek as the only provider.
- MCP remains read-only and context-bounded.
- File writes are explicit CLI-only behavior.
- Error, timeout, cancellation, and retry behavior has dedicated tests.
- Release publication remains blocked by `private: true` and `UNLICENSED`.
