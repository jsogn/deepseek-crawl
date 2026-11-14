# DeepSeek Crawl

[简体中文](README.md) | **English**

**CLI-first** web search, page reading, URL mapping, and bounded crawling for AI
agents, backed by DeepSeek's official Search and Fetch APIs.

Current release: `0.12.0` · [npm](https://www.npmjs.com/package/deepseek-crawl) ·
[GitHub Release](https://github.com/jsogn/deepseek-crawl/releases/tag/v0.12.0)

```text
Agent → deepseek-crawl CLI → DeepSeek APIs → files/JSON → Agent
```

It replaces the common Firecrawl Search, Scrape, Map, and Crawl capabilities. It
is **not** a Firecrawl API or SDK compatibility layer. MCP is optional; ordinary
Agent use should prefer the CLI plus the bundled Skill.

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
0.12.0
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
- Cached page bodies stay local; run `deepseek-crawl cache clear --json` on shared
  machines.
- Map and Crawl are bounded discovery tools, not complete site inventories.

Full limits, MCP differences, environment variables, and privacy details:

[Operations, Safety, and MCP](https://github.com/jsogn/deepseek-crawl/blob/main/docs/operations.md)

## Documentation

- [Complete CLI reference](https://github.com/jsogn/deepseek-crawl/blob/main/skills/deepseek-crawl/references/cli-reference.md)
- [Batch and Crawl workflows](https://github.com/jsogn/deepseek-crawl/blob/main/docs/workflows.md)
- [Operations, safety, and MCP](https://github.com/jsogn/deepseek-crawl/blob/main/docs/operations.md)
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

The project is licensed under MIT.
