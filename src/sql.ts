import { ApiError } from "./errors.js";
import type { RequestOptions, SqlResp } from "./types.js";

/** Complete SQL result. Missing counts mean unknown, never zero writes. */
export interface SqlResult {
  kind: string;
  rows: Record<string, unknown>[];
  columns?: string[];
  column_types?: Record<string, string>;
  rows_affected?: number;
  rows_buffered?: number;
  results: SqlResult[];
  stopped_on_error: boolean;
  raw: Record<string, unknown>;
}

/** A batch can partially succeed. Inspect result before retrying any statement. */
export class BatchError extends ApiError {
  constructor(readonly result: SqlResult) {
    super(200, "batch_failed", "SQL batch contains a failed statement");
    this.name = "BatchError";
  }
}

export class ProtocolError extends ApiError {
  constructor(message: string) {
    super(200, "invalid_response", message);
    this.name = "ProtocolError";
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function count(value: unknown): number | undefined {
  if (value == null) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new ProtocolError("SQL count must be a nonnegative safe integer");
  return value;
}

export function decodeSqlResult(value: unknown): SqlResult {
  if (!record(value) || typeof value.kind !== "string")
    throw new ProtocolError("SQL response must be an object with a string kind");
  const rows = value.rows ?? [];
  const children = value.results ?? [];
  const columns = value.columns ?? value.returning;
  if (!Array.isArray(rows) || !rows.every(record) || !Array.isArray(children))
    throw new ProtocolError("SQL response contains invalid rows or results");
  if (columns !== undefined && (!Array.isArray(columns) || !columns.every(c => typeof c === "string")))
    throw new ProtocolError("SQL response columns must be an array of strings");
  if (value.stopped_on_error !== undefined && typeof value.stopped_on_error !== "boolean")
    throw new ProtocolError("SQL batch state must be a boolean");
  const results = children.map(child => {
    if (record(child) && child.error !== undefined && child.kind === undefined)
      return decodeSqlResult({ ...child, kind: "error" });
    return decodeSqlResult(child);
  });
  return {
    kind: value.kind, rows, columns: columns as string[] | undefined,
    column_types: record(value.column_types) ? value.column_types as Record<string, string> : undefined,
    rows_affected: count(value.rows_affected ?? (value.kind === "insert" ? value.inserted : value.kind === "select" ? 0 : undefined)),
    rows_buffered: count(value.rows_buffered), results,
    stopped_on_error: value.stopped_on_error === true, raw: value,
  };
}

type Run = (statement: string, params?: unknown[], options?: RequestOptions) => Promise<SqlResult>;

export interface SqlApi {
  (statement: string, params?: unknown[], options?: RequestOptions): Promise<SqlResp>;
  run: Run;
  execute: Run;
  query: Run;
}

export function createSqlApi(send:
  (statement: string, params?: unknown[], options?: RequestOptions) => Promise<SqlResp>): SqlApi {
  const run: Run = async (statement, params, options) => {
    if (typeof statement !== "string" || !statement.trim()) throw new TypeError("SQL statement must not be empty");
    if (params !== undefined && !Array.isArray(params)) throw new TypeError("SQL parameters must be an array");
    const result = decodeSqlResult(await send(statement, params, options));
    if (failed(result))
      throw new BatchError(result);
    return result;
  };
  return Object.assign(send, {
    run, execute: run,
    query: async (statement: string, params?: unknown[], options?: RequestOptions) => {
      const result = await run(statement, params, options);
      if (result.kind !== "select") throw new ProtocolError("sql.query expected a SELECT result; use sql.run for other statements");
      return result;
    },
  });
}

function failed(result: SqlResult): boolean {
  return result.stopped_on_error || result.kind === "error" || result.raw.error !== undefined || result.results.some(failed);
}
