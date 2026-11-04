/** Resolves once per request. Honor the signal and cache credentials when appropriate. */
export type TokenProvider = (signal: AbortSignal) => string | Promise<string>;

/** Local transport metadata. Excludes URLs, table names, SQL, values, bodies and tokens. */
export interface RequestEvent {
  readonly method: string;
  readonly operation: string;
  readonly durationMs: number;
  readonly status?: number;
  readonly requestId?: string;
  /** Absent on HTTP success; result decoding can still fail afterwards. */
  readonly errorKind?: string;
}

export class CredentialError extends Error {
  constructor() { super("OriginChainDB credential provider failed"); this.name = "CredentialError"; }
}

export function operation(path: string): string {
  const first = path.replace(/^\//, "").split(/[/?]/, 1)[0];
  return ["sql", "rows", "schemas", "vector", "fts", "graph", "cypher", "usage", "query-metrics"].includes(first ?? "") ? first! : "other";
}

export function observe(callback: ((event: RequestEvent) => void) | undefined, event: RequestEvent): void {
  if (!callback) return;
  try { Promise.resolve(callback(Object.freeze(event))).catch(() => {}); } catch { /* observation never alters results */ }
}

/** Stop awaiting a credential provider even if it ignores cancellation. */
export async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let cancel: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    cancel = () => reject(signal.reason);
    signal.addEventListener("abort", cancel, { once: true });
  });
  try { return await Promise.race([promise, aborted]); }
  finally { if (cancel) signal.removeEventListener("abort", cancel); }
}
