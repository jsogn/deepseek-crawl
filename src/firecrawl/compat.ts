import { z } from "zod";
import { executeFetch, executeSearch } from "../application/index.js";
import type { MapSitemapReader } from "../application/map.js";
import { executeMap } from "../application/map.js";
import type { DeepSeekGateway } from "../deepseek/gateway.js";
import { UnsupportedFallbackFeatureError } from "../gateway/errors.js";

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
  })
  .passthrough();

const mapInputSchema = z
  .object({
    url: z.string().trim().min(1),
    search: z.string().trim().min(1).optional(),
    limit: z.number().int().min(1).max(1000).optional(),
  })
  .passthrough();

function formatType(value: z.infer<typeof formatSchema>): string {
  return typeof value === "string" ? value : value.type;
}

function sourceType(value: z.infer<typeof sourceSchema>): string {
  return typeof value === "string" ? value : value.type;
}

function formatsAreMarkdownOnly(formats: z.infer<typeof formatSchema>[] | undefined): boolean {
  return formats === undefined || formats.every((format) => formatType(format) === "markdown");
}

export async function firecrawlSearchFallback(
  input: unknown,
  client: DeepSeekGateway,
): Promise<Record<string, unknown>> {
  const parsed = searchInputSchema.parse(input);
  if (parsed.sources?.some((source) => sourceType(source) !== "web")) {
    throw new UnsupportedFallbackFeatureError(
      "DeepSeek fallback supports only Firecrawl web search sources.",
    );
  }
  if (!formatsAreMarkdownOnly(parsed.scrapeOptions?.formats)) {
    throw new UnsupportedFallbackFeatureError(
      "DeepSeek fallback supports only the Firecrawl markdown Search format.",
    );
  }

  const includeMarkdown = parsed.scrapeOptions?.formats !== undefined;
  const response = await executeSearch(
    client,
    {
      query: parsed.query,
      count: Math.min(parsed.limit ?? 10, 50),
      need_content: includeMarkdown,
    },
    { maxContentChars: 0 },
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
): Promise<Record<string, unknown>> {
  const parsed = scrapeInputSchema.parse(input);
  if (!formatsAreMarkdownOnly(parsed.formats)) {
    throw new UnsupportedFallbackFeatureError(
      "DeepSeek fallback supports only the Firecrawl markdown Scrape format.",
    );
  }

  const response = await executeFetch(client, { url: parsed.url }, { maxChars: 0 });
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
): Promise<Record<string, unknown>> {
  const parsed = mapInputSchema.parse(input);
  const result = await executeMap(
    client,
    reader,
    { url: parsed.url },
    {
      limit: parsed.limit ?? 500,
      discoveryLimit: 10_000,
      ...(parsed.search === undefined ? {} : { search: parsed.search }),
    },
  );
  return {
    success: true,
    links: result.urls.map((entry) => ({ url: entry.url })),
  };
}
