import { describe, expect, it } from "vitest";
import { gatewayRequestId, normalizeGatewayRoute } from "../../src/gateway/telemetry.js";

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
    expect(normalizeGatewayRoute("/v2/unknown/path")).toBe("/v2/*");
    expect(normalizeGatewayRoute("/healthz")).toBe("/healthz");
  });
});
