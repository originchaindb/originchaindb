import { describe, expect, it, vi } from "vitest";
import { ApiError, OriginChainClient, type QueryMetricsResponse } from "../src/index.js";

const baseUrl = "https://metrics.invalid";
const tenantId = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const payload: QueryMetricsResponse = {
  schema_version: 1, tenant_id: tenantId, from: 1792832400000, to: 1792836000000,
  bucket_seconds: 60, collection_started_at: 1792832400000, scope: "local-process",
  retention_seconds: 604800, dropped_events: 4294967298,
  buckets: [
    { at: 1792832400000, calls: 4294967297, failed: 2147483649, mean_latency_ms: 1.25, observed_seconds: 30 },
    { at: 1792832460000, calls: 0, failed: 0, mean_latency_ms: null, observed_seconds: 60 },
  ],
};

describe("tenant query metrics", () => {
  it("preserves large timestamps/counters, null latency and observed duration", async () => {
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer mock");
      expect(init?.method ?? "GET").toBe("GET");
      return new Response(JSON.stringify(payload));
    });
    const db = new OriginChainClient({ baseUrl, tenantId, bearer: "mock", fetch });
    expect(await db.queryMetrics()).toEqual(payload);
    expect(fetch.mock.calls[0]![0]).toBe(`${baseUrl}/v1/tenants/${tenantId}/query-metrics?minutes=60&bucket_seconds=60`);
  });

  it.each([[1440, 600], [10080, 3600]])("sends the %s/%s window unchanged", async (minutes, bucketSeconds) => {
    const fetch = vi.fn(async (_url: unknown) => new Response(JSON.stringify(payload)));
    const db = new OriginChainClient({ baseUrl, tenantId, bearer: "mock", fetch });
    await db.queryMetrics(minutes, bucketSeconds);
    expect(fetch.mock.calls[0]![0]).toBe(`${baseUrl}/v1/tenants/${tenantId}/query-metrics?minutes=${minutes}&bucket_seconds=${bucketSeconds}`);
  });

  it("preserves authorization failures instead of returning empty metrics", async () => {
    const fetch = vi.fn(async () => new Response('{"error":"forbidden","message":"Query administrator required"}', { status: 403 }));
    const db = new OriginChainClient({ baseUrl, tenantId, bearer: "mock", fetch });
    const request = db.queryMetrics();
    await expect(request).rejects.toMatchObject({ status: 403 });
    await expect(request).rejects.toBeInstanceOf(ApiError);
  });

  it("uses the existing opt-in retry policy for this read-only request", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response('{"error":"busy"}', { status: 503, headers: { "retry-after": "0" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify(payload)));
    const db = new OriginChainClient({ baseUrl, tenantId, bearer: "mock", fetch, maxRetries: 1 });
    expect(await db.queryMetrics()).toEqual(payload);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
