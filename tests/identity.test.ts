import { expect, it } from "vitest";
import { OriginChainClient, type FetchLike } from "../src/index.js";

it("sends identity with bearer and blocks redirects, including diagnostics", async () => {
  const calls: RequestInit[] = [];
  const fetch: FetchLike = async (_, init) => {
    calls.push(init!);
    return new Response(JSON.stringify({ kind: "select", rows: [] }));
  };
  const client = new OriginChainClient({ baseUrl: "https://engine.invalid", bearer: "bearer",
    dbUser: "alice", dbKey: "secret", fetch, diagnostics: true });
  await client.sql("SELECT 1");
  await client.flushDiagnostics();
  expect(calls.length).toBe(2);
  for (const call of calls) {
    const headers = new Headers(call.headers);
    expect(headers.get("authorization")).toBe("Bearer bearer");
    expect(headers.get("x-oc-db-user")).toBe("alice");
    expect(headers.get("x-oc-db-key")).toBe("secret");
    expect(call.redirect).toBe("error");
  }
});

it("rejects partial or invalid identity without echoing the key", () => {
  for (const identity of [{ dbUser: "alice" }, { dbKey: "secret" },
    { dbUser: "alice", dbKey: "bad\r\nkey" }, { dbUser: "", dbKey: "secret" }]) {
    expect(() => new OriginChainClient({ baseUrl: "https://engine.invalid", bearer: "bearer",
      ...identity })).toThrow("dbUser and dbKey");
  }
});

it("serializes node-pair weights and preserves nullable cost", async () => {
  const fetch: FetchLike = async (url) => {
    expect(JSON.parse(new URL(String(url)).searchParams.get("weights_json")!))
      .toEqual({ "u1|u2": 1.5, "u2|u3": 0.5 });
    return new Response(JSON.stringify({ cost: null }));
  };
  const client = new OriginChainClient({ baseUrl: "https://engine.invalid", bearer: "bearer", fetch });
  const result = await client.graph.dijkstra("graph_demo", {
    rel: "follows", src: "u1", dst: "u3", weights: { "u1|u2": 1.5, "u2|u3": 0.5 } });
  expect(result.cost).toBeNull();
});
