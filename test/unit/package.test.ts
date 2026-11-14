import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

async function readProjectFile(path: string): Promise<string> {
  return readFile(new URL(`../../${path}`, import.meta.url), "utf8");
}

describe("package executable", () => {
  it("prints the package version", () => {
    const result = spawnSync(process.execPath, ["dist/bin.js", "--version"], {
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("0.13.0");
    expect(result.stderr).toBe("");
  });

  it("groups the main help by user workflow", () => {
    const result = spawnSync(process.execPath, ["dist/bin.js", "--help"], {
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    for (const section of ["Core", "Gateway", "Credentials", "Jobs", "Integration"]) {
      expect(result.stdout).toContain(section);
    }
    expect(result.stderr).toBe("");
  });

  it("publishes the bundled Agent Skill", async () => {
    const packageJson = JSON.parse(
      await readFile(new URL("../../package.json", import.meta.url), "utf8"),
    ) as {
      files?: string[];
      description?: string;
      private?: boolean;
      license?: string;
      scripts?: Record<string, string>;
    };
    expect(packageJson.files).toContain("skills");
    expect(packageJson.files).toContain("README.en.md");
    expect(packageJson.files).toContain("LICENSE");
    expect(packageJson.description).toMatch(/CLI-first/i);
    expect(packageJson.description).toMatch(/MCP/i);
    expect(packageJson.description).toMatch(/optional Firecrawl-compatible gateway/i);
    expect(packageJson.private).not.toBe(true);
    expect(packageJson.license).toBe("MIT");
    expect(packageJson.scripts?.["smoke:docker"]).toBe("bash scripts/smoke-docker-gateway.sh");
    expect(packageJson.scripts?.["test:live:gateway"]).toBe(
      "npm run build && node scripts/live-gateway-smoke.mjs",
    );
  });
});

describe("package documentation", () => {
  it("documents every public CLI and MCP capability", async () => {
    const readme = await readFile(new URL("../../README.md", import.meta.url), "utf8");
    const readmeEnglish = await readFile(new URL("../../README.en.md", import.meta.url), "utf8");
    const allDocumentation = `${readme}\n${readmeEnglish}`;

    expect(readme).toContain("[English](README.en.md)");
    expect(readmeEnglish).toContain("[简体中文](README.md)");

    for (const text of [
      "deepseek-crawl map",
      "deepseek-crawl crawl",
      "deepseek_map",
      "deepseek_crawl",
      "robots.txt",
      "Firecrawl",
      "CLI-first",
      "skills/deepseek-crawl",
      "map <url> [--search <text>]",
      "deepseek-crawl crawl <url> -o <dir>",
      "MCP is optional",
      "deepseek-crawl init",
      "deepseek-crawl setup skills",
      "~/.agents/skills/deepseek-crawl",
      "--agent codex",
      "npx skills add jsogn/deepseek-crawl",
      "deepseek-crawl auth set",
      "deepseek-crawl auth import firecrawl",
      "deepseek-crawl auth status",
      "deepseek-crawl auth remove",
      "deepseek-crawl balance",
      "deepseek-crawl gateway",
      "test:live:gateway",
      "--matrix",
      "--crawl",
      "auth set firecrawl",
      "auth import firecrawl",
      "--remote",
      "deepseek-crawl fetch status",
      "--job-dir",
      "macOS Keychain",
      "DEEPSEEK_API_KEY",
      "fetch --input",
      "--output-dir",
      "--include-paths",
      "--exclude-paths",
      "--ignore-query-parameters",
      "FIRECRAWL_API_URL",
      "FIRECRAWL_UPSTREAM_URL",
      "DEEPSEEK_GATEWAY_PROVIDER_MODE",
      "DEEPSEEK_GATEWAY_CREDITS_COOLDOWN_SECONDS",
      "--provider-mode",
      "--credits-cooldown",
      "DEEPSEEK_GATEWAY_MAX_CONCURRENT_REQUESTS",
      "DEEPSEEK_GATEWAY_MAX_PROVIDER_REQUESTS",
      "DEEPSEEK_GATEWAY_MAX_CRAWL_JOBS",
      "DEEPSEEK_GATEWAY_MAX_RETAINED_CRAWL_JOBS",
      "DEEPSEEK_GATEWAY_MAX_RETAINED_CRAWL_BYTES",
      "--max-concurrent-requests",
      "--max-provider-requests",
      "--max-crawl-jobs",
      "--max-retained-crawl-jobs",
      "--max-retained-crawl-bytes",
      "GATEWAY_API_KEY",
      "Firecrawl-compatible",
      "gateway url",
      "gateway status",
      "provider_mode",
      "credits_cooldown_seconds",
      "max_retained_crawl_bytes",
      "/healthz",
    ]) {
      expect(allDocumentation).toContain(text);
    }
  });
});

describe("deployment assets", () => {
  it("ships bilingual deployment guidance from both READMEs", async () => {
    const [readme, readmeEnglish, deploying, deployingChinese] = await Promise.all([
      readProjectFile("README.md"),
      readProjectFile("README.en.md"),
      readProjectFile("docs/deploying.md"),
      readProjectFile("docs/deploying.zh-CN.md"),
    ]);

    expect(readme).toContain(
      "](https://github.com/jsogn/deepseek-crawl/blob/main/docs/deploying.zh-CN.md)",
    );
    expect(readmeEnglish).toContain(
      "](https://github.com/jsogn/deepseek-crawl/blob/main/docs/deploying.md)",
    );
    expect(deploying).toContain("[简体中文](deploying.zh-CN.md)");
    expect(deployingChinese).toContain("[English](deploying.md)");

    for (const guidance of [deploying, deployingChinese]) {
      expect(guidance).toContain("install -m 0600 .env.example .env");
      expect(guidance).toContain("docker compose config --quiet");
      expect(guidance).toContain("docker compose up -d --build");
      expect(guidance).toContain("npm run smoke:docker");
      expect(guidance).toContain("SIGTERM");
    }
  });

  it("hardens container and service shutdown", async () => {
    const [
      dockerfile,
      compose,
      service,
      environmentExample,
      dockerignore,
      ciWorkflow,
      smokeScript,
    ] = await Promise.all([
      readProjectFile("Dockerfile"),
      readProjectFile("docker-compose.yml"),
      readProjectFile("deploy/deepseek-crawl-gateway.service"),
      readProjectFile(".env.example"),
      readProjectFile(".dockerignore"),
      readProjectFile(".github/workflows/ci.yml"),
      readProjectFile("scripts/smoke-docker-gateway.sh"),
    ]);

    expect(dockerfile).toMatch(/^USER node$/m);
    expect(dockerfile).toMatch(/^STOPSIGNAL SIGTERM$/m);
    expect(dockerfile).toContain("HEALTHCHECK");

    for (const setting of [
      "init: true",
      "read_only: true",
      "no-new-privileges:true",
      "cap_drop:",
      "stop_grace_period: 30s",
    ]) {
      expect(compose).toContain(setting);
    }
    expect(compose).toMatch(/"127\.0\.0\.1:\$\{GATEWAY_PORT:-8787\}:8787"/);

    for (const setting of [
      "KillSignal=SIGTERM",
      "TimeoutStopSec=30",
      "NoNewPrivileges=true",
      "ProtectSystem=strict",
      "EnvironmentFile=/etc/deepseek-crawl/gateway.env",
    ]) {
      expect(service).toContain(setting);
    }

    for (const key of [
      "GATEWAY_API_KEY",
      "DEEPSEEK_API_KEY",
      "FIRECRAWL_API_KEY",
      "DEEPSEEK_GATEWAY_PROVIDER_MODE",
      "DEEPSEEK_GATEWAY_CREDITS_COOLDOWN_SECONDS",
      "DEEPSEEK_GATEWAY_MAX_CONCURRENT_REQUESTS",
      "DEEPSEEK_GATEWAY_MAX_PROVIDER_REQUESTS",
      "DEEPSEEK_GATEWAY_MAX_CRAWL_JOBS",
      "DEEPSEEK_GATEWAY_MAX_RETAINED_CRAWL_JOBS",
      "DEEPSEEK_GATEWAY_MAX_RETAINED_CRAWL_BYTES",
    ]) {
      expect(environmentExample).toContain(`${key}=`);
    }
    expect(dockerignore.split(/\r?\n/)).toContain(".env");
    expect(dockerignore.split(/\r?\n/)).toContain("!.env.example");
    expect(ciWorkflow).toContain("npm run smoke:docker");
    expect(smokeScript).toContain("docker stop --timeout 30");
    expect(smokeScript).toContain('docker exec "$container_name" id -u');
    expect(smokeScript).toContain('provider_mode="no-fallback"');
    expect(smokeScript).toContain('credits_cooldown_seconds="0"');
    expect(smokeScript).toContain('max_concurrent_requests="7"');
    expect(smokeScript).toContain('max_provider_requests="5"');
    expect(smokeScript).toContain('max_crawl_jobs="3"');
    expect(smokeScript).toContain('max_retained_crawl_jobs="9"');
    expect(smokeScript).toContain('max_retained_crawl_bytes="12345678"');
    expect(smokeScript).toContain('"provider_mode":"no-fallback"');
    expect(smokeScript).toContain('"credits_cooldown_seconds":0');
    expect(smokeScript).toContain('"max_retained_crawl_bytes":12345678');
  });
});
