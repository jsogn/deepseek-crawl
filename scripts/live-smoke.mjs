import { spawnSync } from "node:child_process";

if (!process.env.DEEPSEEK_API_KEY) {
  console.error("Set DEEPSEEK_API_KEY before running the billable live smoke test.");
  process.exit(1);
}

console.error("Billable request: running one DeepSeek Search through doctor --live.");
const result = spawnSync(process.execPath, ["dist/bin.js", "doctor", "--live", "--json"], {
  encoding: "utf8",
  env: process.env,
  stdio: "inherit",
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exitCode = result.status ?? 1;
