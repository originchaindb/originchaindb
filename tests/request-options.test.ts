import { describe, expect, it, vi } from "vitest";
import { OriginChainClient, type RequestOptions } from "../src/index.js";

const calls: Array<[string, (db: OriginChainClient, options: RequestOptions) => Promise<unknown>]> = [
  ["listSchemas", (db, o) => db.listSchemas(o)],
  ["getSchema", (db, o) => db.getSchema("demo.people", o)],
  ["registerSchema", (db, o) => db.registerSchema("namespace = 'demo'", o)],
  ["usage", (db, o) => db.usage(o)],
  ["queryMetrics", (db, o) => db.queryMetrics(60, 60, o)],
  ["vectorPut", (db, o) => db.vectorPut("vectors", { id: "one", embedding: [1], dim: 1 }, o)],
  ["vectorTopk", (db, o) => db.vectorTopk("vectors", { query: [1], k: 1, dim: 1 }, o)],
  ["vectorDelete", (db, o) => db.vectorDelete("vectors", "one", {}, o)],
  ["ftsIndex", (db, o) => db.ftsIndex("docs", "body", { doc_id: "one", text: "sample" }, o)],
  ["ftsSearch", (db, o) => db.ftsSearch("docs", "body", { q: "sample" }, o)],
  ["query", (db, o) => db.query({ schema: "demo.people" }, o)],
  ["graph.neighbors", (db, o) => db.graph.neighbors("demo.people", { rel: "edge", pk: "one" }, o)],
  ["graph.reverseNeighbors", (db, o) => db.graph.reverseNeighbors("demo.people", { rel: "edge", pk: "one" }, o)],
  ["graph.bfs", (db, o) => db.graph.bfs("demo.people", { rel: "edge", pk: "one" }, o)],
  ["graph.path", (db, o) => db.graph.path("demo.people", { rel: "edge", src: "one", dst: "two" }, o)],
  ["graph.dijkstra", (db, o) => db.graph.dijkstra("demo.people", { rel: "edge", src: "one", dst: "two", weights: {} }, o)],
];

describe.each(calls)("%s request controls", (_name, call) => {
  it("honors caller cancellation before sending", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled operation");
    controller.abort(reason);
    const fetch = vi.fn(async () => new Response("{}"));
    const db = new OriginChainClient({ baseUrl: "https://sdk.invalid", bearer: "mock", fetch });
    await expect(call(db, { signal: controller.signal })).rejects.toBe(reason);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("preserves a caller's key and cancels an in-flight operation", async () => {
    const controller = new AbortController();
    const fetch = vi.fn((_url, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      expect(new Headers(init?.headers).get("idempotency-key")).toBe("stable-operation");
      init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
    }));
    const db = new OriginChainClient({ baseUrl: "https://sdk.invalid", bearer: "mock", fetch });
    const pending = call(db, { signal: controller.signal, idempotencyKey: "stable-operation" });
    const assertion = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await assertion;
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

it("keeps schema content type and raw payload with request controls", async () => {
  const fetch = vi.fn(async (_url, init?: RequestInit) => {
    expect(new Headers(init?.headers).get("content-type")).toBe("text/plain");
    expect(init?.body).toBe("namespace = 'demo'");
    return new Response("{}");
  });
  const db = new OriginChainClient({ baseUrl: "https://sdk.invalid", bearer: "mock", fetch });
  await db.registerSchema("namespace = 'demo'", { idempotencyKey: "schema-one" });
});

it.each([false, true])("retries POST only with explicit replay safety (%s)", async (retrySafe) => {
  let attempts = 0;
  const fetch = vi.fn(async () => ++attempts === 1
    ? new Response('{"error":"busy"}', { status: 503, headers: { "retry-after": "0" } })
    : new Response("[]"));
  const db = new OriginChainClient({ baseUrl: "https://sdk.invalid", bearer: "mock", fetch, maxRetries: 1 });
  const pending = db.vectorTopk("vectors", { query: [1], k: 1, dim: 1 }, { retrySafe });
  if (retrySafe) await expect(pending).resolves.toEqual([]);
  else await expect(pending).rejects.toMatchObject({ status: 503 });
  expect(fetch).toHaveBeenCalledTimes(retrySafe ? 2 : 1);
});
