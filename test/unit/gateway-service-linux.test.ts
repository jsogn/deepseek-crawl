import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
const LINUX_UNIT = "deepseek-crawl-gateway.service";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

class FakeSystemd {
  available = true;
  unitExists = false;
  enabled = false;
  active = false;
  mainPid = 6161;
  failStart = false;
  stopNotLoaded = false;
  readonly calls: string[][] = [];

  readonly run: GatewayCommandRunner = async (command, args) => {
    this.calls.push([command, ...args]);
    if (command !== "systemctl" || args[0] !== "--user") {
      throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
    }
    if (args[1] === "show-environment") {
      return this.available
        ? { exitCode: 0, stdout: "HOME=/home/test\n", stderr: "" }
        : { exitCode: 1, stdout: "", stderr: "Failed to connect to bus" };
    }
    if (args[1] === "daemon-reload") {
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (args[1] === "enable") {
      this.unitExists = true;
      this.enabled = true;
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (args[1] === "restart" || args[1] === "start") {
      if (this.failStart) {
        return { exitCode: 1, stdout: "", stderr: "Gateway failed to start" };
      }
      this.unitExists = true;
      this.active = true;
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (args[1] === "stop") {
      if (this.stopNotLoaded) {
        return {
          exitCode: 1,
          stdout: "",
          stderr: `Failed to stop ${LINUX_UNIT}: Unit ${LINUX_UNIT} not loaded.`,
        };
      }
      this.active = false;
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (args[1] === "disable") {
      if (this.stopNotLoaded && !this.unitExists) {
        return {
          exitCode: 1,
          stdout: "",
          stderr: `Unit ${LINUX_UNIT} not loaded.`,
        };
      }
      this.active = false;
      this.enabled = false;
      this.unitExists = false;
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (args[1] === "show" && args[2] === LINUX_UNIT) {
      if (!this.available) {
        return { exitCode: 1, stdout: "", stderr: "Failed to connect to bus" };
      }
      if (this.stopNotLoaded && !this.unitExists) {
        return {
          exitCode: 0,
          stdout: "LoadState=loaded\nActiveState=inactive\nMainPID=0\n",
          stderr: "",
        };
      }
      return {
        exitCode: 0,
        stdout: this.unitExists
          ? `LoadState=loaded\nActiveState=${this.active ? "active" : "inactive"}\nMainPID=${this.active ? this.mainPid : 0}\n`
          : "LoadState=not-found\nActiveState=inactive\nMainPID=0\n",
        stderr: "",
      };
    }
    throw new Error(`Unexpected systemctl arguments: ${args.join(" ")}`);
  };
}

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "deepseek-crawl-service-linux-"));
  temporaryDirectories.push(home);
  const env = {
    XDG_CONFIG_HOME: join(home, "config"),
    XDG_STATE_HOME: join(home, "state"),
  };
  const paths = resolveGatewayServicePaths(home, "linux", env);
  await mkdir(dirname(paths.firecrawlCredentialsPath), { recursive: true });
  await writeFile(
    paths.firecrawlCredentialsPath,
    `${JSON.stringify({ apiKey: "fc-linux", apiUrl: CLOUD_API_URL }, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );

  const systemd = new FakeSystemd();
  const context: GatewayServiceContext = {
    home,
    platform: "linux",
    uid: 1000,
    nodePath: "/home/test/.nvm/versions/node/v22.23.4/bin/node",
    cliPath: "/home/test/.nvm/versions/node/v22.23.4/lib/node_modules/deepseek-crawl/dist/bin.js",
    env,
    runCommand: systemd.run,
    fetchImpl: async () =>
      Response.json({
        status: "ok",
        version: packageVersion,
        pid: systemd.mainPid,
        provider_mode: "deepseek-first",
      }),
    wait: async () => undefined,
    healthTimeoutMs: 1_000,
  };
  return { context, paths, systemd };
}

describe("managed Linux Gateway service", () => {
  it("resolves XDG service, unit, log, and Firecrawl paths", () => {
    const paths = resolveGatewayServicePaths("/home/test", "linux", {
      XDG_CONFIG_HOME: "/home/test/custom-config",
      XDG_STATE_HOME: "/home/test/custom-state",
    });

    expect(paths).toEqual({
      serviceDirectory: "/home/test/custom-config/deepseek-crawl/gateway",
      launcherPath: "/home/test/custom-config/deepseek-crawl/gateway/gateway-service.sh",
      statePath: "/home/test/custom-config/deepseek-crawl/gateway/service.json",
      serviceDefinitionPath: `/home/test/custom-config/systemd/user/${LINUX_UNIT}`,
      logsDirectory: "/home/test/custom-state/deepseek-crawl/logs",
      firecrawlCredentialsPath: "/home/test/custom-config/firecrawl-cli/credentials.json",
    });
  });

  it("installs a systemd user service and points Firecrawl at it", async () => {
    const { context, paths, systemd } = await fixture();

    const status = await installGatewayService(context, {
      providerMode: "deepseek-first",
      port: 8787,
      light: true,
    });
    const unit = await readFile(paths.serviceDefinitionPath, "utf8");
    const launcher = await readFile(paths.launcherPath, "utf8");

    expect(status).toMatchObject({
      supported: true,
      installed: true,
      running: true,
      healthy: true,
      client_targets_gateway: true,
      provider_mode: "deepseek-first",
      capacity_profile: "light",
      gateway_version: packageVersion,
      version_matches_cli: true,
    });
    expect(unit).toContain(`[Unit]`);
    expect(unit).toContain(`ExecStart=/bin/sh "${paths.launcherPath}"`);
    expect(unit).toContain(`WorkingDirectory=${paths.serviceDirectory}`);
    expect(unit).not.toContain(`WorkingDirectory="${paths.serviceDirectory}"`);
    expect(unit).toContain("Restart=on-failure");
    expect(unit).toContain(`StandardError=append:${join(paths.logsDirectory, "gateway.err.log")}`);
    expect(launcher).toContain(`export HOME='${context.home}'`);
    expect(launcher).toContain(`export XDG_CONFIG_HOME='${envValue(context, "XDG_CONFIG_HOME")}'`);
    expect(launcher).toContain(`export XDG_STATE_HOME='${envValue(context, "XDG_STATE_HOME")}'`);
    expect(launcher).toContain(`--log-file '${join(paths.logsDirectory, "gateway.jsonl")}'`);
    expect(launcher).toContain("--max-concurrent-requests 10");
    expect(systemd.calls).toContainEqual(["systemctl", "--user", "daemon-reload"]);
    expect(systemd.calls).toContainEqual(["systemctl", "--user", "enable", LINUX_UNIT]);
    expect(systemd.calls).toContainEqual(["systemctl", "--user", "restart", LINUX_UNIT]);
    expect(JSON.parse(await readFile(paths.firecrawlCredentialsPath, "utf8"))).toMatchObject({
      apiKey: "fc-linux",
      apiUrl: LOCAL_API_URL,
    });
  });

  it("tolerates an unloaded unit discovered during first install", async () => {
    const { context, systemd } = await fixture();
    systemd.stopNotLoaded = true;

    const status = await installGatewayService(context, {
      providerMode: "deepseek-first",
      port: 8787,
    });

    expect(status).toMatchObject({
      installed: true,
      running: true,
      healthy: true,
      issues: [],
    });
  });

  it("stops, restarts, and fully uninstalls the Linux user service", async () => {
    const { context, paths, systemd } = await fixture();
    await installGatewayService(context, { providerMode: "deepseek-first", port: 8787 });

    const stopped = await stopGatewayService(context);
    expect(stopped).toMatchObject({
      installed: true,
      desired_running: false,
      running: false,
      client_targets_gateway: false,
    });
    expect(JSON.parse(await readFile(paths.firecrawlCredentialsPath, "utf8")).apiUrl).toBe(
      CLOUD_API_URL,
    );
    expect(systemd.enabled).toBe(false);

    const started = await startGatewayService(context);
    expect(started).toMatchObject({
      desired_running: true,
      running: true,
      healthy: true,
      client_targets_gateway: true,
    });
    expect(systemd.enabled).toBe(true);

    const uninstalled = await uninstallGatewayService(context);
    expect(uninstalled).toMatchObject({
      installed: false,
      running: false,
      client_targets_gateway: false,
    });
    expect(systemd.unitExists).toBe(false);
    await expect(lstat(paths.serviceDefinitionPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(paths.launcherPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(paths.logsDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    expect(JSON.parse(await readFile(paths.firecrawlCredentialsPath, "utf8")).apiUrl).toBe(
      CLOUD_API_URL,
    );
  });

  it("fails before modifying client state when systemd user manager is unavailable", async () => {
    const { context, paths, systemd } = await fixture();
    systemd.available = false;

    await expect(
      installGatewayService(context, { providerMode: "deepseek-first", port: 8787 }),
    ).rejects.toThrow(/systemd --user/i);
    await expect(lstat(paths.statePath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(JSON.parse(await readFile(paths.firecrawlCredentialsPath, "utf8")).apiUrl).toBe(
      CLOUD_API_URL,
    );
    const status = await getGatewayServiceStatus(context);
    expect(status).toMatchObject({
      supported: false,
      installed: false,
      running: false,
    });
    expect(status.issues.join(" ")).toMatch(/systemd --user/i);
  });

  it("rolls back files and the Firecrawl endpoint when systemd start fails", async () => {
    const { context, paths, systemd } = await fixture();
    systemd.failStart = true;

    await expect(
      installGatewayService(context, { providerMode: "deepseek-first", port: 8787 }),
    ).rejects.toThrow(/failed to start/i);

    await expect(lstat(paths.statePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(paths.serviceDefinitionPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(paths.launcherPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(JSON.parse(await readFile(paths.firecrawlCredentialsPath, "utf8")).apiUrl).toBe(
      CLOUD_API_URL,
    );
  });

  it("uninstalls cleanly when the systemd user manager becomes unavailable", async () => {
    const { context, paths, systemd } = await fixture();
    await installGatewayService(context, { providerMode: "deepseek-first", port: 8787 });
    systemd.available = false;

    const status = await uninstallGatewayService(context);

    expect(status).toMatchObject({
      supported: false,
      installed: false,
      running: false,
      client_targets_gateway: false,
    });
    await expect(lstat(paths.serviceDefinitionPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(paths.launcherPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(paths.statePath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(JSON.parse(await readFile(paths.firecrawlCredentialsPath, "utf8")).apiUrl).toBe(
      CLOUD_API_URL,
    );
  });
});

function envValue(context: GatewayServiceContext, name: string): string {
  const value = context.env?.[name];
  if (!value) {
    throw new Error(`Missing test environment variable ${name}.`);
  }
  return value;
}
