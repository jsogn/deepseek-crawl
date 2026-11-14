import { executeSearch } from "../application/index.js";
import { loadConfig } from "../config.js";
import type { CredentialStore } from "../credentials/store.js";
import { DeepSeekClient } from "../deepseek/client.js";
import type { DeepSeekGateway } from "../deepseek/gateway.js";

export interface DoctorOptions {
  env: NodeJS.ProcessEnv;
  fetchImpl: typeof fetch;
  live: boolean;
  json: boolean;
  stdout: { write(value: string): unknown };
  stderr: { write(value: string): unknown };
  credentialStore?: CredentialStore;
}

interface DoctorResult {
  ok: boolean;
  api_key: "configured" | "invalid" | "missing";
  credential_source: string;
  base_url?: string;
  connectivity?: "reachable" | "unreachable";
  live: "not_requested" | "passed" | "failed";
  node: string;
  error?: string;
}

export interface DoctorCheck {
  result: DoctorResult;
  fatal: boolean;
  messages: string[];
}

function formatDoctorHuman(result: DoctorResult): string {
  return [
    `DeepSeek API key: ${String(result.api_key)}`,
    `Credential source: ${String(result.credential_source)}`,
    `Base URL: ${String(result.base_url)}`,
    `Connectivity: ${String(result.connectivity)}`,
    `Live request: ${String(result.live)}`,
    `Node.js: ${String(result.node)}`,
  ].join("\n");
}

export async function checkDoctor(
  options: Omit<DoctorOptions, "json" | "stdout" | "stderr">,
): Promise<DoctorCheck> {
  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig(options.env, options.credentialStore);
  } catch (error) {
    const result: DoctorResult = {
      ok: false,
      api_key: options.env.DEEPSEEK_API_KEY ? "invalid" : "missing",
      credential_source: "missing",
      live: "not_requested",
      error: error instanceof Error ? error.message : String(error),
      node: process.version,
    };
    return {
      result,
      fatal: true,
      messages: [`DeepSeek doctor failed: ${String(result.error)}`],
    };
  }

  let connectivity: "reachable" | "unreachable";
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

  const messages: string[] = [];
  let live: DoctorResult["live"] = "not_requested";
  if (options.live) {
    messages.push("Billable DeepSeek Search request: doctor --live performs one Search request.");
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
      messages.push(
        `Live request failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const result: DoctorResult = {
    ok,
    api_key: "configured",
    credential_source: config.credentialSource,
    base_url: config.baseUrl.href,
    connectivity,
    live,
    node: process.version,
  };
  return { result, fatal: false, messages };
}

export async function runDoctor(options: DoctorOptions): Promise<number> {
  const check = await checkDoctor(options);
  if (check.fatal) {
    options.stderr.write(
      options.json
        ? `${JSON.stringify(check.result, null, 2)}\n`
        : `DeepSeek doctor failed: ${String(check.result.error)}\n`,
    );
    return 1;
  }

  for (const message of check.messages) {
    options.stderr.write(`${message}\n`);
  }
  options.stdout.write(
    options.json
      ? `${JSON.stringify(check.result, null, 2)}\n`
      : `${formatDoctorHuman(check.result)}\n`,
  );
  return check.result.ok ? 0 : 1;
}
