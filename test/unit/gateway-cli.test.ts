import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../../src/cli/run.js";
import type { CredentialName, CredentialStore } from "../../src/credentials/store.js";
import { listGatewayRuntimeStates, writeGatewayRuntimeState } from "../../src/gateway/runtime.js";
import { writer } from "../helpers/cli.js";

function store(value?: string): CredentialStore {
  return {
    name: "keychain",
    get: () => value,
    set: () => undefined,
    remove: () => undefined,
  };
}

function dependencies(
  runtimeDirectory: string,
  credentialStores: Partial<Record<CredentialName, CredentialStore>> = {},
) {
  const stdout = writer();
  const stderr = writer();
  return {
    deps: {
      env: {},
      fetchImpl: (async () => Response.json({ status: "ok", pid: process.pid })) as typeof fetch,
      stdout,
      stderr,
      stdin: process.stdin,
      gatewayRuntimeDirectory: runtimeDirectory,
      credentialStores,
    },
    stdout,
    stderr,
  };
}

async function runtimeDirectory() {
  return mkdtemp(join(tmpdir(), "deepseek-gateway-cli-"));
}

describe("gateway discovery commands", () => {
  it("prints the URL of the only running gateway", async () => {
    const directory = await runtimeDirectory();
    await writeGatewayRuntimeState(directory, {
      version: 1,
      pid: process.pid,
      url: "http://127.0.0.1:8788/",
      mode: "local",
      startedAt: "2026-11-14T00:00:00.000Z",
    });
    const { deps, stdout, stderr } = dependencies(directory);

    expect(await runCli(["gateway", "url"], deps)).toBe(0);
    expect(stdout.value()).toBe("http://127.0.0.1:8788/\n");
    expect(stderr.value()).toBe("");
  });

  it("requires a port when multiple gateways are running", async () => {
    const directory = await runtimeDirectory();
    for (const url of ["http://127.0.0.1:8787/", "http://127.0.0.1:8788/"]) {
      await writeGatewayRuntimeState(directory, {
        version: 1,
        pid: process.pid,
        url,
        mode: "local",
        startedAt: `2026-11-14T00:00:0${url.endsWith("8787/") ? "0" : "1"}.000Z`,
      });
    }
    const { deps, stderr } = dependencies(directory);

    expect(await runCli(["gateway", "url"], deps)).toBe(1);
    expect(stderr.value()).toContain("--port");
  });

  it("reports running instances and prunes stale state", async () => {
    const directory = await runtimeDirectory();
    await writeGatewayRuntimeState(directory, {
      version: 1,
      pid: process.pid,
      url: "http://127.0.0.1:8787/",
      mode: "local",
      startedAt: "2026-11-14T00:00:00.000Z",
    });
    await writeGatewayRuntimeState(directory, {
      version: 1,
      pid: 999_999,
      url: "http://127.0.0.1:8788/",
      mode: "local",
      startedAt: "2026-11-14T00:00:01.000Z",
    });
    const { deps, stdout } = dependencies(directory, {
      deepseek: store("deepseek-secret"),
      firecrawl: store("firecrawl-secret"),
      gateway: store(),
    });

    expect(await runCli(["gateway", "status", "--json"], deps)).toBe(0);
    expect(JSON.parse(stdout.value())).toMatchObject({
      running: true,
      stale: 1,
      instances: [
        {
          url: "http://127.0.0.1:8787/",
          started_at: "2026-11-14T00:00:00.000Z",
        },
      ],
      credentials: {
        deepseek: { configured: true, source: "keychain" },
        firecrawl: { configured: true, source: "keychain" },
        gateway_auth: { configured: false, source: "missing" },
      },
    });
    expect(await listGatewayRuntimeStates(directory)).toHaveLength(1);
  });

  it("reports provider mode and cooldown from a running gateway", async () => {
    const directory = await runtimeDirectory();
    await writeGatewayRuntimeState(directory, {
      version: 1,
      pid: process.pid,
      url: "http://127.0.0.1:8787/",
      mode: "local",
      startedAt: "2026-11-14T00:00:00.000Z",
    });
    const environment = dependencies(directory);
    environment.deps.fetchImpl = (async () =>
      Response.json({
        status: "ok",
        pid: process.pid,
        provider_mode: "deepseek-first",
        credits_cooldown_seconds: 0,
        max_concurrent_requests: 200,
        max_concurrent_provider_requests: 50,
        max_active_crawl_jobs: 5,
        max_retained_crawl_jobs: 20,
        max_retained_crawl_bytes: 1048576,
      })) as typeof fetch;

    expect(await runCli(["gateway", "status", "--json"], environment.deps)).toBe(0);
    expect(JSON.parse(environment.stdout.value())).toMatchObject({
      instances: [
        {
          provider_mode: "deepseek-first",
          credits_cooldown_seconds: 0,
          max_concurrent_requests: 200,
          max_concurrent_provider_requests: 50,
          max_active_crawl_jobs: 5,
          max_retained_crawl_jobs: 20,
          max_retained_crawl_bytes: 1_048_576,
        },
      ],
    });

    const human = dependencies(directory);
    human.deps.fetchImpl = environment.deps.fetchImpl;
    expect(await runCli(["gateway", "status"], human.deps)).toBe(0);
    expect(human.stdout.value()).toContain("provider=deepseek-first");
    expect(human.stdout.value()).toContain("cooldown=0s");
    expect(human.stdout.value()).toContain("http=200");
    expect(human.stdout.value()).toContain("provider_requests=50");
    expect(human.stdout.value()).toContain("crawl_jobs=5");
    expect(human.stdout.value()).toContain("retained_jobs=20");
    expect(human.stdout.value()).toContain("retained_bytes=1048576");
  });

  it("prints provider readiness in human-readable status when stopped", async () => {
    const directory = await runtimeDirectory();
    const { deps, stdout } = dependencies(directory, {
      deepseek: store("deepseek-secret"),
      firecrawl: store(),
      gateway: store(),
    });

    expect(await runCli(["gateway", "status"], deps)).toBe(0);
    expect(stdout.value()).toContain("Gateway is not running");
    expect(stdout.value()).toContain("DeepSeek: configured via keychain");
    expect(stdout.value()).toContain("Firecrawl: not configured (keychain)");
    expect(stdout.value()).toContain("Gateway auth: not configured (keychain)");
    expect(stdout.value()).not.toContain("deepseek-secret");
  });
});
