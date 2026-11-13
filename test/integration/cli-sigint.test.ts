import { spawn } from "node:child_process";
import { mkdtemp, stat } from "node:fs/promises";
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

function spawnCli(args: string[], baseUrl: string) {
  const child = spawn(process.execPath, ["dist/bin.js", ...args], {
    cwd: projectRoot,
    env: {
      ...process.env,
      DEEPSEEK_API_KEY: "offline-test-key",
      DEEPSEEK_BASE_URL: baseUrl,
      DEEPSEEK_MAX_RETRIES: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    },
  );
  return { child, closed, stderr: () => stderr };
}

describe("CLI SIGINT handling", () => {
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
});
