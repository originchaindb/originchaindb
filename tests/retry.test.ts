import { afterEach, expect, it, vi } from "vitest";
import { OriginChainClient, type FetchLike } from "../src/index.js";
import { backoff, RETRYABLE_STATUSES, retryAfter, retryEligible } from "../src/retry.js";
import contract from "./fixtures/retry-cases.json";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it.each(contract.retry_after)("Retry-After contract: $value", ({ value, seconds }) => {
  expect(retryAfter(value, contract.now_unix * 1000)).toBe(seconds === null ? undefined : seconds * 1000);
});
it.each(contract.methods)("method contract: $method $retry_safe", (test) => {
  expect(retryEligible(test.method, test.retry_safe ?? undefined)).toBe(test.eligible);
});
it("shares retry status codes", () => expect([...RETRYABLE_STATUSES]).toEqual(contract.retryable_statuses));
it("uses bounded full jitter", () => {
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  expect([0, 1, 4, 99].map(backoff)).toEqual([125, 250, 2000, 2000]);
});

const client = (fetch: FetchLike, maxRetries = 2, timeoutMs = 1000, diagnostics = false) =>
  new OriginChainClient({ baseUrl: "https://test.invalid", bearer: "test", tenantId: "test", fetch, maxRetries, timeoutMs, diagnostics });
const path = "/v1/tenants/test/sql";

it.each([undefined, { getRandomValues: (bytes: Uint8Array) => bytes.fill(255) }])(
  "generates valid UUIDv4 headers when randomUUID is unavailable", async (crypto) => {
    vi.stubGlobal("crypto", crypto);
    const headers: Headers[] = [];
    const fetch: FetchLike = async (_url, init) => {
      headers.push(new Headers(init?.headers));
      return new Response('{"kind":"select","rows":[]}');
    };
    await client(fetch).sql("SELECT 1");
    for (const name of ["idempotency-key", "x-oc-logical-request-id"]) {
      expect(headers[0]!.get(name)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }
  },
);

it.each([-1, 100, 1.5, NaN, Infinity])("rejects invalid maxRetries %s", (count) => {
  expect(() => client(vi.fn(), count)).toThrow("maxRetries");
});

it.each([
  ["GET", undefined, 503, "0", 3],
  ["POST", undefined, 503, "0", 1],
  ["PUT", undefined, 503, "0", 1],
  ["DELETE", undefined, 503, "0", 1],
  ["POST", true, 503, "0", 3],
  ["GET", false, 503, "0", 1],
  ["GET", undefined, 401, "0", 1],
  ["GET", undefined, 429, "600", 1],
] as const)("bounds attempts: %s %s %s %s", async (method, retrySafe, status, delay, attempts) => {
  const headers: Headers[] = [];
  const fetch: FetchLike = vi.fn(async (_url, init) => {
    headers.push(new Headers(init?.headers));
    return new Response('{"error":"busy"}', { status, headers: { "retry-after": delay } });
  });
  await expect(client(fetch)._request(path, { method, retrySafe, body: method === "GET" ? undefined : "{}" })).rejects.toMatchObject({ status });
  expect(fetch).toHaveBeenCalledTimes(attempts);
  expect(headers.map(h => h.get("x-oc-attempt"))).toEqual(Array.from({ length: attempts }, (_, i) => String(i + 1)));
  expect(new Set(headers.map(h => h.get("x-oc-logical-request-id"))).size).toBe(1);
  if (method !== "GET") expect(new Set(headers.map(h => h.get("idempotency-key"))).size).toBe(1);
});

it("retries SQL only with an explicit assertion and preserves payload and key", async () => {
  const bodies: unknown[] = [];
  const keys: (string | null)[] = [];
  const fetch: FetchLike = vi.fn(async (_url, init) => {
    bodies.push(JSON.parse(init!.body as string));
    keys.push(new Headers(init?.headers).get("idempotency-key"));
    return bodies.length === 1 ? new Response("{}", { status: 503, headers: { "retry-after": "0" } })
      : new Response('{"kind":"select","rows":[{"n":7}]}');
  });
  expect(await client(fetch).sqlOne("SELECT $1", [7], { retrySafe: true, idempotencyKey: "caller-key" })).toEqual({ n: 7 });
  expect(bodies).toEqual([{ sql: "SELECT $1", params: [7] }, { sql: "SELECT $1", params: [7] }]);
  expect(keys).toEqual(["caller-key", "caller-key"]);
});

it("retries a transient network failure only for safe calls", async () => {
  vi.spyOn(Math, "random").mockReturnValue(0);
  const fetch = vi.fn().mockRejectedValueOnce(new TypeError("connection reset")).mockResolvedValue(new Response("[]"));
  expect(await client(fetch).listSchemas()).toEqual([]);
  expect(fetch).toHaveBeenCalledTimes(2);
});

it("keeps the default at a single attempt", async () => {
  const fetch = vi.fn(async () => new Response("{}", { status: 503 }));
  const db = new OriginChainClient({ baseUrl: "https://test.invalid", bearer: "test", fetch });
  await expect(db.listSchemas()).rejects.toMatchObject({ status: 503 });
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("does not replay streaming request bodies", async () => {
  const fetch = vi.fn(async () => new Response("{}", { status: 503 }));
  await expect(client(fetch)._request(path, { method: "POST", retrySafe: true, body: new ReadableStream() })).rejects.toMatchObject({ status: 503 });
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("cancels a backoff without sending another attempt or leaving timers", async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  const fetch = vi.fn(async () => new Response("{}", { status: 503, headers: { "retry-after": "1" } }));
  const call = client(fetch, 2, 3000)._request(path, { signal: controller.signal });
  const check = expect(call).rejects.toMatchObject({ name: "AbortError" });
  await vi.advanceTimersByTimeAsync(1);
  controller.abort();
  await check;
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

it("reports each HTTP attempt with one logical id", async () => {
  const events: { attempt: number; logical_request_id: string }[] = [];
  let calls = 0;
  const fetch: FetchLike = async (url, init) => {
    if (String(url).endsWith("/diagnostics")) {
      events.push(...JSON.parse(init!.body as string).events);
      return new Response("{}");
    }
    calls++;
    return new Response("[]", { status: calls === 1 ? 503 : 200, headers: { "retry-after": "0" } });
  };
  const db = client(fetch, 1, 1000, true);
  await db.listSchemas();
  await db.flushDiagnostics();
  expect(events.map(e => e.attempt)).toEqual([1, 2]);
  expect(new Set(events.map(e => e.logical_request_id)).size).toBe(1);
});

it("keeps one timeout across the first attempt, backoff and second attempt", async () => {
  vi.useFakeTimers();
  let calls = 0;
  const fetch: FetchLike = (_url, init) => {
    if (++calls === 1) return Promise.resolve(new Response("{}", { status: 503, headers: { "retry-after": "1" } }));
    return new Promise((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
    });
  };
  const check = expect(client(fetch, 2, 1500).listSchemas()).rejects.toMatchObject({ name: "AbortError" });
  await vi.advanceTimersByTimeAsync(1001);
  expect(calls).toBe(2);
  await vi.advanceTimersByTimeAsync(499);
  await check;
  expect(vi.getTimerCount()).toBe(0);
});
