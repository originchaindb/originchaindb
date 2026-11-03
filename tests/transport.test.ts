import { afterEach, describe, expect, it, vi } from "vitest";
import { OriginChainClient, OriginChainAdminClient, type FetchLike } from "../src/index.js";

const BASE = "https://test.invalid";
const PATH = "/v1/tenants/test/sql";

afterEach(() => { vi.useRealTimers(); });

for (const kind of ["engine", "admin"] as const) {
  const client = (fetch: FetchLike, timeoutMs = 1000) => kind === "engine"
    ? new OriginChainClient({ baseUrl: BASE, bearer: "test", tenantId: "test", fetch, timeoutMs })
    : new OriginChainAdminClient({ baseUrl: BASE, bearer: "test", fetch, timeoutMs });

  describe(`${kind} request transport`, () => {
    it.each([
      { "Idempotency-Key": "stable-key", "Content-Type": "text/plain" },
      new Headers({ "Idempotency-Key": "stable-key", "Content-Type": "text/plain" }),
      [["Idempotency-Key", "stable-key"], ["Content-Type", "text/plain"]] as [string, string][],
    ])("preserves caller headers in every HeadersInit form", async (headers) => {
      const fetch: FetchLike = vi.fn(async (_url, init) => {
        const sent = new Headers(init?.headers);
        expect(sent.get("idempotency-key")).toBe("stable-key");
        expect(sent.get("content-type")).toBe("text/plain");
        expect(sent.get("authorization")).toBe("Bearer test");
        return new Response("{}");
      });
      await client(fetch)._request(PATH, { method: "POST", body: "hello", headers });
    });

    it("does not send a request when the caller already cancelled", async () => {
      vi.useFakeTimers();
      const caller = new AbortController();
      const reason = new Error("caller stopped");
      caller.abort(reason);
      const fetch: FetchLike = vi.fn(async () => new Response("{}"));
      await expect(client(fetch)._request(PATH, { signal: caller.signal })).rejects.toBe(reason);
      expect(fetch).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    });

    it("cancels an in-flight request and removes the caller listener", async () => {
      vi.useFakeTimers();
      const caller = new AbortController();
      const removed = vi.spyOn(caller.signal, "removeEventListener");
      const reason = new Error("caller stopped");
      const fetch: FetchLike = vi.fn((_url, init) => new Promise<Response>((_resolve, reject) => {
        init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
      }));
      const request = client(fetch)._request(PATH, { signal: caller.signal });
      const assertion = expect(request).rejects.toBe(reason);
      caller.abort(reason);
      await assertion;
      expect(removed).toHaveBeenCalledWith("abort", expect.any(Function));
      expect(vi.getTimerCount()).toBe(0);
    });

    it("keeps the SDK timeout when a caller signal is supplied", async () => {
      vi.useFakeTimers();
      const caller = new AbortController();
      const fetch: FetchLike = vi.fn((_url, init) => new Promise<Response>((_resolve, reject) => {
        init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
      }));
      const assertion = expect(client(fetch, 25)._request(PATH, { signal: caller.signal })).rejects.toMatchObject({ name: "AbortError" });
      await vi.advanceTimersByTimeAsync(25);
      await assertion;
      expect(caller.signal.aborted).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("removes timeout and caller listener after success", async () => {
      vi.useFakeTimers();
      const caller = new AbortController();
      const removed = vi.spyOn(caller.signal, "removeEventListener");
      await client(async () => new Response("{}"))._request(PATH, { signal: caller.signal });
      expect(removed).toHaveBeenCalledWith("abort", expect.any(Function));
      expect(vi.getTimerCount()).toBe(0);
    });
  });
}

it("SQL methods forward caller cancellation before sending", async () => {
  const caller = new AbortController();
  const reason = new Error("stop SQL");
  caller.abort(reason);
  const fetch: FetchLike = vi.fn(async () => new Response("{}"));
  const db = new OriginChainClient({ baseUrl: BASE, bearer: "test", fetch });
  await expect(db.sql("SELECT id FROM demo.rows", [], { signal: caller.signal })).rejects.toBe(reason);
  await expect(db.sqlOne("SELECT id FROM demo.rows", [], { signal: caller.signal })).rejects.toBe(reason);
  expect(fetch).not.toHaveBeenCalled();
});

it("SQL accepts a stable write key without changing parameter binding", async () => {
  const fetch: FetchLike = vi.fn(async (_url, init) => {
    expect(new Headers(init?.headers).get("idempotency-key")).toBe("write-1");
    expect(JSON.parse(String(init?.body))).toEqual({ sql: "DELETE FROM demo.rows WHERE id = $1", params: ["r1"] });
    return new Response('{"kind":"delete"}');
  });
  const db = new OriginChainClient({ baseUrl: BASE, bearer: "test", fetch });
  await db.sql("DELETE FROM demo.rows WHERE id = $1", ["r1"], { idempotencyKey: "write-1" });
});

it("reports caller cancellation separately from SDK timeout", async () => {
  const caller = new AbortController();
  const reports: Array<{ outcome: string; error_category: string }> = [];
  const fetch: FetchLike = (url, init) => {
    if (String(url).endsWith("/diagnostics")) {
      reports.push(...JSON.parse(String(init?.body)).events);
      return Promise.resolve(new Response("{}", { status: 202 }));
    }
    return new Promise((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
    });
  };
  const db = new OriginChainClient({ baseUrl: BASE, bearer: "test", fetch, diagnostics: true });
  const assertion = expect(db._request(PATH, { signal: caller.signal })).rejects.toMatchObject({ name: "AbortError" });
  caller.abort();
  await assertion;
  await db.flushDiagnostics();
  expect(reports).toHaveLength(1);
  expect(reports[0]).toMatchObject({ outcome: "cancelled", error_category: "cancelled" });
});
