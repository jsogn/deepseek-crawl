import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../../src/cli/run.js";
import { listGatewayRuntimeStates, writeGatewayRuntimeState } from "../../src/gateway/runtime.js";
import { writer } from "../helpers/cli.js";

function dependencies(runtimeDirectory: string) {
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
    const { deps, stdout } = dependencies(directory);

    expect(await runCli(["gateway", "status", "--json"], deps)).toBe(0);
    expect(JSON.parse(stdout.value())).toMatchObject({
      running: true,
      stale: 1,
      instances: [{ url: "http://127.0.0.1:8787/" }],
    });
    expect(await listGatewayRuntimeStates(directory)).toHaveLength(1);
  });
});
