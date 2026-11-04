import { describe, expect, it, vi } from "vitest";
import { BatchWriteError, Client } from "../src/index.js";

describe("bounded iteration", () => {
  it("snapshots reused rows and closes an async producer on early stop", async () => {
    const bodies: unknown[] = [], consumed: string[] = [];
    let closed = false;
    async function* source() {
      const row = { id: "" };
      try { for (const id of "abcde") { consumed.push(id); row.id = id; yield row; } }
      finally { closed = true; }
    }
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(init!.body as string));
      return Response.json({ inserted: 2 });
    });
    const db = new Client({ url: "https://example.invalid", token: "test", fetch });
    const stream = db.rows.writeBatches("app.items", source(), { batchSize: 2 });
    expect(consumed).toEqual([]);
    expect((await stream.next()).value).toEqual({ offset: 0, count: 2, inserted: 2 });
    await stream.return(undefined);
    expect(consumed).toEqual(["a", "b"]);
    expect(bodies).toEqual([[{ id: "a" }, { id: "b" }]]);
    expect(closed).toBe(true);
  });

  it("cancels a stalled async producer without waiting for an uncooperative return", async () => {
    const control = new AbortController();
    const fetch = vi.fn();
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const source = {
      [Symbol.asyncIterator]() { return this; },
      next() { entered(); return new Promise<IteratorResult<Record<string, unknown>>>(() => {}); },
      return() { return new Promise<IteratorResult<Record<string, unknown>>>(() => {}); },
    };
    const db = new Client({ url: "https://example.invalid", token: "test", fetch });
    const pending = db.rows.writeBatches("app.items", source, { signal: control.signal }).next();
    await started;
    control.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not send buffered rows after a producer fails", async () => {
    function* source() { yield { id: "a" }; yield { id: "b" }; yield { id: "c" }; throw new Error("input failure"); }
    const fetch = vi.fn(async () => Response.json({ inserted: 2 }));
    const db = new Client({ url: "https://example.invalid", token: "test", fetch });
    const stream = db.rows.writeBatches("app.items", source(), { batchSize: 2 });
    await stream.next();
    await expect(stream.next()).rejects.toMatchObject({ offset: 2, count: 1, outcome: "not_sent" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects non-finite rows before sending", async () => {
    const fetch = vi.fn();
    const db = new Client({ url: "https://example.invalid", token: "test", fetch });
    await expect(db.rows.writeBatches("app.items", [{ value: NaN }]).next()).rejects.toBeInstanceOf(BatchWriteError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("uses UTF-8 key order and isolates continuation from public page mutation", async () => {
    const bodies: { params: string[] }[] = [];
    const keys = ["\ue000", "\u{10000}"];
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(init!.body as string));
      return Response.json({ kind: "select", rows: bodies.length === 1 ? keys.map(id => ({ id })) : [] });
    });
    const db = new Client({ url: "https://example.invalid", token: "test", fetch });
    const pages = db.rows.pages("app.items", "id", { pageSize: 2 });
    const page = (await pages.next()).value!;
    page.rows[1]!.id = "changed";
    page.nextCursor = "changed";
    expect((await pages.next()).done).toBe(true);
    expect(bodies[1]!.params).toEqual([keys[1]]);
  });
});
