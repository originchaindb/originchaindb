import { writeBatches, pages, scan, type BatchOptions, type PageOptions } from "./iteration.js";
import type { OriginChainClient } from "./client.js";
import type { RequestOptions, VecMetric } from "./types.js";
import { requestOptions } from "./transport.js";
import { decodeFts, type FtsResult } from "./search.js";
import { decodeVector, type VectorHit } from "./vector.js";

export function segment(value: string): string {
  if (typeof value !== "string" || !value || value === "." || value === ".." || /[\x00-\x1f\x7f]/.test(value))
    throw new TypeError("Invalid path name");
  return encodeURIComponent(value);
}

export class Rows {
  constructor(private readonly client: OriginChainClient) {}
  writeBatches(schema: string, rows: Iterable<Record<string, unknown>> | AsyncIterable<Record<string, unknown>>, options: BatchOptions = {}) {
    return writeBatches(this.client, schema, rows, options);
  }
  pages(schema: string, key: string, options: PageOptions = {}) { return pages(this.client, schema, key, options); }
  scan(schema: string, key: string, options: PageOptions = {}) { return scan(this.client, schema, key, options); }

  get(schema: string, key: string, options: RequestOptions = {}): Promise<Record<string, unknown> | null> {
    return this.client._request(this.client._door(`/rows/${segment(schema)}/${segment(key)}`), requestOptions(options));
  }
  put(schema: string, row: Record<string, unknown>, options: RequestOptions = {}): Promise<unknown> {
    if (row === null || typeof row !== "object" || Array.isArray(row)) throw new TypeError("Row must be an object");
    return this.client._request(this.client._door(`/rows/${segment(schema)}`), requestOptions(options, { method: "POST", body: JSON.stringify(row) }));
  }
  putBatch(schema: string, rows: Record<string, unknown>[], options: RequestOptions = {}): Promise<unknown> {
    if (!Array.isArray(rows) || rows.some(row => row === null || typeof row !== "object" || Array.isArray(row))) throw new TypeError("Rows must be an array of objects");
    return this.client._request(this.client._door(`/rows/${segment(schema)}/_batch`), requestOptions(options, { method: "POST", body: JSON.stringify(rows) }));
  }
}
export class Schemas {
  constructor(private readonly client: OriginChainClient) {}
  list(options: RequestOptions = {}) { return this.client.listSchemas(options); }
  get(name: string, options: RequestOptions = {}) { return this.client.getSchema(name, options); }
  register(toml: string, options: RequestOptions = {}) { return this.client.registerSchema(toml, options); }
}
function vector(values: number[]) {
  if (!Array.isArray(values) || !values.length || values.some(v => !Number.isFinite(v))) throw new TypeError("Vector must contain finite numbers");
}
export interface VectorSearchOptions {
  k?: number;
  metric?: VecMetric;
  filter?: Record<string, unknown>;
  mode?: "fast" | "high_recall";
}
export class Vector {
  constructor(private readonly client: OriginChainClient) {}
  put(table: string, id: string, embedding: number[], metadata?: Record<string, unknown>, options: RequestOptions = {}) {
    vector(embedding);
    return this.client.vectorPut(table, { id, embedding, dim: embedding.length, metadata }, options);
  }
  async search(table: string, query: number[], search: VectorSearchOptions = {}, options: RequestOptions = {}): Promise<VectorHit[]> {
    vector(query);
    const k = search.k ?? 10;
    if (!Number.isInteger(k) || k < 1) throw new RangeError("k must be a positive integer");
    return decodeVector(await this.client.vectorTopk(table, { ...search, query, k, dim: query.length, metric: search.metric ?? "cosine" }, options));
  }
  delete(table: string, id: string, options: RequestOptions = {}) { return this.client.vectorDelete(table, id, {}, options); }
}
export interface FtsSearchOptions {
  mode?: "bm25" | "boolean" | "phrase";
  k?: number;
  highlight?: boolean;
  fuzzy?: number;
  facets?: string[];
}
export class Fts {
  constructor(private readonly client: OriginChainClient) {}
  index(table: string, field: string, id: string, text: string, options: RequestOptions = {}) {
    return this.client.ftsIndex(table, field, { doc_id: id, text }, options);
  }
  async search(table: string, field: string, query: string, search: FtsSearchOptions = {}, options: RequestOptions = {}): Promise<FtsResult> {
    const mode = search.mode ?? "bm25", k = search.k ?? 10;
    if (!["bm25", "boolean", "phrase"].includes(mode) || !Number.isInteger(k) || k < 1) throw new TypeError("Invalid search mode or k");
    const qs = new URLSearchParams({ q: query, mode });
    if (mode === "bm25") qs.set("k", String(k));
    if (search.highlight) qs.set("highlight", "true");
    if (search.fuzzy !== undefined) qs.set("fuzzy", String(search.fuzzy));
    if (search.facets !== undefined) qs.set("facets", search.facets.join(","));
    return decodeFts(await this.client._request(this.client._door(`/fts/${segment(table)}/${segment(field)}?${qs}`), requestOptions(options)));
  }
}
