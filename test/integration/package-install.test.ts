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
    expect(result.stdout).toContain("Installed deepseek-crawl@0.11.0 from its package tarball.");
    expect(result.stdout).toContain("Installed CLI version: 0.11.0");
    expect(result.stdout).toContain("Installed Skill setup command is available.");
    expect(result.stdout).toContain("Installed Batch Fetch job commands are available.");
    expect(result.stdout).toContain(
      "Verified packaged init with environment credentials and a copied Skill.",
    );
    expect(result.stdout).toContain("Verified packaged init conflict handling with --force.");
    expect(result.stdout).toContain(
      "Verified packaged init JSON failure without a billable request.",
    );
    if (process.platform !== "darwin") {
      expect(result.stdout).toContain("Verified packaged init with a piped API key.");
    }
    expect(result.stderr).toBe("");
  }, 120_000);
});
