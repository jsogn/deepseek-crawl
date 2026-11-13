import { type DeepSeekGateway, executeSearch } from "../application/index.js";
import { loadConfig } from "../config.js";
import type { CredentialStore } from "../credentials/store.js";
import { DeepSeekClient } from "../deepseek/client.js";

export interface DoctorOptions {
  env: NodeJS.ProcessEnv;
  fetchImpl: typeof fetch;
  live: boolean;
  json: boolean;
  stdout: { write(value: string): unknown };
  stderr: { write(value: string): unknown };
  credentialStore?: CredentialStore;
}

function formatDoctorHuman(result: Record<string, unknown>): string {
  return [
    `DeepSeek API key: ${String(result.api_key)}`,
    `Credential source: ${String(result.credential_source)}`,
    `Base URL: ${String(result.base_url)}`,
    `Connectivity: ${String(result.connectivity)}`,
    `Live request: ${String(result.live)}`,
    `Node.js: ${String(result.node)}`,
  ].join("\n");
}

export async function runDoctor(options: DoctorOptions): Promise<number> {
  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig(options.env, options.credentialStore);
  } catch (error) {
    const result = {
      ok: false,
      api_key: options.env.DEEPSEEK_API_KEY ? "invalid" : "missing",
      credential_source: "missing",
      error: error instanceof Error ? error.message : String(error),
      node: process.version,
    };
    options.stderr.write(
      options.json
        ? `${JSON.stringify(result, null, 2)}\n`
        : `DeepSeek doctor failed: ${String(result.error)}\n`,
    );
    return 1;
  }

  let connectivity = "unknown";
  let ok = true;
  try {
    await options.fetchImpl(config.baseUrl, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(5000),
    });
    connectivity = "reachable";
  } catch {
    connectivity = "unreachable";
    ok = false;
  }

  let live = "not_requested";
  if (options.live) {
    options.stderr.write(
      "Billable DeepSeek Search request: doctor --live performs one Search request.\n",
    );
    const client: DeepSeekGateway = new DeepSeekClient({
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      timeoutMs: config.timeoutMs,
      maxRetries: 0,
      fetchImpl: options.fetchImpl,
    });
    try {
      await executeSearch(
        client,
        { query: "DeepSeek API status", count: 1 },
        { maxContentChars: 0 },
      );
      live = "passed";
    } catch (error) {
      live = "failed";
      ok = false;
      options.stderr.write(
        `Live request failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  }

  const result = {
    ok,
    api_key: "configured",
    credential_source: config.credentialSource,
    base_url: config.baseUrl.href,
    connectivity,
    live,
    node: process.version,
  };
  options.stdout.write(
    options.json ? `${JSON.stringify(result, null, 2)}\n` : `${formatDoctorHuman(result)}\n`,
  );
  return ok ? 0 : 1;
}
