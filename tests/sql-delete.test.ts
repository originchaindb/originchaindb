import { describe, expect, it } from "vitest";
import { OriginChainClient, type SqlDelete } from "../src/index.js";

describe("SQL DELETE response shapes", () => {
  const responses: SqlDelete[] = [
    { kind: "delete", schema: "demo.items", rows_affected: 2 },
    { kind: "delete", schema: "demo.items", pk: null, rows_affected: 2 },
    { kind: "delete", schema: "demo.items", pk: "one", rows_affected: 1 },
    { kind: "delete", schema: "demo.items", rows_affected: 0 },
    { kind: "delete", schema: "demo.items", rows_buffered: 2 },
    { kind: "delete", schema: "demo.items", rows_affected: 2 ** 40 },
  ];
  it.each(responses)("preserves the server result %# without inventing a key or count", async (wire) => {
    let body: unknown;
    const client = new OriginChainClient({
      baseUrl: "https://delete-test.example.invalid", tenantId: "delete-test", bearer: "mock-only",
      fetch: async (_url, init) => {
        body = JSON.parse(String(init?.body));
        return new Response(JSON.stringify(wire), { headers: { "content-type": "application/json" } });
      },
    });
    const result = await client.sql("DELETE FROM demo.items");
    expect(body).toEqual({ sql: "DELETE FROM demo.items" });
    expect(result.kind).toBe("delete");
    if (result.kind !== "delete") throw new Error("Expected a DELETE result");
    expect(result).toEqual(wire);
    expect(Object.hasOwn(result, "pk")).toBe(Object.hasOwn(wire, "pk"));
    expect(Object.hasOwn(result, "rows_affected")).toBe(Object.hasOwn(wire, "rows_affected"));
    expect(result.rows_buffered).toBe(wire.rows_buffered);
  });
});
