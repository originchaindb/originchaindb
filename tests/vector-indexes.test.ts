// Tests for `client.vectorIndexes`: indexes, namespaces, records, jobs and
// search.
//
// Every test injects a mock `fetch`: no socket and no live server. Each
// call's exact method, URL, headers and body bytes are asserted, and so is the
// mapping of the server's error envelope.

import { describe, expect, it } from "vitest";
import {
  ApiError,
  BatchWriteError,
  OCRecordApiNotEnabledError,
  OriginChainClient,
  ProtocolError,
  VECTOR_INDEX_DEFAULT_NAMESPACE,
  VECTOR_INDEX_UPSERT_MAX_BODY_BYTES,
  VECTOR_INDEX_UPSERT_MAX_RECORDS,
  VectorIndexes,
  type FetchLike,
  type VectorIndexRecord,
} from "../src/index.js";

const URL_ = "https://test.invalid/v1/tenants/01HX1TESTTENANTXXXXXXXXXX1";
const BASE = `${URL_}/vector-indexes`;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const INDEX = {
  index_id: "01J9Z2M4Q5W7Y8X3K6N0P2R4T6",
  name: "movies",
  state: "active",
  dimension: 3,
  metric: "cosine",
  score_direction: "higher_is_better",
  dense_index: "hnsw",
  sparse: false,
  text_fields: [],
  visibility_fields: [],
  embedding: null,
  deletion_protection: "disabled",
  tags: {},
  identifier_profile: "ascii",
  compat_family: "vectors",
  created_at: "2026-09-15T07:00:00.000Z",
};
const NAMESPACE = {
  name: "ns1",
  namespace_id: "01J9Z2M4Q5W7Y8X3K6N0P2R4T7",
  state: "active",
  record_count: 7,
  pending_records: 0,
  pending_new_records: 0,
  dense_ids: 7,
  sparse_ids: 0,
  declared_capacity: null,
};

interface Call { url: string; method: string; headers: Headers; body: string | undefined }
type Answer = readonly [status: number, body: unknown];

/** A fake server: `answer` maps each request (and its 1-based number) to a
 * status and body. Every request is recorded. */
function server(answer: (call: Call, n: number) => Answer, headers: Record<string, string> = {}) {
  const calls: Call[] = [];
  const fetch: FetchLike = async (input, init = {}) => {
    if (init.body !== undefined && typeof init.body !== "string") throw new Error("body must be a string");
    const call = { url: String(input), method: init.method ?? "GET", headers: new Headers(init.headers), body: init.body };
    calls.push(call);
    const [status, body] = answer(call, calls.length);
    return new Response(body === undefined ? null : JSON.stringify(body),
      { status, headers: { "content-type": "application/json", ...headers } });
  };
  return { fetch, calls };
}

/** Answers from a queue; the last answer repeats. */
function engine(answers: Answer[], headers: Record<string, string> = {}) {
  return server((_call, n) => answers[Math.min(n, answers.length) - 1]!, headers);
}

function client(fetch: FetchLike, maxRetries = 0): OriginChainClient {
  return new OriginChainClient({ url: URL_, token: "test-bearer", fetch, maxRetries });
}

/** The exact method, URL, headers and body of one request. `body`
 * `undefined` means the request must carry no body. */
function expectCall(call: Call | undefined, method: string, url: string, body?: string): void {
  expect(call).toBeDefined();
  expect(call!.method).toBe(method);
  expect(call!.url).toBe(url);
  expect(call!.body).toBe(body);
  expect(call!.headers.get("authorization")).toBe("Bearer test-bearer");
  expect(call!.headers.get("x-oc-logical-request-id")).toMatch(UUID_RE);
  expect(call!.headers.get("x-oc-attempt")).toBe("1");
  if (body === undefined) expect(call!.headers.has("content-type")).toBe(false);
  else expect(call!.headers.get("content-type")).toBe("application/json");
  if (method === "GET") expect(call!.headers.has("idempotency-key")).toBe(false);
  else expect(call!.headers.get("idempotency-key")).toMatch(UUID_RE);
}

const sent = (call: Call | undefined): unknown => JSON.parse(call!.body!);

async function collect<T>(iterator: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterator) out.push(item);
  return out;
}

/** The rejection of `promise`, which must reject. */
async function failure(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection");
}

// ── Indexes ───────────────────────────────────────────────────────────────

describe("indexes", () => {
  it("creates an index", async () => {
    const { fetch, calls } = engine([[201, INDEX]]);
    const out = await client(fetch).vectorIndexes.createIndex("movies", {
      dimension: 3,
      metric: "cosine",
      text_fields: [{ name: "body", analyzer: "standard_en_v1" }],
      visibility_fields: ["team"],
      identifier_profile: "ascii",
      deletion_protection: "enabled",
      tags: { env: "test" },
    });
    expect(calls).toHaveLength(1);
    expectCall(calls[0], "POST", BASE,
      '{"name":"movies","dimension":3,"metric":"cosine",' +
      '"text_fields":[{"name":"body","analyzer":"standard_en_v1"}],' +
      '"visibility_fields":["team"],"identifier_profile":"ascii",' +
      '"deletion_protection":"enabled","tags":{"env":"test"}}');
    expect(out).toEqual(INDEX);
  });

  it("omits unset fields", async () => {
    const { fetch, calls } = engine([[201, INDEX]]);
    await client(fetch).vectorIndexes.createIndex("m", { sparse: true });
    expectCall(calls[0], "POST", BASE, '{"name":"m","sparse":true}');
  });

  it("describes an index", async () => {
    const { fetch, calls } = engine([[200, INDEX]]);
    const out = await client(fetch).vectorIndexes.describeIndex("movies");
    expectCall(calls[0], "GET", `${BASE}/movies`);
    expect(out.metric).toBe("cosine");
  });

  it("escapes the index path segment", async () => {
    const { fetch, calls } = engine([[200, INDEX]]);
    await client(fetch).vectorIndexes.describeIndex("a/b c");
    expectCall(calls[0], "GET", `${BASE}/a%2Fb%20c`);
  });

  it.each(["", ".", "..", "a\nb"])("refuses the unusable index name %j before any request", async (name) => {
    const { fetch, calls } = engine([[200, INDEX]]);
    expect(await failure(client(fetch).vectorIndexes.describeIndex(name))).toBeInstanceOf(TypeError);
    expect(calls).toEqual([]);
  });

  it("lists indexes", async () => {
    const { fetch, calls } = engine([[200, { indexes: [INDEX], next_cursor: "c2" }]]);
    const out = await client(fetch).vectorIndexes.listIndexes({ prefix: "mov", limit: 10, cursor: "c1" });
    expectCall(calls[0], "POST", `${BASE}/list`, '{"prefix":"mov","limit":10,"cursor":"c1"}');
    expect(out.indexes[0]!.name).toBe("movies");
    expect(out.next_cursor).toBe("c2");
  });

  it("lists indexes without a filter as an empty object", async () => {
    const { fetch, calls } = engine([[200, { indexes: [] }]]);
    const out = await client(fetch).vectorIndexes.listIndexes();
    expectCall(calls[0], "POST", `${BASE}/list`, "{}");
    expect("next_cursor" in out).toBe(false);
  });

  it("configures an index", async () => {
    const { fetch, calls } = engine([[200, { ...INDEX, deletion_protection: "enabled" }]]);
    const out = await client(fetch).vectorIndexes.configureIndex("movies", {
      deletion_protection: "enabled", tags: { env: "" },
    });
    expectCall(calls[0], "PATCH", `${BASE}/movies`, '{"deletion_protection":"enabled","tags":{"env":""}}');
    expect(out.deletion_protection).toBe("enabled");
  });

  it("refuses a configuration without a change", async () => {
    const { fetch, calls } = engine([[200, INDEX]]);
    expect(await failure(client(fetch).vectorIndexes.configureIndex("movies", {}))).toBeInstanceOf(TypeError);
    expect(calls).toEqual([]);
  });

  it("deletes an index", async () => {
    const { fetch, calls } = engine([[202, { ...INDEX, state: "deleting" }]]);
    const out = await client(fetch).vectorIndexes.deleteIndex("movies");
    expectCall(calls[0], "DELETE", `${BASE}/movies`);
    expect(out.state).toBe("deleting");
  });

  it("reads index statistics", async () => {
    const stats = {
      index_id: INDEX.index_id, namespaces: [NAMESPACE], total_record_count: 7,
      dimension: 3, metric: "cosine", truncated: false,
    };
    const { fetch, calls } = engine([[200, stats]]);
    const out = await client(fetch).vectorIndexes.indexStats("movies");
    expectCall(calls[0], "GET", `${BASE}/movies/stats`);
    expect(out).toEqual(stats);
  });
});

// ── Namespaces ────────────────────────────────────────────────────────────

describe("namespaces", () => {
  it("creates a namespace", async () => {
    const { fetch, calls } = engine([[201, { ...NAMESPACE, declared_capacity: 250000 }]]);
    const out = await client(fetch).vectorIndexes.createNamespace("movies", "ns1", { declared_capacity: 250000 });
    expectCall(calls[0], "POST", `${BASE}/movies/namespaces/create`, '{"name":"ns1","declared_capacity":250000}');
    expect(out.declared_capacity).toBe(250000);
  });

  it("describes a namespace", async () => {
    const { fetch, calls } = engine([[200, NAMESPACE]]);
    const out = await client(fetch).vectorIndexes.describeNamespace("movies", "ns1");
    expectCall(calls[0], "POST", `${BASE}/movies/namespaces/describe`, '{"name":"ns1"}');
    expect(out.record_count).toBe(7);
  });

  it("lists namespaces", async () => {
    const { fetch, calls } = engine([[200, { namespaces: [NAMESPACE] }]]);
    const out = await client(fetch).vectorIndexes.listNamespaces("movies", { prefix: "ns", limit: 5 });
    expectCall(calls[0], "POST", `${BASE}/movies/namespaces/list`, '{"prefix":"ns","limit":5}');
    expect(out.namespaces[0]!.record_count).toBe(7);
  });

  it("sets and removes a declared capacity", async () => {
    const { fetch, calls } = engine([[200, NAMESPACE]]);
    const vi = client(fetch).vectorIndexes;
    await vi.configureNamespace("movies", "ns1", { declared_capacity: 10 });
    await vi.configureNamespace("movies", "ns1", { declared_capacity: null });
    const path = `${BASE}/movies/namespaces/configure`;
    expectCall(calls[0], "POST", path, '{"name":"ns1","declared_capacity":10}');
    // null is sent as null: it removes the declared capacity.
    expectCall(calls[1], "POST", path, '{"name":"ns1","declared_capacity":null}');
  });

  it("refuses a namespace configuration without declared_capacity", async () => {
    const { fetch, calls } = engine([[200, NAMESPACE]]);
    const changes = {} as { declared_capacity: number | null };
    expect(await failure(client(fetch).vectorIndexes.configureNamespace("movies", "ns1", changes)))
      .toBeInstanceOf(TypeError);
    expect(calls).toEqual([]);
  });

  it("sends the confirmation when deleting a namespace", async () => {
    const { fetch, calls } = engine([[202, { namespace_id: "01NS", state: "deleting", receipt: {} }]]);
    const out = await client(fetch).vectorIndexes.deleteNamespace("movies", "ns1");
    expectCall(calls[0], "POST", `${BASE}/movies/namespaces/delete`, '{"name":"ns1","confirm":"ns1"}');
    expect(out.state).toBe("deleting");
  });

  it("builds the IVF-PQ index", async () => {
    const { fetch, calls } = engine([[202, { job_id: "01JOB", receipt: {} }]]);
    const vi = client(fetch).vectorIndexes;
    const out = await vi.buildIndex("movies", "ns1", { seed: 7 });
    await vi.buildIndex("movies", "ns1");
    const path = `${BASE}/movies/namespaces/build-index`;
    expectCall(calls[0], "POST", path, '{"namespace":"ns1","seed":7}');
    expectCall(calls[1], "POST", path, '{"namespace":"ns1"}');
    expect(out.job_id).toBe("01JOB");
  });
});

// ── Paging iterators ──────────────────────────────────────────────────────

describe("iterators", () => {
  it("follow cursors to the end", async () => {
    const ix = engine([
      [200, { indexes: [INDEX], next_cursor: "c1" }],
      [200, { indexes: [], next_cursor: "c2" }], // an empty page can carry a cursor
      [200, { indexes: [{ ...INDEX, name: "zeta" }] }],
    ]);
    const names = (await collect(client(ix.fetch).vectorIndexes.iterIndexes({ limit: 1 }))).map(i => i.name);
    expect(names).toEqual(["movies", "zeta"]);
    expect(ix.calls.map(sent)).toEqual([{ limit: 1 }, { limit: 1, cursor: "c1" }, { limit: 1, cursor: "c2" }]);

    const ids = engine([[200, { ids: ["a", "b"], next_cursor: "c1" }], [200, { ids: ["c"] }]]);
    expect(await collect(client(ids.fetch).vectorIndexes.iterIds("movies", "ns1", { prefix: "d" })))
      .toEqual(["a", "b", "c"]);
    expect(ids.calls.map(sent)).toEqual([
      { namespace: "ns1", prefix: "d" },
      { namespace: "ns1", prefix: "d", cursor: "c1" },
    ]);
    expect(new Set(ids.calls.map(c => c.url))).toEqual(new Set([`${BASE}/movies/records/list-ids`]));

    const nss = engine([[200, { namespaces: [NAMESPACE], next_cursor: "n1" }], [200, { namespaces: [] }]]);
    expect(await collect(client(nss.fetch).vectorIndexes.iterNamespaces("movies"))).toHaveLength(1);
    expect(sent(nss.calls[1])).toEqual({ cursor: "n1" });
  });

  it("yield each record of a filter", async () => {
    const { fetch, calls } = engine([
      [200, { records: { a: { id: "a", rev: 1 } }, namespace: "ns1", next_cursor: "f1" }],
      [200, { records: { b: { id: "b", rev: 2 } }, namespace: "ns1" }],
    ]);
    const filter = { genre: { $eq: "drama" } };
    const got = await collect(client(fetch).vectorIndexes.iterRecords("movies", "ns1",
      { filter_expr: filter, limit: 1, include_values: true }));
    expect(got.map(r => r.id)).toEqual(["a", "b"]);
    expect(calls.map(c => c.body)).toEqual([
      '{"namespace":"ns1","filter_expr":{"genre":{"$eq":"drama"}},"limit":1,"include_values":true}',
      '{"namespace":"ns1","filter_expr":{"genre":{"$eq":"drama"}},"limit":1,"cursor":"f1","include_values":true}',
    ]);
  });

  it("stop at a repeated cursor", async () => {
    const { fetch, calls } = engine([[200, { ids: ["a"], next_cursor: "same" }]]);
    expect(await failure(collect(client(fetch).vectorIndexes.iterIds("movies", "ns1")))).toBeInstanceOf(ProtocolError);
    expect(calls).toHaveLength(2);
  });

  it("refuse a page without its items", async () => {
    const { fetch } = engine([[200, { next_cursor: "c1" }]]);
    expect(await failure(collect(client(fetch).vectorIndexes.iterIndexes()))).toBeInstanceOf(ProtocolError);
  });
});

// ── Upsert ────────────────────────────────────────────────────────────────

/** Answers each upsert with the number of records it carried; request
 * `failAt` gets a 409 envelope instead. */
function upsertEcho(failAt = 0) {
  return server((call, n) => {
    if (failAt && n === failAt) {
      return [409, {
        error: {
          code: "configuration_limit_exceeded",
          message: "this index holds the most vectors it may hold",
          status: 409,
          retryable: false,
          details: { reason: "exact_index_capacity", limit: 1000 },
        },
      }];
    }
    const count = (JSON.parse(call.body!) as { records: unknown[] }).records.length;
    return [200, { upserted_count: count, namespace_created: n === 1, receipt: { n: count } }];
  });
}

function sentIds(calls: Call[]): [string[], number[]] {
  const ids: string[] = [], perCall: number[] = [];
  for (const call of calls) {
    const records = (JSON.parse(call.body!) as { records: { id: string }[] }).records;
    perCall.push(records.length);
    ids.push(...records.map(r => r.id));
  }
  return [ids, perCall];
}

const bytes = (text: string) => new TextEncoder().encode(text).byteLength;

describe("upsert", () => {
  it("sends the records in one request", async () => {
    const { fetch, calls } = upsertEcho();
    const out = await client(fetch).vectorIndexes.upsert("movies", "ns1", [
      { id: "a", values: [0.5, 1.0, -2.0], metadata: { genre: "drama" } },
      { id: "b", sparse_values: { indices: [3, 9], values: [0.25, 0.5] } },
      { id: "c", text: { body: "a quiet film" } },
    ]);
    expect(calls).toHaveLength(1);
    expectCall(calls[0], "POST", `${BASE}/movies/records/upsert`,
      '{"namespace":"ns1","records":[' +
      '{"id":"a","values":[0.5,1,-2],"metadata":{"genre":"drama"}},' +
      '{"id":"b","sparse_values":{"indices":[3,9],"values":[0.25,0.5]}},' +
      '{"id":"c","text":{"body":"a quiet film"}}]}');
    expect(out).toEqual({ upserted_count: 3, namespace_created: true, batches: 1, receipts: [{ n: 3 }] });
  });

  it("splits at the record cap", async () => {
    const { fetch, calls } = upsertEcho();
    const records = Array.from({ length: 2500 }, (_, i) => ({ id: `r${String(i).padStart(4, "0")}`, values: [1.0, 2.0] }));
    const out = await client(fetch).vectorIndexes.upsert("movies", "ns1", records.values());
    const [ids, perCall] = sentIds(calls);
    expect(perCall).toEqual([VECTOR_INDEX_UPSERT_MAX_RECORDS, VECTOR_INDEX_UPSERT_MAX_RECORDS, 500]);
    expect(ids).toEqual(records.map(r => r.id)); // nothing lost, nothing reordered
    expect(out.upserted_count).toBe(2500);
    expect(out.batches).toBe(3);
    expect(out.receipts).toHaveLength(3);
    // Each request is its own write, with its own key.
    expect(new Set(calls.map(c => c.headers.get("idempotency-key"))).size).toBe(3);
  });

  it("splits at the byte bound", async () => {
    const { fetch, calls } = upsertEcho();
    const pad = "x".repeat(300_000); // 6 such records fit under 2,000,000 bytes, 7 do not
    const records = Array.from({ length: 10 }, (_, i) => ({ id: `big${i}`, values: [1.0], metadata: { pad } }));
    const out = await client(fetch).vectorIndexes.upsert("movies", "ns1", records);
    const [ids, perCall] = sentIds(calls);
    expect(perCall).toEqual([6, 4]);
    expect(calls.every(c => bytes(c.body!) <= VECTOR_INDEX_UPSERT_MAX_BODY_BYTES)).toBe(true);
    expect(ids).toEqual(records.map(r => r.id));
    expect(out.upserted_count).toBe(10);
  });

  it("honours smaller batch options", async () => {
    const { fetch, calls } = upsertEcho();
    const records = Array.from({ length: 5 }, (_, i) => ({ id: `r${i}`, values: [1.0] }));
    await client(fetch).vectorIndexes.upsert("movies", "ns1", records, { batchSize: 2, maxBytes: 100_000 });
    expect(sentIds(calls)[1]).toEqual([2, 2, 1]);
  });

  it("counts bytes, not characters", async () => {
    // A 2-byte character: 600,000 of them are 1,200,000 bytes, so two such
    // records cannot share a request although their length in characters could.
    const { fetch, calls } = upsertEcho();
    const pad = "é".repeat(600_000);
    const batches = await collect(client(fetch).vectorIndexes.upsertBatches("movies", "ns1",
      [{ id: "a", metadata: { p: pad } }, { id: "b", metadata: { p: pad } }]));
    expect(batches.map(b => b.count)).toEqual([1, 1]);
    expect(calls.every(c => bytes(c.body!) <= VECTOR_INDEX_UPSERT_MAX_BODY_BYTES)).toBe(true);
    // Both records together would fit if characters were counted.
    expect(calls.reduce((n, c) => n + c.body!.length, 0)).toBeLessThan(VECTOR_INDEX_UPSERT_MAX_BODY_BYTES);
  });

  it("sends a body exactly at the bound and refuses one byte more", async () => {
    const { fetch, calls } = upsertEcho();
    const base = bytes('{"namespace":"ns1","records":[{"id":"edge","metadata":{"pad":""}}]}');
    const fill = VECTOR_INDEX_UPSERT_MAX_BODY_BYTES - base;
    const vi = client(fetch).vectorIndexes;
    await vi.upsert("movies", "ns1", [{ id: "edge", metadata: { pad: "y".repeat(fill) } }]);
    expect(calls).toHaveLength(1);
    expect(bytes(calls[0]!.body!)).toBe(VECTOR_INDEX_UPSERT_MAX_BODY_BYTES);
    // One byte more cannot be sent at all, and is not truncated.
    const error = await failure(vi.upsert("movies", "ns1", [{ id: "edge", metadata: { pad: "y".repeat(fill + 1) } }]));
    expect(error).toBeInstanceOf(BatchWriteError);
    expect(error).toMatchObject({ offset: 0, count: 1, outcome: "not_sent" });
    expect((error as BatchWriteError).cause).toBeInstanceOf(RangeError);
    expect(String((error as BatchWriteError).cause)).toContain("edge");
    expect(calls).toHaveLength(1);
  });

  it("reports the unsent range of an oversized record", async () => {
    const { fetch, calls } = upsertEcho();
    const records = [
      { id: "a", values: [1.0] }, { id: "b", values: [1.0] }, { id: "c", values: [1.0] },
      { id: "huge", metadata: { pad: "z".repeat(VECTOR_INDEX_UPSERT_MAX_BODY_BYTES) } },
    ];
    const error = await failure(client(fetch).vectorIndexes.upsert("movies", "ns1", records, { batchSize: 2 }));
    // a and b were acknowledged; c (held) and huge (refused) were not sent.
    expect(sentIds(calls)).toEqual([["a", "b"], [2]]);
    expect(error).toMatchObject({ offset: 2, count: 2, outcome: "not_sent" });
  });

  it.each<[string, unknown]>([
    ["NaN", { id: "a", values: [NaN] }],
    ["Infinity", { id: "a", values: [Infinity] }],
    ["a set", { id: "a", values: new Set([1.0]) }],
    ["a map", { id: "a", metadata: new Map([["k", 1]]) }],
    ["a string", "not an object"],
    ["null", null],
    ["an array", [{ id: "a" }]],
  ])("refuses a record that JSON cannot carry: %s", async (_name, record) => {
    const { fetch, calls } = upsertEcho();
    const error = await failure(client(fetch).vectorIndexes.upsert("movies", "ns1", [record as unknown as VectorIndexRecord]));
    expect(error).toBeInstanceOf(BatchWriteError);
    expect(error).toMatchObject({ offset: 0, count: 1, outcome: "not_sent" });
    expect((error as BatchWriteError).cause).toBeInstanceOf(TypeError);
    expect(calls).toEqual([]);
  });

  it("reports the unacknowledged range of a failed request", async () => {
    const { fetch, calls } = upsertEcho(2);
    const records = Array.from({ length: 2500 }, (_, i) => ({ id: `r${i}`, values: [1.0] }));
    const error = await failure(client(fetch).vectorIndexes.upsert("movies", "ns1", records));
    // Records 0-999 are written; 1000-1999 failed; nothing after was sent.
    expect(error).toBeInstanceOf(BatchWriteError);
    expect(error).toMatchObject({ offset: 1000, count: 1000, outcome: "unknown" });
    const cause = (error as BatchWriteError).cause;
    expect(cause).toBeInstanceOf(ApiError);
    expect(cause).toMatchObject({ status: 409, code: "configuration_limit_exceeded", reason: "exact_index_capacity" });
    expect(calls).toHaveLength(2);
  });

  it("yields each acknowledged range", async () => {
    const { fetch } = upsertEcho();
    const records = Array.from({ length: 5 }, (_, i) => ({ id: `r${i}`, values: [1.0] }));
    const batches = await collect(client(fetch).vectorIndexes.upsertBatches("movies", "ns1", records, { batchSize: 2 }));
    expect(batches).toEqual([
      { offset: 0, count: 2, upserted_count: 2, namespace_created: true, receipt: { n: 2 } },
      { offset: 2, count: 2, upserted_count: 2, namespace_created: false, receipt: { n: 2 } },
      { offset: 4, count: 1, upserted_count: 1, namespace_created: false, receipt: { n: 1 } },
    ]);
  });

  it("treats an answer without a count as a protocol error", async () => {
    const { fetch } = engine([[200, { receipt: {} }]]);
    const error = await failure(client(fetch).vectorIndexes.upsert("movies", "ns1", [{ id: "a", values: [1.0] }]));
    expect(error).toMatchObject({ outcome: "unknown" });
    expect((error as BatchWriteError).cause).toBeInstanceOf(ProtocolError);
  });

  it("sends nothing for no records", async () => {
    const { fetch, calls } = upsertEcho();
    const out = await client(fetch).vectorIndexes.upsert("movies", "ns1", []);
    expect(out).toEqual({ upserted_count: 0, namespace_created: false, batches: 0, receipts: [] });
    expect(calls).toEqual([]);
  });

  it.each([
    { batchSize: 0 }, { batchSize: 1001 }, { batchSize: 1.5 }, { batchSize: true as unknown as number },
    { maxBytes: 2_000_001 }, { maxBytes: 10 },
  ])("checks batch options before any request: %o", async (options) => {
    const { fetch, calls } = upsertEcho();
    expect(await failure(client(fetch).vectorIndexes.upsert("movies", "ns1", [{ id: "a" }], options)))
      .toBeInstanceOf(RangeError);
    expect(calls).toEqual([]);
  });

  it("sends typed arrays as JSON arrays", async () => {
    const echo = upsertEcho();
    await client(echo.fetch).vectorIndexes.upsert("movies", "ns1", [{ id: "a", values: new Float64Array([0.5, 1.0]) }]);
    expect(echo.calls[0]!.body).toBe('{"namespace":"ns1","records":[{"id":"a","values":[0.5,1]}]}');
    const { fetch, calls } = engine([[200, { hits: [] }]]);
    await client(fetch).vectorIndexes.search("movies", "ns1", { k: 1, vector: new Float32Array([0.25]) });
    expect((sent(calls[0]) as { dense: unknown }).dense).toEqual({ vector: [0.25] });
  });

  it("accepts an asynchronous source and reports a later failure", async () => {
    const { fetch, calls } = upsertEcho(3);
    async function* records() {
      for (let i = 0; i < 2500; i++) yield { id: `r${i}`, values: [1.0] };
    }
    const error = await failure(client(fetch).vectorIndexes.upsert("movies", "ns1", records()));
    expect(error).toMatchObject({ offset: 2000, count: 500, outcome: "unknown" });
    expect((error as BatchWriteError).cause).toMatchObject({ reason: "exact_index_capacity" });
    expect(sentIds(calls)[1]).toEqual([1000, 1000, 500]);
  });

  it("does not send what a failing asynchronous source held", async () => {
    const { fetch, calls } = upsertEcho();
    async function* records() {
      yield { id: "a" };
      throw new Error("source broke");
    }
    const error = await failure(client(fetch).vectorIndexes.upsert("movies", "ns1", records()));
    expect(error).toMatchObject({ offset: 0, count: 1, outcome: "not_sent" });
    expect(calls).toEqual([]);
  });

  it("reports a synchronous source failure after acknowledged records", async () => {
    const { fetch, calls } = upsertEcho();
    function* records() {
      yield { id: "a" };
      yield { id: "b" };
      throw new Error("source broke");
    }
    const error = await failure(client(fetch).vectorIndexes.upsert("movies", "ns1", records(), { batchSize: 1 }));
    // a and b were acknowledged one by one; the source failed after them.
    expect(sentIds(calls)).toEqual([["a", "b"], [1, 1]]);
    expect(error).toMatchObject({ offset: 2, count: 0, outcome: "not_sent" });
  });

  it("sends no further batch and closes the source when the loop breaks", async () => {
    const { fetch, calls } = upsertEcho();
    let closed = false, read = 0;
    function* records() {
      try {
        for (let i = 0; i < 10; i++) { read++; yield { id: `r${i}` }; }
      } finally { closed = true; }
    }
    for await (const batch of client(fetch).vectorIndexes.upsertBatches("movies", "ns1", records(), { batchSize: 2 })) {
      expect(batch.offset).toBe(0);
      break;
    }
    expect(calls).toHaveLength(1);
    expect(read).toBe(2);
    expect(closed).toBe(true);
  });
});

// ── Fetch, update, delete, count, jobs ────────────────────────────────────

describe("records", () => {
  it("fetches records", async () => {
    const answer = {
      records: { a: { id: "a", rev: 4, revision_token: "rv1.x", values: [0.5, 1.0] } },
      missing: ["zz"],
      namespace: "ns1",
      receipt_position: { domain: "wal", value: "1:2" },
    };
    const { fetch, calls } = engine([[200, answer]]);
    const out = await client(fetch).vectorIndexes.fetch("movies", "ns1", ["a", "zz"], {
      include_values: true, include_sparse: true, metadata_fields: ["genre"], text_fields: ["body"],
    });
    expectCall(calls[0], "POST", `${BASE}/movies/records/fetch`,
      '{"namespace":"ns1","ids":["a","zz"],"include_values":true,"include_sparse":true,' +
      '"metadata_fields":["genre"],"text_fields":["body"]}');
    expect(out).toEqual(answer);
  });

  it("can turn metadata off", async () => {
    const { fetch, calls } = engine([[200, { records: {}, missing: [] }]]);
    await client(fetch).vectorIndexes.fetch("movies", VECTOR_INDEX_DEFAULT_NAMESPACE, ["a"], { include_metadata: false });
    expectCall(calls[0], "POST", `${BASE}/movies/records/fetch`,
      '{"namespace":"__default__","ids":["a"],"include_metadata":false}');
  });

  it("refuses a string where a list of ids belongs", async () => {
    const { fetch, calls } = engine([[200, {}]]);
    const vi = client(fetch).vectorIndexes;
    const notIds = "abc" as unknown as string[];
    expect(await failure(vi.fetch("movies", "ns1", notIds))).toBeInstanceOf(TypeError);
    expect(await failure(vi.delete("movies", "ns1", notIds))).toBeInstanceOf(TypeError);
    expect(calls).toEqual([]);
  });

  it("fetches by filter", async () => {
    const { fetch, calls } = engine([[200, { records: {}, namespace: "ns1", next_cursor: "f2" }]]);
    const vi = client(fetch).vectorIndexes;
    const out = await vi.fetchByFilter("movies", "ns1", {
      filter_expr: { year: { $gt: 1999 } }, limit: 50, cursor: "f1", include_metadata: false,
    });
    await vi.fetchByFilter("movies", "ns1", { filter: { genre: "drama" } });
    const path = `${BASE}/movies/records/fetch-by-filter`;
    expectCall(calls[0], "POST", path,
      '{"namespace":"ns1","filter_expr":{"year":{"$gt":1999}},"limit":50,"cursor":"f1","include_metadata":false}');
    expectCall(calls[1], "POST", path, '{"namespace":"ns1","filter":{"genre":"drama"}}');
    expect(out.next_cursor).toBe("f2");
  });

  it.each<[string, (vi: VectorIndexes) => Promise<unknown>]>([
    ["fetchByFilter without a filter", vi => vi.fetchByFilter("movies", "ns1", {})],
    ["fetchByFilter with both filters", vi => vi.fetchByFilter("movies", "ns1", { filter_expr: { a: { $eq: 1 } }, filter: { a: 1 } })],
    ["deleteByFilter without a filter", vi => vi.deleteByFilter("movies", "ns1", {})],
    ["updateByFilter without a filter", vi => vi.updateByFilter("movies", "ns1", { metadata_merge: { a: 1 } })],
    ["updateByFilter without a change", vi => vi.updateByFilter("movies", "ns1", { filter_expr: { a: { $eq: 1 } } })],
    ["count with both filters", vi => vi.count("movies", "ns1", { filter_expr: { a: { $eq: 1 } }, filter: { a: 1 } })],
    ["update without a change", vi => vi.update("movies", "ns1", "a", {})],
    ["update with a non-string id", vi => vi.update("movies", "ns1", 7 as unknown as string, { metadata_merge: { a: 1 } })],
  ])("refuses a bad selection before any request: %s", async (_name, call) => {
    const { fetch, calls } = engine([[200, {}]]);
    expect(await failure(call(client(fetch).vectorIndexes))).toBeInstanceOf(TypeError);
    expect(calls).toEqual([]);
  });

  it("lists ids", async () => {
    const { fetch, calls } = engine([[200, { ids: ["a", "b"], next_cursor: "l2" }]]);
    const out = await client(fetch).vectorIndexes.listIds("movies", "ns1", { prefix: "doc-", limit: 2, cursor: "l1" });
    expectCall(calls[0], "POST", `${BASE}/movies/records/list-ids`,
      '{"namespace":"ns1","prefix":"doc-","limit":2,"cursor":"l1"}');
    expect(out.ids).toEqual(["a", "b"]);
  });

  it("updates a record by id", async () => {
    const { fetch, calls } = engine([[200, { receipt: { records: [{ id: "a", rev: 5 }] } }]]);
    const out = await client(fetch).vectorIndexes.update("movies", "ns1", "a", {
      values: [0.1, 0.2, 0.3],
      sparse_values: { indices: [1], values: [0.5] },
      metadata_merge: { genre: "comedy" },
      metadata_remove: ["draft"],
      text_set: { body: "new" },
      text_remove: ["title"],
      if_revision_token: "rv1.abc",
    });
    expectCall(calls[0], "POST", `${BASE}/movies/records/update`,
      '{"namespace":"ns1","id":"a","values":[0.1,0.2,0.3],' +
      '"sparse_values":{"indices":[1],"values":[0.5]},"metadata_merge":{"genre":"comedy"},' +
      '"metadata_remove":["draft"],"text_set":{"body":"new"},"text_remove":["title"],' +
      '"if_revision_token":"rv1.abc"}');
    expect(out).toEqual({ receipt: { records: [{ id: "a", rev: 5 }] } });
  });

  it("replaces metadata", async () => {
    const { fetch, calls } = engine([[200, { receipt: {} }]]);
    await client(fetch).vectorIndexes.update("movies", "ns1", "a", { metadata_replace: { genre: "drama" } });
    expectCall(calls[0], "POST", `${BASE}/movies/records/update`,
      '{"namespace":"ns1","id":"a","metadata_replace":{"genre":"drama"}}');
  });

  it("updates by filter", async () => {
    const { fetch, calls } = engine([[202, { job_id: "01JOB", receipt: {} }]]);
    const vi = client(fetch).vectorIndexes;
    const out = await vi.updateByFilter("movies", "ns1", {
      filter_expr: { genre: { $eq: "drama" } }, metadata_merge: { seen: true },
    });
    await vi.updateByFilter("movies", "ns1", { filter: { genre: "drama" }, metadata_remove: ["seen"], dry_run: true });
    const path = `${BASE}/movies/records/update`;
    expectCall(calls[0], "POST", path,
      '{"namespace":"ns1","filter_expr":{"genre":{"$eq":"drama"}},"metadata_merge":{"seen":true}}');
    expectCall(calls[1], "POST", path,
      '{"namespace":"ns1","filter":{"genre":"drama"},"metadata_remove":["seen"],"dry_run":true}');
    expect(out.job_id).toBe("01JOB");
  });

  it("deletes by ids", async () => {
    const { fetch, calls } = engine([[200, { deleted: 1, missing: 1, receipt: {} }]]);
    const out = await client(fetch).vectorIndexes.delete("movies", "ns1", ["a", "zz"]);
    expectCall(calls[0], "POST", `${BASE}/movies/records/delete`, '{"namespace":"ns1","ids":["a","zz"]}');
    expect([out.deleted, out.missing]).toEqual([1, 1]);
  });

  it("deletes by filter as a job", async () => {
    const { fetch, calls } = engine([[202, { job_id: "01JOB", receipt: {} }]]);
    const out = await client(fetch).vectorIndexes.deleteByFilter("movies", "ns1", { filter_expr: { genre: { $eq: "drama" } } });
    expectCall(calls[0], "POST", `${BASE}/movies/records/delete`,
      '{"namespace":"ns1","filter_expr":{"genre":{"$eq":"drama"}}}');
    expect(out.job_id).toBe("01JOB");
  });

  it("deletes by filter as a dry run", async () => {
    const { fetch, calls } = engine([[200, { dry_run: true, matched_records: 12, sample_ids: ["a"] }]]);
    const out = await client(fetch).vectorIndexes.deleteByFilter("movies", "ns1", { filter: { genre: "drama" }, dry_run: true });
    expectCall(calls[0], "POST", `${BASE}/movies/records/delete`,
      '{"namespace":"ns1","filter":{"genre":"drama"},"dry_run":true}');
    expect(out.matched_records).toBe(12);
    expect("job_id" in out).toBe(false);
  });

  it("sends the confirmation when deleting all records", async () => {
    const { fetch, calls } = engine([[200, { receipt: {} }]]);
    const vi = client(fetch).vectorIndexes;
    await vi.deleteAll("movies", "ns1");
    await vi.deleteAll("movies", "ns1", { dry_run: true });
    const path = `${BASE}/movies/records/delete`;
    expectCall(calls[0], "POST", path, '{"namespace":"ns1","all":true,"confirm":"ns1"}');
    expectCall(calls[1], "POST", path, '{"namespace":"ns1","all":true,"confirm":"ns1","dry_run":true}');
  });

  it("counts records", async () => {
    const { fetch, calls } = engine([[200, { count: 3, namespace: "ns1" }]]);
    const vi = client(fetch).vectorIndexes;
    const out = await vi.count("movies", "ns1");
    await vi.count("movies", "ns1", { filter_expr: { genre: { $in: ["a", "b"] } } });
    const path = `${BASE}/movies/records/count`;
    expectCall(calls[0], "POST", path, '{"namespace":"ns1"}');
    expectCall(calls[1], "POST", path, '{"namespace":"ns1","filter_expr":{"genre":{"$in":["a","b"]}}}');
    expect(out.count).toBe(3);
  });

  it("reads and cancels a job", async () => {
    const job = { job_id: "01JOB", kind: "delete_by_filter", state: "running", progress: {} };
    const { fetch, calls } = engine([[200, job], [202, {}]]);
    const vi = client(fetch).vectorIndexes;
    const out = await vi.getJob("movies", "01JOB");
    await vi.cancelJob("movies", "01JOB");
    expectCall(calls[0], "GET", `${BASE}/movies/jobs/01JOB`);
    expectCall(calls[1], "POST", `${BASE}/movies/jobs/01JOB/cancel`);
    expect(out).toEqual(job);
  });
});

// ── Search ────────────────────────────────────────────────────────────────

const SEARCH = {
  index_id: "01IX",
  namespace: "ns1",
  mode: "semantic",
  ranking_method: "dense_similarity",
  k: 2,
  returned: 1,
  completeness: { value: "ann_full" },
  hits: [{ id: "a", score: 0.91, rank: 1, metadata: { genre: "drama" } }],
};

describe("search", () => {
  it("runs a dense semantic search", async () => {
    const { fetch, calls } = engine([[200, SEARCH]]);
    const out = await client(fetch).vectorIndexes.search("movies", "ns1", {
      k: 2,
      vector: [0.5, 1.0, -2.0],
      quality: "exact",
      filter_expr: { genre: { $eq: "drama" } },
      include_values: true,
      include_metadata: true,
      metadata_fields: ["genre"],
      include_components: false,
      require_complete: true,
      timeout_ms: 500,
    });
    expectCall(calls[0], "POST", `${BASE}/movies/search`,
      '{"namespace":"ns1","mode":"semantic","k":2,' +
      '"dense":{"vector":[0.5,1,-2],"quality":"exact"},' +
      '"filter_expr":{"genre":{"$eq":"drama"}},' +
      '"include_values":true,"include_metadata":true,"metadata_fields":["genre"],' +
      '"include_components":false,"require_complete":true,"timeout_ms":500}');
    expect(out.hits[0]!.id).toBe("a");
  });

  it("runs a minimal search and one by record id", async () => {
    const { fetch, calls } = engine([[200, SEARCH]]);
    const vi = client(fetch).vectorIndexes;
    await vi.search("movies", "ns1", { k: 5, vector: [1.0] });
    await vi.search("movies", "ns1", { k: 5, record_id: "a", filter: { genre: "drama" } });
    const path = `${BASE}/movies/search`;
    expectCall(calls[0], "POST", path, '{"namespace":"ns1","mode":"semantic","k":5,"dense":{"vector":[1]}}');
    expectCall(calls[1], "POST", path,
      '{"namespace":"ns1","mode":"semantic","k":5,"dense":{"record_id":"a"},"filter":{"genre":"drama"}}');
  });

  it("runs sparse, keyword and hybrid searches", async () => {
    const { fetch, calls } = engine([[200, SEARCH]]);
    const vi = client(fetch).vectorIndexes;
    const sparse = { indices: [3, 9], values: [0.2, 0.5], scorer: "dot" };
    const lexical = { field: "body", query: "quiet film", match: "phrase" };
    await vi.search("movies", "ns1", { k: 3, sparse });
    await vi.search("movies", "ns1", { k: 3, lexical, text_fields: ["body"] });
    await vi.search("movies", "ns1", {
      k: 3, dense: { vector: [1.0], candidates: 80 }, sparse, lexical, fusion: { method: "rrf", rrf_k: 20 },
    });
    await vi.search("movies", "ns1", { k: 3, vector: [1.0], lexical });
    await vi.search("movies", "ns1", { k: 3, vector: [1.0], mode: "dense_with_text_filter" });
    const bodies = calls.map(sent) as Record<string, unknown>[];
    expect(bodies[0]).toEqual({ namespace: "ns1", mode: "semantic", k: 3, sparse });
    expect(bodies[1]).toEqual({ namespace: "ns1", mode: "lexical", k: 3, lexical, text_fields: ["body"] });
    expect(bodies[2]).toEqual({
      namespace: "ns1", mode: "hybrid", k: 3, dense: { vector: [1.0], candidates: 80 }, sparse, lexical,
      fusion: { method: "rrf", rrf_k: 20 },
    });
    // Without `fusion`, a hybrid search is fused by reciprocal rank on the server.
    expect(bodies[3]).toEqual({ namespace: "ns1", mode: "hybrid", k: 3, dense: { vector: [1.0] }, lexical });
    expect(bodies[4]!.mode).toBe("dense_with_text_filter");
  });

  it.each<[string, Record<string, unknown>, typeof TypeError | typeof RangeError]>([
    ["no query leg", { k: 5 }, TypeError],
    ["vector and record_id", { k: 5, vector: [1.0], record_id: "a" }, TypeError],
    ["dense and vector", { k: 5, dense: { vector: [1.0] }, vector: [1.0] }, TypeError],
    ["dense and quality", { k: 5, dense: { vector: [1.0] }, quality: "exact" }, TypeError],
    ["quality alone", { k: 5, quality: "exact", sparse: { indices: [1], values: [1.0] } }, TypeError],
    ["k of 0", { k: 0, vector: [1.0] }, RangeError],
    ["a boolean k", { k: true, vector: [1.0] }, RangeError],
    ["a string k", { k: "5", vector: [1.0] }, RangeError],
    ["a fractional k", { k: 1.5, vector: [1.0] }, RangeError],
    ["both filters", { k: 5, vector: [1.0], filter_expr: { a: { $eq: 1 } }, filter: { a: 1 } }, TypeError],
    ["a NaN in the vector", { k: 5, vector: [NaN] }, TypeError],
  ])("refuses %s before any request", async (_name, query, kind) => {
    const { fetch, calls } = engine([[200, SEARCH]]);
    const error = await failure(client(fetch).vectorIndexes.search("movies", "ns1", query as never));
    expect(error).toBeInstanceOf(kind);
    expect(calls).toEqual([]);
  });

  it("does not send a search whose signal is already aborted", async () => {
    const { fetch, calls } = engine([[200, SEARCH]]);
    const controller = new AbortController();
    controller.abort();
    await expect(client(fetch).vectorIndexes.search("movies", "ns1", { k: 1, vector: [1] },
      { signal: controller.signal })).rejects.toThrow();
    expect(calls).toEqual([]);
  });
});

// ── Errors ────────────────────────────────────────────────────────────────

function envelope(code: string, status: number, retryable: boolean, details?: Record<string, unknown>) {
  const error: Record<string, unknown> = { code, message: `message for ${code}`, status, retryable };
  if (details !== undefined) error.details = details;
  return { error };
}

type ErrorClass = abstract new (...args: never[]) => ApiError;
const ERROR_CASES: [number, string, boolean, Record<string, unknown> | undefined, ErrorClass][] = [
  [400, "invalid_argument", false, { reason: "k_out_of_range", limit: 10000 }, ApiError],
  [400, "unknown_request_field", false, { unknown: ["/dense/bogus"] }, ApiError],
  [401, "unauthorized", false, undefined, ApiError],
  [403, "key_scope_insufficient", false, undefined, ApiError],
  [404, "index_not_found", false, undefined, ApiError],
  [404, "record_not_found", false, undefined, ApiError],
  [409, "index_already_exists", false, { reason: "index_already_exists" }, ApiError],
  [409, "index_capability_missing", false, { reason: "sparse_not_declared" }, ApiError],
  [409, "record_write_conflict", true, undefined, ApiError],
  [413, "request_too_large", false, undefined, ApiError],
  [422, "filtered_search_incomplete", false, undefined, ApiError],
  [429, "overloaded", true, undefined, ApiError],
  [501, "not_implemented", false, { reason: "record_api_not_enabled" }, OCRecordApiNotEnabledError],
  [501, "not_implemented", false, { reason: "ivf_pq_index_rebuild" }, ApiError],
  [503, "record_api_restore_pending", true, undefined, ApiError],
];

describe("errors", () => {
  it.each(ERROR_CASES)("maps %i %s", async (status, code, retryable, details, kind) => {
    const requestId = "0190b3e2-8f4a-7c1d-b5e6-0123456789ab";
    const { fetch, calls } = engine([[status, envelope(code, status, retryable, details)]],
      { "x-oc-request-id": requestId, "retry-after": "7" });
    const error = await failure(client(fetch).vectorIndexes.search("movies", "ns1", { k: 5, vector: [1.0] }));
    expect(error).toBeInstanceOf(kind);
    expect((error as object).constructor).toBe(kind);
    const e = error as ApiError;
    expect(e.status).toBe(status);
    expect(e.code).toBe(code);
    expect(e.retryable).toBe(retryable);
    expect(e.details).toEqual(details);
    expect(e.reason).toBe(details?.reason);
    expect(e.message).toBe(`message for ${code}`);
    expect(e.requestId).toBe(requestId);
    expect(e.logicalRequestId).toBe(calls[0]!.headers.get("x-oc-logical-request-id"));
    expect(e.retryAfter).toBe("7");
    expect(calls).toHaveLength(1); // no automatic retries by default
  });

  it("raises the not-enabled error as an ApiError", async () => {
    const { fetch } = engine([[501, envelope("not_implemented", 501, false, { reason: "record_api_not_enabled" })]]);
    const error = await failure(client(fetch).vectorIndexes.listIndexes());
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toBeInstanceOf(OCRecordApiNotEnabledError);
    expect((error as Error).name).toBe("OCRecordApiNotEnabledError");
  });

  it("leaves the envelope fields unset for a flat error body", async () => {
    // Other routes answer {"error": "<text>"}; that keeps working.
    const { fetch } = engine([[400, { error: "bad thing" }]]);
    const e = await failure(client(fetch).vectorIndexes.describeIndex("movies")) as ApiError;
    expect(e.message).toBe("bad thing");
    expect(e.code).toBe("bad thing");
    expect([e.reason, e.details, e.retryable]).toEqual([undefined, undefined, undefined]);
  });

  it("uses the code of an envelope without a message", async () => {
    const { fetch } = engine([[404, { error: { code: "job_not_found" } }]]);
    const e = await failure(client(fetch).vectorIndexes.getJob("movies", "01JOB")) as ApiError;
    expect(e.message).toBe("job_not_found");
    expect(e.code).toBe("job_not_found");
  });

  it("keeps the default message and code when the envelope has neither", async () => {
    const { fetch } = engine([[500, { error: { retryable: true } }]]);
    const e = await failure(client(fetch).vectorIndexes.describeIndex("movies")) as ApiError;
    expect([e.message, e.code, e.retryable]).toEqual(["HTTP 500", "http_error", true]);
  });
});

// ── Retries ───────────────────────────────────────────────────────────────

describe("retries", () => {
  it("retry reads when retries are on", async () => {
    const { fetch, calls } = engine([[429, envelope("overloaded", 429, true)], [200, SEARCH]], { "retry-after": "0" });
    const out = await client(fetch, 1).vectorIndexes.search("movies", "ns1", { k: 5, vector: [1.0] });
    expect(out.returned).toBe(1);
    expect(calls.map(c => c.headers.get("x-oc-attempt"))).toEqual(["1", "2"]);
    expect(calls[0]!.body).toBe(calls[1]!.body);
    const ids = calls.map(c => c.headers.get("x-oc-logical-request-id"));
    expect(ids[0]).toBe(ids[1]);
  });

  it.each<[string, (vi: VectorIndexes) => Promise<unknown>]>([
    ["describeIndex", vi => vi.describeIndex("movies")],
    ["listIndexes", vi => vi.listIndexes()],
    ["fetch", vi => vi.fetch("movies", "ns1", ["a"])],
    ["count", vi => vi.count("movies", "ns1")],
    ["getJob", vi => vi.getJob("movies", "01JOB")],
  ])("retry the read %s", async (_name, call) => {
    const { fetch, calls } = engine([[503, envelope("unavailable", 503, true)], [200, { count: 1 }]], { "retry-after": "0" });
    await call(client(fetch, 1).vectorIndexes);
    expect(calls).toHaveLength(2);
  });

  it.each<[string, (vi: VectorIndexes) => Promise<unknown>]>([
    ["upsert", vi => vi.upsert("movies", "ns1", [{ id: "a", values: [1.0] }])],
    ["delete", vi => vi.delete("movies", "ns1", ["a"])],
    ["deleteByFilter", vi => vi.deleteByFilter("movies", "ns1", { filter_expr: { a: { $eq: 1 } } })],
    ["deleteAll", vi => vi.deleteAll("movies", "ns1")],
    ["update", vi => vi.update("movies", "ns1", "a", { metadata_merge: { b: 1 } })],
    ["updateByFilter", vi => vi.updateByFilter("movies", "ns1", { filter: { a: 1 }, metadata_merge: { b: 1 } })],
    ["createIndex", vi => vi.createIndex("movies", { dimension: 3 })],
    ["configureIndex", vi => vi.configureIndex("movies", { tags: { a: "b" } })],
    ["deleteIndex", vi => vi.deleteIndex("movies")],
    ["createNamespace", vi => vi.createNamespace("movies", "ns1")],
    ["deleteNamespace", vi => vi.deleteNamespace("movies", "ns1")],
    ["buildIndex", vi => vi.buildIndex("movies", "ns1")],
    ["cancelJob", vi => vi.cancelJob("movies", "01JOB")],
  ])("never send the write %s twice", async (_name, call) => {
    const { fetch, calls } = engine([[503, envelope("unavailable", 503, true)], [200, { upserted_count: 1 }]],
      { "retry-after": "0" });
    const error = await failure(call(client(fetch, 3).vectorIndexes));
    expect(error instanceof ApiError || error instanceof BatchWriteError).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("do not retry a database without the record operations", async () => {
    const { fetch, calls } = engine([[501, envelope("not_implemented", 501, false, { reason: "record_api_not_enabled" })]]);
    expect(await failure(client(fetch, 3).vectorIndexes.describeIndex("movies"))).toBeInstanceOf(OCRecordApiNotEnabledError);
    expect(calls).toHaveLength(1);
  });
});

describe("surface", () => {
  it("exposes every operation on client.vectorIndexes", () => {
    const vi = client(engine([[200, {}]]).fetch).vectorIndexes;
    expect(vi).toBeInstanceOf(VectorIndexes);
    const methods = Object.getOwnPropertyNames(VectorIndexes.prototype)
      .filter(name => name !== "constructor" && name !== "send").sort();
    expect(methods).toEqual([
      "buildIndex", "cancelJob", "configureIndex", "configureNamespace", "count", "createIndex",
      "createNamespace", "delete", "deleteAll", "deleteByFilter", "deleteIndex", "deleteNamespace",
      "describeIndex", "describeNamespace", "fetch", "fetchByFilter", "getJob", "indexStats",
      "iterIds", "iterIndexes", "iterNamespaces", "iterRecords", "listIds", "listIndexes",
      "listNamespaces", "search", "update", "updateByFilter", "upsert", "upsertBatches",
    ]);
  });
});
