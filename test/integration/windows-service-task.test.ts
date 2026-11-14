import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
    const run: GatewayCommandRunner = async (command, args) => {
      if (command === "whoami") {
        return { exitCode: 0, stdout: whoami, stderr: "" };
      }
      if (command === "powershell.exe") {
        return { exitCode: 0, stdout: "Running", stderr: "" };
      }
      if (command === "schtasks") {
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
});
