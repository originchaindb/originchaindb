import { describe, expect, it, vi } from "vitest";
import { Client, ApiError, CredentialError, mapRows, RowDecodeError, type RequestEvent } from "../src/index.js";
import { decodeSqlResult } from "../src/sql.js";

describe("application integration", () => {
  it("resolves rotated tokens once per call, never replaying auth failures", async () => {
    const events: RequestEvent[] = [];
    let sequence = 0;
    const headers: string[] = [];
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      headers.push(new Headers(init?.headers).get("authorization")!);
      return new Response(JSON.stringify(headers.length === 1 ? { error: { code: "token_expired" } } : { kind: "select", rows: [{ value: 7 }] }),
        { status: headers.length === 1 ? 401 : 200, headers: { "x-oc-request-id": "request-123" } });
    });
    const db = new Client({ url: "https://example.invalid/private-db", tokenProvider: async () => `secret-${++sequence}`,
      fetch, onRequest: event => { events.push(event); } });
    await expect(db.sql.run("private SQL")).rejects.toBeInstanceOf(ApiError);
    expect(sequence).toBe(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((await db.sql.run("private SQL")).rows).toEqual([{ value: 7 }]);
    expect(headers).toEqual(["Bearer secret-1", "Bearer secret-2"]);
    expect(events.map(event => event.errorKind)).toEqual(["authentication", undefined]);
    expect(events[1]).toMatchObject({ operation: "sql", status: 200, requestId: "request-123" });
    for (const secret of ["secret-", "private-db", "private SQL", "example.invalid"])
      expect(JSON.stringify(events)).not.toContain(secret);
  });

  it("rejects bad provider values without sending and isolates observers", async () => {
    const fetch = vi.fn();
    const db = new Client({ url: "https://example.invalid", tokenProvider: () => "bad\nheader", fetch,
      onRequest: () => { throw new Error("observer"); } });
    await expect(db.usage()).rejects.toBeInstanceOf(CredentialError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("cancels a pending credential lookup without sending", async () => {
    const fetch = vi.fn();
    const events: RequestEvent[] = [];
    const db = new Client({ url: "https://example.invalid", tokenProvider: () => new Promise(() => {}), fetch,
      onRequest: event => { events.push(event); } });
    const controller = new AbortController();
    const result = db.usage({ signal: controller.signal });
    controller.abort();
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(fetch).not.toHaveBeenCalled();
    expect(events[0]?.errorKind).toBe("canceled");
  });

  it("times out an uncooperative credential provider", async () => {
    const events: RequestEvent[] = [];
    const fetch = vi.fn();
    const db = new Client({ url: "https://example.invalid", timeoutMs: 20,
      tokenProvider: () => new Promise(() => {}), fetch, onRequest: event => { events.push(event); } });
    await expect(db.usage()).rejects.toMatchObject({ name: "AbortError" });
    expect(fetch).not.toHaveBeenCalled();
    expect(events[0]?.errorKind).toBe("timeout");
  });

  it("maps rows through a real validator while preserving the raw response", () => {
    const result = decodeSqlResult({ kind: "select", rows: [{ id: "9007199254740993", name: "Widget" }] });
    const decode = (row: Readonly<Record<string, unknown>>) => {
      if (typeof row.id !== "string" || typeof row.name !== "string") throw new TypeError("Invalid product");
      return { id: BigInt(row.id), name: row.name };
    };
    expect(mapRows(result, decode)).toEqual([{ id: 9007199254740993n, name: "Widget" }]);
    mapRows(result, row => { (row as Record<string, unknown>).id = "changed"; });
    expect(result.rows[0]?.id).toBe("9007199254740993");
    result.rows.push({ id: null });
    try { mapRows(result, decode); throw new Error("accepted bad row"); }
    catch (error) { expect(error).toBeInstanceOf(RowDecodeError); expect((error as RowDecodeError).row).toBe(1); }
  });

  it("supports a provider with fromEnv without a static token", () => {
    expect(() => Client.fromEnv({ env: { OC_URL: "https://example.invalid" }, tokenProvider: () => "token" })).not.toThrow();
  });
});
