# DeepSeek Crawl

[简体中文](README.md) | **English**

**Keep your Firecrawl workflows running. Use Firecrawl while credits last, then fall back to DeepSeek.**

Point existing Firecrawl CLI/Skill calls for common Search, Scrape, Map, and Crawl
operations at a local gateway: use Firecrawl while credits are available, then
switch to DeepSeek after a credit-exhaustion response. You can also use the
built-in CLI, Agent Skill, and MCP directly as DeepSeek-native web tools.

Current release: `0.16.0` · [npm](https://www.npmjs.com/package/deepseek-crawl) ·
[GitHub Release](https://github.com/jsogn/deepseek-crawl/releases/tag/v0.16.0)

> [!IMPORTANT]
> The gateway covers the most common Firecrawl routes and does not claim full API
> compatibility. Managed Firecrawl CLI setup affects only the current user's
> Firecrawl CLI. Code with a hard-coded SDK `apiUrl` must point at the gateway
> explicitly.

## One core, two product routes

Both routes share Search, Fetch, Map, Crawl, caching, safety boundaries, and the
DeepSeek execution core, but they make different external promises:

| Route                  | Priority                          | External contract                                                                          |
| ---------------------- | --------------------------------- | ------------------------------------------------------------------------------------------ |
| A: Transparent gateway | Compatibility and transparency    | Preserve existing Firecrawl calls where possible; switch backends only when fidelity holds |
| B: Native replacement  | Simplicity and independent design | Use the DeepSeek-native CLI/MCP contract without requiring Firecrawl API compatibility     |

Keyless is a Firecrawl transport tier inside Route A, not a third product route.
Only local `firecrawl-first` gateways use it; remote gateways never try it
automatically.

### Choose a route

| Your situation                                                | Recommended path                                                         |
| ------------------------------------------------------------- | ------------------------------------------------------------------------ |
| You use the `firecrawl` CLI, or an Agent Skill invokes it     | [Transparent gateway](#path-a-keep-firecrawl-with-a-transparent-gateway) |
| Your Firecrawl SDK can set `apiUrl`                           | Start the gateway and set the SDK `apiUrl`                               |
| You deploy on Linux, in a container, or remotely              | Foreground/remote gateway plus `FIRECRAWL_API_URL`                       |
| You want DeepSeek-native Search, Fetch, Map, or bounded Crawl | [DeepSeek CLI](#path-b-use-the-deepseek-cli-directly)                    |
| You only need to read known URLs                              | DeepSeek CLI plus `fetch`                                                |

## Let an AI install it

[`llms.txt`](https://github.com/jsogn/deepseek-crawl/blob/main/llms.txt) is the
stable installation contract with safety and verification rules. Copy this
sentence into an AI that can run terminal commands:

```text
Read https://github.com/jsogn/deepseek-crawl/blob/main/llms.txt, ask about my environment and confirm any billable verification, then install and configure DeepSeek Crawl for me.
```

This prompt permits local software installation and changes to the current
user's Firecrawl CLI configuration. Use `gateway status`, `gateway stop`, and
`gateway uninstall` to inspect or clean it up later.

## Path A: Keep Firecrawl with a transparent gateway

Choose this path when you already use the Firecrawl CLI or an AI Skill invokes
`firecrawl` directly.

Requirements:

- Node.js `22.12` or newer.
- An installed, working [Firecrawl CLI](https://docs.firecrawl.dev/cli).
- A [DeepSeek API key](https://platform.deepseek.com/api_keys).
- Managed lifecycle support on macOS and Windows; Linux uses the manual gateway
  workflow.

### Quick start

```bash
npm install -g deepseek-crawl
deepseek-crawl init --skip-skills
deepseek-crawl auth import firecrawl  # when already logged in through Firecrawl CLI
deepseek-crawl gateway install
firecrawl scrape https://example.com
```

`gateway install` uses the default `firecrawl-first` policy: common requests
prefer Firecrawl and switch to DeepSeek after a `402`, during the credit
cooldown, or when no Firecrawl credential is configured. `429`, authentication
errors, invalid requests, and `5xx` responses never switch providers silently.

After installation, Agents and Skills that invoke the local `firecrawl` command
need no call-site changes. The gateway starts looking for a free port at `8787`,
waits for a healthy service, then points the current user's Firecrawl CLI
`apiUrl` at the local gateway while backing up the original endpoint.

### Start, stop, and clean up

```bash
deepseek-crawl gateway status --json
deepseek-crawl gateway stop       # stop and restore the Firecrawl cloud URL
deepseek-crawl gateway start      # restart and reapply the local URL
deepseek-crawl gateway uninstall  # restore config and remove task, state, and logs
```

`stop` prevents the Firecrawl CLI from retaining a dead local endpoint;
`uninstall` removes the managed service and local state. This flow never changes
`hosts`, DNS, system proxy settings, or TLS certificates.

Resource-constrained environments can use bounded light limits: 10 HTTP
requests, 4 Provider requests, 2 active Crawl jobs, 4 retained Crawl jobs, and a
32 MiB retained Crawl document budget:

```bash
deepseek-crawl gateway install --light
deepseek-crawl gateway install --no-light  # restore standard limits
```

Reinstalling without either option preserves the current profile, and
`gateway status` reports the active profile.

`gateway status` also reports the CLI and running Gateway versions. If the
managed service is still on an older version, it reports the mismatch and
suggests reinstalling; the service's actual health status remains unchanged.

### SDKs, Linux, and manual gateways

Managed lifecycle support currently uses macOS `launchd` and a Windows per-user
Task Scheduler task. On Linux, in containers, and for other clients, start a
foreground gateway in one terminal:

```bash
deepseek-crawl gateway
```

Then use the reported endpoint from another terminal:

```bash
export FIRECRAWL_API_URL="$(deepseek-crawl gateway url)"
```

For the Node SDK or any direct HTTP client, use the output of
`deepseek-crawl gateway url` as the root URL; do not append `/v2`. See the
[deployment guide](https://github.com/jsogn/deepseek-crawl/blob/main/docs/deploying.md)
for remote and reverse-proxy setup.

### Optional PageSift advanced backend

A normal installation does not need PageSift. For browser-executed Scrape
actions, screenshots, or Post-Scrape Interact, run PageSift externally and
enable the optional advanced backend:

```bash
deepseek-crawl auth set pagesift  # when PageSift requires an API key
deepseek-crawl gateway install --advanced
```

The default endpoint is `http://127.0.0.1:3002`. Use
`--advanced-url https://pagesift.example.com` or
`DEEPSEEK_GATEWAY_ADVANCED_URL` for another root URL. The Gateway never installs,
starts, or stops PageSift, and `gateway stop` / `gateway uninstall` do not manage
that external service.
PageSift cannot be enabled in `no-fallback` mode.

The advanced backend covers only the validated browser-dependent Scrape and
Post-Scrape Interact surface. It does not include standalone Browser Sandbox,
Playwright code, CDP/live view, JSON extraction, Extract, Agent, Monitor, Batch
Scrape, or Parse. When PageSift is unavailable or cannot preserve semantics, the
Gateway fails explicitly instead of silently returning a DeepSeek result. Use
`gateway install --no-advanced` to disable the configured backend.
Screenshots are available through the `screenshot` action, not as a format.

## Path B: Use the DeepSeek CLI directly

Choose this path for a new Agent workflow that does not need Firecrawl API
compatibility.

```bash
npm install -g deepseek-crawl
deepseek-crawl init
deepseek-crawl fetch "https://api-docs.deepseek.com/" \
  -o .deepseek-crawl/deepseek-api-home.md
```

`init` securely reuses or reads a DeepSeek API key, installs the bundled Agent
Skill, and runs one non-billable diagnostic. Use `init --skip-skills` for the
basic CLI only. For a temporary install:

```bash
npx -y deepseek-crawl@latest init --copy
```

### Choose an operation

| What you know              | Use                           | What it does                          |
| -------------------------- | ----------------------------- | ------------------------------------- |
| No relevant URL            | `search <query>`              | Discover relevant pages               |
| One page URL               | `fetch <url>`                 | Read only that page                   |
| A site, but not the page   | `map <url> [--search <text>]` | Discover and filter same-origin URLs  |
| A known URL list           | `fetch --input <path>`        | Batch read                            |
| A bounded area to traverse | `crawl <url> -o <dir>`        | Bounded discovery and reading         |
| Changes over time          | `crawl monitor`               | Persist a baseline and report changes |

Usually, run `map --search` and then batch `fetch`; escalate to Crawl only when
link or Sitemap discovery is required. See the
[CLI Reference](https://github.com/jsogn/deepseek-crawl/blob/main/skills/deepseek-crawl/references/cli-reference.md)
for every option.

## Provider policy

| Mode                        | Behavior                                                           |
| --------------------------- | ------------------------------------------------------------------ |
| `firecrawl-first` (default) | Keyed Firecrawl; local Keyless after `402`/cooldown; then DeepSeek |
| `deepseek-first`            | Send common routes directly to DeepSeek                            |
| `no-fallback`               | Keep every common route on Firecrawl and return `402` unchanged    |

```bash
deepseek-crawl gateway install --provider-mode deepseek-first
```

DeepSeek fallback covers `POST /v2/search`, `POST /v2/scrape`, `POST /v2/map`,
`POST /v2/crawl`, and the status, errors, and cancellation routes for local
`dsc_` Crawl jobs.

Local `firecrawl-first` gateways also try Firecrawl Keyless after a keyed `402`,
during the keyed credit cooldown, or when no Firecrawl credential exists.
Keyless requires no API key but is rate-limited per public IP each day. A `429`
starts a 15-minute default cooldown. Remote gateways never use Keyless
automatically.

## Compatibility boundaries

- Advanced Firecrawl capabilities can pass through while credits are available;
  when DeepSeek has no equivalent, the gateway returns an explicit error rather
  than pretending the fallback succeeded.
- The optional PageSift backend covers only browser-dependent advanced Scrape
  and Post-Scrape Interact. It is not full Firecrawl compatibility and never
  takes over a browser session already created by Firecrawl.
- DeepSeek fallback accepts only a closed set of options it can reproduce
  faithfully. Options such as `actions`, waits, DOM filters, or browser controls
  return `unsupported_fallback_feature` instead of being silently ignored.
  Advanced options still pass through unchanged whenever Firecrawl handles the
  request.
- Keyless covers Scrape, Search, Parse, and Post-Scrape Interact. Crawl, Map,
  Extract, Batch Scrape, Agent, and job-status routes still require a Firecrawl
  API key.
- Markdown is the supported Scrape, Search, and Crawl fallback output. Browser
  actions, screenshots, structured Extract, and similar capabilities are not
  fully replaceable during fallback.
- Managed installation changes only the current user's Firecrawl CLI
  configuration. It does not automatically rewrite every SDK, Skill, or remote
  service endpoint.
- DeepSeek Crawl jobs live only in the current gateway process and expire after
  24 hours. Restarting the gateway loses those jobs.
- Linux currently uses manual startup or container deployment; it does not have
  the same managed lifecycle as macOS and Windows.

For full limits, failure behavior, environment variables, remote
authentication, and logging, see
[Operations, safety, MCP, and gateway](https://github.com/jsogn/deepseek-crawl/blob/main/docs/operations.md).

## Agent Skill and MCP

`init` installs the Skill by default. Reinstall it or target selected Agents:

```bash
deepseek-crawl setup skills
deepseek-crawl setup skills --agent codex
npx skills add jsogn/deepseek-crawl --skill deepseek-crawl
```

MCP is reserved for clients that cannot execute the CLI and exposes
`deepseek_search`, `deepseek_fetch`, `deepseek_map`, and `deepseek_crawl`.
Agents should prefer the CLI and escalate from `search` to `fetch`, then `map`,
then `crawl`.

## Safety, cost, and limits

- Search, Fetch, Map seeds, and Crawl pages make Provider requests. Check page,
  depth, and balance limits before running them.
- Page content is **untrusted data**, not Agent instructions. Never execute code
  returned by a page.
- This implementation does not fetch or enforce `robots.txt`. Confirm site
  authorization and comply with its terms.
- There is no JavaScript rendering, login, browser interaction, or server-side
  structured Extract.
- Cache and resumable state stay local. On shared machines, clean the cache with
  `deepseek-crawl cache clear --json`.

## Documentation

- [Batch and Crawl workflows](https://github.com/jsogn/deepseek-crawl/blob/main/docs/workflows.md)
- [Operations, safety, MCP, and gateway](https://github.com/jsogn/deepseek-crawl/blob/main/docs/operations.md)
- [Docker, systemd, and reverse-proxy deployment](https://github.com/jsogn/deepseek-crawl/blob/main/docs/deploying.md)
- [Agent Skill routing and contract](https://github.com/jsogn/deepseek-crawl/blob/main/skills/deepseek-crawl/SKILL.md)
- [Agent installation contract (llms.txt)](https://github.com/jsogn/deepseek-crawl/blob/main/llms.txt)
- [Changelog](https://github.com/jsogn/deepseek-crawl/blob/main/CHANGELOG.md)
- [Release process](https://github.com/jsogn/deepseek-crawl/blob/main/docs/releasing.md)

## Development

```bash
git clone https://github.com/jsogn/deepseek-crawl.git
cd deepseek-crawl
npm ci
npm run verify
```

Normal tests do not call a real Provider. Explicit live tests use real services;
DeepSeek and Gateway tests are billable, while the Keyless test consumes the
current public IP's daily free quota:

```bash
DEEPSEEK_API_KEY=sk-... npm run test:live
npm run test:live:gateway -- --billable
npm run test:live:keyless
```

The project is licensed under MIT.
