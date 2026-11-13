import { isIP } from "node:net";
import { z } from "zod";
import type { FetchInput, RawFetchResponse, RawSearchResponse, SearchInput } from "../types.js";

function unicodeLength(value: string): number {
  return [...value].length;
}

const query = z.string().refine((value) => {
  const length = unicodeLength(value);
  return value.trim().length > 0 && length >= 1 && length <= 128;
}, "Must contain 1 to 128 Unicode characters and cannot be all whitespace.");

export const searchInputSchema: z.ZodType<SearchInput> = z.object({
  query,
  count: z.number().int().min(1).max(50).default(10),
  ori_question: query.nullable().optional(),
  localization: z
    .string()
    .refine((value) => isIP(value) !== 0, "Must be a valid IPv4 or IPv6 address.")
    .optional(),
  need_content: z.boolean().default(false),
});

const fetchUrl = z
  .string()
  .min(1)
  .max(8192)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        ["http:", "https:"].includes(url.protocol) &&
        Boolean(url.hostname) &&
        !url.username &&
        !url.password
      );
    } catch {
      return false;
    }
  }, "Must be an HTTP(S) URL with a host and no username or password.");

export const fetchInputSchema: z.ZodType<FetchInput> = z.object({
  url: fetchUrl,
});

const rawSearchResult = z.looseObject({
  rerank_score: z.number(),
  title: z.string(),
  url: z.string(),
  snippet: z.string(),
  summary: z.string(),
  content: z.string(),
  site_name: z.string().nullable(),
  site_icon: z.string().nullable(),
  date: z.string().nullable(),
  authority: z.number().int(),
});

export const searchResponseSchema: z.ZodType<RawSearchResponse> = z.looseObject({
  results: z.array(rawSearchResult),
});

export const fetchResponseSchema: z.ZodType<RawFetchResponse> = z.looseObject({
  title: z.string(),
  content: z.string(),
});
