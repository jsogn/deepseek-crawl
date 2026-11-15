import { z } from "zod";
import { UnsupportedFallbackFeatureError } from "../gateway/errors.js";

const SCRAPE_KEYS = [
  "url",
  "formats",
  "actions",
  "waitFor",
  "onlyMainContent",
  "includeTags",
  "excludeTags",
  "headers",
  "timeout",
  "mobile",
  "blockAds",
  "origin",
] as const;

const INTERACT_KEYS = ["prompt", "actions", "timeout", "origin"] as const;
const FORMATS = new Set(["markdown", "html", "rawHtml", "links", "images"]);
const ACTIONS = new Set([
  "wait",
  "click",
  "write",
  "press",
  "scroll",
  "screenshot",
  "scrape",
  "pdf",
]);

const actionSchema = z.object({ type: z.string() }).passthrough();
const formatSchema = z.union([z.string(), z.object({ type: z.string() }).passthrough()]);
const scrapeSchema = z
  .object({
    url: z.string().trim().min(1),
    formats: z.array(formatSchema).optional(),
    actions: z.array(actionSchema).optional(),
    waitFor: z.number().int().nonnegative().optional(),
    onlyMainContent: z.boolean().optional(),
    includeTags: z.array(z.string()).optional(),
    excludeTags: z.array(z.string()).optional(),
    headers: z.record(z.string(), z.string()).optional(),
    timeout: z.number().int().positive().optional(),
    mobile: z.boolean().optional(),
    blockAds: z.boolean().optional(),
    origin: z.string().optional(),
  })
  .passthrough();

type Action = z.infer<typeof actionSchema>;

function unsupported(path: string): never {
  throw new UnsupportedFallbackFeatureError(
    `PageSift fallback does not support Firecrawl option \`${path}\`.`,
  );
}

function validateActions(actions: Action[] | undefined): void {
  actions?.forEach((action, index) => {
    if (!ACTIONS.has(action.type)) {
      unsupported(`actions[${index}].type`);
    }
  });
}

export function preparePageSiftScrape(input: unknown): {
  body: Record<string, unknown>;
  serialized: Uint8Array;
} {
  const parsed = scrapeSchema.parse(input);
  for (const key of Object.keys(parsed).sort()) {
    if (!SCRAPE_KEYS.includes(key as (typeof SCRAPE_KEYS)[number])) {
      unsupported(key);
    }
  }
  parsed.formats?.forEach((format, index) => {
    if (typeof format !== "string" || !FORMATS.has(format)) {
      unsupported(`formats[${index}]`);
    }
  });
  validateActions(parsed.actions);
  const body = { ...parsed, keepSession: true };
  return {
    body,
    serialized: Buffer.from(JSON.stringify(body)),
  };
}

const interactSchema = z
  .object({
    prompt: z.string().min(1).max(10_000).optional(),
    actions: z.array(actionSchema).optional(),
    timeout: z.number().int().positive().max(300).optional(),
    origin: z.string().optional(),
  })
  .passthrough();

export function preparePageSiftInteract(input: unknown): Uint8Array {
  const parsed = interactSchema.parse(input);
  for (const key of Object.keys(parsed).sort()) {
    if (!INTERACT_KEYS.includes(key as (typeof INTERACT_KEYS)[number])) {
      unsupported(key);
    }
  }
  validateActions(parsed.actions);
  if (parsed.prompt === undefined && parsed.actions === undefined) {
    throw new UnsupportedFallbackFeatureError("PageSift Interact requires a prompt or actions.");
  }
  return Buffer.from(JSON.stringify(parsed));
}
