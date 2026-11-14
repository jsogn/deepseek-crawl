import { z } from "zod";
import type { CrawlBaseline, CrawlBaselinePage, CrawlChanges, CrawlPageSummary } from "./types.js";

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const baselinePageSchema = z.object({
  url: z.string().url(),
  title: z.string(),
  depth: z.number().int().min(0).max(5),
  sources: z.array(z.enum(["seed_url", "markdown", "sitemap"])),
  content_length: z.number().int().min(0),
  content_hash: hashSchema,
  content_truncated: z.boolean(),
  content_original_length: z.number().int().min(0).optional(),
  sitemap_lastmod: z.string().optional(),
});
const baselineSchema = z.object({
  version: z.literal(2),
  pages: z.array(baselinePageSchema),
});

function version(url: string, hash: string) {
  return { url, content_hash: hash };
}

export function parseCrawlBaseline(input: unknown, source: string): CrawlBaseline {
  const result = baselineSchema.safeParse(input);
  if (!result.success) {
    throw new Error("Invalid Crawl baseline: version 2 with complete page metadata is required.", {
      cause: result.error,
    });
  }
  const pages = new Map<string, CrawlBaselinePage>();
  for (const page of result.data.pages) {
    if (pages.has(page.url)) {
      throw new Error(`Crawl baseline contains duplicate URL: ${page.url}`);
    }
    pages.set(page.url, {
      url: page.url,
      title: page.title,
      depth: page.depth,
      sources: [...page.sources],
      content_length: page.content_length,
      content_hash: page.content_hash,
      content_truncated: page.content_truncated,
      ...(page.content_original_length === undefined
        ? {}
        : { content_original_length: page.content_original_length }),
      ...(page.sitemap_lastmod === undefined ? {} : { sitemap_lastmod: page.sitemap_lastmod }),
    });
  }
  return { source, pages };
}

export function compareCrawlBaseline(
  pages: readonly CrawlPageSummary[],
  seen: ReadonlySet<string>,
  baseline: CrawlBaseline,
): CrawlChanges {
  const changes: CrawlChanges = {
    added: [],
    modified: [],
    unchanged: [],
    removed: [],
  };
  for (const page of pages) {
    if (page.change_status === "added") {
      changes.added.push(version(page.url, page.content_hash));
    } else if (page.change_status === "modified") {
      changes.modified.push({
        ...version(page.url, page.content_hash),
        previous_content_hash:
          page.previous_content_hash ?? baseline.pages.get(page.url)?.content_hash ?? "",
      });
    } else {
      changes.unchanged.push(version(page.url, page.content_hash));
    }
  }
  for (const [url, baselinePage] of baseline.pages) {
    if (!seen.has(url)) {
      changes.removed.push(version(url, baselinePage.content_hash));
    }
  }
  const byUrl = (left: { url: string }, right: { url: string }) =>
    left.url.localeCompare(right.url);
  for (const values of Object.values(changes)) {
    values.sort(byUrl);
  }
  return changes;
}
