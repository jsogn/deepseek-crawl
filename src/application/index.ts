import { contentHashFor, fetchSourceFor } from "../cache/cached-gateway.js";
import type { DeepSeekBalanceGateway, DeepSeekGateway } from "../deepseek/gateway.js";
import { fetchInputSchema, searchInputSchema } from "../deepseek/schemas.js";
import { boundFetchOutput, boundSearchOutput } from "../output/bounds.js";
import type { BalanceOutput, FetchOutput, SearchOutput } from "../types.js";

export { executeCrawl } from "./crawl.js";
export { executeCrawlPlan } from "./crawl-plan.js";
export { executeCrawlRetry } from "./crawl-retry.js";
export { executeMap } from "./map.js";

export async function executeBalance(
  client: DeepSeekBalanceGateway,
  signal?: AbortSignal,
): Promise<BalanceOutput> {
  const response = await client.balance(signal);
  return {
    version: 1,
    provider: "deepseek",
    available: response.is_available,
    balances: response.balance_infos
      .map((balance) => ({
        currency: balance.currency,
        total: balance.total_balance,
        granted: balance.granted_balance,
        topped_up: balance.topped_up_balance,
      }))
      .sort((left, right) =>
        left.currency < right.currency ? -1 : left.currency > right.currency ? 1 : 0,
      ),
  };
}

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
  const source = fetchSourceFor(client, parsed.url);
  return {
    ...boundFetchOutput({ ...response, url: parsed.url }, options.maxChars),
    content_hash: contentHashFor(client, parsed.url, response),
    ...(source ? { retrieved_from: source } : {}),
  };
}
