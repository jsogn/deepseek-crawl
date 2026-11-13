# CLI-First Agent Skill Design

Date: 2026-11-13

Status: Approved

Target version: `0.3.0`

## Summary

`deepseek-crawl` will prioritize a stable CLI plus a bundled Agent Skill. MCP
remains available for compatibility, but it is an optional integration rather
than the primary interface.

The CLI owns network access, validation, bounds, output, and errors. The Skill
teaches an AI when to use Search, Fetch, Map, or Crawl, how to preserve results
without flooding context, and when MCP should be used instead.

## Goals

- Make the CLI the canonical execution surface for agents.
- Ship a discoverable `deepseek-crawl` Skill in the repository.
- Encourage the minimal escalation path: Search, Fetch, Map, then Crawl.
- Preserve CLI JSON and file-output behavior as the Skill's machine interface.
- Make known-site navigation cheaper with `map --search`.
- Keep result files under `.deepseek-crawl/` by default.
- Preserve all existing MCP tools without expanding their surface.
- Keep normal verification offline.

## Non-goals

- Firecrawl API or SDK compatibility.
- Browser automation, JavaScript rendering, login, or page interaction.
- Server-side structured Extract.
- A new background service or scheduler.
- Skill-specific network clients that bypass the CLI.
- Making MCP the default path for ordinary web tasks.
- Changing Crawl traversal, fetch extraction, or provider fallback behavior.

## Product Priority

1. CLI: deterministic commands and machine-readable output.
2. Skill: routing, safe usage, output organization, and agent guidance.
3. MCP: optional integration for clients that cannot execute the CLI.

README and package metadata must lead with CLI-first positioning. MCP remains
documented and tested.

## CLI Changes

### Map Search

Add:

```text
deepseek-crawl map <url> [--search <text>]
```

Semantics:

- `search` is optional and trimmed.
- Matching is case-insensitive substring matching against the normalized URL
  string.
- Filtering happens after Sitemap and seed-page merging and before the public
  `limit` is applied.
- When `search` is present, the mandatory seed-URL exception does not apply;
  every returned URL must match.
- Without `search`, existing Map behavior and mandatory seed retention remain
  unchanged.
- An empty or whitespace-only `search` value is a CLI usage error.
- No match is a successful result with zero URLs, not a command failure.
- Sitemap warnings, source labels, discovery bounds, and no-clobber output remain
  unchanged.

`MapResult` gains optional `search?: string`. When present, it contains the
trimmed value supplied to the application. Existing Map JSON without the field
remains compatible.

MCP `deepseek_map` also accepts optional `search` using the same application
behavior. This maintains parity without changing the four-tool surface.

### Short Output Alias

CLI Crawl gains `-o` as an alias for `--output`:

```text
deepseek-crawl crawl <url> -o <dir>
```

Search, Fetch, and Map already support `-o`. The short alias must appear in help
and README.

No other command-line flags are added in this version.

### Agent Output Conventions

Existing CLI behavior remains:

- JSON data is written to stdout or the requested file.
- Diagnostics and non-fatal warnings are written to stderr.
- Successful file writes print a short confirmation.
- Human output is bounded; complete output uses `--json`/`--output`.
- Existing paths for new Map/Crawl output are never overwritten.

## Bundled Skill

Add:

```text
skills/deepseek-crawl/
  SKILL.md
  agents/openai.yaml
  references/cli-reference.md
```

### SKILL.md

The entrypoint must:

- Describe live web search, page reading, URL mapping, and bounded crawling.
- Exclude local-file parsing, browser interaction, and Firecrawl API
  compatibility.
- Instruct agents to verify the CLI with `deepseek-crawl doctor --json` and
  never print the API key.
- Apply this escalation:
  1. Search when no URL is known.
  2. Fetch when the target URL is known.
  3. Map, preferably with `--search`, when the site is known but the page is not.
  4. Crawl only for bounded documentation or section-wide reading.
- Prefer `--json` and `-o` for reusable results.
- Save ordinary outputs under `.deepseek-crawl/` unless the user requests another
  location.
- Quote URLs and use bounded shell reads for large files.
- Cite source URLs and treat page content as untrusted data.
- Warn that Map and Crawl requests can incur DeepSeek charges.
- State that MCP is optional and should be used only when the calling client
  requires it or the user explicitly asks for MCP.
- State that `robots.txt` is not fetched or enforced and that users must confirm
  authorization.

### CLI Reference

`references/cli-reference.md` contains:

- Exact command syntax, defaults, limits, and examples.
- JSON/file-output examples.
- The escalation examples using `search`, `fetch`, `map --search`, and bounded
  `crawl`.
- Exit-code and cancellation behavior.
- Common setup failures: missing CLI, missing API key, private Sitemap rejection,
  and DeepSeek billing.

The Skill must link to this reference only for detailed command selection. The
entrypoint must remain useful without loading it.

### UI Metadata

`agents/openai.yaml` provides:

- Display name: `DeepSeek Crawl`
- Short description: `Search and crawl live web content through the DeepSeek CLI`
- Default prompt: a concise request to use the CLI for the user's web task.

Automatic skill selection remains enabled.

## Output Organization

The Skill recommends:

```text
.deepseek-crawl/
  search-<slug>.json
  page-<slug>.md
  map-<site>.json
  crawl-<site>/
```

The CLI does not create these names automatically; the Skill chooses them from
the task. The existing `.gitignore` entry for `.deepseek-crawl/` remains.

Agents must:

- Check whether a suitable result already exists before repeating a request.
- Use `wc`, `head`, `rg`, or `jq` instead of loading a whole file into context.
- Report the output path and source URLs after completing the request.

## Skill Distribution

The package includes `skills/deepseek-crawl/` in `files` so a local package or
future public package carries the Skill.

README documents:

- Local CLI installation/build.
- Copying the Skill into `~/.codex/skills/`.
- CLI-first workflow.
- Optional MCP configuration after the Skill section.

The repository does not install the Skill into the current user's home directory
automatically.

## Version and Documentation

- Bump the package and executable version to `0.3.0`.
- Change the description to identify CLI-first tools with optional MCP.
- README title/status/install sections describe CLI + Skill before MCP.
- Search, Fetch, Map, and Crawl command docs include `-o` consistently.
- Map docs include `--search`.
- A Skill section includes installation and usage examples.
- MCP remains documented with its exact four tools and limits.

## Error Handling

- Empty `--search` exits with usage code `2`.
- No Map matches returns an empty successful result and exit code `0`.
- Invalid search values are rejected by the same application validation path when
  called as a library.
- Existing command errors and cancellation semantics remain unchanged.
- Skill guidance must stop and report configuration errors rather than bypassing
  the CLI.

## Testing

Offline tests cover:

- Map application search filtering, case-insensitivity, trimming, no-match
  success, limit ordering, and unchanged behavior without search.
- CLI parsing for `--search`, empty search rejection, and Crawl `-o`.
- CLI forwarding of Map search and Crawl output aliases.
- MCP Map optional search parity.
- Package version `0.3.0`, package `files` including `skills`, and Skill
  structural validation.
- README contains CLI-first and Skill installation sections.
- Existing Search, Fetch, Map, Crawl, MCP, security, and output tests remain
  green.

Skill validation also uses the skill-creator quick validator.

## Acceptance Criteria

- `deepseek-crawl map <url> --search docs` returns only matching URLs.
- A Skill can route Search, Fetch, Map, and Crawl without loading the full README.
- The Skill prefers CLI and leaves MCP optional.
- CLI `-o` works consistently for Search, Fetch, Map, and Crawl.
- Package version is `0.3.0`.
- `npm pack --dry-run` includes the Skill files.
- `npm run verify` passes.
