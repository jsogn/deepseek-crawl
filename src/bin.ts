#!/usr/bin/env node

import { runCli } from "./cli/run.js";

const argv = process.argv.slice(2);
const signalCommands = new Set(["crawl", "gateway", "map"]);

if (!signalCommands.has(argv[0] ?? "")) {
  process.exitCode = await runCli(argv);
} else {
  const controller = new AbortController();
  const onSigint = () => controller.abort();
  process.once("SIGINT", onSigint);

  try {
    process.exitCode = await runCli(argv, { signal: controller.signal });
  } finally {
    process.removeListener("SIGINT", onSigint);
  }
}
