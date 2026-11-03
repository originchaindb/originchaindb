// Error classes raised by the OriginChain SDK.
//
// All non-2xx responses are normalised into an `ApiError` (or one of its
// subclasses). Calling code can branch on `instanceof ApiError` for the
// generic case and `instanceof OCAddonRequiredError` /
// `OCPaymentRequiredError` for the specific 402 add-on flow.

export type ApiErrorBody = {
  error?: { code?: string; message?: string } | string;
};

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  /** The engine's id for the request (`x-oc-request-id`), when it answered with
   * one. Quote it in a support request: it identifies the exact engine record. */
  requestId?: string;
  /** The id this client sent for the call (`x-oc-logical-request-id`). */
  logicalRequestId?: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
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
