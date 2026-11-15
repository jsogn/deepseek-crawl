import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const projectRoot = new URL("../..", import.meta.url).pathname;

function runScript(args: string[]) {
  return spawnSync(process.execPath, ["scripts/live-keyless-smoke.mjs", ...args], {
    cwd: projectRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      FIRECRAWL_API_KEY: "",
    },
    timeout: 5000,
  });
}

describe("live Keyless smoke script", () => {
  it("requires explicit confirmation before making a request", () => {
    const result = runScript([]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--confirm");
    expect(result.stdout).toBe("");
  });

  it("prints help without loading the gateway runtime", () => {
    const result = runScript(["--help"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("--confirm");
    expect(result.stdout).toContain("one Keyless Scrape");
    expect(result.stderr).toBe("");
  });

  it("publishes an explicit npm script", async () => {
    const packageJson = JSON.parse(
      await readFile(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { scripts?: Record<string, string> };

    expect(packageJson.scripts?.["test:live:keyless"]).toBe(
      "npm run build && node scripts/live-keyless-smoke.mjs --confirm",
    );
  });
});
