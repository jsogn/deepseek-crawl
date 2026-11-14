import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

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
    const result = checkReleaseTag("v0.10.0");

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("Release tag v0.10.0 matches package version 0.10.0.");
    expect(result.stderr).toBe("");
  });

  it("rejects a tag that differs from the package version", () => {
    const result = checkReleaseTag("v0.9.1");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Release tag v0.9.1 does not match package version 0.10.0.");
  });
});
