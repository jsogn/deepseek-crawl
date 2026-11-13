import type { MapResult } from "../crawl/types.js";

export function formatMapUrls(result: MapResult): string {
  return result.urls.map((item) => item.url).join("\n");
}

export function formatMapWarnings(result: MapResult): string {
  return result.warnings.map((warning) => `${warning.code}: ${warning.message}`).join("\n");
}
