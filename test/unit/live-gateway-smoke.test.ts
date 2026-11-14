import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const projectRoot = new URL("../..", import.meta.url).pathname;

function runScript(args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, ["scripts/live-gateway-smoke.mjs", ...args], {
    cwd: projectRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      ...env,
    },
    timeout: 5000,
  });
}

describe("live Gateway smoke script", () => {
  it("requires explicit billable confirmation", () => {
    const result = runScript([]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--billable");
    expect(result.stdout).toBe("");
  });

  it("requires explicit billable confirmation for the expanded matrix", () => {
    const result = runScript(["--matrix"]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--billable");
    expect(result.stdout).toBe("");
  });

  it("requires explicit billable confirmation for the bounded Crawl", () => {
    const result = runScript(["--crawl"]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--billable");
    expect(result.stdout).toBe("");
  });

  it("prints help without reading credentials", () => {
    const result = runScript(["--help"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("--billable");
    expect(result.stdout).toContain("--matrix");
    expect(result.stdout).toContain("--crawl");
    expect(result.stderr).toBe("");
  });
});
