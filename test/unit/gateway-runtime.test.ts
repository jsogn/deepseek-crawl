import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  listGatewayRuntimeStates,
  pruneGatewayRuntimeStates,
  resolveGatewayRuntimeDirectory,
  writeGatewayRuntimeState,
} from "../../src/gateway/runtime.js";

describe("gateway runtime state", () => {
  it("uses XDG_RUNTIME_DIR when available", () => {
    expect(
      resolveGatewayRuntimeDirectory({ XDG_RUNTIME_DIR: "/run/user/1000" }, "/home/user", "linux"),
    ).toBe("/run/user/1000/deepseek-crawl/gateway");
  });

  it("keeps healthy instances and removes stale ones", async () => {
    const directory = await mkdtemp(join(tmpdir(), "deepseek-gateway-runtime-"));
    const active = {
      version: 1 as const,
      pid: process.pid,
      url: "http://127.0.0.1:8787/",
      mode: "local" as const,
      startedAt: "2026-11-14T00:00:00.000Z",
    };
    const stale = {
      ...active,
      pid: 999_999,
      url: "http://127.0.0.1:8788/",
      startedAt: "2026-11-14T00:00:01.000Z",
    };

    await writeGatewayRuntimeState(directory, active);
    await writeGatewayRuntimeState(directory, stale);
    expect(await listGatewayRuntimeStates(directory)).toHaveLength(2);

    const pruned = await pruneGatewayRuntimeStates(directory, async () =>
      Response.json({
        status: "ok",
        pid: process.pid,
        provider_mode: "no-fallback",
        credits_cooldown_seconds: 120,
        max_concurrent_requests: 200,
        max_concurrent_provider_requests: 50,
        max_active_crawl_jobs: 5,
        max_retained_crawl_jobs: 20,
        max_retained_crawl_bytes: 1048576,
      }),
    );

    expect(pruned).toEqual({
      running: [
        {
          ...active,
          providerMode: "no-fallback",
          creditsCooldownSeconds: 120,
          maxConcurrentRequests: 200,
          maxConcurrentProviderRequests: 50,
          maxActiveCrawlJobs: 5,
          maxRetainedCrawlJobs: 20,
          maxRetainedCrawlBytes: 1_048_576,
        },
      ],
      stale: 1,
    });
    expect(await listGatewayRuntimeStates(directory)).toEqual([active]);
    expect(await readdir(directory)).toHaveLength(1);
  });
});
