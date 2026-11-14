import { createServer, type Server } from "node:http";
import type { MapSitemapReader } from "../application/map.js";
import type { DeepSeekGateway } from "../deepseek/gateway.js";
import { GATEWAY_CAPACITY_DEFAULTS, type GatewayConfig } from "./config.js";
import { CrawlJobManager } from "./crawl-jobs.js";
import { createGatewayHandler } from "./handler.js";
import { removeGatewayRuntimeState, writeGatewayRuntimeState } from "./runtime.js";
import type { GatewayLogger } from "./telemetry.js";

export interface GatewayServerRuntimeOptions {
  directory: string;
  mode: "local" | "remote";
  now?: () => Date;
}

export interface GatewayServerOptions {
  config: GatewayConfig;
  env: NodeJS.ProcessEnv;
  fetchImpl: typeof fetch;
  deepseekClient?: DeepSeekGateway;
  sitemapReader?: MapSitemapReader;
  crawlJobs?: CrawlJobManager;
  runtimeState?: GatewayServerRuntimeOptions;
  logger?: GatewayLogger;
}

export interface GatewayServer {
  url: URL;
  runtimeStatePath?: string;
  timeouts: {
    headers_timeout_ms: number;
    request_timeout_ms: number;
    keep_alive_timeout_ms: number;
  };
  close(): Promise<void>;
}

function listen(server: Server, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

function isAddressInUse(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "EADDRINUSE"
  );
}

async function listenGateway(server: Server, config: GatewayConfig): Promise<void> {
  if (!(config.autoPort ?? false)) {
    await listen(server, config.host, config.port);
    return;
  }
  const lastPort = Math.min(config.port + 99, 65_535);
  for (let port = config.port; port <= lastPort; port += 1) {
    try {
      await listen(server, config.host, port);
      return;
    } catch (error) {
      if (!isAddressInUse(error)) {
        throw error;
      }
    }
  }
  await listen(server, config.host, 0);
}

function serverUrl(server: Server, fallbackHost: string): URL {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Gateway server did not expose a TCP address.");
  }
  const host = fallbackHost === "0.0.0.0" ? "127.0.0.1" : fallbackHost;
  const bracketedHost = host.includes(":") ? `[${host}]` : host;
  return new URL(`http://${bracketedHost}:${address.port}/`);
}

export async function startGatewayServer(options: GatewayServerOptions): Promise<GatewayServer> {
  const crawlJobs =
    options.crawlJobs ??
    new CrawlJobManager({
      maxRunningJobs:
        options.config.maxActiveCrawlJobs ?? GATEWAY_CAPACITY_DEFAULTS.maxActiveCrawlJobs,
      maxRetainedJobs:
        options.config.maxRetainedCrawlJobs ?? GATEWAY_CAPACITY_DEFAULTS.maxRetainedCrawlJobs,
      maxRetainedBytes:
        options.config.maxRetainedCrawlBytes ?? GATEWAY_CAPACITY_DEFAULTS.maxRetainedCrawlBytes,
    });
  const server = createServer(
    createGatewayHandler({
      config: options.config,
      env: options.env,
      fetchImpl: options.fetchImpl,
      ...(options.deepseekClient === undefined ? {} : { deepseekClient: options.deepseekClient }),
      ...(options.sitemapReader === undefined ? {} : { sitemapReader: options.sitemapReader }),
      crawlJobs,
      ...(options.logger === undefined ? {} : { logger: options.logger }),
    }),
  );
  const timeouts = {
    headers_timeout_ms: options.config.headersTimeoutMs ?? 15_000,
    request_timeout_ms: options.config.requestTimeoutMs ?? 120_000,
    keep_alive_timeout_ms: options.config.keepAliveTimeoutMs ?? 5_000,
  };
  server.headersTimeout = timeouts.headers_timeout_ms;
  server.requestTimeout = timeouts.request_timeout_ms;
  server.keepAliveTimeout = timeouts.keep_alive_timeout_ms;
  server.on("upgrade", (_request, socket) => {
    const body = Buffer.from(
      `${JSON.stringify({
        success: false,
        error: "WebSocket watcher is not supported by this gateway. Use polling.",
        code: "websocket_not_supported",
      })}\n`,
    );
    socket.end(
      [
        "HTTP/1.1 426 Upgrade Required",
        "Connection: close",
        "Upgrade: websocket",
        "Content-Type: application/json",
        `Content-Length: ${body.byteLength}`,
        "",
      ].join("\r\n") + body.toString("utf8"),
    );
  });
  await listenGateway(server, options.config);
  const jobSweeper = setInterval(() => crawlJobs.sweepExpired(), 60_000);
  jobSweeper.unref();
  const url = serverUrl(server, options.config.host);
  let runtimeStatePath: string | undefined;
  if (options.runtimeState) {
    try {
      runtimeStatePath = await writeGatewayRuntimeState(options.runtimeState.directory, {
        version: 1,
        pid: process.pid,
        url: url.href,
        mode: options.runtimeState.mode,
        startedAt: (options.runtimeState.now ?? (() => new Date()))().toISOString(),
      });
    } catch (error) {
      clearInterval(jobSweeper);
      await new Promise<void>((resolve) => server.close(() => resolve()));
      throw error;
    }
  }
  let closing: Promise<void> | undefined;

  return {
    url,
    timeouts,
    ...(runtimeStatePath === undefined ? {} : { runtimeStatePath }),
    close: () => {
      if (closing) {
        return closing;
      }
      closing = (async () => {
        crawlJobs.cancelAll();
        try {
          if (server.listening) {
            await new Promise<void>((resolve, reject) => {
              server.close((error) => {
                if (error) {
                  reject(error);
                } else {
                  resolve();
                }
              });
              server.closeIdleConnections();
            });
          }
        } finally {
          clearInterval(jobSweeper);
          if (runtimeStatePath) {
            await removeGatewayRuntimeState(runtimeStatePath);
          }
        }
      })();
      return closing;
    },
  };
}
