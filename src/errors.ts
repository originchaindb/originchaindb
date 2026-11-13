// Error classes raised by the OriginChain SDK.
//
// All non-2xx responses are normalised into an `ApiError` (or one of its
// subclasses). Calling code can branch on `instanceof ApiError` for the
// generic case, `instanceof OCAddonRequiredError` /
// `OCPaymentRequiredError` for the specific 402 add-on flow, and
// `instanceof OCRecordApiNotEnabledError` for a database that does not serve
// the vector index record operations.

export type ApiErrorBody = {
  error?: { code?: string; message?: string } | string;
};

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  /** The engine's id for the request (`x-oc-request-id`), when it answered with
   * one. Quote it in a support request: it identifies the exact engine record. */
  requestId?: string;
  /** Raw Retry-After header when the server supplies one; no automatic retry implied. */
  retryAfter?: string;
  /** The id this client sent for the call (`x-oc-logical-request-id`). */
  logicalRequestId?: string;
  /** `error.details.reason` from the server's structured error envelope (for
   * example `"exact_index_capacity"`), when it sent one. Branch on `code` plus
   * `reason`, never on `status` alone. */
  reason?: string;
  /** The envelope's `error.details` object, when present. */
  details?: Record<string, unknown>;
  /** The envelope's `error.retryable`: `true` only when the identical request
   * can succeed later without changes. */
  retryable?: boolean;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

/** HTTP 501 with `reason === "record_api_not_enabled"`: this database does not
 * serve the vector index record operations (`client.vectorIndexes`). Not
 * retryable: the same request keeps failing until the operations are switched
 * on for the database. The per-table `client.vector` calls are not affected. */
export class OCRecordApiNotEnabledError extends ApiError {
  constructor(code: string, message: string) {
    super(501, code, message);
    this.name = "OCRecordApiNotEnabledError";
  }
}

/** @internal The structured error envelope's `error` object:
 * `{"error": {"code", "message", "status", "retryable", "details"}}`. */
export function errorEnvelope(body: unknown): Record<string, unknown> | undefined {
  const error = body !== null && typeof body === "object" ? (body as { error?: unknown }).error : undefined;
  return error !== null && typeof error === "object" && !Array.isArray(error)
    ? (error as Record<string, unknown>) : undefined;
}

/** @internal Copy `details`, `reason` and `retryable` from a structured error
 * envelope onto an error. Fields the server did not send stay unset. */
export function applyErrorEnvelope(error: ApiError, body: unknown): void {
  const envelope = errorEnvelope(body);
  if (!envelope) return;
  const details = envelope.details;
  if (details !== null && typeof details === "object" && !Array.isArray(details)) {
    error.details = details as Record<string, unknown>;
    const reason = (details as { reason?: unknown }).reason;
    if (typeof reason === "string") error.reason = reason;
  }
  if (typeof envelope.retryable === "boolean") error.retryable = envelope.retryable;
}

// HTTP 402 Payment Required + canonical add-on body. Mirrors the wire shape
// documented in `oc-addon-entitlements-spec.md` - `snake_case` from the
// engine, translated to `camelCase` on this typed error.
export class OCAddonRequiredError extends ApiError {
  readonly addon: string;
  readonly addonName: string;
  readonly monthlyUsd: number;
  readonly preview: boolean;
  readonly enterpriseOnly: boolean;
  readonly purchaseUrl: string;

  constructor(
    message: string,
    addon: string,
    addonName: string,
    monthlyUsd: number,
    preview: boolean,
    enterpriseOnly: boolean,
    purchaseUrl: string,
  ) {
    super(402, "addon_required", message);
    this.name = "OCAddonRequiredError";
    this.addon = addon;
    this.addonName = addonName;
    this.monthlyUsd = monthlyUsd;
    this.preview = preview;
    this.enterpriseOnly = enterpriseOnly;
    this.purchaseUrl = purchaseUrl;
  }
}

// Generic 402 (when the body is NOT the add-on-required envelope, e.g. a
// payment-method-required signal from the control plane). Kept alongside
// `OCAddonRequiredError` so calling code can treat all 402s uniformly via
// `instanceof OCPaymentRequiredError`.
export class OCPaymentRequiredError extends ApiError {
  readonly body: unknown;

  constructor(message: string, body: unknown) {
    super(402, "payment_required", message);
    this.name = "OCPaymentRequiredError";
    this.body = body;
  }
}

// Internal type-guard for the canonical 402 add-on body.
export type AddonRequiredBody = {
  error: "addon_required";
  addon: string;
  name: string;
  monthly_usd: number;
  preview: boolean;
  enterprise_only?: boolean;
  purchase_url: string;
  msg?: string;
};

export function isAddonRequiredBody(b: unknown): b is AddonRequiredBody {
  return (
    typeof b === "object" &&
    b !== null &&
    (b as { error?: unknown }).error === "addon_required" &&
    typeof (b as { addon?: unknown }).addon === "string" &&
    typeof (b as { purchase_url?: unknown }).purchase_url === "string"
  );
}
