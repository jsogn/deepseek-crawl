# Sitemap-Assisted Crawl Design

Date: 2026-11-14

Status: Approved

Target version: `0.7.0`

## Summary

Crawl currently discovers links only from DeepSeek Fetch Markdown. Several
documentation and GitHub sites return useful page content without Markdown links,
causing Crawl to stop at the seed. Add Sitemap-assisted discovery so Crawl can
seed its frontier from the same public Sitemap reader used by Map.

CLI Crawl defaults to Sitemap `include`. MCP keeps its existing Markdown-only
behavior for compatibility.

## Goals

- Let Crawl traverse documentation sites even when fetched Markdown has no links.
- Reuse the existing safe Sitemap reader and its public-network protections.
- Preserve Markdown discovery as a source.
- Let users choose `include`, `only`, or `skip`.
- Apply existing origin, depth, path, query, page, and discovery limits to
  Sitemap candidates.
- Keep partial failures and deterministic ordering.

## Non-goals

- Changing Map discovery.
- Adding sitemap discovery to MCP Crawl in this version.
- Cross-origin, subdomain, or private-network Sitemap access.
- Crawl resumption or async jobs.

## CLI

```text
--sitemap <include|only|skip>
```

Default: `include`.

- `include`: merge seed-page Markdown links and same-origin Sitemap URLs.
- `only`: enqueue Sitemap URLs, but ignore links found in the seed Markdown.
- `skip`: use Markdown links only, preserving `0.6.0` behavior.

Sitemap candidates are depth `1`; the seed remains depth `0`.

## Discovery Flow

1. Fetch the seed through DeepSeek.
2. Read Sitemap through `SitemapReader` unless mode is `skip`.
3. Keep URLs that:
   - are HTTP(S) and credential-free;
   - have the same origin as the canonical seed;
   - match path filters;
   - are within `maxDepth`;
   - fit the page/discovery limits.
4. Merge seed Markdown links and Sitemap URLs into a deterministic bounded set.
5. Continue the existing layered BFS.

Sitemap read failures do not fail Crawl. They produce a warning and Crawl
continues with available discovery sources.

## Result Contract

`CrawlRunResult` gains:

```ts
settings.sitemap_mode?: "include" | "only" | "skip";
stats.sitemap_candidates?: number;
warnings: MapWarning[];
```

CLI Crawl includes these fields. MCP uses application default `skip` and omits
the optional `settings.sitemap_mode`/`stats.sitemap_candidates` values.

Warnings use the existing Map warning codes. A Sitemap failure in Crawl uses
`sitemap_unavailable`; invalid/truncated Sitemap warnings are propagated.

## Application Interface

`CrawlOptions` gains:

```ts
sitemapMode?: "include" | "only" | "skip";
sitemapReader?: CrawlSitemapReader;
```

```ts
export interface CrawlSitemapReader {
  read(
    seedUrl: URL,
    options: { maxDocuments: number; maxCandidates: number },
    signal?: AbortSignal,
  ): Promise<{
    urls: URL[];
    warnings: MapWarning[];
    truncated: boolean;
  }>;
}
```

Application default is `skip` when no mode/reader is supplied. CLI passes
`include` and its Sitemap reader.

## Error Handling

- Invalid `--sitemap` value exits `2`.
- `include`/`only` without a reader in the application throws a configuration
  error.
- Sitemap request errors in CLI Crawl become warnings, not command failure.
- Cancellation propagates.
- Seed failure remains fatal.

## Documentation and Skill

Document:

- Sitemap-assisted Crawl is the CLI default.
- `skip` restores Markdown-only behavior.
- `only` is useful when Markdown contains noisy links.
- Sitemap warnings and candidate counts are in `crawl.json`.

Skill guidance prefers:

```text
Map --search → Batch Fetch
```

for known URL lists and Sitemap-assisted Crawl for section traversal.

## Testing

Offline tests cover:

- Include mode merges Sitemap and Markdown links.
- Only mode ignores Markdown links.
- Skip mode does not call the reader.
- Sitemap candidates obey origin, depth, path, query, discovery, and page limits.
- Sitemap failure warnings do not abort.
- CLI parse/run/help.
- Existing MCP contract remains unchanged.
- Version `0.7.0`.

Live acceptance:

- Crawl the DeepSeek docs root with `--include-paths /guides --max-pages 2`.
- Confirm at least one Sitemap-discovered page is fetched.

## Acceptance Criteria

- CLI Crawl no longer depends solely on Markdown links.
- `include`, `only`, and `skip` behave as specified.
- Sitemap failures are explicit warnings.
- Version is `0.7.0`.
- Offline, live, Skill, CI, and GitHub Release checks pass.
