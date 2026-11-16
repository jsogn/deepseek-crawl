import { describe, expect, it } from "vitest";
import {
  GatewayMetrics,
  gatewayRequestId,
  normalizeGatewayRoute,
} from "../../src/gateway/telemetry.js";

describe("gateway telemetry", () => {
  it("preserves safe request IDs and replaces unsafe IDs", () => {
    expect(gatewayRequestId("client-request_1:abc")).toBe("client-request_1:abc");
    expect(gatewayRequestId("contains spaces")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("normalizes routes without query strings or concrete crawl IDs", () => {
    expect(normalizeGatewayRoute("/v2/search")).toBe("/v2/search");
    expect(normalizeGatewayRoute("/v2/crawl/dsc_secret")).toBe("/v2/crawl/:id");
    expect(normalizeGatewayRoute("/v2/crawl/dsc_secret/errors")).toBe("/v2/crawl/:id/errors");
    expect(normalizeGatewayRoute("/v2/scrape/ps_abc/interact")).toBe("/v2/scrape/:id/interact");
    expect(normalizeGatewayRoute("/v2/unknown/path")).toBe("/v2/*");
    expect(normalizeGatewayRoute("/healthz")).toBe("/healthz");
  });

  it("counts providers, fallbacks, and error classes", () => {
    const metrics = new GatewayMetrics();
    metrics.record({
      status: 200,
      provider: "firecrawl",
      fallback: false,
    });
    metrics.record({
      status: 502,
      provider: "deepseek",
      fallback: true,
      fallback_reason: "firecrawl_credits_exhausted",
    });
    metrics.record({
      status: 400,
      provider: "none",
      fallback: false,
    });
    metrics.record({
      status: 200,
      provider: "gateway",
      fallback: false,
    });

    expect(metrics.snapshot()).toEqual({
      requests_total: 3,
      firecrawl_requests: 1,
      firecrawl_keyless_requests: 0,
      deepseek_requests: 1,
      pagesift_requests: 0,
      none_requests: 1,
      fallback_requests: 1,
      client_errors: 1,
      server_errors: 1,
      last_fallback_reason: "firecrawl_credits_exhausted",
    });
  });
});
