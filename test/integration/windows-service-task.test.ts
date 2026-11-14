import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type GatewayCommandRunner,
  installGatewayService,
  resolveGatewayServicePaths,
  uninstallGatewayService,
} from "../../src/gateway/service.js";

const temporaryDirectories: string[] = [];

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor(
  condition: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) {
      return;
    }
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function runSchtasks(args: string[]): string {
  try {
    return execFileSync("schtasks.exe", args, {
      encoding: "utf8",
      stdio: "pipe",
      timeout: 15_000,
      windowsHide: true,
    });
  } catch (error) {
    const failure = error as Error & { stdout?: Buffer | string; stderr?: Buffer | string };
    const stdout = Buffer.isBuffer(failure.stdout)
      ? failure.stdout.toString("utf8")
      : failure.stdout;
    const stderr = Buffer.isBuffer(failure.stderr)
      ? failure.stderr.toString("utf8")
      : failure.stderr;
    throw new Error(
      `schtasks ${args.join(" ")} failed: ${failure.message}\nstdout: ${stdout ?? ""}\nstderr: ${stderr ?? ""}`,
    );
  }
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe.runIf(process.platform === "win32")("Windows Scheduled Task integration", () => {
  it("registers the generated task XML with Task Scheduler", async () => {
    const home = await mkdtemp(join(tmpdir(), "deepseek-crawl-windows-task-"));
    temporaryDirectories.push(home);
    const env = {
      APPDATA: join(home, "AppData", "Roaming"),
      LOCALAPPDATA: join(home, "AppData", "Local"),
    };
    const paths = resolveGatewayServicePaths(home, "win32", env);
    await mkdir(dirname(paths.firecrawlCredentialsPath), { recursive: true });
    await writeFile(
      paths.firecrawlCredentialsPath,
      `${JSON.stringify({ apiKey: "fc-test", apiUrl: "https://api.firecrawl.dev" })}\n`,
      "utf8",
    );
    const whoami = execFileSync("whoami.exe", ["/user", "/fo", "csv", "/nh"], {
      encoding: "utf8",
    });
    let fakeRegistered = false;
    let fakeEnabled = false;
    let fakeRunning = false;
    const run: GatewayCommandRunner = async (command, args) => {
      if (command === "whoami") {
        return { exitCode: 0, stdout: whoami, stderr: "" };
      }
      if (command === "powershell.exe") {
        if (!fakeRegistered) {
          return { exitCode: 1, stdout: "", stderr: "Task not found." };
        }
        return {
          exitCode: 0,
          stdout: fakeRunning ? "Running" : fakeEnabled ? "Ready" : "Disabled",
          stderr: "",
        };
      }
      if (command === "schtasks") {
        const action = args[0]?.toLowerCase();
        if (action === "/create") {
          fakeRegistered = true;
          fakeEnabled = true;
        } else if (action === "/change") {
          fakeEnabled = args.some((argument) => argument.toUpperCase() === "/ENABLE");
        } else if (action === "/run") {
          fakeRunning = true;
        } else if (action === "/end") {
          fakeRunning = false;
        } else if (action === "/delete") {
          fakeRegistered = false;
          fakeEnabled = false;
          fakeRunning = false;
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
    };
    const context = {
      home,
      platform: "win32" as const,
      uid: 0,
      nodePath: process.execPath,
      cliPath: join(home, "bin.js"),
      env,
      runCommand: run,
      fetchImpl: async () =>
        Response.json({
          status: "ok",
          pid: process.pid,
          provider_mode: "deepseek-first",
        }),
      wait: async () => undefined,
      healthTimeoutMs: 1_000,
    };
    await installGatewayService(context, { providerMode: "deepseek-first", port: 8787 });
    const taskName = `DeepSeek Crawl Test ${randomUUID()}`;

    try {
      runSchtasks(["/Create", "/TN", taskName, "/XML", paths.serviceDefinitionPath, "/F"]);
      const query = runSchtasks(["/Query", "/TN", taskName, "/FO", "LIST"]);
      expect(query).toContain(taskName);
    } finally {
      try {
        runSchtasks(["/Delete", "/TN", taskName, "/F"]);
      } catch {
        // Best-effort cleanup for a task that may not have been created.
      }
      await uninstallGatewayService(context);
    }
  }, 30_000);

  it("runs and ends the scheduled task process tree repeatedly", async () => {
    const root = await mkdtemp(join(tmpdir(), "deepseek-crawl-windows-lifecycle-"));
    temporaryDirectories.push(root);
    const pidFile = join(root, "child.pid");
    const scriptPath = join(root, "keep-alive.cjs");
    const launcherPath = join(root, "launcher.cmd");
    const taskXmlPath = join(root, "task.xml");
    const taskName = `DeepSeek Crawl Lifecycle ${randomUUID()}`;
    await writeFile(
      scriptPath,
      'require("node:fs").writeFileSync(process.argv[2], String(process.pid)); setInterval(() => {}, 1000);\n',
      "utf8",
    );
    await writeFile(
      launcherPath,
      `@echo off\r\n"${process.execPath}" "${scriptPath}" "${pidFile}"\r\n`,
      "utf8",
    );
    const whoami = execFileSync("whoami.exe", ["/user", "/fo", "csv", "/nh"], {
      encoding: "utf8",
    });
    const sid = whoami.match(/S-\d-(?:\d+-)+\d+/)?.[0];
    if (!sid) {
      throw new Error("Could not determine the current Windows user SID.");
    }
    const taskXml = `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers/>
  <Principals>
    <Principal id="Author">
      <UserId>${sid}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <AllowHardTerminate>true</AllowHardTerminate>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>true</Hidden>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>cmd.exe</Command>
      <Arguments>${xmlEscape(`/d /c ""${launcherPath}""`)}</Arguments>
    </Exec>
  </Actions>
</Task>
`;
    await writeFile(taskXmlPath, `\ufeff${taskXml}`, "utf16le");
    let childPid: number | undefined;

    try {
      runSchtasks(["/Create", "/TN", taskName, "/XML", taskXmlPath, "/F"]);
      for (let run = 1; run <= 2; run += 1) {
        await rm(pidFile, { force: true });
        runSchtasks(["/Run", "/TN", taskName]);
        await waitFor(async () => {
          try {
            return (await readFile(pidFile, "utf8")).trim().length > 0;
          } catch {
            return false;
          }
        }, "child PID file");
        childPid = Number((await readFile(pidFile, "utf8")).trim());
        expect(processIsAlive(childPid)).toBe(true);

        runSchtasks(["/End", "/TN", taskName]);
        await waitFor(() => !processIsAlive(childPid as number), `run ${run} process exit`);
      }
    } finally {
      try {
        runSchtasks(["/End", "/TN", taskName]);
      } catch {
        // Best-effort stop before cleanup.
      }
      if (childPid !== undefined && processIsAlive(childPid)) {
        try {
          execFileSync("taskkill.exe", ["/PID", String(childPid), "/T", "/F"], {
            stdio: "ignore",
            windowsHide: true,
          });
        } catch {
          // Best-effort process cleanup.
        }
      }
      try {
        runSchtasks(["/Delete", "/TN", taskName, "/F"]);
      } catch {
        // Best-effort task cleanup.
      }
    }
  }, 60_000);
});
