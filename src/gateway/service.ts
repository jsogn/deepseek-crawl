import { spawn } from "node:child_process";
import { chmod, lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "../output/files.js";
import type { GatewayProviderMode } from "./config.js";

const SERVICE_LABEL = "com.jsogn.deepseek-crawl.gateway";
const WINDOWS_TASK_NAME = "DeepSeek Crawl Gateway";
const CLOUD_API_URL = "https://api.firecrawl.dev";
const HEALTH_POLL_MS = 250;
const DEFAULT_HEALTH_TIMEOUT_MS = 15_000;
const STOP_POLL_MS = 100;
const STOP_TIMEOUT_MS = 5_000;

export interface GatewayCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type GatewayCommandRunner = (
  command: string,
  args: string[],
) => Promise<GatewayCommandResult>;

export interface GatewayServiceContext {
  home: string;
  platform: NodeJS.Platform;
  uid: number;
  nodePath: string;
  cliPath: string;
  env?: NodeJS.ProcessEnv;
  runCommand?: GatewayCommandRunner;
  fetchImpl?: typeof fetch;
  wait?: (milliseconds: number) => Promise<void>;
  healthTimeoutMs?: number;
}

export interface GatewayServicePaths {
  serviceDirectory: string;
  launcherPath: string;
  statePath: string;
  serviceDefinitionPath: string;
  logsDirectory: string;
  firecrawlCredentialsPath: string;
}

interface FirecrawlApiUrlSnapshot {
  present: boolean;
  value?: unknown;
}

interface GatewayServiceState {
  version: 1;
  providerMode: GatewayProviderMode;
  port: number;
  desiredRunning: boolean;
  installedAt: string;
  originalFirecrawlApiUrl: FirecrawlApiUrlSnapshot;
}

export interface GatewayServiceStatus {
  supported: boolean;
  installed: boolean;
  desired_running: boolean;
  running: boolean;
  healthy: boolean;
  client_targets_gateway: boolean;
  provider_mode: GatewayProviderMode | null;
  gateway_url: string | null;
  client_api_url: string | null;
  service_path: string | null;
  issues: string[];
}

export interface GatewayServiceManager {
  install(options: {
    providerMode: GatewayProviderMode;
    port: number;
  }): Promise<GatewayServiceStatus>;
  start(): Promise<GatewayServiceStatus>;
  stop(): Promise<GatewayServiceStatus>;
  uninstall(): Promise<GatewayServiceStatus>;
  status(): Promise<GatewayServiceStatus>;
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function runCommand(command: string, args: string[]): Promise<GatewayCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });
  });
}

function localGatewayUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}

function normalizedUrl(value: string | null | undefined): string | null {
  return value?.replace(/\/+$/, "") || null;
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validateProviderMode(value: unknown): GatewayProviderMode {
  if (value === "firecrawl-first" || value === "deepseek-first" || value === "no-fallback") {
    return value;
  }
  throw new Error("Gateway service state contains an invalid provider mode.");
}

function validatePort(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 65_535) {
    throw new Error("Gateway service state contains an invalid port.");
  }
  return value as number;
}

export function resolveGatewayServicePaths(
  home: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): GatewayServicePaths {
  if (platform === "darwin") {
    const serviceDirectory = join(
      home,
      "Library",
      "Application Support",
      "deepseek-crawl",
      "gateway",
    );
    return {
      serviceDirectory,
      launcherPath: join(serviceDirectory, "gateway-service.sh"),
      statePath: join(serviceDirectory, "service.json"),
      serviceDefinitionPath: join(home, "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`),
      logsDirectory: join(home, "Library", "Logs", "deepseek-crawl"),
      firecrawlCredentialsPath: join(
        home,
        "Library",
        "Application Support",
        "firecrawl-cli",
        "credentials.json",
      ),
    };
  }
  if (platform === "win32") {
    const appData = env.APPDATA?.trim() || join(home, "AppData", "Roaming");
    const localAppData = env.LOCALAPPDATA?.trim() || join(home, "AppData", "Local");
    const serviceDirectory = join(appData, "deepseek-crawl", "gateway");
    return {
      serviceDirectory,
      launcherPath: join(serviceDirectory, "gateway-service.cmd"),
      statePath: join(serviceDirectory, "service.json"),
      serviceDefinitionPath: join(serviceDirectory, "gateway-task.xml"),
      logsDirectory: join(localAppData, "deepseek-crawl", "logs"),
      firecrawlCredentialsPath: join(appData, "firecrawl-cli", "credentials.json"),
    };
  }
  throw new Error("Managed Gateway services are supported on macOS and Windows only.");
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function readServiceState(path: string): Promise<GatewayServiceState | undefined> {
  let serialized: string;
  try {
    serialized = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new Error("Gateway service state is not valid JSON.");
  }
  if (!isRecord(value) || value.version !== 1 || typeof value.installedAt !== "string") {
    throw new Error("Gateway service state is invalid.");
  }
  if (!isRecord(value.originalFirecrawlApiUrl)) {
    throw new Error("Gateway service state is missing the Firecrawl API URL backup.");
  }
  return {
    version: 1,
    providerMode: validateProviderMode(value.providerMode),
    port: validatePort(value.port),
    desiredRunning: value.desiredRunning !== false,
    installedAt: value.installedAt,
    originalFirecrawlApiUrl: {
      present: value.originalFirecrawlApiUrl.present === true,
      ...(Object.hasOwn(value.originalFirecrawlApiUrl, "value")
        ? { value: value.originalFirecrawlApiUrl.value }
        : {}),
    },
  };
}

async function readFirecrawlCredentials(
  path: string,
): Promise<Record<string, unknown> | undefined> {
  let serialized: string;
  try {
    serialized = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new Error("Firecrawl CLI credentials are not valid JSON.");
  }
  if (!isRecord(value)) {
    throw new Error("Firecrawl CLI credentials must contain a JSON object.");
  }
  return value;
}

async function writeFirecrawlCredentials(
  path: string,
  credentials: Record<string, unknown>,
): Promise<void> {
  await writeFileAtomic(path, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });
}

function firecrawlApiSnapshot(
  credentials: Record<string, unknown>,
  port: number,
): FirecrawlApiUrlSnapshot {
  const present = Object.hasOwn(credentials, "apiUrl");
  const value = credentials.apiUrl;
  if (
    present &&
    typeof value === "string" &&
    normalizedUrl(value) === normalizedUrl(localGatewayUrl(port))
  ) {
    return { present: true, value: CLOUD_API_URL };
  }
  return { present, ...(present ? { value } : {}) };
}

async function setFirecrawlApiUrl(path: string, apiUrl: string): Promise<void> {
  const credentials = await readFirecrawlCredentials(path);
  if (!credentials) {
    throw new Error("Firecrawl CLI credentials were not found. Run `firecrawl config` first.");
  }
  await writeFirecrawlCredentials(path, { ...credentials, apiUrl });
}

async function restoreFirecrawlApiUrl(
  path: string,
  snapshot: FirecrawlApiUrlSnapshot,
): Promise<void> {
  const credentials = await readFirecrawlCredentials(path);
  if (!credentials) {
    return;
  }
  if (snapshot.present) {
    credentials.apiUrl = snapshot.value;
  } else {
    delete credentials.apiUrl;
  }
  await writeFirecrawlCredentials(path, credentials);
}

async function currentFirecrawlApiUrl(path: string): Promise<string | null> {
  const credentials = await readFirecrawlCredentials(path);
  return typeof credentials?.apiUrl === "string" ? credentials.apiUrl : null;
}

async function writeServiceState(path: string, state: GatewayServiceState): Promise<void> {
  await writeFileAtomic(path, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

async function writeServiceFiles(
  context: GatewayServiceContext,
  paths: GatewayServicePaths,
  state: GatewayServiceState,
): Promise<void> {
  await mkdir(paths.serviceDirectory, { recursive: true, mode: 0o700 });
  await mkdir(paths.logsDirectory, { recursive: true, mode: 0o700 });
  if (context.platform === "win32") {
    const launcher = [
      "@echo off",
      `"${context.nodePath}" "${context.cliPath}" gateway --provider-mode ${state.providerMode} --port ${state.port} 1>>"${join(paths.logsDirectory, "gateway.log")}" 2>>"${join(paths.logsDirectory, "gateway.err.log")}"`,
      "",
    ].join("\r\n");
    await writeFileAtomic(paths.launcherPath, launcher, { mode: 0o600 });
    const user = await (await commandRunner(context))("whoami", ["/user", "/fo", "csv", "/nh"]);
    const sid = user.stdout.match(/S-\d-(?:\d+-)+\d+/)?.[0];
    if (user.exitCode !== 0 || !sid) {
      throw new Error("Could not determine the current Windows user SID.");
    }
    const taskArguments = `/d /c ""${paths.launcherPath}""`;
    const taskXml = `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Author>deepseek-crawl</Author>
    <Description>Run the DeepSeek Crawl Firecrawl-compatible Gateway.</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${sid}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>true</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>3</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>cmd.exe</Command>
      <Arguments>${xmlEscape(taskArguments)}</Arguments>
      <WorkingDirectory>${xmlEscape(paths.serviceDirectory)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
    await writeFile(paths.serviceDefinitionPath, `\ufeff${taskXml}`, {
      encoding: "utf16le",
      mode: 0o600,
    });
    await writeServiceState(paths.statePath, state);
    return;
  }

  const launcher = [
    "#!/bin/sh",
    "set -eu",
    "umask 077",
    `exec ${shellQuote(context.nodePath)} ${shellQuote(context.cliPath)} gateway --provider-mode ${shellQuote(state.providerMode)} --port ${state.port}`,
    "",
  ].join("\n");
  await writeFileAtomic(paths.launcherPath, launcher, { mode: 0o700 });
  await chmod(paths.launcherPath, 0o700);

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>${xmlEscape(paths.launcherPath)}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xmlEscape(context.env?.PATH ?? "/usr/bin:/bin")}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${xmlEscape(join(paths.logsDirectory, "gateway.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(join(paths.logsDirectory, "gateway.err.log"))}</string>
</dict>
</plist>
`;
  await writeFileAtomic(paths.serviceDefinitionPath, plist, { mode: 0o644 });
  await writeServiceState(paths.statePath, state);
}

function launchctlTarget(context: GatewayServiceContext): string {
  return `gui/${context.uid}/${SERVICE_LABEL}`;
}

async function commandRunner(context: GatewayServiceContext): Promise<GatewayCommandRunner> {
  return context.runCommand ?? runCommand;
}

interface ServiceRuntimeInfo {
  exists: boolean;
  running: boolean;
  pid?: number;
}

async function serviceRuntimeInfo(context: GatewayServiceContext): Promise<ServiceRuntimeInfo> {
  if (context.platform === "win32") {
    const result = await (await commandRunner(context))("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `$task = Get-ScheduledTask -TaskName '${WINDOWS_TASK_NAME}' -ErrorAction SilentlyContinue; if ($null -eq $task) { exit 1 }; [Console]::Out.Write($task.State)`,
    ]);
    if (result.exitCode !== 0) {
      return { exists: false, running: false };
    }
    const state = result.stdout.trim().toLowerCase();
    return {
      exists: true,
      running: state === "running",
    };
  }

  const result = await (await commandRunner(context))("launchctl", [
    "print",
    launchctlTarget(context),
  ]);
  if (result.exitCode !== 0) {
    return { exists: false, running: false };
  }
  const pidMatch = result.stdout.match(/^\s*pid\s*=\s*(\d+)\s*$/m);
  return {
    exists: true,
    running: /^\s*state\s*=\s*running\s*$/m.test(result.stdout),
    ...(pidMatch ? { pid: Number(pidMatch[1]) } : {}),
  };
}

async function windowsListenerPid(
  context: GatewayServiceContext,
  port: number | undefined,
): Promise<number | undefined> {
  if (port === undefined) {
    return undefined;
  }
  const result = await (await commandRunner(context))("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    `$connection = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; if ($null -eq $connection) { exit 1 }; [Console]::Out.Write($connection.OwningProcess)`,
  ]);
  if (result.exitCode !== 0) {
    return undefined;
  }
  const pid = Number(result.stdout.trim());
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

async function windowsProcessIsAlive(
  context: GatewayServiceContext,
  pid: number,
): Promise<boolean> {
  const result = await (await commandRunner(context))("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    `if (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { [Console]::Out.Write('1') } else { exit 1 }`,
  ]);
  return result.exitCode === 0;
}

async function stopService(
  context: GatewayServiceContext,
  port?: number,
): Promise<number | undefined> {
  const runner = await commandRunner(context);
  if (context.platform === "win32") {
    const info = await serviceRuntimeInfo(context);
    if (!info.exists) {
      return undefined;
    }
    const pid = await windowsListenerPid(context, port);
    const disabled = await runner("schtasks", ["/Change", "/TN", WINDOWS_TASK_NAME, "/DISABLE"]);
    if (disabled.exitCode !== 0 && !/not found|does not exist/i.test(disabled.stderr)) {
      throw new Error(disabled.stderr.trim() || "Could not disable the Gateway task.");
    }
    const ended = await runner("schtasks", ["/End", "/TN", WINDOWS_TASK_NAME]);
    if (ended.exitCode !== 0 && !/not running|not found|does not exist/i.test(ended.stderr)) {
      throw new Error(ended.stderr.trim() || "Could not stop the Gateway task.");
    }
    if (pid !== undefined) {
      const killed = await runner("taskkill.exe", ["/PID", String(pid), "/T", "/F"]);
      if (
        killed.exitCode !== 0 &&
        !/not found|no running instance|does not exist/i.test(killed.stderr)
      ) {
        throw new Error(killed.stderr.trim() || "Could not stop the Gateway process tree.");
      }
    }
    return pid;
  }

  const result = await runner("launchctl", ["bootout", launchctlTarget(context)]);
  if (
    result.exitCode !== 0 &&
    !/could not find|no such process|not found/i.test(`${result.stdout}\n${result.stderr}`)
  ) {
    throw new Error(result.stderr.trim() || "Could not stop the Gateway service.");
  }
  return undefined;
}

async function waitForStopped(context: GatewayServiceContext, processId?: number): Promise<void> {
  const delay = context.wait ?? wait;
  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (
      context.platform === "win32" &&
      processId !== undefined &&
      (await windowsProcessIsAlive(context, processId))
    ) {
      await delay(STOP_POLL_MS);
      continue;
    }
    const info = await serviceRuntimeInfo(context);
    if (!info.exists || !info.running) {
      return;
    }
    await delay(STOP_POLL_MS);
  }
  throw new Error("Gateway service did not stop.");
}

async function bootoutAndWait(context: GatewayServiceContext, port?: number): Promise<void> {
  const processId = await stopService(context, port);
  await waitForStopped(context, processId);
}

async function startService(
  context: GatewayServiceContext,
  paths: GatewayServicePaths,
): Promise<void> {
  const runner = await commandRunner(context);
  if (context.platform === "win32") {
    const created = await runner("schtasks", [
      "/Create",
      "/TN",
      WINDOWS_TASK_NAME,
      "/XML",
      paths.serviceDefinitionPath,
      "/F",
    ]);
    if (created.exitCode !== 0) {
      throw new Error(created.stderr.trim() || "Could not register the Gateway task.");
    }
    const enabled = await runner("schtasks", ["/Change", "/TN", WINDOWS_TASK_NAME, "/ENABLE"]);
    if (enabled.exitCode !== 0) {
      throw new Error(enabled.stderr.trim() || "Could not enable the Gateway task.");
    }
    const started = await runner("schtasks", ["/Run", "/TN", WINDOWS_TASK_NAME]);
    if (started.exitCode !== 0) {
      throw new Error(started.stderr.trim() || "Could not start the Gateway task.");
    }
    return;
  }

  const started = await runner("launchctl", [
    "bootstrap",
    `gui/${context.uid}`,
    paths.serviceDefinitionPath,
  ]);
  if (started.exitCode !== 0) {
    throw new Error(started.stderr.trim() || "Could not start the Gateway service.");
  }
}

async function deleteRegisteredService(context: GatewayServiceContext): Promise<void> {
  if (context.platform !== "win32") {
    return;
  }
  const result = await (await commandRunner(context))("schtasks", [
    "/Delete",
    "/TN",
    WINDOWS_TASK_NAME,
    "/F",
  ]);
  if (result.exitCode !== 0 && !/not found|does not exist/i.test(result.stderr)) {
    throw new Error(result.stderr.trim() || "Could not delete the Gateway task.");
  }
}

async function waitForHealthy(
  context: GatewayServiceContext,
  port: number,
  providerMode: GatewayProviderMode,
): Promise<void> {
  const fetchImpl = context.fetchImpl ?? fetch;
  const delay = context.wait ?? wait;
  const deadline = Date.now() + (context.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS);
  let lastError = "Gateway did not become healthy.";
  while (Date.now() < deadline) {
    const service = await serviceRuntimeInfo(context);
    if (service.running) {
      try {
        const response = await fetchImpl(new URL("healthz", `${localGatewayUrl(port)}/`), {
          signal: AbortSignal.timeout(750),
        });
        const health = (await response.json()) as {
          status?: unknown;
          pid?: unknown;
          provider_mode?: unknown;
        };
        if (
          response.ok &&
          health.status === "ok" &&
          (context.platform === "win32" || health.pid === service.pid) &&
          health.provider_mode === providerMode
        ) {
          return;
        }
        lastError = "Gateway health did not match the managed service.";
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    } else {
      lastError = "Gateway service did not produce a running process.";
    }
    await delay(HEALTH_POLL_MS);
  }
  throw new Error(`Gateway service did not become healthy: ${lastError}`);
}

async function startFromState(
  context: GatewayServiceContext,
  paths: GatewayServicePaths,
  state: GatewayServiceState,
  previousPort?: number,
): Promise<GatewayServiceStatus> {
  state.desiredRunning = true;
  await writeServiceFiles(context, paths, state);
  await bootoutAndWait(context, previousPort ?? state.port);
  await startService(context, paths);
  try {
    await waitForHealthy(context, state.port, state.providerMode);
    await setFirecrawlApiUrl(paths.firecrawlCredentialsPath, localGatewayUrl(state.port));
  } catch (error) {
    await bootoutAndWait(context, state.port).catch(() => undefined);
    await restoreFirecrawlApiUrl(paths.firecrawlCredentialsPath, state.originalFirecrawlApiUrl);
    throw error;
  }
  return getGatewayServiceStatus(context);
}

function unsupportedStatus(): GatewayServiceStatus {
  return {
    supported: false,
    installed: false,
    desired_running: false,
    running: false,
    healthy: false,
    client_targets_gateway: false,
    provider_mode: null,
    gateway_url: null,
    client_api_url: null,
    service_path: null,
    issues: ["Managed Gateway services are supported on macOS and Windows only."],
  };
}

export async function getGatewayServiceStatus(
  context: GatewayServiceContext,
): Promise<GatewayServiceStatus> {
  if (context.platform !== "darwin" && context.platform !== "win32") {
    return unsupportedStatus();
  }
  const paths = resolveGatewayServicePaths(context.home, context.platform, context.env);
  const state = await readServiceState(paths.statePath);
  if (!state) {
    return {
      supported: true,
      installed: false,
      desired_running: false,
      running: false,
      healthy: false,
      client_targets_gateway: false,
      provider_mode: null,
      gateway_url: null,
      client_api_url: normalizedUrl(await currentFirecrawlApiUrl(paths.firecrawlCredentialsPath)),
      service_path: null,
      issues: [],
    };
  }

  const [runtime, clientApiUrl, launcherExists, definitionExists] = await Promise.all([
    serviceRuntimeInfo(context),
    currentFirecrawlApiUrl(paths.firecrawlCredentialsPath),
    fileExists(paths.launcherPath),
    fileExists(paths.serviceDefinitionPath),
  ]);
  const expectedUrl = localGatewayUrl(state.port);
  let healthy = false;
  if (runtime.running) {
    try {
      const response = await (context.fetchImpl ?? fetch)(new URL("healthz", `${expectedUrl}/`), {
        signal: AbortSignal.timeout(750),
      });
      const health = (await response.json()) as {
        status?: unknown;
        pid?: unknown;
        provider_mode?: unknown;
      };
      healthy =
        response.ok &&
        health.status === "ok" &&
        (context.platform === "win32" || health.pid === runtime.pid) &&
        health.provider_mode === state.providerMode;
    } catch {
      healthy = false;
    }
  }
  const clientTargetsGateway = normalizedUrl(clientApiUrl) === normalizedUrl(expectedUrl);
  const issues: string[] = [];
  if (!launcherExists || !definitionExists) {
    issues.push("Managed service files are missing. Run `gateway install` again.");
  }
  if (state.desiredRunning && !runtime.running) {
    issues.push("Gateway service is not running.");
  } else if (state.desiredRunning && runtime.running && !healthy) {
    issues.push("Gateway service is running but unhealthy.");
  }
  if (state.desiredRunning && clientTargetsGateway && !healthy) {
    issues.push("Firecrawl CLI points to an unavailable Gateway.");
  }
  if (state.desiredRunning && healthy && !clientTargetsGateway) {
    issues.push("Firecrawl CLI is not targeting the managed Gateway.");
  }
  if (!state.desiredRunning && runtime.running) {
    issues.push("Gateway service is running while marked as stopped.");
  }
  return {
    supported: true,
    installed: launcherExists && definitionExists,
    desired_running: state.desiredRunning,
    running: runtime.running,
    healthy,
    client_targets_gateway: clientTargetsGateway,
    provider_mode: state.providerMode,
    gateway_url: `${expectedUrl}/`,
    client_api_url: normalizedUrl(clientApiUrl),
    service_path: paths.serviceDefinitionPath,
    issues,
  };
}

export async function installGatewayService(
  context: GatewayServiceContext,
  options: { providerMode: GatewayProviderMode; port: number },
): Promise<GatewayServiceStatus> {
  if (context.platform !== "darwin" && context.platform !== "win32") {
    throw new Error("Managed Gateway services are supported on macOS and Windows only.");
  }
  const paths = resolveGatewayServicePaths(context.home, context.platform, context.env);
  const existing = await readServiceState(paths.statePath);
  const credentials = await readFirecrawlCredentials(paths.firecrawlCredentialsPath);
  if (!credentials) {
    throw new Error("Firecrawl CLI credentials were not found. Run `firecrawl config` first.");
  }
  const state: GatewayServiceState = {
    version: 1,
    providerMode: options.providerMode,
    port: options.port,
    desiredRunning: true,
    installedAt: existing?.installedAt ?? new Date().toISOString(),
    originalFirecrawlApiUrl:
      existing?.originalFirecrawlApiUrl ?? firecrawlApiSnapshot(credentials, options.port),
  };
  await writeServiceFiles(context, paths, state);
  try {
    return await startFromState(context, paths, state, existing?.port);
  } catch (error) {
    await bootoutAndWait(context, state.port).catch(() => undefined);
    await restoreFirecrawlApiUrl(
      paths.firecrawlCredentialsPath,
      state.originalFirecrawlApiUrl,
    ).catch(() => undefined);
    await deleteRegisteredService(context).catch(() => undefined);
    await rm(paths.serviceDefinitionPath, { force: true }).catch(() => undefined);
    await rm(paths.launcherPath, { force: true }).catch(() => undefined);
    await rm(paths.statePath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function startGatewayService(
  context: GatewayServiceContext,
): Promise<GatewayServiceStatus> {
  if (context.platform !== "darwin" && context.platform !== "win32") {
    throw new Error("Managed Gateway services are supported on macOS and Windows only.");
  }
  const paths = resolveGatewayServicePaths(context.home, context.platform, context.env);
  const state = await readServiceState(paths.statePath);
  if (!state) {
    throw new Error("Managed Gateway service is not installed. Run `gateway install` first.");
  }
  return startFromState(context, paths, state);
}

export async function stopGatewayService(
  context: GatewayServiceContext,
): Promise<GatewayServiceStatus> {
  if (context.platform !== "darwin" && context.platform !== "win32") {
    throw new Error("Managed Gateway services are supported on macOS and Windows only.");
  }
  const paths = resolveGatewayServicePaths(context.home, context.platform, context.env);
  const state = await readServiceState(paths.statePath);
  if (!state) {
    return getGatewayServiceStatus(context);
  }
  try {
    await bootoutAndWait(context, state.port);
  } finally {
    await restoreFirecrawlApiUrl(paths.firecrawlCredentialsPath, state.originalFirecrawlApiUrl);
  }
  state.desiredRunning = false;
  await writeServiceState(paths.statePath, state);
  return getGatewayServiceStatus(context);
}

export async function uninstallGatewayService(
  context: GatewayServiceContext,
): Promise<GatewayServiceStatus> {
  if (context.platform !== "darwin" && context.platform !== "win32") {
    throw new Error("Managed Gateway services are supported on macOS and Windows only.");
  }
  const paths = resolveGatewayServicePaths(context.home, context.platform, context.env);
  const state = await readServiceState(paths.statePath);
  try {
    await bootoutAndWait(context, state?.port);
    await deleteRegisteredService(context);
  } finally {
    if (state) {
      await restoreFirecrawlApiUrl(paths.firecrawlCredentialsPath, state.originalFirecrawlApiUrl);
    } else {
      const credentials = await readFirecrawlCredentials(paths.firecrawlCredentialsPath);
      if (
        credentials &&
        typeof credentials.apiUrl === "string" &&
        /^http:\/\/127\.0\.0\.1:\d+\/?$/.test(credentials.apiUrl)
      ) {
        credentials.apiUrl = CLOUD_API_URL;
        await writeFirecrawlCredentials(paths.firecrawlCredentialsPath, credentials);
      }
    }
  }
  await rm(paths.serviceDefinitionPath, { force: true });
  await rm(paths.serviceDirectory, { recursive: true, force: true });
  await rm(paths.logsDirectory, { recursive: true, force: true });
  return getGatewayServiceStatus(context);
}

export function createGatewayServiceManager(context: GatewayServiceContext): GatewayServiceManager {
  return {
    install: (options) => installGatewayService(context, options),
    start: () => startGatewayService(context),
    stop: () => stopGatewayService(context),
    uninstall: () => uninstallGatewayService(context),
    status: () => getGatewayServiceStatus(context),
  };
}
