import { readFile } from "node:fs/promises";

const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const expectedTag = `v${packageJson.version}`;
const actualTag = process.env.GITHUB_REF_NAME;

if (!actualTag) {
  console.error("GITHUB_REF_NAME is required to validate a release tag.");
  process.exit(1);
}

if (actualTag !== expectedTag) {
  console.error(`Release tag ${actualTag} does not match package version ${packageJson.version}.`);
  process.exit(1);
}

console.log(`Release tag ${actualTag} matches package version ${packageJson.version}.`);
