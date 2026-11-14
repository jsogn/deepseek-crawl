import { createServer, type Server } from "node:http";
import type { MapSitemapReader } from "../application/map.js";
import type { DeepSeekGateway } from "../deepseek/gateway.js";
import type { GatewayConfig } from "./config.js";
import { CrawlJobManager } from "./crawl-jobs.js";
import { createGatewayHandler } from "./handler.js";

export interface GatewayServerOptions {
  config: GatewayConfig;
  env: NodeJS.ProcessEnv;
  fetchImpl: typeof fetch;
  deepseekClient?: DeepSeekGateway;
  sitemapReader?: MapSitemapReader;
  crawlJobs?: CrawlJobManager;
}

export interface GatewayServer {
  url: URL;
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
  await listen(server, options.config.host, options.config.port);
  let closing: Promise<void> | undefined;

  return {
    url: serverUrl(server, options.config.host),
    close: () => {
      if (closing) {
        return closing;
      }
      closing = (async () => {
        crawlJobs.cancelAll();
        if (!server.listening) {
          return;
        }
        await new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) {
              reject(error);
            } else {
              resolve();
            }
          });
        });
      })();
      return closing;
    },
  };
}
