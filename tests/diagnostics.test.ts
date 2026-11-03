// Request correlation and opt-in diagnostics. Every test injects a mock `fetch`
// that answers engine calls and records diagnostics posts separately.

import { afterEach, describe, expect, it } from "vitest";
import { ApiError, OriginChainClient, type FetchLike } from "../src/index.js";
import {
  DiagnosticsQueue,
  SDK_VERSION,
  diagnosticEvent,
  now,
  type DiagnosticEvent,
} from "../src/diagnostics.js";
import pkg from "../package.json";

const BASE = "https://tnt-test.ap-south-1.db.originchain.ai";
const BEARER = "test-bearer-token";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ENGINE_ID = "3f2a9c1b7e5d4a60000000000042";

type Call = { url: string; headers: Record<string, string>; body: unknown };

/** Engine calls answer `status` (with `x-oc-request-id`); a URL containing
 * "/boom" rejects like a dropped connection; diagnostics posts are recorded. */
function engine(status = 200, body: unknown = { kind: "select", rows: [] }) {
  const calls: Call[] = [];
  const reports: DiagnosticEvent[][] = [];
  const fetch: FetchLike = (input, init) => {
    const url = typeof input === "string" ? input : input.toString();
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const parsed = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    if (url.endsWith("/diagnostics")) {
      reports.push((parsed as { events: DiagnosticEvent[] }).events);
      return Promise.resolve(new Response('{"accepted":1}', { status: 202 }));
    }
    calls.push({ url, headers, body: parsed });
    if (url.includes("/boom")) return Promise.reject(new TypeError("fetch failed"));
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json", "x-oc-request-id": ENGINE_ID },
      }),
    );
  };
  return { fetch, calls, reports };
}

afterEach(() => {
  delete (globalThis as { document?: unknown }).document;
  delete (globalThis as { WorkerGlobalScope?: unknown }).WorkerGlobalScope;
});

/** A browser worker's global scope: `globalThis` is an instance of it. */
function asBrowserWorker(isInstance: boolean): void {
  const scope = function WorkerGlobalScope() {} as unknown as { [Symbol.hasInstance]: unknown };
  Object.defineProperty(scope, Symbol.hasInstance, { value: (o: unknown) => isInstance && o === globalThis });
  (globalThis as { WorkerGlobalScope?: unknown }).WorkerGlobalScope = scope;
}

describe("request correlation", () => {
  it("sends a fresh logical request id and attempt 1 on every call", async () => {
    const { fetch, calls } = engine();
    const oc = new OriginChainClient({ baseUrl: BASE, bearer: BEARER, fetch });
    await oc.sql("SELECT 1");
    await oc.sql("SELECT 2");
    const [a, b] = calls.map((c) => c.headers);
    expect(a!["x-oc-logical-request-id"]).toMatch(UUID);
    expect(a!["x-oc-attempt"]).toBe("1");
    expect(b!["x-oc-logical-request-id"]).not.toBe(a!["x-oc-logical-request-id"]);
  });

  it("keeps a caller's UUID, and never reports a caller's non-UUID id", async () => {
    const { fetch, calls, reports } = engine();
    const oc = new OriginChainClient({ baseUrl: BASE, bearer: BEARER, fetch, diagnostics: true });
    const mine = "0B9A6C1E-2F4D-4C8B-9E7A-1D2C3B4A5F60";
    await oc._request("/v1/tenants/tnt-test/sql", {
      method: "POST",
      body: "{}",
      headers: { "x-oc-logical-request-id": mine },
    });
    await oc._request("/v1/tenants/tnt-test/sql", {
      method: "POST",
      body: "{}",
      headers: { "x-oc-logical-request-id": "order-42" },
    });
    await oc.flushDiagnostics();
    expect(calls[0]!.headers["x-oc-logical-request-id"]).toBe(mine);
    expect(reports[0]![0]!.logical_request_id).toBe(mine.toLowerCase());
    expect(calls[1]!.headers["x-oc-logical-request-id"]).toBe("order-42");
    expect(reports[0]![1]!.logical_request_id).toMatch(UUID);
  });

  it("puts both ids on an ApiError so a support request can name the engine record", async () => {
    const { fetch, calls } = engine(503, { error: { code: "write_overloaded", message: "busy" } });
    const oc = new OriginChainClient({ baseUrl: BASE, bearer: BEARER, fetch });
    const err = await oc.sql("SELECT 1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).requestId).toBe(ENGINE_ID);
    expect((err as ApiError).logicalRequestId).toBe(calls[0]!.headers["x-oc-logical-request-id"]);
  });

  it("does not send the correlation headers from a browser", async () => {
    (globalThis as { document?: unknown }).document = {};
    const { fetch, calls } = engine(500, { error: "internal" });
    const oc = new OriginChainClient({ baseUrl: BASE, bearer: BEARER, fetch });
    const err = (await oc.sql("SELECT 1").catch((e: unknown) => e)) as ApiError;
    expect(calls[0]!.headers["x-oc-logical-request-id"]).toBeUndefined();
    expect(calls[0]!.headers["x-oc-attempt"]).toBeUndefined();
    expect(err.requestId).toBe(ENGINE_ID);
  });

  it("does not send the correlation headers from a browser worker, which has no document", async () => {
    asBrowserWorker(true);
    const { fetch, calls } = engine(500, { error: "internal" });
    const oc = new OriginChainClient({ baseUrl: BASE, bearer: BEARER, fetch });
    const err = (await oc.sql("SELECT 1").catch((e: unknown) => e)) as ApiError;
    expect(calls[0]!.headers["x-oc-logical-request-id"]).toBeUndefined();
    expect(calls[0]!.headers["x-oc-attempt"]).toBeUndefined();
    expect(err.requestId).toBe(ENGINE_ID);
  });

  it("still sends them where WorkerGlobalScope exists but this is not a worker", async () => {
    asBrowserWorker(false);
    const { fetch, calls } = engine();
    const oc = new OriginChainClient({ baseUrl: BASE, bearer: BEARER, fetch });
    await oc.sql("SELECT 1");
    expect(calls[0]!.headers["x-oc-logical-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(calls[0]!.headers["x-oc-attempt"]).toBe("1");
  });
});

describe("diagnostics", () => {
  it("are off by default: nothing is reported", async () => {
    const { fetch, reports } = engine();
    const oc = new OriginChainClient({ baseUrl: BASE, bearer: BEARER, fetch });
    await oc.sql("SELECT 1");
    await oc.flushDiagnostics();
    expect(reports).toHaveLength(0);
  });

  it("report each call with only contract fields, the path without its query string", async () => {
    const { fetch, calls, reports } = engine();
    const oc = new OriginChainClient({ baseUrl: BASE, bearer: BEARER, fetch, diagnostics: true });
    await oc.sql("SELECT secret FROM private_table");
    await oc.ftsSearch("articles", "body", { q: "a confidential search" }).catch(() => undefined);
    await oc.flushDiagnostics();
    expect(reports).toHaveLength(1);
    const [sql, fts] = reports[0]!;
    const allowed = new Set([
      "client", "client_version", "method", "path", "outcome", "duration_ms", "http_status",
      "error_category", "error_code", "request_id", "logical_request_id", "attempt", "transport",
    ]);
    for (const e of reports[0]!) {
      for (const key of Object.keys(e)) expect(allowed.has(key), key).toBe(true);
      expect(JSON.stringify(e)).not.toMatch(/secret|private_table|confidential/);
    }
    expect(sql).toMatchObject({
      client: "typescript",
      client_version: SDK_VERSION,
      method: "POST",
      path: "/v1/tenants/tnt-test/sql",
      outcome: "success",
      http_status: 200,
      request_id: ENGINE_ID,
      logical_request_id: calls[0]!.headers["x-oc-logical-request-id"],
      attempt: 1,
    });
    expect(fts!.path).toBe("/v1/tenants/tnt-test/fts/articles/body");
  });

  it("classify a refused call and keep only a contract-shaped error code", async () => {
    const { fetch, reports } = engine(429, { error: { code: "rate_limited", message: "slow down" } });
    const oc = new OriginChainClient({ baseUrl: BASE, bearer: BEARER, fetch, diagnostics: true });
    await oc.sql("SELECT 1").catch(() => undefined);
    const { fetch: f2, reports: r2 } = engine(400, { error: { code: "bad request: near SELECT", message: "x" } });
    const oc2 = new OriginChainClient({ baseUrl: BASE, bearer: BEARER, fetch: f2, diagnostics: true });
    await oc2.sql("SELECT 1").catch(() => undefined);
    await oc.flushDiagnostics();
    await oc2.flushDiagnostics();
    expect(reports[0]![0]).toMatchObject({
      outcome: "error",
      error_category: "rate_limited",
      error_code: "rate_limited",
      http_status: 429,
    });
    expect(r2[0]![0]!.error_category).toBe("validation");
    expect(r2[0]![0]!.error_code).toBeUndefined();
  });

  it("report a dropped connection as no response, and still throw the original error", async () => {
    const { fetch, reports } = engine();
    const oc = new OriginChainClient({ baseUrl: BASE, bearer: BEARER, fetch, diagnostics: true });
    const err = await oc._request("/v1/tenants/tnt-test/boom").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TypeError);
    await oc.flushDiagnostics();
    const [e] = reports[0]!;
    expect(e).toMatchObject({ outcome: "error", error_category: "network", transport: "no_response" });
    expect(e!.http_status).toBeUndefined();
  });

  it("never fail a call when the report itself cannot be sent", async () => {
    const fetch: FetchLike = (input) =>
      String(input).endsWith("/diagnostics")
        ? Promise.reject(new TypeError("offline"))
        : Promise.resolve(new Response('{"kind":"select","rows":[]}', { status: 200 }));
    const oc = new OriginChainClient({ baseUrl: BASE, bearer: BEARER, fetch, diagnostics: true });
    await expect(oc.sql("SELECT 1")).resolves.toMatchObject({ kind: "select" });
    await expect(oc.flushDiagnostics()).resolves.toBeUndefined();
  });

  it("never queue an event that would make the engine refuse a whole batch", () => {
    const base = {
      path: "/v1/tenants/t/sql",
      startedAt: now(),
      logicalRequestId: "8fb1dce6-72c0-4aa5-8d46-50a4e0b47ba5",
      status: 200,
    };
    expect(diagnosticEvent({ ...base, method: "HEAD" })).toBeUndefined();
    expect(diagnosticEvent({ ...base, method: "GET", path: "/v1/version" })).toBeUndefined();
    expect(
      diagnosticEvent({ ...base, method: "GET", path: `/v1/tenants/${"x".repeat(600)}` }),
    ).toBeUndefined();
    const old = diagnosticEvent({ ...base, method: "GET", startedAt: now() - 7_200_000 });
    expect(old!.duration_ms).toBe(3_600_000);
  });

  it("bound the queue, dropping the oldest events", () => {
    const sent: DiagnosticEvent[][] = [];
    const q = new DiagnosticsQueue(async (b) => {
      sent.push(b);
    });
    // Hold sending so the queue fills: push faster than any flush completes.
    (q as unknown as { sending: boolean }).sending = true;
    const e = { client: "typescript" } as DiagnosticEvent;
    for (let i = 0; i < 300; i++) q.push(e);
    expect(q.size).toBe(256);
    expect(q.dropped).toBe(44);
  });

  it("report the version package.json publishes", () => {
    expect(SDK_VERSION).toBe(pkg.version);
  });
});
