import { spawn } from "node:child_process";
import { mkdtemp, readdir, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const projectRoot = new URL("../..", import.meta.url).pathname;

interface SlowServer {
  baseUrl: string;
  requestStarted: Promise<void>;
  close(): Promise<void>;
}

interface ExhaustedFirecrawl {
  baseUrl: string;
  close(): Promise<void>;
}

async function startExhaustedFirecrawl(): Promise<ExhaustedFirecrawl> {
  const server = createServer((request, response) => {
    request.resume();
    request.once("end", () => {
      response.writeHead(402, { "content-type": "application/json" });
      response.end(JSON.stringify({ success: false, error: "Payment required." }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Firecrawl mock did not bind a TCP port.");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}/`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

async function startSlowDeepSeek(): Promise<SlowServer> {
  let resolveRequest!: () => void;
  const requestStarted = new Promise<void>((resolve) => {
    resolveRequest = resolve;
  });
  const server = createServer((request) => {
    request.resume();
    request.on("end", resolveRequest);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Slow DeepSeek server did not bind a TCP port.");
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}/`,
    requestStarted,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

function spawnCli(args: string[], baseUrl: string, env: NodeJS.ProcessEnv = {}) {
  const child = spawn(process.execPath, ["dist/bin.js", ...args], {
    cwd: projectRoot,
    env: {
      ...process.env,
      DEEPSEEK_API_KEY: "offline-test-key",
      DEEPSEEK_BASE_URL: baseUrl,
      DEEPSEEK_MAX_RETRIES: "0",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  let stdout = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    },
  );
  return {
    child,
    closed,
    stderr: () => stderr,
    stdout: () => stdout,
  };
}

async function waitFor(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("Timed out waiting for child process output.");
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("CLI signal handling", () => {
  it("aborts Crawl with exit 130 and removes staging", async () => {
    const root = await mkdtemp(join(tmpdir(), "deepseek-crawl-sigint-"));
    const output = join(root, "result");
    const server = await startSlowDeepSeek();
    const process = spawnCli(
      ["crawl", "https://example.com", "--max-depth", "0", "--output", output],
      server.baseUrl,
    );

    await server.requestStarted;
    process.child.kill("SIGINT");
    const result = await process.closed;
    await server.close();

    expect(result).toEqual({ code: 130, signal: null });
    expect(process.stderr()).toMatch(/cancelled/i);
    await expect(stat(output)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readdir(root)).filter((name) => name.startsWith(".result-"))).toEqual([]);
  }, 10_000);

  it("preserves default SIGINT termination for Fetch", async () => {
    const server = await startSlowDeepSeek();
    const process = spawnCli(["fetch", "https://example.com"], server.baseUrl);

    await server.requestStarted;
    process.child.kill("SIGINT");
    const result = await process.closed;
    await server.close();

    expect(result).toEqual({ code: null, signal: "SIGINT" });
  }, 10_000);

  it("gracefully stops the Gateway and clears runtime state on SIGTERM", async () => {
    const runtimeDirectory = await mkdtemp(join(tmpdir(), "deepseek-gateway-sigterm-"));
    const firecrawl = await startExhaustedFirecrawl();
    const server = await startSlowDeepSeek();
    const process = spawnCli(["gateway"], server.baseUrl, {
      DEEPSEEK_GATEWAY_RUNTIME_DIR: runtimeDirectory,
      FIRECRAWL_API_KEY: "offline-firecrawl-key",
      FIRECRAWL_UPSTREAM_URL: firecrawl.baseUrl,
    });

    await waitFor(() => /listening on http:\/\/127\.0\.0\.1:\d+\//.test(process.stdout()));
    const match = process.stdout().match(/listening on (http:\/\/127\.0\.0\.1:\d+\/)/);
    if (!match) {
      throw new Error("Gateway URL was not printed.");
    }
    const response = await fetch(new URL("/v2/crawl", match[1]), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: "https://example.com/",
        limit: 1,
        maxDiscoveryDepth: 0,
        sitemap: "skip",
      }),
    });
    expect(response.status).toBe(200);
    await server.requestStarted;

    process.child.kill("SIGTERM");
    const result = await process.closed;
    await server.close();
    await firecrawl.close();

    expect(result).toEqual({ code: 0, signal: null });
    expect(await readdir(runtimeDirectory)).toEqual([]);
  }, 10_000);
});
