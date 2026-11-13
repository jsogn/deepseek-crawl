#!/usr/bin/env node

import { runCli } from "./cli/run.js";

const controller = new AbortController();
const onSigint = () => controller.abort();
process.once("SIGINT", onSigint);

try {
  process.exitCode = await runCli(process.argv.slice(2), { signal: controller.signal });
} finally {
  process.removeListener("SIGINT", onSigint);
}
