import { codepointLength } from "../output/bounds.js";
import type { BatchFetchPage, BatchFetchPageSummary } from "./types.js";

export function summarizeBatchFetchPage(page: BatchFetchPage): BatchFetchPageSummary {
  const summary: BatchFetchPageSummary = {
    index: page.index,
    url: page.url,
    title: page.title,
    content_length: codepointLength(page.content),
    content_hash: page.contentHash,
    content_truncated: page.contentTruncated,
  };
  if (page.contentTruncated) {
    summary.content_original_length = page.contentOriginalLength;
  }
  if (page.retryOf) {
    summary.retry_of = page.retryOf;
  }
  if (page.retrievedFrom) {
    summary.retrieved_from = page.retrievedFrom;
  }
  return summary;
}
