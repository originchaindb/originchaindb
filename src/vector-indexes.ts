// `client.vectorIndexes`: record operations on vector indexes.
//
// An index holds namespaces, and a namespace holds records. A record has an
// `id` and any of a dense vector (`values`), a sparse vector
// (`sparse_values`), flat `metadata` and declared `text` fields. Every method
// takes the index by its name or its `index_id`. Record calls always name a
// namespace; `"__default__"` is the default one.
//
// The routes are `<url>/vector-indexes/...`. They are separate from the
// per-table `client.vector` calls (`<url>/vector/<table>/...`), which keep
// working unchanged; the two never share data.
//
// Request fields use the server's own snake_case names, like the responses,
// which are returned as the server sent them. Options that only steer this
// client (`batchSize`, `maxBytes`, `signal`) are camelCase, as elsewhere in
// this SDK.
//
// Failures are `ApiError`. Branch on `code` plus `reason` (the server's
// `error.details.reason`), never on `status` alone. A database where these
// operations are not switched on answers every call with
// `OCRecordApiNotEnabledError`.
//
// Retries: `maxRetries` applies to the read operations (describe, list,
// fetch, count, statistics, search, job status), which are safe to send again.
// Writes are never sent twice by this client.

import type { OriginChainClient } from "./client.js";
import { abortable } from "./integration.js";
import { BatchWriteError } from "./iteration.js";
import { segment } from "./resources.js";
import { ProtocolError } from "./sql.js";

/** The server's cap on records in one upsert request. */
export const VECTOR_INDEX_UPSERT_MAX_RECORDS = 1000;
/** The server's bound on one upsert request body, in bytes. */
export const VECTOR_INDEX_UPSERT_MAX_BODY_BYTES = 2_000_000;
/** The default namespace. */
export const VECTOR_INDEX_DEFAULT_NAMESPACE = "__default__";

// ── Request types ─────────────────────────────────────────────────────────

/** A list of numbers. Typed arrays are sent as JSON arrays. */
export type VectorIndexValues = readonly number[] | Float32Array | Float64Array | Int32Array | Uint32Array;
export type VectorIndexMetric = "cosine" | "dot" | "l2" | "manhattan";
export type VectorIndexSearchQuality = "fast" | "high_recall" | "exact";

export interface VectorIndexSparseValues {
  indices: VectorIndexValues;
  values: VectorIndexValues;
}

export interface VectorIndexTextField {
  name: string;
  analyzer: string;
}

/** One record of an upsert. Only `id` is always required. An upsert replaces
 * the whole record. */
export interface VectorIndexRecord {
  id: string;
  values?: VectorIndexValues;
  sparse_values?: VectorIndexSparseValues;
  metadata?: Record<string, unknown>;
  text?: Record<string, string>;
}

/** Per-call options. */
export interface VectorIndexRequestOptions {
  signal?: AbortSignal;
}

/** Upsert options. `batchSize` (1 to 1,000) and `maxBytes` (up to
 * 2,000,000) only lower the server's limits. */
export interface VectorIndexUpsertOptions {
  batchSize?: number;
  maxBytes?: number;
  signal?: AbortSignal;
}

/** At least one of `dimension`, `sparse: true` or `text_fields` is required. */
export interface VectorIndexSpec {
  dimension?: number;
  /** Goes with `dimension`. */
  metric?: VectorIndexMetric;
  sparse?: boolean;
  text_fields?: VectorIndexTextField[];
  visibility_fields?: string[];
  /** `"unicode"` (the default) or `"ascii"`. */
  identifier_profile?: "unicode" | "ascii";
  deletion_protection?: "enabled" | "disabled";
  tags?: Record<string, string>;
}

/** Send `deletion_protection`, `tags` or both. A tag set to `""` is removed. */
export interface VectorIndexChanges {
  deletion_protection?: "enabled" | "disabled";
  tags?: Record<string, string>;
}

/** Restricts a call to matching records: `filter_expr` takes operators such as
 * `$eq`, `$ne`, `$in`, `$gt`, `$exists`, `$and` and `$or`; `filter` takes a
 * plain equality map. Pass at most one. */
export interface VectorIndexFilter {
  filter_expr?: Record<string, unknown>;
  filter?: Record<string, unknown>;
}

/** What a read returns of each record. `fetch` returns metadata unless
 * `include_metadata` is `false`; search returns it only when it is `true`. */
export interface VectorIndexProjection {
  include_values?: boolean;
  include_sparse?: boolean;
  include_metadata?: boolean;
  metadata_fields?: string[];
  text_fields?: string[];
}

export interface VectorIndexFetchByFilter extends VectorIndexFilter, VectorIndexProjection {
  limit?: number;
  cursor?: string;
}

/** The changes of `update`. At least one is required. */
export interface VectorIndexUpdate {
  values?: VectorIndexValues;
  sparse_values?: VectorIndexSparseValues;
  /** Sets these keys. */
  metadata_merge?: Record<string, unknown>;
  /** Replaces the whole metadata map. */
  metadata_replace?: Record<string, unknown>;
  /** Drops these keys. */
  metadata_remove?: string[];
  text_set?: Record<string, string>;
  text_remove?: string[];
  /** Apply only if the record has not changed since this token (from a fetch
   * or a receipt). */
  if_revision_token?: string;
}

/** `filter_expr` or `filter` is required, and `metadata_merge` or
 * `metadata_remove`. */
export interface VectorIndexUpdateByFilter extends VectorIndexFilter {
  metadata_merge?: Record<string, unknown>;
  metadata_remove?: string[];
  dry_run?: boolean;
}

/** `filter_expr` or `filter` is required. */
export interface VectorIndexDeleteByFilter extends VectorIndexFilter {
  dry_run?: boolean;
}

/**
 * A search. `k` is required.
 *
 * Query legs:
 * - dense: `vector` or `record_id` (the stored vector of a record), with
 *   `quality` `"fast"`, `"high_recall"` (the default) or `"exact"`; or the
 *   whole leg as `dense` (adds `candidates`);
 * - `sparse: { indices, values }` (optional `scorer` `"cosine"` or `"dot"`,
 *   `candidates`);
 * - `lexical: { field, query }` (BM25 over a declared text field; optional
 *   `match` `"terms"` or `"phrase"`).
 *
 * One leg is a `"semantic"` (dense or sparse) or `"lexical"` search; two or
 * more are `"hybrid"`, fused by reciprocal rank (`fusion: { method: "rrf",
 * rrf_k: 60 }` is the default). `mode` overrides that choice.
 */
export interface VectorIndexSearch extends VectorIndexFilter, VectorIndexProjection {
  k: number;
  vector?: VectorIndexValues;
  record_id?: string;
  quality?: VectorIndexSearchQuality;
  dense?: Record<string, unknown>;
  sparse?: Record<string, unknown>;
  lexical?: Record<string, unknown>;
  fusion?: Record<string, unknown>;
  mode?: string;
  include_components?: boolean;
  require_complete?: boolean;
  timeout_ms?: number;
}

// ── Response types ────────────────────────────────────────────────────────
// Responses are returned as the server sent them; these types name the
// documented fields, and every other field the server adds is kept.

/** A response object: the documented fields, plus whatever else the server sent. */
export interface VectorIndexAnswer {
  [field: string]: unknown;
}

export interface VectorIndex extends VectorIndexAnswer {
  index_id: string;
  name: string;
  /** `"active"`, or `"deleting"` once deletion has started. */
  state: string;
  dimension?: number;
  metric?: VectorIndexMetric;
  score_direction?: string;
  dense_index?: string;
  sparse?: boolean;
  text_fields?: VectorIndexTextField[];
  visibility_fields?: string[];
  deletion_protection?: "enabled" | "disabled";
  tags?: Record<string, string>;
  identifier_profile?: "unicode" | "ascii";
  created_at?: string;
}

/** `next_cursor` is absent on the last page. */
export interface VectorIndexPage extends VectorIndexAnswer {
  indexes: VectorIndex[];
  next_cursor?: string;
}

export interface VectorIndexNamespace extends VectorIndexAnswer {
  name: string;
  namespace_id?: string;
  state?: string;
  record_count?: number;
  declared_capacity?: number | null;
}

export interface VectorIndexNamespacePage extends VectorIndexAnswer {
  namespaces: VectorIndexNamespace[];
  next_cursor?: string;
}

/** At most 1,000 namespaces are listed; `truncated` says whether there are
 * more (page them with `listNamespaces`). */
export interface VectorIndexStats extends VectorIndexAnswer {
  namespaces: VectorIndexNamespace[];
  total_record_count: number;
  truncated?: boolean;
}

export interface VectorIndexStoredRecord extends VectorIndexAnswer {
  id: string;
  rev?: number;
  revision_token?: string;
  values?: number[];
  sparse_values?: { indices: number[]; values: number[] };
  metadata?: Record<string, unknown>;
  text?: Record<string, string>;
}

/** `records` is keyed by id; `missing` lists the ids not found. */
export interface VectorIndexFetchResult extends VectorIndexAnswer {
  records: Record<string, VectorIndexStoredRecord>;
  missing: string[];
  namespace?: string;
}

/** A page can be short, or empty, and still carry `next_cursor`; only a page
 * without one ends the listing. */
export interface VectorIndexRecordPage extends VectorIndexAnswer {
  records: Record<string, VectorIndexStoredRecord>;
  namespace?: string;
  next_cursor?: string;
}

export interface VectorIndexIdPage extends VectorIndexAnswer {
  ids: string[];
  next_cursor?: string;
}

export interface VectorIndexCount extends VectorIndexAnswer {
  count: number;
  namespace?: string;
}

export interface VectorIndexDeleteResult extends VectorIndexAnswer {
  deleted: number;
  missing: number;
  receipt?: unknown;
}

/** A background job that was started (`job_id`, `receipt`) or, for a dry run,
 * what would match (`dry_run: true`, `matched_records`, `sample_ids`). */
export interface VectorIndexFilterJob extends VectorIndexAnswer {
  job_id?: string;
  receipt?: unknown;
  dry_run?: boolean;
  matched_records?: number;
  sample_ids?: string[];
}

/** A background job. It is finished once `state` is no longer `queued` or
 * `running`. */
export interface VectorIndexJob extends VectorIndexAnswer {
  job_id: string;
  kind?: string;
  state: string;
  progress?: Record<string, unknown>;
}

export interface VectorIndexSearchHit extends VectorIndexAnswer {
  id: string;
  /** Always higher-is-better. */
  score: number;
  rank?: number;
  values?: number[];
  sparse_values?: { indices: number[]; values: number[] };
  metadata?: Record<string, unknown>;
}

/** Hits, best first. `completeness.value` says whether an approximate leg may
 * have missed records. */
export interface VectorIndexSearchResult extends VectorIndexAnswer {
  hits: VectorIndexSearchHit[];
  mode?: string;
  returned?: number;
  completeness?: { value: string; [field: string]: unknown };
  legs?: unknown[];
}

/** One acknowledged upsert request. `offset` and `count` name its range in
 * the caller's input; `receipt` is the server's write receipt. */
export interface VectorIndexUpsertBatch {
  readonly offset: number;
  readonly count: number;
  readonly upserted_count: number;
  readonly namespace_created: boolean;
  readonly receipt: unknown;
}

/** The sum over the requests an upsert sent; `receipts` holds one receipt per
 * request, in order. */
export interface VectorIndexUpsertResult {
  upserted_count: number;
  namespace_created: boolean;
  batches: number;
  receipts: unknown[];
}

// ── Encoding ──────────────────────────────────────────────────────────────

const utf8 = new TextEncoder();

/** Compact JSON, strict about what JSON cannot carry: NaN and Infinity, sets,
 * maps and functions fail here rather than being sent as something else.
 * Typed arrays are sent as arrays. */
function encode(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === "number" && !Number.isFinite(item)) throw new TypeError("Numbers must be finite");
    if (ArrayBuffer.isView(item) && !(item instanceof DataView)) return Array.from(item as unknown as ArrayLike<number>);
    if (item instanceof Set || item instanceof Map || typeof item === "function" || typeof item === "symbol")
      throw new TypeError("Value is not JSON: use arrays and plain objects");
    return item;
  });
}

/** Copy the set fields onto `body` in order; `undefined` and `null` are unset. */
function put(body: Record<string, unknown>, fields: Record<string, unknown>): Record<string, unknown> {
  for (const [key, value] of Object.entries(fields)) if (value !== undefined && value !== null) body[key] = value;
  return body;
}

function strings(values: unknown, name: string): string[] | undefined {
  if (values === undefined || values === null) return undefined;
  return idList(values, name);
}

function idList(values: unknown, name = "ids"): string[] {
  if (!Array.isArray(values)) throw new TypeError(`${name} must be an array of strings`);
  return [...values] as string[];
}

function selector(filter: VectorIndexFilter | undefined, required: boolean): Record<string, unknown> {
  const expr = filter?.filter_expr, equal = filter?.filter;
  if (expr != null && equal != null) throw new TypeError("Pass at most one of filter_expr and filter");
  if (required && expr == null && equal == null) throw new TypeError("filter_expr or filter is required");
  if (expr != null) return { filter_expr: expr };
  if (equal != null) return { filter: equal };
  return {};
}

function projection(p: VectorIndexProjection | undefined): Record<string, unknown> {
  return put({}, {
    include_values: p?.include_values,
    include_sparse: p?.include_sparse,
    include_metadata: p?.include_metadata,
    metadata_fields: strings(p?.metadata_fields, "metadata_fields"),
    text_fields: strings(p?.text_fields, "text_fields"),
  });
}

function indexPath(index: string, suffix = ""): string {
  return `/vector-indexes/${segment(index)}${suffix}`;
}

function searchBody(namespace: string, q: VectorIndexSearch): Record<string, unknown> {
  if (q === null || typeof q !== "object") throw new TypeError("search needs a query object");
  const { k } = q;
  if (typeof k !== "number" || !Number.isInteger(k) || k < 1) throw new RangeError("k must be a positive integer");
  const vector = q.vector ?? undefined, recordId = q.record_id ?? undefined, quality = q.quality ?? undefined;
  if (vector !== undefined && recordId !== undefined) throw new TypeError("Pass at most one of vector and record_id");
  const shorthand = vector !== undefined || recordId !== undefined || quality !== undefined;
  let dense = q.dense ?? undefined;
  if (dense !== undefined && shorthand) throw new TypeError("Pass dense, or vector / record_id / quality, not both");
  if (dense === undefined && shorthand) {
    if (vector === undefined && recordId === undefined) throw new TypeError("quality needs vector or record_id");
    dense = put({}, { vector, record_id: recordId, quality });
  }
  const legs = put({}, { dense, sparse: q.sparse, lexical: q.lexical });
  const count = Object.keys(legs).length;
  if (!count) throw new TypeError("search needs a query: vector, record_id, dense, sparse or lexical");
  const mode = q.mode ?? (count > 1 ? "hybrid" : "lexical" in legs ? "lexical" : "semantic");
  const body = put({ namespace, mode, k, ...legs }, { fusion: q.fusion });
  Object.assign(body, selector(q, false), projection(q));
  return put(body, {
    include_components: q.include_components,
    require_complete: q.require_complete,
    timeout_ms: q.timeout_ms,
  });
}

// ── Upsert batching ───────────────────────────────────────────────────────

interface Batch { offset: number; count: number; body: string }

/** Splits records into request bodies under both server bounds. Every record
 * lands in exactly one body, in input order, encoded once. Nothing is
 * truncated: a record that cannot fit a request on its own is refused before
 * its batch is sent. */
class UpsertBatcher {
  offset = 0;
  private items: string[] = [];
  private readonly head: string;
  private readonly overhead: number;
  private size: number;

  constructor(namespace: unknown, private readonly batchSize: number, private readonly maxBytes: number) {
    if (typeof namespace !== "string") throw new TypeError("namespace must be a string");
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > VECTOR_INDEX_UPSERT_MAX_RECORDS)
      throw new RangeError(`batchSize must be an integer from 1 to ${VECTOR_INDEX_UPSERT_MAX_RECORDS}`);
    this.head = `{"namespace":${encode(namespace)},"records":[`;
    this.overhead = utf8.encode(this.head).byteLength + 2; // "]}"
    if (!Number.isInteger(maxBytes) || maxBytes <= this.overhead || maxBytes > VECTOR_INDEX_UPSERT_MAX_BODY_BYTES)
      throw new RangeError(`maxBytes must be an integer up to ${VECTOR_INDEX_UPSERT_MAX_BODY_BYTES}`);
    this.size = this.overhead;
  }

  get pending(): number { return this.items.length; }

  /** Encode `record`; return the batches that are now ready to send. */
  add(record: unknown): Batch[] {
    if (record === null || typeof record !== "object" || Array.isArray(record))
      throw new TypeError("Each record must be an object");
    const raw = encode(record);
    const length = utf8.encode(raw).byteLength;
    if (this.overhead + length > this.maxBytes) {
      throw new RangeError(`Record ${JSON.stringify((record as { id?: unknown }).id) ?? "without an id"} is ` +
        `${length} bytes encoded, over the ${this.maxBytes}-byte request bound on its own`);
    }
    const ready: Batch[] = [];
    if (this.items.length && this.size + 1 + length > this.maxBytes) ready.push(this.take());
    this.size += length + (this.items.length ? 1 : 0);
    this.items.push(raw);
    if (this.items.length === this.batchSize) ready.push(this.take());
    return ready;
  }

  finish(): Batch[] { return this.items.length ? [this.take()] : []; }

  private take(): Batch {
    const batch = { offset: this.offset, count: this.items.length, body: `${this.head}${this.items.join(",")}]}` };
    this.offset += this.items.length;
    this.items = [];
    this.size = this.overhead;
    return batch;
  }
}

function acknowledged(answer: unknown, offset: number, count: number): VectorIndexUpsertBatch {
  const value = answer !== null && typeof answer === "object" ? answer as Record<string, unknown> : undefined;
  const upserted = value?.upserted_count;
  if (typeof upserted !== "number" || !Number.isInteger(upserted) || upserted < 0 || upserted > count)
    throw new ProtocolError("Upsert response must contain a valid upserted_count");
  return Object.freeze({
    offset, count, upserted_count: upserted,
    namespace_created: Boolean(value?.namespace_created), receipt: value?.receipt,
  });
}

// ── Paging ────────────────────────────────────────────────────────────────

function nextCursor(previous: string | undefined, cursor: unknown): string | undefined {
  if (cursor === undefined || cursor === null) return undefined;
  if (typeof cursor !== "string" || !cursor || cursor === previous)
    throw new ProtocolError("Page response carried an invalid next_cursor");
  return cursor;
}

function pageItems(page: unknown, key: string): unknown[] {
  const items = page !== null && typeof page === "object" ? (page as Record<string, unknown>)[key] : undefined;
  if (key === "records" && items !== null && typeof items === "object" && !Array.isArray(items)) return Object.values(items);
  if (!Array.isArray(items)) throw new ProtocolError(`Page response must contain ${key}`);
  return items;
}

async function* follow<T>(load: (cursor: string | undefined) => Promise<unknown>, key: string,
  signal: AbortSignal | undefined): AsyncGenerator<T> {
  let cursor: string | undefined;
  while (true) {
    signal?.throwIfAborted();
    const page = await load(cursor);
    for (const item of pageItems(page, key)) {
      signal?.throwIfAborted();
      yield item as T;
    }
    cursor = nextCursor(cursor, (page as Record<string, unknown>).next_cursor);
    if (cursor === undefined) return;
  }
}

// ── Client namespace ──────────────────────────────────────────────────────

/** `client.vectorIndexes`: record operations on vector indexes. */
export class VectorIndexes {
  constructor(private readonly client: OriginChainClient) {}

  /** Send one request. `read` marks it safe to send again under `maxRetries`. */
  private send<T>(method: string, path: string, body: Record<string, unknown> | string | undefined,
    read: boolean, options: VectorIndexRequestOptions): Promise<T> {
    const init: RequestInit & { retrySafe: boolean } = { method, retrySafe: read };
    if (body !== undefined) init.body = typeof body === "string" ? body : encode(body);
    if (options.signal !== undefined) init.signal = options.signal;
    return this.client._request<T>(this.client._door(path), init);
  }

  // Indexes

  /** Create an index and return it. A name that is already taken fails with
   * `code === "index_already_exists"` (409); creation is not sent twice, so
   * after a lost answer, describe the index. */
  async createIndex(name: string, spec: VectorIndexSpec = {}, options: VectorIndexRequestOptions = {}): Promise<VectorIndex> {
    const body = put({ name }, {
      dimension: spec.dimension,
      metric: spec.metric,
      sparse: spec.sparse,
      text_fields: spec.text_fields,
      visibility_fields: strings(spec.visibility_fields, "visibility_fields"),
      identifier_profile: spec.identifier_profile,
      deletion_protection: spec.deletion_protection,
      tags: spec.tags,
    });
    return this.send("POST", "/vector-indexes", body, false, options);
  }

  /** One index, by name or `index_id`. */
  async describeIndex(index: string, options: VectorIndexRequestOptions = {}): Promise<VectorIndex> {
    return this.send("GET", indexPath(index), undefined, true, options);
  }

  /** One page of live indexes in ascending name order. Send at most one of
   * `name` and `prefix`. */
  async listIndexes(page: { name?: string; prefix?: string; limit?: number; cursor?: string } = {},
    options: VectorIndexRequestOptions = {}): Promise<VectorIndexPage> {
    const body = put({}, { name: page.name, prefix: page.prefix, limit: page.limit, cursor: page.cursor });
    return this.send("POST", "/vector-indexes/list", body, true, options);
  }

  /** Every live index, one page in memory at a time and no prefetch. */
  iterIndexes(page: { prefix?: string; limit?: number } = {},
    options: VectorIndexRequestOptions = {}): AsyncGenerator<VectorIndex> {
    return follow((cursor) => this.listIndexes({ prefix: page.prefix, limit: page.limit, cursor }, options),
      "indexes", options.signal);
  }

  /** Change `deletion_protection` or `tags` (a tag set to `""` is removed).
   * Returns the index. */
  async configureIndex(index: string, changes: VectorIndexChanges, options: VectorIndexRequestOptions = {}): Promise<VectorIndex> {
    const body = put({}, { deletion_protection: changes?.deletion_protection, tags: changes?.tags });
    if (!Object.keys(body).length) throw new TypeError("configureIndex needs deletion_protection or tags");
    return this.send("PATCH", indexPath(index), body, false, options);
  }

  /** Start deleting an index and every record in it. Returns the index with
   * `state === "deleting"`. An index with deletion protection fails with
   * `code === "deletion_protection_enabled"`. */
  async deleteIndex(index: string, options: VectorIndexRequestOptions = {}): Promise<VectorIndex> {
    return this.send("DELETE", indexPath(index), undefined, false, options);
  }

  /** Record counts per namespace and in total. */
  async indexStats(index: string, options: VectorIndexRequestOptions = {}): Promise<VectorIndexStats> {
    return this.send("GET", indexPath(index, "/stats"), undefined, true, options);
  }

  // Namespaces

  /** Create a namespace. An upsert also creates its namespace; create one
   * explicitly to set `declared_capacity`, the most records it may hold. */
  async createNamespace(index: string, name: string, spec: { declared_capacity?: number } = {},
    options: VectorIndexRequestOptions = {}): Promise<VectorIndexNamespace> {
    const body = put({ name }, { declared_capacity: spec.declared_capacity });
    return this.send("POST", indexPath(index, "/namespaces/create"), body, false, options);
  }

  /** One namespace, with its `record_count`. */
  async describeNamespace(index: string, name: string, options: VectorIndexRequestOptions = {}): Promise<VectorIndexNamespace> {
    return this.send("POST", indexPath(index, "/namespaces/describe"), { name }, true, options);
  }

  /** One page of an index's namespaces. */
  async listNamespaces(index: string, page: { prefix?: string; limit?: number; cursor?: string } = {},
    options: VectorIndexRequestOptions = {}): Promise<VectorIndexNamespacePage> {
    const body = put({}, { prefix: page.prefix, limit: page.limit, cursor: page.cursor });
    return this.send("POST", indexPath(index, "/namespaces/list"), body, true, options);
  }

  /** Every namespace of an index, one page in memory at a time. */
  iterNamespaces(index: string, page: { prefix?: string; limit?: number } = {},
    options: VectorIndexRequestOptions = {}): AsyncGenerator<VectorIndexNamespace> {
    return follow((cursor) => this.listNamespaces(index, { prefix: page.prefix, limit: page.limit, cursor }, options),
      "namespaces", options.signal);
  }

  /** Set `declared_capacity`, or remove it with `null`. A value below the
   * records already held is refused (409). */
  async configureNamespace(index: string, name: string, changes: { declared_capacity: number | null },
    options: VectorIndexRequestOptions = {}): Promise<VectorIndexNamespace> {
    const capacity = changes?.declared_capacity;
    if (capacity !== null && typeof capacity !== "number")
      throw new TypeError("configureNamespace needs declared_capacity: a number, or null to remove it");
    // null is sent as JSON null: it removes the declared capacity.
    return this.send("POST", indexPath(index, "/namespaces/configure"),
      { name, declared_capacity: capacity }, false, options);
  }

  /** Delete a namespace and every record in it. The server requires the name
   * to be confirmed; this method sends the confirmation, so calling it is the
   * confirmation. The default namespace cannot be deleted (400,
   * `namespace_reserved`): clear it with `deleteAll`. */
  async deleteNamespace(index: string, name: string, options: VectorIndexRequestOptions = {}): Promise<VectorIndexAnswer> {
    return this.send("POST", indexPath(index, "/namespaces/delete"), { name, confirm: name }, false, options);
  }

  /** Build a namespace's disk IVF-PQ index as a background job: `{ job_id,
   * receipt }`. Poll `getJob`. */
  async buildIndex(index: string, namespace: string, build: { seed?: number } = {},
    options: VectorIndexRequestOptions = {}): Promise<VectorIndexFilterJob> {
    const body = put({ namespace }, { seed: build.seed });
    return this.send("POST", indexPath(index, "/namespaces/build-index"), body, false, options);
  }

  // Records

  /**
   * Write records, replacing any record with the same id, and return the sum
   * over the requests sent. The namespace is created on its first write.
   *
   * The input is read lazily and sent in requests of at most `batchSize`
   * records and `maxBytes` bytes (the server's limits are 1,000 and
   * 2,000,000), in order, and each record exactly once. Each request commits
   * on its own. A failure rejects with `BatchWriteError` naming the input
   * range that was not acknowledged (`offset`, `count`, and `outcome`
   * `not_sent` or `unknown`); every record before `offset` is written, and
   * the underlying error is its `cause`. Nothing is sent again automatically.
   */
  async upsert(index: string, namespace: string,
    records: Iterable<VectorIndexRecord> | AsyncIterable<VectorIndexRecord>,
    options: VectorIndexUpsertOptions = {}): Promise<VectorIndexUpsertResult> {
    const total: VectorIndexUpsertResult = { upserted_count: 0, namespace_created: false, batches: 0, receipts: [] };
    for await (const batch of this.upsertBatches(index, namespace, records, options)) {
      total.upserted_count += batch.upserted_count;
      total.namespace_created ||= batch.namespace_created;
      total.batches += 1;
      total.receipts.push(batch.receipt);
    }
    return total;
  }

  /** `upsert`, lazily: yields one result per acknowledged request. Reads the
   * input as it goes, so only one batch is held in memory. Breaking the loop
   * sends no further batch. */
  async *upsertBatches(index: string, namespace: string,
    records: Iterable<VectorIndexRecord> | AsyncIterable<VectorIndexRecord>,
    options: VectorIndexUpsertOptions = {}): AsyncGenerator<VectorIndexUpsertBatch> {
    const path = indexPath(index, "/records/upsert");
    const batcher = new UpsertBatcher(namespace, options.batchSize ?? VECTOR_INDEX_UPSERT_MAX_RECORDS,
      options.maxBytes ?? VECTOR_INDEX_UPSERT_MAX_BODY_BYTES);
    const signal = options.signal;
    const source = Symbol.asyncIterator in records
      ? (records as AsyncIterable<unknown>)[Symbol.asyncIterator]()
      : (records as Iterable<unknown>)[Symbol.iterator]();
    const send = async (batch: Batch): Promise<VectorIndexUpsertBatch> => {
      signal?.throwIfAborted();
      try {
        return acknowledged(await this.send("POST", path, batch.body, false, { signal }), batch.offset, batch.count);
      } catch (error) {
        signal?.throwIfAborted();
        throw new BatchWriteError(batch.offset, batch.count, "unknown", error);
      }
    };
    try {
      while (true) {
        signal?.throwIfAborted();
        let item: IteratorResult<unknown>;
        try {
          const pending = Promise.resolve(source.next());
          item = signal ? await abortable(pending, signal) : await pending;
        } catch (error) {
          signal?.throwIfAborted();
          throw new BatchWriteError(batcher.offset, batcher.pending, "not_sent", error);
        }
        if (item.done) break;
        let ready: Batch[];
        try {
          ready = batcher.add(item.value);
        } catch (error) {
          throw new BatchWriteError(batcher.offset, batcher.pending + 1, "not_sent", error);
        }
        for (const batch of ready) yield await send(batch);
      }
      for (const batch of batcher.finish()) yield await send(batch);
    } finally {
      if (source.return) {
        const cleanup = Promise.resolve(source.return());
        if (signal?.aborted) void cleanup.catch(() => {});
        else await cleanup;
      }
    }
  }

  /** Read records by id (1 to 1,000 unique ids). Metadata is returned unless
   * `include_metadata` is `false`; values and sparse values only when asked
   * for. */
  async fetch(index: string, namespace: string, ids: readonly string[], select: VectorIndexProjection = {},
    options: VectorIndexRequestOptions = {}): Promise<VectorIndexFetchResult> {
    const body = { namespace, ids: idList(ids), ...projection(select) };
    return this.send("POST", indexPath(index, "/records/fetch"), body, true, options);
  }

  /** One page of the records matching a filter, in ascending id order. */
  async fetchByFilter(index: string, namespace: string, query: VectorIndexFetchByFilter,
    options: VectorIndexRequestOptions = {}): Promise<VectorIndexRecordPage> {
    const where = selector(query, true), select = projection(query);
    const body = put({ namespace, ...where }, { limit: query.limit, cursor: query.cursor });
    return this.send("POST", indexPath(index, "/records/fetch-by-filter"), Object.assign(body, select), true, options);
  }

  /** Every record matching a filter, from `fetchByFilter` pages, one page in
   * memory at a time. Not a snapshot: each page reads the records as they are
   * when it is fetched. */
  iterRecords(index: string, namespace: string, query: Omit<VectorIndexFetchByFilter, "cursor">,
    options: VectorIndexRequestOptions = {}): AsyncGenerator<VectorIndexStoredRecord> {
    return follow((cursor) => this.fetchByFilter(index, namespace, { ...query, cursor }, options),
      "records", options.signal);
  }

  /** One page of record ids in ascending byte order. */
  async listIds(index: string, namespace: string, page: { prefix?: string; limit?: number; cursor?: string } = {},
    options: VectorIndexRequestOptions = {}): Promise<VectorIndexIdPage> {
    const body = put({ namespace }, { prefix: page.prefix, limit: page.limit, cursor: page.cursor });
    return this.send("POST", indexPath(index, "/records/list-ids"), body, true, options);
  }

  /** Every record id of a namespace, one page in memory at a time. */
  iterIds(index: string, namespace: string, page: { prefix?: string; limit?: number } = {},
    options: VectorIndexRequestOptions = {}): AsyncGenerator<string> {
    return follow((cursor) => this.listIds(index, namespace, { prefix: page.prefix, limit: page.limit, cursor }, options),
      "ids", options.signal);
  }

  /** Change one record in place and return `{ receipt }`. Unlike `upsert`,
   * fields that are not named are kept. An absent record fails with
   * `code === "record_not_found"`. */
  async update(index: string, namespace: string, id: string, changes: VectorIndexUpdate,
    options: VectorIndexRequestOptions = {}): Promise<VectorIndexAnswer> {
    if (typeof id !== "string") throw new TypeError("id must be a string");
    const set = put({}, {
      values: changes?.values,
      sparse_values: changes?.sparse_values,
      metadata_merge: changes?.metadata_merge,
      metadata_replace: changes?.metadata_replace,
      metadata_remove: strings(changes?.metadata_remove, "metadata_remove"),
      text_set: changes?.text_set,
      text_remove: strings(changes?.text_remove, "text_remove"),
    });
    if (!Object.keys(set).length) throw new TypeError("update needs at least one change");
    const body = put({ namespace, id, ...set }, { if_revision_token: changes.if_revision_token });
    return this.send("POST", indexPath(index, "/records/update"), body, false, options);
  }

  /** Change the metadata of every record matching a filter, as a background
   * job: `{ job_id, receipt }`; poll `getJob`. A job updates at most 100,000
   * records. With `dry_run: true` nothing is written: `{ dry_run: true,
   * matched_records, sample_ids }`. */
  async updateByFilter(index: string, namespace: string, update: VectorIndexUpdateByFilter,
    options: VectorIndexRequestOptions = {}): Promise<VectorIndexFilterJob> {
    const where = selector(update, true);
    const set = put({}, {
      metadata_merge: update.metadata_merge,
      metadata_remove: strings(update.metadata_remove, "metadata_remove"),
    });
    if (!Object.keys(set).length) throw new TypeError("updateByFilter needs metadata_merge or metadata_remove");
    const body: Record<string, unknown> = { namespace, ...where, ...set };
    if (update.dry_run) body.dry_run = true;
    return this.send("POST", indexPath(index, "/records/update"), body, false, options);
  }

  /** Delete records by id (1 to 1,000 unique ids). An id with no record
   * counts as missing. */
  async delete(index: string, namespace: string, ids: readonly string[],
    options: VectorIndexRequestOptions = {}): Promise<VectorIndexDeleteResult> {
    return this.send("POST", indexPath(index, "/records/delete"),
      { namespace, ids: idList(ids) }, false, options);
  }

  /** Delete every record of a namespace that matches a filter, as a
   * background job: `{ job_id, receipt }`; poll `getJob`. With `dry_run:
   * true` nothing is written: `{ dry_run: true, matched_records, sample_ids }`. */
  async deleteByFilter(index: string, namespace: string, selection: VectorIndexDeleteByFilter,
    options: VectorIndexRequestOptions = {}): Promise<VectorIndexFilterJob> {
    const body: Record<string, unknown> = { namespace, ...selector(selection, true) };
    if (selection.dry_run) body.dry_run = true;
    return this.send("POST", indexPath(index, "/records/delete"), body, false, options);
  }

  /** Delete every record of a namespace and keep the namespace. The server
   * requires the namespace to be confirmed; this method sends the
   * confirmation, so calling it is the confirmation. With `dry_run: true`
   * nothing is written: `{ dry_run: true, record_count }`. */
  async deleteAll(index: string, namespace: string, opts: { dry_run?: boolean } = {},
    options: VectorIndexRequestOptions = {}): Promise<VectorIndexAnswer> {
    const body: Record<string, unknown> = { namespace, all: true, confirm: namespace };
    if (opts.dry_run) body.dry_run = true;
    return this.send("POST", indexPath(index, "/records/delete"), body, false, options);
  }

  /** The exact number of records, optionally matching a filter. */
  async count(index: string, namespace: string, filter: VectorIndexFilter = {},
    options: VectorIndexRequestOptions = {}): Promise<VectorIndexCount> {
    return this.send("POST", indexPath(index, "/records/count"), { namespace, ...selector(filter, false) }, true, options);
  }

  // Jobs

  /** A background job. It is finished once `state` is no longer `queued` or
   * `running`. */
  async getJob(index: string, jobId: string, options: VectorIndexRequestOptions = {}): Promise<VectorIndexJob> {
    return this.send("GET", indexPath(index, `/jobs/${segment(jobId)}`), undefined, true, options);
  }

  /** Stop a job's further rounds. Not a rollback: records it already changed
   * stay changed. */
  async cancelJob(index: string, jobId: string, options: VectorIndexRequestOptions = {}): Promise<VectorIndexAnswer> {
    return this.send("POST", indexPath(index, `/jobs/${segment(jobId)}/cancel`), undefined, false, options);
  }

  // Search

  /** The `k` best records, best first. See `VectorIndexSearch` for the query
   * legs. A filter restricts the records ranked; nothing is filtered after the
   * top `k` is cut. Search returns metadata only with `include_metadata:
   * true`. Scores are always higher-is-better. */
  async search(index: string, namespace: string, query: VectorIndexSearch,
    options: VectorIndexRequestOptions = {}): Promise<VectorIndexSearchResult> {
    const path = indexPath(index, "/search");
    return this.send("POST", path, searchBody(namespace, query), true, options);
  }
}
