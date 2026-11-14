import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { packageVersion } from "../../src/version.js";

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));

function checkReleaseTag(tag: string) {
  return spawnSync(process.execPath, ["scripts/check-release.mjs"], {
    cwd: projectRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      GITHUB_REF_NAME: tag,
    },
  });
}

describe("release tag check", () => {
  it("accepts the tag matching the package version", () => {
    const tag = `v${packageVersion}`;
    const result = checkReleaseTag(tag);

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(
      `Release tag ${tag} matches package version ${packageVersion}.`,
    );
    expect(result.stderr).toBe("");
  });

  it("rejects a tag that differs from the package version", () => {
    const result = checkReleaseTag(`v${packageVersion}-mismatch`);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      `Release tag v${packageVersion}-mismatch does not match package version ${packageVersion}.`,
    );
  });
});
