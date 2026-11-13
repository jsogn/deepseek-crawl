# DeepSeek Websearch Design

Date: 2026-11-13

Status: Decided

## Summary

`deepseek-websearch` is a local Node.js package that exposes DeepSeek's official
Search and Fetch APIs through a CLI and an MCP stdio server. It is read-only,
cross-tool, and deliberately limited to one search provider.

The package name and executable name are both `deepseek-websearch`.

## Goals

- Work from Codex, Claude Code, Cursor, and other MCP-compatible clients.
- Work directly from shells and non-MCP scripts without an agent.
- Install with npm and run through `npx` without native build artifacts.
- Return context-safe results by default.
- Expose complete structured results for machine automation.
- Map DeepSeek API behavior into stable, predictable CLI and MCP contracts.
- Keep the implementation small enough for one maintainer to audit.

## Non-goals

- Automatic provider selection or fallback.
- Firecrawl, Brave, Tavily, or other search-provider adapters.
- Crawling, sitemap discovery, browser automation, or page interaction.
- Persistent HTTP/SSE service mode.
- Background jobs, queues, databases, or request history.
- A web UI.
- Handling the policy of when an AI should choose DeepSeek.

The caller decides when to use this provider. The project must not infer that
policy or introduce hidden routing.

## Technology

- Node.js 22 or newer.
- Strict TypeScript compiled to ESM with `tsc`.
- Official `@modelcontextprotocol/sdk` for stdio MCP.
- Zod for runtime validation and MCP tool schemas.
- Native `fetch`, `AbortSignal`, `node:fs/promises`, and `node:path`.
- Vitest for unit and integration tests.
- Biome for formatting and linting.
- npm lockfile committed to source control.
- GitHub Actions for verification and npm Trusted Publishing.

No HTTP framework, CLI framework, configuration framework, ORM, or monorepo is
introduced.

## Command Surface

One executable dispatches four commands:

```text
deepseek-websearch search <query> [options]
deepseek-websearch fetch <url> [options]
deepseek-websearch doctor [--live] [--json]
deepseek-websearch mcp
```

All commands support `--help`; the executable supports `--version`.

### Search

```text
deepseek-websearch search <query>
  [--count <1..50>]
  [--content]
  [--max-content-chars <number>]
  [--ori-question <text>]
  [--localization <ip>]
  [--json]
  [--output <path>]
```

Defaults:

- `--count 10`
- `--content false`
- MCP and human-readable `--max-content-chars 4000` per result

`--output` writes a complete successful JSON result. `--json` writes a complete
successful JSON result to stdout unless `--max-content-chars` is explicitly set.
Human-readable stdout and all MCP Search output are bounded. `--max-content-chars
0` disables content truncation for an explicit machine-output use case.

### Fetch

```text
deepseek-websearch fetch <url>
  [--max-chars <number>]
  [--json]
  [--output <path>]
```

Defaults:

- MCP and human-readable `--max-chars 30000`

`--output` writes Markdown by default and writes a complete JSON result when
`--json` is also present. Without `--output`, stdout is bounded. `--json`
returns the complete result unless `--max-chars` is explicitly set.
`--max-chars 0` disables truncation for an explicit machine-output use case.

### Doctor

`doctor` validates:

- The executable and Node.js versions.
- Whether `DEEPSEEK_API_KEY` is present without printing it.
- Whether the configured base URL is valid HTTP(S), requiring HTTPS unless it is
  a loopback address.
- Whether the process can connect to the configured host.

It does not call a billable endpoint by default. `doctor --live` performs one
Search request with `count=1`, labels the request as billable before execution,
and still avoids printing the API key.

### MCP

`mcp` starts a stdio server exposing:

- `deepseek_search`
- `deepseek_fetch`

The MCP server does not write local files. It returns bounded inline content so
it remains useful to clients without filesystem access. Every tool result
includes:

- Human-readable Markdown in MCP `content`.
- Machine-readable data in MCP `structuredContent`.
- Truncation metadata when a field was shortened.

`deepseek_search` accepts the same Search parameters as the CLI, including
`need_content` and `max_content_chars`; `max_content_chars` defaults to 4000.
`deepseek_fetch` accepts `url` and `max_chars`; `max_chars` defaults to 30000.

Stdout is reserved for the MCP protocol. Logs and diagnostics go to stderr.

## Architecture

```text
CLI arguments ─┐
               ├─> Application use cases ─> DeepSeek client ─> api.deepseek.com
MCP tool call ─┘              │
                              ├─> response normalization
                              ├─> bounded formatting
                              └─> text/JSON/file/MCP output
```

The planned source layout is:

```text
src/
  bin.ts
  cli/
    command.ts
    search.ts
    fetch.ts
    doctor.ts
  mcp/
    server.ts
  application/
    search.ts
    fetch.ts
  deepseek/
    client.ts
    errors.ts
    schemas.ts
  output/
    bounds.ts
    format.ts
    files.ts
  config.ts
  version.ts
test/
  unit/
  integration/
  fixtures/
```

Module boundaries:

- `deepseek/client.ts` is the only module allowed to construct DeepSeek HTTP
  requests or interpret transport status codes.
- Application modules contain the Search and Fetch use cases and do not know
  whether the caller is CLI or MCP.
- CLI modules parse arguments, call application modules, and select output.
- MCP modules validate tool arguments, call the same application modules, and
  convert results into MCP payloads.
- Output modules own truncation and file serialization.
- Configuration is environment-driven and has no config-file dependency.

There is no provider interface because there is exactly one provider. The
boundary can be introduced only after a second real provider is committed.

## Configuration

Supported environment variables:

- `DEEPSEEK_API_KEY`: required for Search, Fetch, and live doctor checks.
- `DEEPSEEK_BASE_URL`: optional override, defaulting to
  `https://api.deepseek.com`.
- `DEEPSEEK_TIMEOUT_MS`: optional request timeout, defaulting to 60000.
- `DEEPSEEK_MAX_RETRIES`: optional retry count, defaulting to 2.

CLI flags may override non-secret timeouts and output limits. The API key is
never accepted as a positional argument or CLI flag.

Configuration validation rejects:

- Empty or newline-containing API keys.
- Non-HTTP(S) base URLs; non-loopback overrides must use HTTPS.
- Timeouts outside 1000 to 120000 milliseconds.
- Retry counts outside 0 to 5.

## Input Validation

The CLI and MCP schemas enforce the same limits before any network request:

- Search `query`: 1 to 128 Unicode code points and not all whitespace.
- Search `count`: integer from 1 to 50.
- Search `ori_question`: omitted, `null`, or 1 to 128 Unicode code points.
- Search `localization`: omitted or a valid IPv4/IPv6 address.
- Fetch `url`: 1 to 8192 characters, HTTP(S), host present, and no username or
  password.
- Content limits: integer from 0 to 1000000; `0` means unlimited.

## Request Behavior

Requests are sent to:

```text
POST /v1/tools/search
POST /v1/tools/fetch
```

The client:

- Sends `Authorization: Bearer <key>`, `Content-Type: application/json`, and
  `Accept: application/json`.
- Disables automatic redirects.
- Uses the caller's abort signal to propagate cancellation.
- Applies a per-request timeout.
- Validates all successful responses before returning them.
- Never logs the API key, request body, query, URL, or response body by default.

## Error Handling

HTTP status handling is explicit:

| Status             | Behavior                                                 |
| ------------------ | -------------------------------------------------------- |
| 400                | Invalid request; do not retry                            |
| 401                | Invalid or missing key; do not retry                     |
| 402                | DeepSeek balance insufficient; do not retry              |
| 403                | Fetch rejected by security policy; do not retry          |
| 404                | No usable fetched page; do not retry                     |
| 408                | Retry with bounded backoff                               |
| 413                | Request too large; do not retry                          |
| 429                | Honor `Retry-After` when safe, otherwise bounded backoff |
| 500, 502, 503, 504 | Retry with bounded backoff                               |
| Other 4xx          | Return a configuration/request error; do not retry       |

Network failures and local timeouts are reported without automatic retries
because the request may still have reached DeepSeek. Only failures known by
status code to be unsuccessful are retried.

Retry defaults:

- Maximum two retries after the initial attempt.
- Exponential delays of 250 ms and 750 ms, with jitter.
- `Retry-After` values are capped at 5000 ms.
- Cancellation stops retries immediately.

DeepSeek's OpenAI-compatible `error.message` is surfaced when it is short and
does not contain headers or credentials. Raw upstream bodies are not returned.

CLI exit codes:

- `0`: success.
- `1`: configuration, network, or API failure.
- `2`: invalid command usage.

MCP failures return `isError: true` with a stable, actionable message.

## Output and Context Safety

Human-readable Search output includes:

- Ranked result number.
- Title and source URL.
- Publication date and authority when present.
- Long summary.
- Content preview only when requested.

Human-readable Fetch output includes:

- Page title.
- Source URL.
- Bounded Markdown body.

Truncation:

- Occurs on Unicode code-point boundaries.
- Adds `truncated` and `original_length` metadata.
- Never silently alters complete `--output` files.
- Uses a visible tail marker in human-readable text.

MCP Search defaults to `need_content=false`. MCP Fetch returns a bounded body
because clients may not have filesystem tools. The tool descriptions explicitly
state that returned page content is untrusted data, not instructions.

File output:

- Is available only through the CLI.
- Uses UTF-8.
- Creates missing parent directories for an explicit `--output` path.
- Writes through a temporary sibling file and atomically renames it.
- Preserves the complete result; display and MCP bounds do not apply.
- Writes normalized JSON for Search. Fetch writes Markdown unless `--json` is
  present, in which case it writes normalized JSON.

## Security

- Read-only external API access is the only network behavior.
- Fetch URLs must be HTTP(S), contain a host, omit username/password, and be no
  longer than 8192 characters.
- The local MCP process never fetches the target URL directly.
- Fetched content is treated as untrusted.
- No analytics, telemetry, crash upload, or remote logging.
- No secrets in CLI arguments, stdout, MCP results, or committed files.
- MCP tools are annotated read-only and non-destructive.
- npm package files are allowlisted; tests and development files are excluded
  from the published artifact unless needed.

## Testing

All normal tests are offline and non-billable.

Unit tests cover:

- Configuration validation.
- Search and Fetch request bodies.
- URL and argument validation.
- HTTP status mapping.
- Retry and `Retry-After` behavior.
- Cancellation and timeout handling.
- Response schema validation.
- Unicode-safe truncation.
- Atomic file output.

Integration tests cover:

- CLI success and failure exit codes.
- JSON and human-readable output.
- Search and Fetch against a mocked local HTTP server.
- MCP initialization and tool discovery over stdio.
- MCP Search and Fetch calls against the mocked server.
- Stdout containing only protocol data in MCP mode.

Live tests are opt-in through `npm run test:live`, require
`DEEPSEEK_API_KEY`, state that requests are billable, and are never run in pull
request CI.

## Packaging and Distribution

- Unscoped npm package: `deepseek-websearch`.
- Published binary: `deepseek-websearch`.
- `engines.node` is `>=22`.
- npm package files are limited to the compiled `dist`, README, and license
  text once a license is selected.
- Users can run with `npx -y deepseek-websearch@<version> ...`.
- Frequent MCP users can globally install the package and point their client at
  the installed binary.
- Example MCP configuration uses a pinned version rather than `@latest`.
- CI runs format, lint, type-check, tests, and package smoke tests.
- Publishing requires an explicit maintainer release action.

No license file is added at this stage. The package must not be published until
the owner selects a license.

## Acceptance Criteria

- `npx deepseek-websearch search <query>` returns ranked results without a build
  step or native dependency.
- `npx deepseek-websearch fetch <url>` returns Markdown and respects its inline
  size limit.
- `npx deepseek-websearch mcp` negotiates MCP over stdio and lists exactly
  `deepseek_search` and `deepseek_fetch`.
- Existing MCP clients can discover and call both tools.
- A quota or balance error is reported clearly and is not retried.
- A rate-limited or transient server error follows the bounded retry policy.
- Large fetched content cannot exceed the MCP inline limit without explicit
  truncation metadata.
- No offline test or CI job makes a billable DeepSeek request.
- The published package contains no API key, local state, or generated test
  artifact.

## Decided Tradeoffs

- npm distribution is preferred over native binaries because onboarding is the
  higher priority for cross-tool adoption.
- MCP returns bounded content by default even though files are better for very
  large pages because not every MCP client has filesystem access.
- CLI machine output and explicit file output remain complete because shell
  users and automation can manage context deliberately.
- DeepSeek remains the only provider so provider selection remains an external
  policy decision.
