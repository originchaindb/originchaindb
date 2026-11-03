// Opt-in client diagnostics (off by default).
//
// With `diagnostics: true`, the client reports what it saw of its own calls to
// your engine - method, path, outcome, duration, the status it received, and the
// request ids - to that same engine (`POST /v1/tenants/:tenant/diagnostics`,
// authenticated with your bearer). The engine matches the path to its route
// template and forwards only the template, so table, key and index names stay
// on your engine. Nothing else is sent: no SQL, no parameters, no row data, no
// search text (query strings are removed before anything is queued), no error
// messages, no keys.
//
// Reporting never slows or fails your calls: events go into a small bounded
// queue (the oldest are dropped when it is full), are sent in the background at
// most once a second in batches of up to 32, and any failure to send is ignored.

/** The SDK version reported with diagnostics; kept equal to package.json by a test. */
export const SDK_VERSION = "1.0.0-rc.1";

export const DIAGNOSTICS_PATH_SUFFIX = "/diagnostics";
const MAX_QUEUE = 256;
const MAX_BATCH = 32;
const FLUSH_MS = 1000;
// The engine refuses a whole diagnostics batch for one invalid event, so an event
// that would break any of these rules is never queued.
const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const MAX_PATH = 512;
const MAX_DURATION_MS = 3_600_000;

export type DiagnosticEvent = {
  client: "typescript";
  client_version: string;
  method: string;
  path: string;
  outcome: "success" | "error" | "cancelled" | "timeout" | "denied";
  duration_ms: number;
  http_status?: number;
  error_category?: string;
  error_code?: string;
  request_id?: string;
  logical_request_id: string;
  attempt: number;
  transport?: "not_sent" | "no_response";
};

/** The engine's request id when it is one the contract accepts. */
export function engineRequestId(value: string | null): string | undefined {
  if (!value) return undefined;
  return /^[0-9a-f]{28}$/.test(value) ||
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
    ? value
    : undefined;
}

/** A machine code the contract accepts (a SQLSTATE or a short snake/upper code). */
function contractCode(code: string): boolean {
  if (/^[0-9A-Z]{5}$/.test(code)) return true;
  if (code.length > 32 || (code.match(/[0-9]/g) ?? []).length > 4) return false;
  return /^[a-z][a-z0-9]*(_[a-z0-9]+){0,3}$/.test(code) || /^[A-Z][A-Z0-9]*(_[A-Z0-9]+){0,3}$/.test(code);
}

/** Outcome and category for an HTTP status the client received. */
function classify(status: number): Pick<DiagnosticEvent, "outcome" | "error_category"> {
  if (status < 400) return { outcome: "success" };
  if (status === 401) return { outcome: "denied", error_category: "auth" };
  if (status === 403) return { outcome: "denied", error_category: "permission" };
  if (status === 408) return { outcome: "timeout", error_category: "timeout" };
  if (status === 404) return { outcome: "error", error_category: "not_found" };
  if (status === 409) return { outcome: "error", error_category: "conflict" };
  if (status === 413) return { outcome: "error", error_category: "capacity" };
  if (status === 429) return { outcome: "error", error_category: "rate_limited" };
  if (status === 400 || status === 422) return { outcome: "error", error_category: "validation" };
  if (status === 502 || status === 503 || status === 504) return { outcome: "error", error_category: "unavailable" };
  if (status >= 500) return { outcome: "error", error_category: "internal" };
  return { outcome: "error", error_category: "unknown" };
}

/** The event for one finished call, or `undefined` when it cannot be reported.
 * `path` may carry a query string; it is removed here. */
export function diagnosticEvent(call: {
  method: string;
  path: string;
  startedAt: number;
  logicalRequestId: string;
  attempt?: number;
  status?: number;
  requestId?: string;
  errorCode?: string;
  failure?: "timeout" | "cancelled" | "network";
}): DiagnosticEvent | undefined {
  const path = call.path.split(/[?#]/)[0] ?? call.path;
  if (!METHODS.has(call.method) || !path.startsWith("/v1/tenants/") || path.length > MAX_PATH) {
    return undefined;
  }
  const elapsed = Math.min(MAX_DURATION_MS, Math.max(0, now() - call.startedAt));
  const event: DiagnosticEvent = {
    client: "typescript",
    client_version: SDK_VERSION,
    method: call.method,
    path,
    outcome: "success",
    duration_ms: Math.round(elapsed * 1000) / 1000,
    logical_request_id: call.logicalRequestId,
    attempt: call.attempt ?? 1,
  };
  if (call.failure) {
    // No response at all: never a status.
    event.outcome = call.failure === "network" ? "error" : call.failure;
    event.error_category = call.failure;
    event.transport = "no_response";
    return event;
  }
  const status = call.status ?? 0;
  Object.assign(event, classify(status));
  event.http_status = status;
  if (call.requestId) event.request_id = call.requestId;
  if (event.outcome !== "success" && call.errorCode && contractCode(call.errorCode)) {
    event.error_code = call.errorCode;
  }
  return event;
}

export function now(): number {
  const p = (globalThis as { performance?: { now(): number } }).performance;
  return p ? p.now() : Date.now();
}

/** A bounded queue flushed in the background with the given sender. */
export class DiagnosticsQueue {
  private readonly events: DiagnosticEvent[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private sending = false;
  /** Events dropped because the queue was full (oldest first). */
  dropped = 0;

  constructor(private readonly send: (batch: DiagnosticEvent[]) => Promise<void>) {}

  push(event: DiagnosticEvent | undefined): void {
    if (!event) return;
    if (this.events.length >= MAX_QUEUE) {
      this.events.shift();
      this.dropped += 1;
    }
    this.events.push(event);
    if (this.events.length >= MAX_BATCH) {
      void this.flush();
    } else if (!this.timer) {
      this.timer = setTimeout(() => void this.flush(), FLUSH_MS);
      // Never keep a Node process alive just to report diagnostics.
      (this.timer as { unref?: () => void }).unref?.();
    }
  }

  /** Send what is queued, in batches; failures are dropped silently. */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.sending) return;
    this.sending = true;
    try {
      while (this.events.length) {
        const batch = this.events.splice(0, MAX_BATCH);
        try {
          await this.send(batch);
        } catch {
          // Diagnostics are best-effort; a failed report is not retried.
        }
      }
    } finally {
      this.sending = false;
    }
  }

  /** Queued, not yet sent (testing). */
  get size(): number {
    return this.events.length;
  }
}
