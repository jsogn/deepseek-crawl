import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      npm_config_dry_run: "false",
    },
    maxBuffer: 10 * 1024 * 1024,
  });

  if (result.error) {
    throw new Error(`${command} failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const details = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");
    throw new Error(`${command} ${args.join(" ")} exited ${result.status}.\n${details}`);
  }

  return result;
}

let temporaryRoot;

try {
  const packageJson = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8"));
  temporaryRoot = await mkdtemp(join(tmpdir(), "deepseek-crawl-package-"));

  const packed = run(
    npmCommand,
    ["pack", "--json", "--pack-destination", temporaryRoot],
    projectRoot,
  );
  const packedResult = JSON.parse(packed.stdout);
  const packedPackage = Array.isArray(packedResult)
    ? packedResult[0]
    : Object.values(packedResult)[0];
  const tarball = join(temporaryRoot, packedPackage.filename);
  const consumerRoot = join(temporaryRoot, "consumer");
  await mkdir(consumerRoot);

  run(
    npmCommand,
    [
      "install",
      "--prefer-offline",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--prefix",
      consumerRoot,
      tarball,
    ],
    consumerRoot,
  );

  const installedRoot = join(consumerRoot, "node_modules", packageJson.name);
  const binary = join(installedRoot, "dist", "bin.js");
  const version = run(process.execPath, [binary, "--version"], consumerRoot).stdout.trim();
  if (version !== packageJson.version) {
    throw new Error(`Installed CLI reports ${version}; expected ${packageJson.version}.`);
  }

  const skill = await readFile(join(installedRoot, "skills", "deepseek-crawl", "SKILL.md"), "utf8");
  if (!/^name:\s*deepseek-crawl\s*$/m.test(skill)) {
    throw new Error("Installed package does not contain the deepseek-crawl Agent Skill.");
  }

  const setupHelp = run(
    process.execPath,
    [binary, "setup", "skills", "--help"],
    consumerRoot,
  ).stdout;
  if (!setupHelp.includes("--agent")) {
    throw new Error("Installed Skill setup command is missing expected help output.");
  }

  console.log(`Installed ${packageJson.name}@${packageJson.version} from its package tarball.`);
  console.log(`Installed CLI version: ${version}`);
  console.log("Installed Skill setup command is available.");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  if (temporaryRoot) {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}
