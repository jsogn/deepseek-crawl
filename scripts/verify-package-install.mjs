import { spawn } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const outputLimitBytes = 10 * 1024 * 1024;

function run(command, args, cwd, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: options.env ?? { ...process.env, npm_config_dry_run: "false" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let settled = false;

    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    };
    const collect = (chunk, target) => {
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > outputLimitBytes) {
        child.kill("SIGKILL");
        fail(new Error(`${command} produced more than ${outputLimitBytes} bytes of output.`));
        return target;
      }
      return target + chunk;
    };
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      fail(new Error(`${command} ${args.join(" ")} timed out.`));
    }, 120_000);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout = collect(chunk, stdout);
    });
    child.stderr.on("data", (chunk) => {
      stderr = collect(chunk, stderr);
    });
    child.on("error", (error) => {
      fail(new Error(`${command} failed: ${error.message}`));
    });
    child.on("close", (status) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ status, stdout, stderr });
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(options.input ?? "");
  });
}

async function runOk(command, args, cwd, options) {
  const result = await run(command, args, cwd, options);
  if (result.status !== 0) {
    const details = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");
    throw new Error(`${command} ${args.join(" ")} exited ${result.status}.\n${details}`);
  }
  return result;
}

function parseJsonOutput(result, label) {
  try {
    return JSON.parse(result.stdout.trim());
  } catch (error) {
    throw new Error(`${label} did not emit one valid JSON object.`, { cause: error });
  }
}

function isolatedEnvironment(home, baseUrl, apiKey) {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) =>
        !name.startsWith("DEEPSEEK_") &&
        !["HOME", "USERPROFILE", "XDG_CONFIG_HOME", "CODEX_HOME", "NODE_OPTIONS"].includes(name),
    ),
  );
  return {
    ...environment,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    CODEX_HOME: join(home, ".codex"),
    DEEPSEEK_BASE_URL: baseUrl,
    DEEPSEEK_TIMEOUT_MS: "5000",
    DEEPSEEK_MAX_RETRIES: "0",
    ...(apiKey === undefined ? {} : { DEEPSEEK_API_KEY: apiKey }),
    NO_COLOR: "1",
  };
}

async function startProbeServer() {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({
      method: request.method ?? "",
      url: request.url ?? "",
    });
    response.writeHead(404, { "content-type": "text/plain" });
    response.end("not found");
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Could not determine the local probe server address.");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}/`,
    requests,
    async close() {
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

function assertReadOnlyProbe(requests) {
  const mutation = requests.find((request) => request.method !== "GET");
  if (mutation) {
    throw new Error(`Packaged init made an unexpected ${mutation.method} ${mutation.url} request.`);
  }
}

function assertNoSecret(output, secret, label) {
  if (output.includes(secret)) {
    throw new Error(`${label} exposed the API key.`);
  }
}

async function verifyPackagedInit(binary, consumerRoot, temporaryRoot, probe) {
  const environmentHome = join(temporaryRoot, "home-environment");
  await mkdir(environmentHome);
  probe.requests.length = 0;
  const environmentResult = await runOk(
    process.execPath,
    [binary, "init", "--copy", "--json"],
    consumerRoot,
    {
      env: isolatedEnvironment(environmentHome, probe.baseUrl, "environment-test-key"),
    },
  );
  const environmentOutput = parseJsonOutput(environmentResult, "Packaged init");
  const environmentSkill = join(environmentHome, ".agents", "skills", "deepseek-crawl");
  const environmentSkillStat = await lstat(environmentSkill);
  if (
    environmentOutput.ok !== true ||
    environmentOutput.auth?.source !== "environment" ||
    environmentOutput.skills?.mode !== "copy" ||
    environmentOutput.doctor?.live !== "not_requested" ||
    environmentSkillStat.isSymbolicLink()
  ) {
    throw new Error("Packaged init did not produce the expected copied Skill result.");
  }
  const environmentSkillText = await readFile(join(environmentSkill, "SKILL.md"), "utf8");
  if (!/^name:\s*deepseek-crawl\s*$/m.test(environmentSkillText)) {
    throw new Error("Packaged init copied an invalid Agent Skill.");
  }
  assertNoSecret(environmentResult.stdout, "environment-test-key", "Packaged init stdout");
  assertNoSecret(environmentResult.stderr, "environment-test-key", "Packaged init stderr");
  assertReadOnlyProbe(probe.requests);

  const conflict = await run(process.execPath, [binary, "init", "--copy", "--json"], consumerRoot, {
    env: isolatedEnvironment(environmentHome, probe.baseUrl, "environment-test-key"),
  });
  if (conflict.status !== 1 || !/already exists/i.test(conflict.stderr)) {
    throw new Error("Packaged init did not reject an existing copied Skill destination.");
  }
  const forced = await runOk(
    process.execPath,
    [binary, "init", "--copy", "--force", "--json"],
    consumerRoot,
    {
      env: isolatedEnvironment(environmentHome, probe.baseUrl, "environment-test-key"),
    },
  );
  const forcedOutput = parseJsonOutput(forced, "Packaged init --force");
  if (forcedOutput.skills?.installs?.[0]?.status !== "replaced") {
    throw new Error("Packaged init --force did not replace the existing Skill.");
  }
  assertReadOnlyProbe(probe.requests);

  const failureHome = join(temporaryRoot, "home-failure");
  await mkdir(failureHome);
  probe.requests.length = 0;
  const failure = await run(
    process.execPath,
    [binary, "init", "--skip-auth", "--skip-skills", "--json"],
    consumerRoot,
    {
      env: isolatedEnvironment(failureHome, probe.baseUrl, "invalid\nkey"),
    },
  );
  const failureOutput = parseJsonOutput(failure, "Packaged init failure");
  if (
    failure.status !== 1 ||
    failureOutput.ok !== false ||
    failureOutput.doctor?.api_key !== "invalid" ||
    failureOutput.doctor?.live !== "not_requested" ||
    probe.requests.length !== 0
  ) {
    throw new Error("Packaged init did not emit the expected non-billable failure JSON.");
  }

  let pipedKeyVerified = false;
  if (process.platform !== "darwin") {
    const pipedHome = join(temporaryRoot, "home-piped-key");
    await mkdir(pipedHome);
    probe.requests.length = 0;
    const pipedKey = "piped-test-key";
    const piped = await runOk(
      process.execPath,
      [binary, "init", "--skip-skills", "--json"],
      consumerRoot,
      {
        env: isolatedEnvironment(pipedHome, probe.baseUrl),
        input: `${pipedKey}\n`,
      },
    );
    const pipedOutput = parseJsonOutput(piped, "Packaged init piped credential");
    const credentialsPath = join(pipedHome, ".config", "deepseek-crawl", "credentials.json");
    const credentialsStat = await stat(credentialsPath);
    if (
      pipedOutput.auth?.changed !== true ||
      pipedOutput.auth?.source !== "file" ||
      (credentialsStat.mode & 0o777) !== 0o600
    ) {
      throw new Error("Packaged init did not store the piped API key safely.");
    }
    assertNoSecret(piped.stdout, pipedKey, "Packaged init piped stdout");
    assertNoSecret(piped.stderr, pipedKey, "Packaged init piped stderr");
    assertReadOnlyProbe(probe.requests);
    pipedKeyVerified = true;
  }

  return { pipedKeyVerified };
}

let temporaryRoot;
let probe;

try {
  const packageJson = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8"));
  temporaryRoot = await mkdtemp(join(tmpdir(), "deepseek-crawl-package-"));

  const packed = await runOk(
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

  await runOk(
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
  const version = (
    await runOk(process.execPath, [binary, "--version"], consumerRoot)
  ).stdout.trim();
  if (version !== packageJson.version) {
    throw new Error(`Installed CLI reports ${version}; expected ${packageJson.version}.`);
  }

  const skill = await readFile(join(installedRoot, "skills", "deepseek-crawl", "SKILL.md"), "utf8");
  if (!/^name:\s*deepseek-crawl\s*$/m.test(skill)) {
    throw new Error("Installed package does not contain the deepseek-crawl Agent Skill.");
  }

  const setupHelp = (
    await runOk(process.execPath, [binary, "setup", "skills", "--help"], consumerRoot)
  ).stdout;
  if (!setupHelp.includes("--agent")) {
    throw new Error("Installed Skill setup command is missing expected help output.");
  }
  const fetchHelp = (await runOk(process.execPath, [binary, "fetch", "--help"], consumerRoot))
    .stdout;
  if (
    !fetchHelp.includes("--job-dir <dir>") ||
    !fetchHelp.includes("fetch resume <job-dir>") ||
    !fetchHelp.includes("fetch status <job-dir>")
  ) {
    throw new Error("Installed Batch Fetch job commands are missing expected help output.");
  }

  probe = await startProbeServer();
  const initChecks = await verifyPackagedInit(binary, consumerRoot, temporaryRoot, probe);

  console.log(`Installed ${packageJson.name}@${packageJson.version} from its package tarball.`);
  console.log(`Installed CLI version: ${version}`);
  console.log("Installed Skill setup command is available.");
  console.log("Installed Batch Fetch job commands are available.");
  console.log("Verified packaged init with environment credentials and a copied Skill.");
  console.log("Verified packaged init conflict handling with --force.");
  console.log("Verified packaged init JSON failure without a billable request.");
  if (initChecks.pipedKeyVerified) {
    console.log("Verified packaged init with a piped API key.");
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  if (probe) {
    await probe.close().catch(() => undefined);
  }
  if (temporaryRoot) {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}
