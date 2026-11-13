import type { DeepSeekGateway } from "../deepseek/gateway.js";
import { fetchInputSchema, searchInputSchema } from "../deepseek/schemas.js";
import { boundFetchOutput, boundSearchOutput } from "../output/bounds.js";
import type { FetchOutput, SearchOutput } from "../types.js";

export type { DeepSeekGateway } from "../deepseek/gateway.js";

export async function executeSearch(
  client: DeepSeekGateway,
  input: unknown,
  options: { maxContentChars: number },
  signal?: AbortSignal,
): Promise<SearchOutput> {
  const parsed = searchInputSchema.parse(input);
  const response = await client.search(parsed, signal);
  return boundSearchOutput({ ...response }, options.maxContentChars);
}

export async function executeFetch(
  client: DeepSeekGateway,
  input: unknown,
  options: { maxChars: number },
  signal?: AbortSignal,
): Promise<FetchOutput> {
  const parsed = fetchInputSchema.parse(input);
  const response = await client.fetch(parsed, signal);
  return boundFetchOutput({ ...response, url: parsed.url }, options.maxChars);
}
