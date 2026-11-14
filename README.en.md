# DeepSeek Crawl

[简体中文](README.md) | **English**

**CLI-first** web search, page reading, URL mapping, and bounded crawling for AI
agents, backed by DeepSeek's official Search and Fetch APIs.

Current release: `0.13.1` · [npm](https://www.npmjs.com/package/deepseek-crawl) ·
[GitHub Release](https://github.com/jsogn/deepseek-crawl/releases/tag/v0.13.1)

```text
Agent → deepseek-crawl CLI → DeepSeek APIs → files/JSON → Agent
```

It replaces the common Firecrawl Search, Scrape, Map, and Crawl capabilities.
The ordinary CLI and MCP use only DeepSeek. The package also includes an optional
Firecrawl-compatible gateway for existing Firecrawl v2 clients that should switch
to DeepSeek after Firecrawl credits are exhausted.
MCP is optional; ordinary Agent use should prefer the CLI plus the bundled Skill.

## Core principles

- **Use the narrowest operation**: when a URL is known, read it instead of
  crawling a site.
- **Return Agent-ready output**: Markdown by default, JSON when structure is
  needed, with optional file output.
- **Keep work bounded**: origin, paths, depth, pages, concurrency, and request
  delay all have hard limits.
- **Preserve failure context**: successful pages, errors, sources, hashes, and
  stable paths survive partial failure.
- **Keep state local**: there is no remote storage or telemetry; cache and
  resumable state stay on the machine.

## Install and first run

### Requirements

- Node.js 22.12 or newer.
- A [DeepSeek API key](https://platform.deepseek.com/api_keys).
- Direct target-site Sitemap access for Map and Crawl.

### Choose an installation method

| Usage              | Best for                                  | Command                                      |
| ------------------ | ----------------------------------------- | -------------------------------------------- |
| `npx`              | Temporary use or CI                       | `npx -y deepseek-crawl@latest`               |
| Global install     | Repeated everyday CLI use                 | `npm install -g deepseek-crawl`              |
| Project dependency | Pinning a version or embedding in Node.js | `npm install deepseek-crawl`                 |
| GitHub `main`      | Testing unreleased code                   | `npm install -g github:jsogn/deepseek-crawl` |

Global installation is recommended for regular use:

```bash
npm install -g deepseek-crawl
deepseek-crawl --version
```

The version command should print the current release, for example:

```text
0.13.1
```

If global npm lacks write permission, do not use `sudo npm install -g`. Use your
Node.js version manager or configure a user-owned npm global prefix instead.

You can run the same CLI without a global install:

```bash
npx -y deepseek-crawl@latest --version
npx -y deepseek-crawl@latest init --copy
```

After installing it as a project dependency, invoke it through `npx`:

```bash
npm install deepseek-crawl
npx deepseek-crawl --version
npx deepseek-crawl init --project
```

GitHub installation follows `main` and is intended only for testing unreleased
changes:

```bash
npm install -g github:jsogn/deepseek-crawl
deepseek-crawl --version
```

Upgrade a global installation to the latest npm release:

```bash
npm install -g deepseek-crawl@latest
```

### Initialize the CLI

After a global install, run:

```bash
deepseek-crawl init
```

When credentials are missing, `init` reads the API key through a hidden prompt,
installs the bundled Agent Skill, and runs one non-billable `doctor` check.
Existing environment variables or local credentials are reused without prompting.

The default Skill target is `~/.agents/skills/deepseek-crawl`. Install it in the
current project or select Agents with:

```bash
deepseek-crawl init --project
deepseek-crawl init --skip-skills
deepseek-crawl init --agent codex
deepseek-crawl init --agent claude-code,cursor
```

Use `--json` for one aggregate result suitable for scripts and Agents:

```bash
deepseek-crawl init --json
```

`init` never calls a billable endpoint. Add `--copy` when using `npx` so the Skill
does not link to a temporary npx cache. Refresh a copied Skill with
`init --skip-auth --copy --force`, then start a new Agent session so it is
discovered.

### Manage authentication manually

`init` is the recommended first-run setup. Use the commands below to replace,
inspect, or remove credentials separately. They assume a global install; for
`npx`, prefix them with `npx -y deepseek-crawl@latest`.

```bash
deepseek-crawl auth set
deepseek-crawl auth status --json
```

`auth set` reads the API key from a hidden prompt. `DEEPSEEK_API_KEY` is also
supported. macOS Keychain stores the credential; other platforms use a private
file with mode `0600`.

`auth status` reports only the source and storage backend, never the key. Remove
the local credential with:

```bash
deepseek-crawl auth remove
```

Gateway providers use the same credential commands:

```bash
deepseek-crawl auth import firecrawl
deepseek-crawl auth set firecrawl
deepseek-crawl auth set gateway
deepseek-crawl auth status firecrawl --json
deepseek-crawl auth remove gateway
```

When Firecrawl CLI is already authenticated with `firecrawl config`,
`auth import firecrawl` reads its platform credential file, prints only a masked
hint, and stores the key in the DeepSeek Crawl Keychain/file store.
`FIRECRAWL_API_KEY` still takes precedence, and the import command explicitly
reports that override.

Omitting the provider keeps the existing `deepseek` default.

### Verify the CLI and credential

```bash
deepseek-crawl doctor
```

`init` performs the same check. `doctor` validates configuration without a
billable call; `doctor --live` performs one billable Search.

### Check the account balance

```bash
deepseek-crawl balance
deepseek-crawl balance --json
```

The balance command reads DeepSeek `/user/balance` without making a billable
request. `--json` returns a stable `available` flag and currency-sorted
`balances[]` for Agents and scripts. Use `-o` to publish the output atomically.

### Make the first request

After installation and authentication, verify end-to-end page reading with a
known URL:

```bash
deepseek-crawl fetch "https://api-docs.deepseek.com/" \
  -o .deepseek-crawl/deepseek-api-home.md
```

This command makes one DeepSeek Fetch request. For a fully non-billable install
check, stop after `--version`, `init`, `auth status`, `doctor`, and `balance`.

`init` installs the Agent Skill by default; add `--skip-skills` when only the
basic CLI is needed. See [Agent integration](#agent-integration) for targets and
manual installation options.

## Choose the right operation

| What do you know?               | Use                           | Why                                             |
| ------------------------------- | ----------------------------- | ----------------------------------------------- |
| No relevant URL                 | `search <query>`              | Discover candidate pages                        |
| One page URL                    | `fetch <url>`                 | Read only that page                             |
| A site, but not the page        | `map <url> [--search <text>]` | Discover and filter same-origin URLs            |
| A known URL list                | `fetch --input <path>`        | Read without rediscovery                        |
| A bounded docs area to traverse | `crawl <url> -o <dir>`        | Discover and read under explicit limits         |
| Changes over time               | `crawl monitor`               | Persist a baseline and emit incremental reports |

`map --search` followed by Batch Fetch usually costs less than a site-wide Crawl.
Escalate to Crawl only when link or Sitemap discovery is needed.

## Core operations

### Search

```bash
deepseek-crawl search "DeepSeek API changes" \
  --count 5 \
  --json \
  -o .deepseek-crawl/search-deepseek-changes.json
```

Useful options include `--content`, `--max-content-chars`, `--ori-question`, and
`--localization`. Human-readable output limits each result to 4,000 characters by
default.

### Fetch

```bash
deepseek-crawl fetch "https://api-docs.deepseek.com/" \
  -o .deepseek-crawl/deepseek-api-home.md
```

`-o` writes Markdown by default, or structured JSON with `--json`. Human-readable
output is capped at 30,000 characters by default. Use `--cache-ttl 3600` when
revisiting pages; `--fresh` bypasses and replaces the cache entry.

Batch-fetch known URLs:

```bash
deepseek-crawl fetch \
  --input .deepseek-crawl/map-docs.json \
  --output-dir .deepseek-crawl/pages-docs \
  --concurrency 3 \
  --delay-ms 250
```

`--input` accepts Map JSON, URL arrays, object arrays with `url`, and line-based
URL text. See the workflow guide for every input form, caching, and retry.

Enable local checkpoints for a large batch. The job directory and final output
directory must be absent and must not contain each other:

```bash
deepseek-crawl fetch \
  --input .deepseek-crawl/map-docs.json \
  --output-dir .deepseek-crawl/pages-docs \
  --job-dir .deepseek-crawl/jobs/docs

deepseek-crawl fetch status .deepseek-crawl/jobs/docs --json
deepseek-crawl fetch resume .deepseek-crawl/jobs/docs
```

Resume requests only unfinished URLs and does not reread successful pages. The
final `fetch.json` and page directory are published atomically after completion.

### Map

```bash
deepseek-crawl map "https://api-docs.deepseek.com/" \
  --search guides \
  --json \
  -o .deepseek-crawl/map-deepseek-docs.json
```

Map merges same-origin Sitemap URLs with links from the seed page Markdown.
`--search` filters normalized URLs before `limit` is applied. Map JSON can feed
Batch Fetch directly.

### Crawl

```bash
deepseek-crawl crawl "https://api-docs.deepseek.com/guides/" \
  --max-depth 1 \
  --max-pages 10 \
  --include-paths "/guides/*" \
  -o .deepseek-crawl/crawl-deepseek-guides
```

`deepseek-crawl crawl <url> -o <dir>` defaults to depth `2`, 20 pages, and
concurrency `2`. CLI Crawl combines Sitemap and Markdown discovery by default and
stays on the exact seed origin.

The destination contains `crawl.json` and stable `pages/*.md` files. Crawl writes
to hidden staging and publishes atomically. SIGINT removes staging and exits with
code `130`.

Plan, path filters, incremental comparison, Change Monitor, resumable jobs, and
failed-item retry:

[Batch and Crawl Workflows](https://github.com/jsogn/deepseek-crawl/blob/main/docs/workflows.md)

## Common tasks

| Task                                                   | Entry point                       |
| ------------------------------------------------------ | --------------------------------- |
| Inspect a docs area before fetching                    | `crawl --plan-only`               |
| Write only changed pages                               | `crawl --baseline --changed-only` |
| Monitor recurring docs changes                         | `crawl monitor`                   |
| Continue an interrupted long job                       | `crawl resume`                    |
| Retry only failures                                    | Batch Retry or Crawl Retry        |
| Scope Crawl with `--include-paths` / `--exclude-paths` | Crawl workflow guide              |
| Deduplicate with `--ignore-query-parameters`           | Crawl workflow guide              |

## Optional Firecrawl-compatible gateway

The ordinary CLI and MCP do not start an HTTP service. To connect an existing
Firecrawl v2 client:

```bash
deepseek-crawl auth import firecrawl
deepseek-crawl gateway
```

An existing Firecrawl CLI login can be imported directly. `auth set firecrawl`
remains available for manual entry. DeepSeek-only use can skip the Firecrawl
credential. DeepSeek credentials continue to use the existing
`deepseek-crawl auth set` or Keychain configuration.

Local mode starts at `8787`, tries subsequent ports when it is occupied, and
prints the actual URL. An explicit `--port` is strict and fails if unavailable.

Provider mode defaults to `firecrawl-first` and can be set by CLI or
environment:

```bash
deepseek-crawl gateway --provider-mode deepseek-first
DEEPSEEK_GATEWAY_PROVIDER_MODE=no-fallback deepseek-crawl gateway
deepseek-crawl gateway --credits-cooldown 120
DEEPSEEK_GATEWAY_CREDITS_COOLDOWN_SECONDS=120 deepseek-crawl gateway
```

`deepseek-first` sends common routes directly to DeepSeek. `no-fallback` keeps
common routes on Firecrawl and passes Firecrawl `402` responses through.
In `firecrawl-first` mode, a 402 starts a 60-second cooldown by default.
`--credits-cooldown 0` retries Firecrawl on every request.

The gateway defaults to `100` concurrent HTTP requests, `100` concurrent
Provider requests, `10` running Crawl jobs, `100` retained Crawl jobs, and
`256 MiB` of retained Crawl documents. Advanced deployments can tune these
limits:

```bash
deepseek-crawl gateway \
  --max-concurrent-requests 200 \
  --max-provider-requests 50 \
  --max-crawl-jobs 5 \
  --max-retained-crawl-jobs 50 \
  --max-retained-crawl-bytes 134217728
```

The corresponding `DEEPSEEK_GATEWAY_MAX_CONCURRENT_REQUESTS`,
`DEEPSEEK_GATEWAY_MAX_PROVIDER_REQUESTS`, `DEEPSEEK_GATEWAY_MAX_CRAWL_JOBS`, and
`DEEPSEEK_GATEWAY_MAX_RETAINED_CRAWL_JOBS`,
`DEEPSEEK_GATEWAY_MAX_RETAINED_CRAWL_BYTES` variables are available for
containers and systemd. When either retained capacity is full, the gateway
evicts the oldest terminal job first. A new job is rejected only when running
jobs still consume all capacity. A running job that would cross the global
document budget evicts reclaimable terminal pages first. It fails only when
active jobs consume the remaining budget and never retains the out-of-budget
page. `max-retained-crawl-jobs` must be greater than or equal to
`max-crawl-jobs`.

Other terminals and scripts can discover the selected endpoint:

```bash
deepseek-crawl gateway url
deepseek-crawl gateway status --json
```

When one instance is running, `gateway url` prints its URL directly. Multiple
instances require `gateway url --port 8788`. Runtime state stores only PID, URL,
start time, and mode, never provider keys. `gateway status` verifies `/healthz`
and prunes stale state.
It also reports DeepSeek, Firecrawl, and remote gateway-auth readiness and
source, plus each instance's provider mode and cooldown, replacing separate
credential checks.
Instance JSON includes `provider_mode` and `credits_cooldown_seconds`; the same
nonsecret values are available from `/healthz`. Capacity fields include
`max_retained_crawl_jobs` and `max_retained_crawl_bytes`.

When an HTTP client disconnects, the gateway cancels queued and in-flight
foreground DeepSeek fallback work so unattended Provider calls do not continue.
After a Crawl-create response finishes, its asynchronous job continues through
the normal completion, cancellation, or expiration lifecycle.

The client usually only needs the gateway URL:

```bash
export FIRECRAWL_API_URL=http://127.0.0.1:<reported-port>
```

The local Node SDK can set only the root URL. Do not append `/v2`:

```js
import { Firecrawl } from "firecrawl";

const firecrawl = new Firecrawl({
  apiUrl: "http://127.0.0.1:8787", // replace with the reported port
});
```

In the default `firecrawl-first` mode, `POST /v2/search`, `POST /v2/scrape`,
`POST /v2/map`, and `POST /v2/crawl` prefer Firecrawl. Firecrawl `402` responses,
or a missing Firecrawl credential, switch to DeepSeek. Crawl also exposes
Firecrawl-compatible job status, errors, and cancellation. `429`, authentication
failures, invalid requests, and server errors remain transparent and do not
silently switch providers.

The gateway process reads only `FIRECRAWL_UPSTREAM_URL` for its Firecrawl
upstream; it defaults to `https://api.firecrawl.dev`. `FIRECRAWL_API_URL` is the
client-facing gateway URL and is never used as the gateway upstream, preventing a
proxy loop.

Advanced Firecrawl capabilities pass through while credits are available. They
never pretend to succeed when a DeepSeek fallback does not provide equivalent
behavior. DeepSeek Crawl jobs remain in the current gateway process and expire
after 24 hours.

Remote mode uses fixed port `8787` and requires a gateway token:

```bash
deepseek-crawl auth set gateway
deepseek-crawl gateway --remote
```

Remote clients use that token as the Firecrawl SDK `apiKey`. After
authentication, the gateway strips it and uses its own Firecrawl provider
credential upstream. `--allow-remote` remains a compatibility alias; new usage
uses `--remote`.
CI and containers can override the stored token with `GATEWAY_API_KEY`.

Firecrawl upstream responses stream through the gateway instead of being fully
buffered, including large Crawl responses. Normal gateway shutdown cancels
active process-local DeepSeek Crawl jobs.

Remote mode locks a source for 60 seconds after 5 consecutive authentication
failures and caps concurrent requests at 100. Every request receives an
`x-request-id`. The CLI gateway writes one JSON log line per request to stderr,
containing only normalized route, status, duration, provider, and fallback
reason. It never logs keys, page bodies, query strings, or full target URLs.
Default header, request, and keep-alive timeouts are 15, 120, and 5 seconds.

The official SDK WebSocket `Watcher` is not supported. Upgrade requests receive a
structured `426 websocket_not_supported` response. Use the SDK's polling Crawl
helpers, or `startCrawl` plus `getCrawlStatus`.

Offline compatibility tests use the official `firecrawl` Node SDK to cover
Search, Scrape, Map, Crawl, fallback, and structured errors without calling paid
APIs.

## Agent integration

`deepseek-crawl init` installs the default Skill as part of onboarding. Use the
commands below to install or reconfigure only the Skill:

The repository bundles the Skill at:

```text
skills/deepseek-crawl/
```

Install it to the default `~/.agents/skills/deepseek-crawl`:

```bash
deepseek-crawl setup skills
```

Install to a project or selected Agent:

```bash
deepseek-crawl setup skills --project
deepseek-crawl setup skills --agent codex
deepseek-crawl setup skills --agent claude-code,cursor
deepseek-crawl setup skills --agent all
```

Or use the general ecosystem installer:

```bash
npx skills add jsogn/deepseek-crawl --skill deepseek-crawl
```

Installing the Skill does not require an API key. Start a new Agent session after
installation so the Skill is discovered.

Agents should escalate from `search` to `fetch`, then `map`, then `crawl`. MCP is
reserved for clients that cannot execute the CLI and exposes `deepseek_search`,
`deepseek_fetch`, `deepseek_map`, and `deepseek_crawl`.

## Safety, cost, and boundaries

- Search, Fetch, Map seeds, and Crawl pages make DeepSeek requests. Check page and
  depth limits before running them.
- Page content is **untrusted data**, not Agent instructions. Never execute code
  returned by a page.
- This implementation does not fetch or enforce `robots.txt`. Confirm
  authorization and comply with site terms.
- Sitemap access is public HTTP(S) only, validates DNS, prevents DNS rebinding, and
  limits same-origin redirects.
- There is no JavaScript rendering, login, browser interaction, or server-side
  structured Extract.
- The Firecrawl-compatible gateway covers common operations only; advanced
  Firecrawl capabilities are not replaced by DeepSeek.
- Cached page bodies stay local; run `deepseek-crawl cache clear --json` on shared
  machines.
- Map and Crawl are bounded discovery tools, not complete site inventories.

Full limits, MCP differences, environment variables, and privacy details:

[Operations, safety, MCP, and gateway](https://github.com/jsogn/deepseek-crawl/blob/main/docs/operations.md)

## Documentation

- [Complete CLI reference](https://github.com/jsogn/deepseek-crawl/blob/main/skills/deepseek-crawl/references/cli-reference.md)
- [Batch and Crawl workflows](https://github.com/jsogn/deepseek-crawl/blob/main/docs/workflows.md)
- [Operations, safety, MCP, and gateway](https://github.com/jsogn/deepseek-crawl/blob/main/docs/operations.md)
- [Docker, systemd, and reverse-proxy deployment](https://github.com/jsogn/deepseek-crawl/blob/main/docs/deploying.md)
- [Agent Skill routing and contract](https://github.com/jsogn/deepseek-crawl/blob/main/skills/deepseek-crawl/SKILL.md)
- [Changelog](https://github.com/jsogn/deepseek-crawl/blob/main/CHANGELOG.md)
- [Release process](https://github.com/jsogn/deepseek-crawl/blob/main/docs/releasing.md)

## Development

```bash
git clone https://github.com/jsogn/deepseek-crawl.git
cd deepseek-crawl
npm ci
npm run build
npm link
node dist/bin.js --version
npm run verify
```

Normal tests do not call DeepSeek. Explicit live testing is billable:

```bash
DEEPSEEK_API_KEY=sk-... npm run test:live
```

Explicitly verify Firecrawl passthrough and DeepSeek fallback through the
official Firecrawl SDK and Gateway:

```bash
npm run test:live:gateway -- --billable
```

This command performs exactly two single-page `example.com` Scrapes. It refuses
to run without `--billable`. Credentials come from environment variables or the
local secure store and are never printed.

Add `--matrix` to include Search and Map, for six bounded operations total:

```bash
npm run test:live:gateway -- --billable --matrix
```

Add `--crawl` to verify two minimal Crawls with `limit=1`,
`maxDiscoveryDepth=0`, and `sitemap=skip`:

```bash
npm run test:live:gateway -- --billable --crawl
```

`--matrix --crawl` combines both for eight bounded operations total.

The project is licensed under MIT.
