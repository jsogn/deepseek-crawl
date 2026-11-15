import { z } from "zod";
import { executeFetch, executeSearch } from "../application/index.js";
import type { MapSitemapReader } from "../application/map.js";
import { executeMap } from "../application/map.js";
import type { DeepSeekGateway } from "../deepseek/gateway.js";
import {
  collectUnsupportedFormats,
  collectUnsupportedKeys,
  collectUnsupportedSources,
  throwForUnsupportedOptions,
} from "./fallback-capabilities.js";

const formatSchema = z.union([
  z.string(),
  z
    .object({
      type: z.string(),
    })
    .passthrough(),
]);

const sourceSchema = z.union([
  z.string(),
  z
    .object({
      type: z.string(),
    })
    .passthrough(),
]);

const searchInputSchema = z
  .object({
    query: z.string().trim().min(1),
    limit: z.number().int().min(1).max(100).optional(),
    sources: z.array(sourceSchema).optional(),
    origin: z.string().optional(),
    scrapeOptions: z
      .object({
        formats: z.array(formatSchema).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const scrapeInputSchema = z
  .object({
    url: z.string().trim().min(1),
    formats: z.array(formatSchema).optional(),
    origin: z.string().optional(),
  })
  .passthrough();

const mapInputSchema = z
  .object({
    url: z.string().trim().min(1),
    search: z.string().trim().min(1).optional(),
    limit: z.number().int().min(1).max(1000).optional(),
    origin: z.string().optional(),
  })
  .passthrough();

const SEARCH_FALLBACK_KEYS = ["query", "limit", "sources", "scrapeOptions", "origin"] as const;
const SCRAPE_FALLBACK_KEYS = ["url", "formats", "origin"] as const;
const MAP_FALLBACK_KEYS = ["url", "search", "limit", "origin"] as const;

export async function firecrawlSearchFallback(
  input: unknown,
  client: DeepSeekGateway,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const parsed = searchInputSchema.parse(input);
  throwForUnsupportedOptions([
    ...collectUnsupportedKeys(parsed, SEARCH_FALLBACK_KEYS),
    ...collectUnsupportedSources(parsed.sources, "sources"),
    ...collectUnsupportedKeys(parsed.scrapeOptions ?? {}, ["formats"], "scrapeOptions"),
    ...collectUnsupportedFormats(parsed.scrapeOptions?.formats, "scrapeOptions.formats"),
  ]);

  const includeMarkdown = parsed.scrapeOptions?.formats !== undefined;
  const response = await executeSearch(
    client,
    {
      query: parsed.query,
      count: Math.min(parsed.limit ?? 10, 50),
      need_content: includeMarkdown,
    },
    { maxContentChars: 0 },
    signal,
  );

  return {
    success: true,
    data: {
      web: response.results.map((result) => ({
        title: result.title,
        description: result.snippet || result.summary,
        url: result.url,
        ...(includeMarkdown ? { markdown: result.content } : {}),
        metadata: {
          title: result.title,
          description: result.snippet || result.summary,
          sourceURL: result.url,
          url: result.url,
        },
      })),
    },
    creditsUsed: 0,
  };
}

export async function firecrawlScrapeFallback(
  input: unknown,
  client: DeepSeekGateway,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const parsed = scrapeInputSchema.parse(input);
  throwForUnsupportedOptions([
    ...collectUnsupportedKeys(parsed, SCRAPE_FALLBACK_KEYS),
    ...collectUnsupportedFormats(parsed.formats, "formats"),
  ]);

  const response = await executeFetch(client, { url: parsed.url }, { maxChars: 0 }, signal);
  return {
    success: true,
    data: {
      markdown: response.content,
      metadata: {
        title: response.title,
        sourceURL: response.url,
        url: response.url,
      },
    },
  };
}

export async function firecrawlMapFallback(
  input: unknown,
  client: DeepSeekGateway,
  reader: MapSitemapReader,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const parsed = mapInputSchema.parse(input);
  throwForUnsupportedOptions(collectUnsupportedKeys(parsed, MAP_FALLBACK_KEYS));
  const result = await executeMap(
    client,
    reader,
    { url: parsed.url },
    {
      limit: parsed.limit ?? 500,
      discoveryLimit: 10_000,
      ...(parsed.search === undefined ? {} : { search: parsed.search }),
    },
    signal,
  );
  return {
    success: true,
    links: result.urls.map((entry) => ({ url: entry.url })),
  };
}
