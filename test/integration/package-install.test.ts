import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));

describe("published package", () => {
  it("installs in isolation and exposes the CLI and Skill setup", () => {
    const result = spawnSync(process.execPath, ["scripts/verify-package-install.mjs"], {
      cwd: projectRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        npm_config_dry_run: "true",
      },
      timeout: 120_000,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Installed deepseek-crawl@0.10.0 from its package tarball.");
    expect(result.stdout).toContain("Installed CLI version: 0.10.0");
    expect(result.stdout).toContain("Installed Skill setup command is available.");
    expect(result.stderr).toBe("");
  }, 120_000);
});
