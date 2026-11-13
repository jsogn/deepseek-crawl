# DeepSeek Crawl CLI Reference

Use this reference when the Skill needs exact command selection, bounds, output
behavior, or error handling.

## Prerequisite Check

```bash
deepseek-crawl doctor --json
deepseek-crawl --version
```

`doctor` does not make a billable request. Never print `DEEPSEEK_API_KEY`.

Required environment:

- `DEEPSEEK_API_KEY`
- Optional `DEEPSEEK_BASE_URL`
- Optional `DEEPSEEK_TIMEOUT_MS`
- Optional `DEEPSEEK_MAX_RETRIES`

## Escalation

```text
No URL → Search → Fetch selected URL(s)
Known site, unknown page → Map --search → Fetch selected URL(s)
Known docs section requiring many pages → bounded Crawl
```

## Search

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

Defaults:

- count: `10`
- content: `false`
- human content limit: `4,000` code points per result
- JSON without an explicit limit preserves API content

Use `--content` when the result content is likely sufficient for the task.

## Fetch

```text
deepseek-crawl fetch <url>
  [--max-chars <0..1000000>]
  [--json]
  [--output, -o <path>]
```

Defaults:

- human content limit: `30,000` code points
- `-o` without `--json` writes Markdown
- `-o` with `--json` writes structured JSON

## Map

```text
deepseek-crawl map <url>
  [--search <text>]
  [--limit <1..1000>]
  [--json]
  [--output, -o <path>]
```

Defaults:

- limit: `500`

Search matching is case-insensitive against the normalized URL. With
`--search`, every returned URL must match and the seed is not forced into the
result. No matches are a successful empty result.

Without `--search`, the seed URL is always retained and the remaining URLs are
selected lexicographically up to the limit.

Map output contains:

```json
{
  "version": 1,
  "seed_url": "https://example.com/",
  "generated_at": "2026-11-13T12:00:00.000Z",
  "limit": 100,
  "search": "docs",
  "total": 2,
  "truncated": false,
  "urls": [
    {
      "url": "https://example.com/docs",
      "sources": ["sitemap"]
    }
  ],
  "warnings": []
}
```

The `search` field is omitted when no filter is used.

## Crawl

```text
deepseek-crawl crawl <url>
  [--max-depth <0..5>]
  [--max-pages <1..100>]
  [--concurrency <1..5>]
  [--delay-ms <0..5000>]
  --output, -o <dir>
  [--json]
```

Defaults:

- depth: `2`
- pages: `20`
- concurrency: `2`
- delay: `250 ms`

The seed is depth `0`. Crawl remains inside the exact origin, follows Markdown
links from DeepSeek Fetch, processes deterministic depth layers, and records
partial page failures.

Output:

```text
<dir>/
  crawl.json
  pages/
    0001-page.md
```

Read `crawl.json` first. It contains page paths, failures, settings, and stats,
but not duplicate page bodies.

## Output Rules

- Quote URLs in shell commands.
- Prefer `--json` for automation and `-o` for reusable results.
- New Map files and Crawl directories are never overwritten.
- Search and Fetch `-o` use the existing compatible overwrite behavior.
- Warnings go to stderr and are also retained in JSON where applicable.
- Use bounded file reads such as `jq`, `head`, `rg`, and `wc`.

## Hard Limits

| Resource | Limit |
| --- | --- |
| Fetch response body | 8 MiB |
| Crawl page content | 1,000,000 code points |
| Crawl discovery CLI | 10,000 URLs |
| Map candidates | 10,000 URLs |
| Sitemap documents | 10 |
| Sitemap response | 5 MiB |
| Sitemap redirects | 3, same-origin |

## Exit and Cancellation

- `0`: success, including partial Crawl results with at least one successful
  page.
- `1`: runtime, configuration, network, or output failure.
- `2`: CLI usage error.
- `130`: SIGINT cancellation after cleanup.

## Common Setup Failures

- `deepseek-crawl: command not found` — install/build the local CLI and put it on
  `PATH`.
- `DEEPSEEK_API_KEY is required` — configure the environment; never pass the key
  as a CLI flag.
- Sitemap warnings — Map may still succeed from seed-page links.
- Private/reserved Sitemap target — Map rejects direct network access to
  non-public addresses.
- Map or Crawl billing warning — reduce `--limit`, `--max-pages`, or depth before
  retrying.
