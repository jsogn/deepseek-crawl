import type { Server } from "node:http";
import type { GatewayServer } from "../../src/gateway/server.js";

export type TestServer = GatewayServer | Server;

export async function closeTestServers(servers: TestServer[]): Promise<void> {
  await Promise.all(
    servers.splice(0).map((server) => {
      if ("url" in server) {
        return server.close();
      }
      return new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
    }),
  );
}
