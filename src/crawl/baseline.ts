import { z } from "zod";
import type { CrawlBaseline, CrawlChanges, CrawlPageSummary } from "./types.js";

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const baselineSchema = z.object({
  version: z.literal(1),
  pages: z.array(
    z.object({
      url: z.string().url(),
      content_hash: hashSchema,
    }),
  ),
});

function version(url: string, hash: string) {
  return { url, content_hash: hash };
}

export function parseCrawlBaseline(input: unknown, source: string): CrawlBaseline {
  const result = baselineSchema.safeParse(input);
  if (!result.success) {
    throw new Error("Invalid Crawl baseline: pages with valid content_hash values are required.", {
      cause: result.error,
    });
  }
  const hashes = new Map<string, string>();
  for (const page of result.data.pages) {
    if (hashes.has(page.url)) {
      throw new Error(`Crawl baseline contains duplicate URL: ${page.url}`);
    }
    hashes.set(page.url, page.content_hash);
  }
  return { source, hashes };
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
        previous_content_hash: page.previous_content_hash ?? baseline.hashes.get(page.url) ?? "",
      });
    } else {
      changes.unchanged.push(version(page.url, page.content_hash));
    }
  }
  for (const [url, hash] of baseline.hashes) {
    if (!seen.has(url)) {
      changes.removed.push(version(url, hash));
    }
  }
  const byUrl = (left: { url: string }, right: { url: string }) =>
    left.url.localeCompare(right.url);
  for (const values of Object.values(changes)) {
    values.sort(byUrl);
  }
  return changes;
}
