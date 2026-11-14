import { describe, expect, it } from "vitest";
import { requestFirecrawlUpstream } from "../../src/firecrawl/upstream.js";

const config = {
  host: "127.0.0.1",
  port: 8787,
  allowRemote: false,
  upstreamUrl: new URL("https://api.firecrawl.dev/"),
  requestBodyLimit: 8 * 1024 * 1024,
  timeoutMs: 2000,
};

describe("Firecrawl upstream client", () => {
  it("keeps absolute-form request targets on the configured upstream origin", async () => {
    let target = "";
    await requestFirecrawlUpstream(
      {
        method: "GET",
        path: "https://attacker.example/v2/scrape",
        headers: new Headers(),
      },
      {
        config,
        env: { FIRECRAWL_API_KEY: "fc-test" },
        fetchImpl: async (input) => {
          target = String(input);
          return Response.json({ success: true });
        },
      },
    );

    expect(target).toBe("https://api.firecrawl.dev/v2/scrape");
  });
});
