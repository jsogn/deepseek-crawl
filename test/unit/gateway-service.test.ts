import { lstat, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type GatewayCommandRunner,
  type GatewayServiceContext,
  getGatewayServiceStatus,
  installGatewayService,
  resolveGatewayServicePaths,
  startGatewayService,
  stopGatewayService,
  uninstallGatewayService,
} from "../../src/gateway/service.js";
import { packageVersion } from "../../src/version.js";

const CLOUD_API_URL = "https://api.firecrawl.dev";
const LOCAL_API_URL = "http://127.0.0.1:8787";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

class FakeLaunchctl {
  running = false;
  delayedBootoutPolls = 0;
  bootstrapEioFailures = 0;
  readonly calls: string[][] = [];
  #pendingBootout = false;
  #bootoutPollsRemaining = 0;

  readonly run: GatewayCommandRunner = async (command, args) => {
    this.calls.push([command, ...args]);
    if (command !== "launchctl") {
      throw new Error(`Unexpected command: ${command}`);
    }
    if (args[0] === "print") {
      if (this.#pendingBootout) {
        if (this.#bootoutPollsRemaining > 0) {
          this.#bootoutPollsRemaining -= 1;
        } else {
          this.#pendingBootout = false;
          this.running = false;
        }
      }
      return this.running
        ? { exitCode: 0, stdout: "state = running\npid = 4242\n", stderr: "" }
        : { exitCode: 1, stdout: "", stderr: "Could not find service." };
    }
    if (args[0] === "bootstrap") {
      if (this.bootstrapEioFailures > 0) {
        this.bootstrapEioFailures -= 1;
        return {
          exitCode: 5,
          stdout: "",
          stderr: "Bootstrap failed: 5: Input/output error",
        };
      }
      this.running = true;
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "bootout") {
      if (this.delayedBootoutPolls > 0) {
        this.#pendingBootout = true;
        this.#bootoutPollsRemaining = this.delayedBootoutPolls;
      } else {
        this.running = false;
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    throw new Error(`Unexpected launchctl arguments: ${args.join(" ")}`);
  };
}

class FakeWindowsScheduler {
  registered = false;
  enabled = false;
  running = false;
  childAlive = false;
  readonly childPid = 5151;
  readonly calls: string[][] = [];

  readonly run: GatewayCommandRunner = async (command, args) => {
    this.calls.push([command, ...args]);
    if (command === "whoami") {
      return {
        exitCode: 0,
        stdout: '"DOMAIN\\\\runner","S-1-5-21-1000-1001-1002-1003"\r\n',
        stderr: "",
      };
    }
    if (command === "powershell.exe") {
      const script = args.at(-1) ?? "";
      if (script.includes("Get-NetTCPConnection")) {
        return this.childAlive
          ? { exitCode: 0, stdout: String(this.childPid), stderr: "" }
          : { exitCode: 1, stdout: "", stderr: "" };
      }
      if (script.includes("Get-Process")) {
        return this.childAlive
          ? { exitCode: 0, stdout: "1", stderr: "" }
          : { exitCode: 1, stdout: "", stderr: "" };
      }
      if (!this.registered) {
        return { exitCode: 1, stdout: "", stderr: "Task not found." };
      }
      const state = this.running ? "Running" : this.enabled ? "Ready" : "Disabled";
      return { exitCode: 0, stdout: state, stderr: "" };
    }
    if (command !== "schtasks") {
      if (command === "taskkill.exe") {
        this.childAlive = false;
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      throw new Error(`Unexpected command: ${command}`);
    }
    const action = args[0]?.toLowerCase();
    if (action === "/create") {
      this.registered = true;
      this.enabled = true;
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (action === "/change") {
      this.enabled = args.some((argument) => argument.toUpperCase() === "/ENABLE");
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (action === "/run") {
      this.running = true;
      this.childAlive = true;
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (action === "/end") {
      this.running = false;
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (action === "/delete") {
      this.registered = false;
      this.enabled = false;
      this.running = false;
      this.childAlive = false;
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    throw new Error(`Unexpected schtasks arguments: ${args.join(" ")}`);
  };
}

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "deepseek-crawl-service-"));
  temporaryDirectories.push(home);
  const paths = resolveGatewayServicePaths(home, "darwin");
  await mkdir(dirname(paths.firecrawlCredentialsPath), { recursive: true });
  await writeFile(
    paths.firecrawlCredentialsPath,
    `${JSON.stringify({ apiKey: "fc-secret", apiUrl: CLOUD_API_URL, custom: "keep" }, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );

  const launchctl = new FakeLaunchctl();
  const context: GatewayServiceContext = {
    home,
    platform: "darwin",
    uid: 501,
    nodePath: "/Users/Test User/.nvm/versions/node/v22.23.4/bin/node",
    cliPath: "/Users/Test User/lib/node_modules/deepseek-crawl/dist/bin.js",
    env: { PATH: "/usr/bin:/bin" },
    runCommand: launchctl.run,
    fetchImpl: async () =>
      Response.json({
        status: "ok",
        version: packageVersion,
        pid: 4242,
        provider_mode: "deepseek-first",
      }),
    wait: async () => undefined,
    healthTimeoutMs: 1_000,
  };
  return { context, launchctl, paths };
}

async function windowsFixture() {
  const home = await mkdtemp(join(tmpdir(), "deepseek-crawl-service-windows-"));
  temporaryDirectories.push(home);
  const env = {
    APPDATA: join(home, "AppData", "Roaming"),
    LOCALAPPDATA: join(home, "AppData", "Local"),
  };
  const paths = resolveGatewayServicePaths(home, "win32", env);
  await mkdir(dirname(paths.firecrawlCredentialsPath), { recursive: true });
  await writeFile(
    paths.firecrawlCredentialsPath,
    `${JSON.stringify({ apiKey: "fc-windows", apiUrl: CLOUD_API_URL }, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  const scheduler = new FakeWindowsScheduler();
  const context: GatewayServiceContext = {
    home,
    platform: "win32",
    uid: 0,
    nodePath: "C:\\Program Files\\nodejs\\node.exe",
    cliPath:
      "C:\\Users\\Test User\\AppData\\Roaming\\npm\\node_modules\\deepseek-crawl\\dist\\bin.js",
    env,
    runCommand: scheduler.run,
    fetchImpl: async () =>
      Response.json({
        status: "ok",
        version: packageVersion,
        pid: 5151,
        provider_mode: "deepseek-first",
      }),
    wait: async () => undefined,
    healthTimeoutMs: 1_000,
  };
  return { context, paths, scheduler };
}

function advancedFetch(gatewayHealth: () => Response): typeof fetch {
  return async (input) => {
    const url = String(input);
    if (url === "http://127.0.0.1:3002/healthz") {
      return new Response("ok");
    }
    if (url === "http://127.0.0.1:3002/v2/crawl/active") {
      return Response.json([]);
    }
    return gatewayHealth();
  };
}

describe.skipIf(process.platform === "win32")("managed Gateway service", () => {
  it("installs a persistent service and points the Firecrawl CLI at it", async () => {
    const { context, launchctl, paths } = await fixture();

    const status = await installGatewayService(context, {
      providerMode: "deepseek-first",
      port: 8787,
    });

    expect(status).toMatchObject({
      supported: true,
      installed: true,
      desired_running: true,
      running: true,
      healthy: true,
      client_targets_gateway: true,
      provider_mode: "deepseek-first",
      cli_version: packageVersion,
      gateway_version: packageVersion,
      version_matches_cli: true,
      gateway_url: `${LOCAL_API_URL}/`,
    });
    expect(launchctl.calls.some((call) => call[1] === "bootstrap")).toBe(true);
    expect(await readFile(paths.launcherPath, "utf8")).toContain(
      "/Users/Test User/.nvm/versions/node/v22.23.4/bin/node",
    );
    expect(await readFile(paths.serviceDefinitionPath, "utf8")).toContain("<key>KeepAlive</key>");
    expect(await readFile(paths.statePath, "utf8")).not.toContain("fc-secret");
    expect((await stat(paths.firecrawlCredentialsPath)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(paths.firecrawlCredentialsPath, "utf8"))).toMatchObject({
      apiKey: "fc-secret",
      apiUrl: LOCAL_API_URL,
      custom: "keep",
    });
  });

  it("does not probe PageSift for a default install", async () => {
    const { context } = await fixture();
    const calls: string[] = [];
    context.fetchImpl = async (input) => {
      calls.push(String(input));
      return Response.json({ status: "ok", pid: 4242, provider_mode: "firecrawl-first" });
    };

    await installGatewayService(context, {
      providerMode: "firecrawl-first",
      port: 8787,
    });

    expect(calls.every((url) => !url.includes(":3002"))).toBe(true);
  });

  it("installs a light capacity profile and can return to standard limits", async () => {
    const { context, paths } = await fixture();

    const light = await installGatewayService(context, {
      providerMode: "deepseek-first",
      port: 8787,
      light: true,
    });
    const launcher = await readFile(paths.launcherPath, "utf8");

    expect(light.capacity_profile).toBe("light");
    expect(launcher).toContain(
      "--max-concurrent-requests 10 --max-provider-requests 4 " +
        "--max-crawl-jobs 2 --max-retained-crawl-jobs 4 " +
        "--max-retained-crawl-bytes 33554432",
    );
    expect(JSON.parse(await readFile(paths.statePath, "utf8"))).toMatchObject({
      capacityProfile: "light",
    });

    const preserved = await installGatewayService(context, {
      providerMode: "deepseek-first",
      port: 8787,
    });
    expect(preserved.capacity_profile).toBe("light");

    const standard = await installGatewayService(context, {
      providerMode: "deepseek-first",
      port: 8787,
      noLight: true,
    });
    expect(standard.capacity_profile).toBe("standard");
    expect(await readFile(paths.launcherPath, "utf8")).not.toContain("--max-concurrent-requests");
  });

  it("persists advanced settings and passes them to the managed process", async () => {
    const { context, paths } = await fixture();
    context.fetchImpl = advancedFetch(() =>
      Response.json({ status: "ok", pid: 4242, provider_mode: "firecrawl-first" }),
    );

    const status = await installGatewayService(context, {
      providerMode: "firecrawl-first",
      port: 8787,
      advanced: true,
      advancedUrl: "http://127.0.0.1:3002",
    });

    expect(status.advanced_backend).toMatchObject({
      enabled: true,
      provider: "pagesift",
      api_ready: true,
    });
    expect(await readFile(paths.launcherPath, "utf8")).toContain(
      "--advanced --advanced-url 'http://127.0.0.1:3002/'",
    );
    expect(JSON.parse(await readFile(paths.statePath, "utf8"))).toMatchObject({
      advancedBackend: {
        provider: "pagesift",
        url: "http://127.0.0.1:3002/",
      },
    });
  });

  it("does not modify install state when PageSift preflight fails", async () => {
    const { context, paths } = await fixture();
    context.fetchImpl = async (input) => {
      if (String(input).endsWith("/healthz")) {
        return new Response("not pagesift");
      }
      return Response.json({ status: "ok", pid: 4242 });
    };

    await expect(
      installGatewayService(context, {
        providerMode: "firecrawl-first",
        port: 8787,
        advanced: true,
      }),
    ).rejects.toThrow(/PageSift/i);

    await expect(lstat(paths.statePath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(JSON.parse(await readFile(paths.firecrawlCredentialsPath, "utf8")).apiUrl).toBe(
      CLOUD_API_URL,
    );
  });

  it("requires a stored PageSift key for a managed remote backend", async () => {
    const { context } = await fixture();
    context.env = {
      PATH: "/usr/bin:/bin",
      PAGESIFT_API_KEY: "environment-only-secret",
    };
    context.credentialStores = {
      pagesift: {
        name: "keychain",
        get: () => undefined,
        set: () => undefined,
        remove: () => undefined,
      },
    };
    context.fetchImpl = advancedFetch(() =>
      Response.json({ status: "ok", pid: 4242, provider_mode: "firecrawl-first" }),
    );

    await expect(
      installGatewayService(context, {
        providerMode: "firecrawl-first",
        port: 8787,
        advanced: true,
        advancedUrl: "https://pagesift.example/",
      }),
    ).rejects.toThrow(/PageSift.*credential/i);
  });

  it("rejects PageSift configuration in no-fallback mode", async () => {
    const { context } = await fixture();

    await expect(
      installGatewayService(context, {
        providerMode: "no-fallback",
        port: 8787,
        advanced: true,
      }),
    ).rejects.toThrow(/no-fallback/i);
  });

  it("preserves advanced settings when reinstall omits advanced flags", async () => {
    const { context, paths } = await fixture();
    context.fetchImpl = advancedFetch(() =>
      Response.json({ status: "ok", pid: 4242, provider_mode: "firecrawl-first" }),
    );

    await installGatewayService(context, {
      providerMode: "firecrawl-first",
      port: 8787,
      advanced: true,
      advancedUrl: "http://127.0.0.1:3002",
    });
    await installGatewayService(context, {
      providerMode: "firecrawl-first",
      port: 8787,
    });

    expect(JSON.parse(await readFile(paths.statePath, "utf8"))).toMatchObject({
      advancedBackend: {
        provider: "pagesift",
        url: "http://127.0.0.1:3002/",
      },
    });
  });

  it("removes advanced settings with noAdvanced", async () => {
    const { context, paths } = await fixture();
    context.fetchImpl = advancedFetch(() =>
      Response.json({ status: "ok", pid: 4242, provider_mode: "firecrawl-first" }),
    );

    await installGatewayService(context, {
      providerMode: "firecrawl-first",
      port: 8787,
      advanced: true,
      advancedUrl: "http://127.0.0.1:3002",
    });
    await installGatewayService(context, {
      providerMode: "firecrawl-first",
      port: 8787,
      noAdvanced: true,
    });

    const state = JSON.parse(await readFile(paths.statePath, "utf8"));
    expect(state.advancedBackend).toBeUndefined();
    expect(await readFile(paths.launcherPath, "utf8")).not.toContain("--advanced");
  });

  it("reports an unreachable advanced backend as a service issue", async () => {
    const { context } = await fixture();
    context.fetchImpl = advancedFetch(() =>
      Response.json({ status: "ok", pid: 4242, provider_mode: "firecrawl-first" }),
    );
    await installGatewayService(context, {
      providerMode: "firecrawl-first",
      port: 8787,
      advanced: true,
      advancedUrl: "http://127.0.0.1:3002",
    });

    context.fetchImpl = async (input) =>
      String(input) === "http://127.0.0.1:3002/healthz"
        ? new Response("not pagesift")
        : Response.json({ status: "ok", pid: 4242, provider_mode: "firecrawl-first" });
    const status = await getGatewayServiceStatus(context);

    expect(status.advanced_backend).toMatchObject({
      enabled: true,
      reachable: false,
      api_ready: false,
    });
    expect(status.issues).toContain("Advanced PageSift backend is unreachable.");
  });

  it("restores the cloud endpoint when stopped and reapplies the proxy when started", async () => {
    const { context, paths } = await fixture();
    await installGatewayService(context, { providerMode: "deepseek-first", port: 8787 });

    const stopped = await stopGatewayService(context);
    expect(stopped).toMatchObject({
      installed: true,
      desired_running: false,
      running: false,
      client_targets_gateway: false,
      issues: [],
    });
    expect(JSON.parse(await readFile(paths.firecrawlCredentialsPath, "utf8")).apiUrl).toBe(
      CLOUD_API_URL,
    );

    const started = await startGatewayService(context);
    expect(started).toMatchObject({
      installed: true,
      desired_running: true,
      running: true,
      healthy: true,
      client_targets_gateway: true,
    });
    expect(JSON.parse(await readFile(paths.firecrawlCredentialsPath, "utf8")).apiUrl).toBe(
      LOCAL_API_URL,
    );
  });

  it("removes managed service, state, and logs during uninstall", async () => {
    const { context, paths } = await fixture();
    await installGatewayService(context, { providerMode: "deepseek-first", port: 8787 });
    await writeFile(join(paths.logsDirectory, "gateway.err.log"), "log\n", "utf8");

    const status = await uninstallGatewayService(context);

    expect(status).toMatchObject({
      supported: true,
      installed: false,
      desired_running: false,
      running: false,
      client_targets_gateway: false,
    });
    await expect(readFile(paths.serviceDefinitionPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readFile(paths.launcherPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(paths.logsDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    const credentials = JSON.parse(await readFile(paths.firecrawlCredentialsPath, "utf8"));
    expect(credentials).toMatchObject({ apiKey: "fc-secret", apiUrl: CLOUD_API_URL });
  });

  it("reports installed services that are no longer healthy", async () => {
    const { context, launchctl } = await fixture();
    await installGatewayService(context, { providerMode: "deepseek-first", port: 8787 });
    launchctl.running = false;
    context.fetchImpl = async () => {
      throw new Error("connection refused");
    };

    const status = await getGatewayServiceStatus(context);

    expect(status).toMatchObject({
      installed: true,
      desired_running: true,
      running: false,
      healthy: false,
      client_targets_gateway: true,
    });
    expect(status.issues.join(" ")).toMatch(/not running|unhealthy|unavailable/i);
  });

  it("reports version drift without marking a healthy service as unavailable", async () => {
    const { context } = await fixture();
    await installGatewayService(context, { providerMode: "deepseek-first", port: 8787 });
    context.fetchImpl = async () =>
      Response.json({
        status: "ok",
        version: "0.14.0",
        pid: 4242,
        provider_mode: "deepseek-first",
      });

    const status = await getGatewayServiceStatus(context);

    expect(status).toMatchObject({
      healthy: true,
      cli_version: packageVersion,
      gateway_version: "0.14.0",
      version_matches_cli: false,
    });
    expect(status.issues.join(" ")).toMatch(
      new RegExp(`gateway.*0\\.14\\.0.*cli.*${packageVersion.replaceAll(".", "\\.")}`, "i"),
    );
  });

  it("waits for launchd to finish unloading before reporting stopped", async () => {
    const { context, launchctl } = await fixture();
    await installGatewayService(context, { providerMode: "deepseek-first", port: 8787 });
    launchctl.delayedBootoutPolls = 2;

    const stopped = await stopGatewayService(context);

    expect(stopped).toMatchObject({
      desired_running: false,
      running: false,
      healthy: false,
      client_targets_gateway: false,
      issues: [],
    });
    expect(launchctl.calls.filter((call) => call[1] === "print").length).toBeGreaterThanOrEqual(3);
  });

  it("retries launchd bootstrap when an immediate reinstall reports EIO", async () => {
    const { context, launchctl } = await fixture();
    await installGatewayService(context, { providerMode: "deepseek-first", port: 8787 });
    launchctl.bootstrapEioFailures = 1;

    const status = await installGatewayService(context, {
      providerMode: "deepseek-first",
      port: 8787,
    });

    expect(status).toMatchObject({
      installed: true,
      desired_running: true,
      running: true,
      healthy: true,
      provider_mode: "deepseek-first",
    });
    expect(launchctl.calls.filter((call) => call[1] === "bootstrap")).toHaveLength(3);
  });

  it("restores the Firecrawl endpoint when installation health fails", async () => {
    const { context, paths } = await fixture();
    context.fetchImpl = async () => {
      throw new Error("connection refused");
    };
    context.healthTimeoutMs = 1;

    await expect(
      installGatewayService(context, { providerMode: "deepseek-first", port: 8787 }),
    ).rejects.toThrow(/healthy/i);

    expect(JSON.parse(await readFile(paths.firecrawlCredentialsPath, "utf8")).apiUrl).toBe(
      CLOUD_API_URL,
    );
    await expect(lstat(paths.serviceDefinitionPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(paths.statePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("restores the cloud endpoint when migrating an unmanaged local API URL", async () => {
    const { context, paths } = await fixture();
    await writeFile(
      paths.firecrawlCredentialsPath,
      `${JSON.stringify({ apiKey: "fc-secret", apiUrl: LOCAL_API_URL }, null, 2)}\n`,
      "utf8",
    );

    await installGatewayService(context, { providerMode: "deepseek-first", port: 8787 });
    await uninstallGatewayService(context);

    expect(JSON.parse(await readFile(paths.firecrawlCredentialsPath, "utf8")).apiUrl).toBe(
      CLOUD_API_URL,
    );
  });
});

describe("managed Windows Gateway service", () => {
  it("installs a per-user scheduled task and points the Firecrawl CLI at it", async () => {
    const { context, paths, scheduler } = await windowsFixture();

    const status = await installGatewayService(context, {
      providerMode: "deepseek-first",
      port: 8787,
    });

    expect(status).toMatchObject({
      supported: true,
      installed: true,
      desired_running: true,
      running: true,
      healthy: true,
      client_targets_gateway: true,
      provider_mode: "deepseek-first",
      gateway_url: `${LOCAL_API_URL}/`,
    });
    expect(await readFile(paths.launcherPath, "utf8")).toContain("@echo off");
    const taskXml = await readFile(paths.serviceDefinitionPath, "utf16le");
    expect(taskXml).toContain("<Task version=");
    expect(taskXml).toContain("<UserId>S-1-5-21-1000-1001-1002-1003</UserId>");
    expect(scheduler.calls.some((call) => call[1]?.toLowerCase() === "/create")).toBe(true);
    expect(JSON.parse(await readFile(paths.firecrawlCredentialsPath, "utf8"))).toMatchObject({
      apiKey: "fc-windows",
      apiUrl: LOCAL_API_URL,
    });
  });

  it("passes advanced settings to the Windows launcher", async () => {
    const { context, paths } = await windowsFixture();
    context.fetchImpl = advancedFetch(() =>
      Response.json({ status: "ok", pid: 5151, provider_mode: "firecrawl-first" }),
    );

    await installGatewayService(context, {
      providerMode: "firecrawl-first",
      port: 8787,
      advanced: true,
      advancedUrl: "http://127.0.0.1:3002",
      light: true,
    });

    expect(await readFile(paths.launcherPath, "utf8")).toContain(
      '--advanced --advanced-url "http://127.0.0.1:3002/"',
    );
    const launcher = await readFile(paths.launcherPath, "utf8");
    expect(launcher).toContain(
      "--max-concurrent-requests 10 --max-provider-requests 4 " +
        "--max-crawl-jobs 2 --max-retained-crawl-jobs 4 " +
        "--max-retained-crawl-bytes 33554432",
    );
    expect(launcher).toContain('set "DEEPSEEK_GATEWAY_ADVANCED_URL="');
    expect(launcher).toContain('set "PAGESIFT_API_KEY="');
  });

  it("stops, restarts, and fully uninstalls the Windows task", async () => {
    const { context, paths, scheduler } = await windowsFixture();
    await installGatewayService(context, { providerMode: "deepseek-first", port: 8787 });

    const stopped = await stopGatewayService(context);
    expect(stopped).toMatchObject({
      desired_running: false,
      running: false,
      client_targets_gateway: false,
      issues: [],
    });
    expect(JSON.parse(await readFile(paths.firecrawlCredentialsPath, "utf8")).apiUrl).toBe(
      CLOUD_API_URL,
    );
    expect(
      scheduler.calls.some(
        (call) =>
          call[0] === "taskkill.exe" &&
          call.includes(String(scheduler.childPid)) &&
          call.includes("/T") &&
          call.includes("/F"),
      ),
    ).toBe(true);

    const started = await startGatewayService(context);
    expect(started).toMatchObject({
      desired_running: true,
      running: true,
      healthy: true,
      client_targets_gateway: true,
    });

    const uninstalled = await uninstallGatewayService(context);
    expect(uninstalled).toMatchObject({
      installed: false,
      running: false,
      client_targets_gateway: false,
    });
    expect(scheduler.registered).toBe(false);
    await expect(lstat(paths.serviceDefinitionPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(JSON.parse(await readFile(paths.firecrawlCredentialsPath, "utf8")).apiUrl).toBe(
      CLOUD_API_URL,
    );
  });
});
