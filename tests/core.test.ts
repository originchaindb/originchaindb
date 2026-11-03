import { describe, expect, it } from "vitest";
import { Client, BatchError, ProtocolError } from "../src/index.js";
import { decodeFts } from "../src/search.js";

describe("shared SDK result contract", () => {
  it("preserves unsafe integers and precise decimal strings", async () => {
    const client = new Client({ url: "https://db.example.invalid/opaque", token: "test",
      fetch: async () => new Response('{"kind":"update","rows_affected":2,"rows":[{"id":9007199254740993,"decimal":"1.00000000000000001"}],"future":true}') });
    const result = await client.sql.run("UPDATE t SET n=$1 RETURNING id", [7]);
    expect(result.rows[0]).toEqual({ id: "9007199254740993", decimal: "1.00000000000000001" });
    expect(result.rows_affected).toBe(2); expect(result.raw.future).toBe(true);
  });
  it("exposes nested partial failure without replay", async () => {
    let calls = 0;
    const client = new Client({ url: "https://db.example.invalid", token: "test", maxRetries: 3,
      fetch: async () => { calls++; return Response.json({ kind: "batch", results: [{ kind: "insert", inserted: 1 }, { kind: "batch", results: [{ error: "failed" }] }] }); } });
    await expect(client.sql.run("INSERT; INSERT")).rejects.toBeInstanceOf(BatchError);
    expect(calls).toBe(1);
  });
  it.each([["one"], [{ doc_id: "one", score: 1 }], { hits: [{ doc_id: "one", score: 1, highlights: { body: ["one"] } }], facets: { tag: [] } }].map(payload => ({payload})))("normalizes full-text hits %#", ({payload}) => {
    expect(decodeFts(payload).hits[0]?.doc_id).toBe("one");
  });
  it.each([null, {}, [2], [{ doc_id: "one", score: "invalid" }]].map(value => ({value})))("rejects malformed full-text results %#", ({value}) => {
    expect(() => decodeFts(value)).toThrow(ProtocolError);
  });
  it("rejects traversal names before sending a request", async () => {
    const client = new Client({ url: "https://db.example.invalid", token: "test", fetch: async () => { throw new Error("request must not be sent"); } });
    expect(() => client.rows.get("..", "id")).toThrow(TypeError);
  });
});
