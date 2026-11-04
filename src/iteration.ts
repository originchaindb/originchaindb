import type { OriginChainClient } from "./client.js";
import { abortable } from "./integration.js";
import { ProtocolError } from "./sql.js";

export interface BatchResult {
  readonly offset: number;
  readonly count: number;
  readonly inserted: number;
}
export interface BatchOptions {
  batchSize?: number;
  maxBytes?: number;
  signal?: AbortSignal;
}
export interface PageOptions {
  pageSize?: number;
  after?: string;
  signal?: AbortSignal;
}
export interface RowPage {
  rows: Record<string, unknown>[];
  nextCursor: string | null;
}
/** The range failed before sending, or its server outcome is unknown. No replay. */
export class BatchWriteError extends Error {
  constructor(readonly offset: number, readonly count: number,
    readonly outcome: "not_sent" | "unknown", override readonly cause: unknown) {
    super(`Batch at input offset ${offset} failed (${outcome})`);
    this.name = "BatchWriteError";
  }
}

const encoder = new TextEncoder();
function limits(count: number, bytes: number): void {
  if (!Number.isInteger(count) || count < 1 || count > 10000)
    throw new RangeError("Batch/page size must be an integer from 1 to 10000");
  if (!Number.isInteger(bytes) || bytes < 2 || bytes > 8388608)
    throw new RangeError("maxBytes must be an integer from 2 to 8388608");
}
function encode(row: Record<string, unknown>): [Record<string, unknown>, number] {
  if (row === null || typeof row !== "object" || Array.isArray(row))
    throw new TypeError("Each row must be an object");
  const text = JSON.stringify(row, (_key, value: unknown) => {
    if (typeof value === "number" && !Number.isFinite(value)) throw new TypeError("Numbers must be finite");
    return value;
  });
  const copy: unknown = JSON.parse(text);
  if (copy === null || typeof copy !== "object" || Array.isArray(copy)) throw new TypeError("Row must encode as an object");
  return [copy as Record<string, unknown>, encoder.encode(text).byteLength];
}

/** Sequential, lazy batch writes. Breaking iteration never sends another batch. */
export async function* writeBatches(client: OriginChainClient, schema: string,
  rows: Iterable<Record<string, unknown>> | AsyncIterable<Record<string, unknown>>,
  options: BatchOptions = {}): AsyncGenerator<BatchResult> {
  const count = options.batchSize ?? 1000, bytes = options.maxBytes ?? 1048576;
  limits(count, bytes);
  const source = Symbol.asyncIterator in rows ? rows[Symbol.asyncIterator]() : rows[Symbol.iterator]();
  let batch: Record<string, unknown>[] = [], size = 2, offset = 0;
  const flush = async (): Promise<BatchResult> => {
    options.signal?.throwIfAborted();
    try {
      const value = await client.rows.putBatch(schema, batch, { signal: options.signal, retrySafe: false });
      const inserted = value && typeof value === "object" ? (value as Record<string, unknown>).inserted : undefined;
      if (typeof inserted !== "number" || !Number.isInteger(inserted) || inserted < 0 || inserted > batch.length)
        throw new ProtocolError("Batch response must contain a valid inserted count");
      return Object.freeze({ offset, count: batch.length, inserted });
    } catch (error) {
      options.signal?.throwIfAborted();
      throw new BatchWriteError(offset, batch.length, "unknown", error);
    }
  };
  try {
    while (true) {
      options.signal?.throwIfAborted();
      let item: IteratorResult<Record<string, unknown>>;
      try {
        const pending = Promise.resolve(source.next());
        item = options.signal ? await abortable(pending, options.signal) : await pending;
      } catch (error) {
        options.signal?.throwIfAborted();
        throw new BatchWriteError(offset, batch.length, "not_sent", error);
      }
      if (item.done) break;
      let row: Record<string, unknown>, length: number;
      try {
        [row, length] = encode(item.value);
        if (length + 2 > bytes) throw new RangeError("Row exceeds maxBytes");
      } catch (error) { throw new BatchWriteError(offset, batch.length + 1, "not_sent", error); }
      if (batch.length && size + 1 + length > bytes) {
        const result = await flush();
        offset += batch.length;
        batch = []; size = 2;
        yield result;
      }
      size += length + (batch.length ? 1 : 0);
      batch.push(row);
      if (batch.length === count) {
        const result = await flush();
        offset += batch.length;
        batch = []; size = 2;
        yield result;
      }
    }
    if (batch.length) yield await flush();
  } finally {
    if (source.return) {
      const cleanup = Promise.resolve(source.return());
      if (options.signal?.aborted) void cleanup.catch(() => {});
      else await cleanup;
    }
  }
}

function pageQuery(schema: string, key: string, size: number, after?: string): [string, unknown[]] {
  const parts = schema.split(".");
  if (parts.length > 2 || ![...parts, key].every(part => /^[A-Za-z_][A-Za-z0-9_]*$/.test(part)))
    throw new TypeError("Use a simple schema/table name and unique string-key column");
  limits(size, 2);
  if (after !== undefined && typeof after !== "string") throw new TypeError("after must be a string");
  const table = parts.map(part => `"${part}"`).join("."), column = `"${key}"`;
  return [`SELECT * FROM ${table}${after === undefined ? "" : ` WHERE ${column} > $1`} ORDER BY ${column} ASC LIMIT ${size}`, after === undefined ? [] : [after]];
}
function compareUtf8(left: string, right: string): number {
  const a = encoder.encode(left), b = encoder.encode(right);
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return a.length - b.length;
}

/** Keyset pages over a unique immutable string key. No snapshot or server cursor. */
export async function* pages(client: OriginChainClient, schema: string, key: string,
  options: PageOptions = {}): AsyncGenerator<RowPage> {
  const size = options.pageSize ?? 1000;
  let after = options.after;
  while (true) {
    options.signal?.throwIfAborted();
    const [statement, params] = pageQuery(schema, key, size, after);
    const result = await client.sql.query(statement, params, { signal: options.signal, retrySafe: false });
    if (result.rows.length > size) throw new ProtocolError("Server exceeded pageSize");
    let previous = after;
    for (const row of result.rows) {
      const value = row[key];
      if (typeof value !== "string") throw new ProtocolError("Pagination requires a non-null string key");
      if (previous !== undefined && compareUtf8(value, previous) <= 0) throw new ProtocolError("Pagination key did not advance uniquely");
      previous = value;
    }
    if (!result.rows.length) return;
    after = previous;
    const nextCursor = result.rows.length === size ? after! : null;
    yield { rows: result.rows, nextCursor };
    if (nextCursor === null) return;
  }
}

export async function* scan(client: OriginChainClient, schema: string, key: string,
  options: PageOptions = {}): AsyncGenerator<Record<string, unknown>> {
  for await (const page of pages(client, schema, key, options)) {
    for (const row of page.rows) {
      options.signal?.throwIfAborted();
      yield row;
    }
  }
}
