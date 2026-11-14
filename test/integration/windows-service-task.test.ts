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
      execFileSync(
        "schtasks.exe",
        ["/Create", "/TN", taskName, "/XML", paths.serviceDefinitionPath, "/F"],
        { encoding: "utf8", stdio: "pipe" },
      );
      const query = execFileSync("schtasks.exe", ["/Query", "/TN", taskName, "/FO", "LIST"], {
        encoding: "utf8",
        stdio: "pipe",
      });
      expect(query).toContain(taskName);
    } finally {
      try {
        execFileSync("schtasks.exe", ["/Delete", "/TN", taskName, "/F"], {
          encoding: "utf8",
          stdio: "pipe",
        });
      } catch {
        // Best-effort cleanup for a task that may not have been created.
      }
      await uninstallGatewayService(context);
    }
  });
});
