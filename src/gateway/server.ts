import { createServer, type Server } from "node:http";
import type { MapSitemapReader } from "../application/map.js";
import type { DeepSeekGateway } from "../deepseek/gateway.js";
import type { GatewayConfig } from "./config.js";
import { CrawlJobManager } from "./crawl-jobs.js";
import { createGatewayHandler } from "./handler.js";
import { removeGatewayRuntimeState, writeGatewayRuntimeState } from "./runtime.js";

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
}

export interface GatewayServer {
  url: URL;
  runtimeStatePath?: string;
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
  const crawlJobs = options.crawlJobs ?? new CrawlJobManager();
  const server = createServer(
    createGatewayHandler({
      config: options.config,
      env: options.env,
      fetchImpl: options.fetchImpl,
      ...(options.deepseekClient === undefined ? {} : { deepseekClient: options.deepseekClient }),
      ...(options.sitemapReader === undefined ? {} : { sitemapReader: options.sitemapReader }),
      crawlJobs,
    }),
  );
  await listenGateway(server, options.config);
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
      await new Promise<void>((resolve) => server.close(() => resolve()));
      throw error;
    }
  }
  let closing: Promise<void> | undefined;

  return {
    url,
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
            });
          }
        } finally {
          if (runtimeStatePath) {
            await removeGatewayRuntimeState(runtimeStatePath);
          }
        }
      })();
      return closing;
    },
  };
}
