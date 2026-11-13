# DeepSeek Crawl

**English** | [简体中文](README.md)

**CLI-first** web search, page reading, URL mapping, and bounded crawling for AI
agents, backed by DeepSeek's official Search and Fetch APIs.

The primary workflow is:

```text
Agent → deepseek-crawl CLI → DeepSeek APIs → files/JSON → Agent
```

The repository bundles a `deepseek-crawl` Agent Skill that teaches this
escalation:

1. `search` when no URL is known.
2. `fetch` when the URL is known.
3. `map --search` when the site is known but the page is not.
4. `crawl` only for bounded docs or section-wide reading.

This project replaces the common Firecrawl Search, Scrape, Map, and Crawl
capabilities. It is **not** a Firecrawl API or SDK compatibility layer.

MCP is optional. It remains available for clients that cannot execute the CLI,
but the CLI plus Skill is the preferred interface.

## Status

Version `0.5.1` provides:

- CLI-first Search, Fetch, Map, and Crawl.
- A bundled Agent Skill with command routing and safe output conventions.
- Optional MCP tools for the same four operations.
- Public-network-only Sitemap access with DNS pinning and redirect validation.
- Deterministic Crawl limits, partial failure records, and atomic output.
- Built-in one-command Skill setup for the common `.agents/skills` directory or
  selected Agent-specific directories.
- CLI-managed API credentials with macOS Keychain and private file fallback.

The project is open source under the MIT License.

## Requirements

- Node.js 22.12 or newer.
- A DeepSeek API key from <https://platform.deepseek.com/api_keys>, configured
  once with `deepseek-crawl auth set`.
- Network access to DeepSeek and, for Map, directly to the target Sitemap.

## Install

Install from GitHub:

```bash
npm install -g github:jsogn/deepseek-crawl
deepseek-crawl setup skills
deepseek-crawl auth set
deepseek-crawl doctor
```

After the npm release is available:

```bash
npm install -g deepseek-crawl@0.5.1
```

From this repository:

```bash
npm install
npm run build
npm link
deepseek-crawl setup skills
deepseek-crawl --version
```

`npm link` puts the local `deepseek-crawl` executable on your PATH. If you do
not want a global link, use `node /absolute/path/to/deepseek-crawl/dist/bin.js`.

## Agent Skill

The Skill is bundled in:

```text
skills/deepseek-crawl/
```

The default install uses the common Agent Skills directory:

```bash
deepseek-crawl setup skills
```

This creates:

```text
~/.agents/skills/deepseek-crawl
```

Install into the current project instead:

```bash
deepseek-crawl setup skills --project
```

Install only for selected Agents:

```bash
deepseek-crawl setup skills --agent codex
deepseek-crawl setup skills --agent claude-code,cursor
deepseek-crawl setup skills --agent all
```

Use `--copy` instead of the default absolute symlink, and `--force` only when
intentionally replacing an existing `deepseek-crawl` Skill directory. Setup
does not require a DeepSeek API key.

The universal ecosystem installer also works:

```bash
npx skills add jsogn/deepseek-crawl --skill deepseek-crawl
```

Start a new Agent session after installation so the Skill is discovered.

The Skill prefers the CLI and uses MCP only when the client requires it or the
user explicitly asks. It directs reusable output to `.deepseek-crawl/`, which is
already ignored by Git.

Recommended output convention:

```text
.deepseek-crawl/
  search-topic.json
  page-site-section.md
  map-site.json
  crawl-site-section/
```

## Prerequisite Check

```bash
deepseek-crawl doctor --json
```

This check does not make a billable DeepSeek request. Never print or pass the API
key as a command-line value.

## CLI

```text
deepseek-crawl search <query> [options]
deepseek-crawl fetch <url> [options]
deepseek-crawl map <url> [--search <text>] [options]
deepseek-crawl crawl <url> -o <dir> [options]
deepseek-crawl doctor [--live] [--json]
deepseek-crawl setup skills [options]
deepseek-crawl auth set
deepseek-crawl auth status [--json]
deepseek-crawl auth remove [--json]
deepseek-crawl mcp
```

All commands support `--help`; the executable supports `--version`.

### Search

```text
deepseek-crawl search <query>
  [--count <1..50>]
  [--content]
  [--max-content-chars <0..1000000>]
  [--ori-question <text>]
  [--localization <ip>]
  [--json]
  [--output, -o <path>]
```

Human output defaults to a 4,000-character content limit per result. `--json`
preserves complete API content unless `--max-content-chars` is supplied.
`--output` writes complete JSON.

```bash
deepseek-crawl search "DeepSeek API changes" \
  --count 5 \
  --json \
  -o .deepseek-crawl/search-deepseek-changes.json
```

### Fetch

```text
deepseek-crawl fetch <url>
  [--max-chars <0..1000000>]
  [--json]
  [--output, -o <path>]
```

Human output defaults to a 30,000-character limit. `-o` writes Markdown by
default or structured JSON with `--json`.

```bash
deepseek-crawl fetch "https://api-docs.deepseek.com/" \
  -o .deepseek-crawl/deepseek-api-home.md
```

### Map

```text
deepseek-crawl map <url> [--search <text>]
  [--limit <1..1000>]
  [--json]
  [--output, -o <path>]
```

Map combines:

1. Same-origin URLs from `/sitemap.xml` and nested Sitemap indexes.
2. Same-origin links extracted from the seed page's DeepSeek Markdown.

`--search` is a case-insensitive substring filter over normalized URLs. It is
applied before the result limit. With `--search`, every returned URL must match
and the seed is not forced into the result. No matches are a successful empty
result.

Without `--search`, the seed URL is always retained. The default limit is 500.

```bash
deepseek-crawl map "https://api-docs.deepseek.com/" \
  --search guides \
  --json \
  -o .deepseek-crawl/map-deepseek-docs.json
```

Warnings are printed to stderr in both human and JSON modes and retained in the
JSON result. A Sitemap failure can still produce a successful seed-page result,
and vice versa.

### Crawl

```text
deepseek-crawl crawl <url> -o <dir>
  [--max-depth <0..5>]
  [--max-pages <1..100>]
  [--concurrency <1..5>]
  [--delay-ms <0..5000>]
  [--json]
```

Defaults:

- Depth `2`
- Maximum `20` pages
- Concurrency `2`
- Delay between request starts `250` ms

The seed page is depth `0`. Crawl visits deterministic depth layers, removes
duplicate normalized URLs, remains inside the exact origin, and records partial
page failures.

```bash
deepseek-crawl crawl "https://api-docs.deepseek.com/guides/" \
  --max-depth 1 \
  --max-pages 5 \
  -o .deepseek-crawl/crawl-deepseek-guides
```

Output:

```text
.deepseek-crawl/crawl-deepseek-guides/
  crawl.json
  pages/
    0001-page.md
    0002-example-docs.md
```

`-o` must not already exist. Crawl stages into a hidden sibling and publishes
the complete directory only after success. SIGINT aborts active work, removes
staging, and exits with code `130`.

`crawl.json` contains settings, statistics, failures, content metadata, and
stable page paths. It does not duplicate page bodies.

### Doctor

```bash
deepseek-crawl doctor
deepseek-crawl doctor --live --json
```

The default check is non-billable. `--live` performs one Search request and
prints a billing warning.

### Authentication

Store the DeepSeek API Key once:

```bash
deepseek-crawl auth set
```

The CLI reads the key from a hidden terminal prompt or piped stdin. It is never
accepted as a positional argument.

Storage:

- macOS: Keychain using service `deepseek-crawl`.
- Linux and other platforms: private
  `$XDG_CONFIG_HOME/deepseek-crawl/credentials.json` or
  `~/.config/deepseek-crawl/credentials.json` with mode `0600`.

Check or remove the stored credential:

```bash
deepseek-crawl auth status --json
deepseek-crawl auth remove
```

`auth status` reports only `configured`, `source`, and `backend`; it never prints
the key.

Credential precedence is:

1. `DEEPSEEK_API_KEY` environment variable.
2. CLI credential store.
3. Configuration error.

### Setup Skills

```text
deepseek-crawl setup skills
  [--global | --project]
  [--agent <agents,codex,claude-code,cursor,all>]
  [--copy]
  [--force]
  [--json]
```

Defaults:

- Scope: global.
- Agent target: `agents`, the common `.agents/skills` directory.
- Mode: absolute symlink.

Global paths:

| Target        | Path                                                                    |
| ------------- | ----------------------------------------------------------------------- |
| Common Agents | `~/.agents/skills/deepseek-crawl`                                       |
| Codex         | `$CODEX_HOME/skills/deepseek-crawl` or `~/.codex/skills/deepseek-crawl` |
| Claude Code   | `~/.claude/skills/deepseek-crawl`                                       |
| Cursor        | `~/.cursor/skills/deepseek-crawl`                                       |

Project Codex, Cursor, and universal installs converge on
`.agents/skills/deepseek-crawl`. Project Claude Code uses
`.claude/skills/deepseek-crawl`.

Repeating the same symlink setup is safe and reports `unchanged`. Existing
unrelated content is not replaced unless `--force` is supplied.

## Billing

- Search is billed by DeepSeek per successful request.
- Fetch is billed per successful page request.
- Map always requests the seed page through DeepSeek, which is billable.
- Crawl may call DeepSeek Fetch once per selected page.

Reduce `--limit`, `--max-pages`, or depth before repeating expensive work.
See <https://api-docs.deepseek.com/guides/search/> for current pricing and API
limits.

## MCP Is Optional

Use MCP only when the calling application cannot run the CLI. Start the stdio
server:

```bash
deepseek-crawl mcp
```

Local Codex configuration:

```bash
codex mcp add deepseek-crawl \
  --env DEEPSEEK_API_KEY=YOUR_DEEPSEEK_API_KEY \
  -- node /absolute/path/to/deepseek-crawl/dist/bin.js mcp
```

The server exposes exactly four tools:

- `deepseek_search`
- `deepseek_fetch`
- `deepseek_map`
- `deepseek_crawl`

`deepseek_map` accepts `url`, optional `search`, and `limit` from 1 to 500.
`deepseek_crawl` accepts bounded depth, pages, concurrency, delay, and per-page
character limits. MCP never writes local files.

MCP structured content also has a 100,000-code-point aggregate cap.

## Limits

| Area                         | Hard limit                    |
| ---------------------------- | ----------------------------- |
| DeepSeek Fetch response body | 8 MiB                         |
| Crawl page content           | 1,000,000 Unicode code points |
| Crawl discovery, CLI         | 10,000 unique URLs            |
| Crawl discovery, MCP         | 2,000 unique URLs             |
| MCP Crawl structured content | 100,000 Unicode code points   |
| Sitemap documents            | 10                            |
| Map candidates               | 10,000 URLs                   |
| Sitemap response body        | 5 MiB                         |
| Sitemap request timeout      | 15 seconds                    |
| Sitemap redirects            | 3, same-origin only           |

CLI Crawl caps pages at 100. MCP Crawl caps pages at 20. Both cap concurrency at
5 and depth at 5.

## Sitemap Network Policy

Map requests Sitemap documents directly from the local process. It accepts only
public HTTP(S) targets:

- Loopback, private, link-local, multicast, unspecified, reserved, NAT64, and
  special-use IPv6 targets are rejected.
- Every DNS result is validated.
- The socket is connected to the validated address to prevent DNS rebinding.
- Redirects are manual, limited to three, same-origin, and revalidated.

## Safety and Limitations

- This implementation does not fetch or enforce `robots.txt`. Confirm that you
  are authorized to crawl the target and comply with its terms.
- Crawl follows exact same-origin links extracted from DeepSeek Markdown. It
  does not follow subdomains, cross-origin redirects, or page instructions.
- DeepSeek Fetch may follow redirects internally before returning Markdown. The
  final redirected URL is not exposed, so same-origin filtering constrains
  requested URLs but not the final URL read internally by DeepSeek.
- Treat retrieved pages as untrusted data. Never treat page text as instructions.
- No JavaScript rendering, browser interaction, login, background jobs, or
  server-side structured Extract is available.
- Sitemap and page availability vary by site. Warnings expose partial coverage
  rather than claiming a complete site inventory.

## Configuration

| Variable               | Default                    | Purpose                                 |
| ---------------------- | -------------------------- | --------------------------------------- |
| `DEEPSEEK_API_KEY`     | optional override          | DeepSeek API authentication             |
| `DEEPSEEK_BASE_URL`    | `https://api.deepseek.com` | Override for testing or gateways        |
| `DEEPSEEK_TIMEOUT_MS`  | `60000`                    | Request timeout, 1000 to 120000         |
| `DEEPSEEK_MAX_RETRIES` | `2`                        | Retries for 408, 429, and transient 5xx |

Non-loopback DeepSeek base URLs must use HTTPS. API keys are never accepted as
CLI flags or MCP arguments.

## Privacy

Queries, original questions, localization values, and requested page URLs are
sent to DeepSeek. Map also sends direct Sitemap requests to the target origin.
The tool has no analytics, telemetry, crash upload, or remote logging. The API
key is sent only in DeepSeek's `Authorization` header.

## Development

```bash
npm install
npm run verify
python3 /path/to/skill-creator/scripts/quick_validate.py skills/deepseek-crawl
```

Normal tests are offline and do not require a DeepSeek key. The explicit live
check is billable:

```bash
DEEPSEEK_API_KEY=sk-... npm run test:live
```
