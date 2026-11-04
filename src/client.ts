import { createSqlApi, type SqlApi } from "./sql.js";
import { abortable, CredentialError, observe, operation, type RequestEvent, type TokenProvider } from "./integration.js";
import { parse, isSafeNumber } from "lossless-json";
import { Rows, Schemas, Vector, Fts, segment } from "./resources.js";
// OriginChain TypeScript client.
//
// Two classes:
//   * `OriginChainClient`     - talks to one database: HTTPS to its address
//                                (OC_URL) with OC_TOKEN as the bearer.
//   * `OriginChainAdminClient` - talks to the control plane (cookie auth, or
//                                bearer when used from Node).
//
// They are split because the auth model is fundamentally different: the
// engine takes an `Authorization: Bearer …` header, the control-plane takes
// a session cookie. Mixing them would force every method to learn about
// auth modes that don't apply to it.

import { backoff, retryAfter, retryEligible, RETRYABLE_STATUSES, waitForRetry } from "./retry.js";
import { requestHeaders, requestOptions, requestSignal } from "./transport.js";
import { checkAddress, checkToken, connectionFromEnv, processEnv } from "./connect.js";
import {
  ApiError,
  type ApiErrorBody,
  isAddonRequiredBody,
  OCAddonRequiredError,
  OCPaymentRequiredError,
} from "./errors.js";
import {
  DIAGNOSTICS_PATH_SUFFIX,
  type DiagnosticEvent,
  DiagnosticsQueue,
  diagnosticEvent,
  engineRequestId,
  now,
} from "./diagnostics.js";
import type {
  AddonEnableResponse,
  AddonRow,
  AdminClientOptions,
  Allowlist,
  AllowlistEntry,
  AuthResponse,
  ClientOptions,
  ConfirmPaymentBody,
  ConfirmPaymentMethodBody,
  CurrentUsageResponse,
  DijkstraResult,
  Eligibility,
  EventView,
  FetchLike,
  FromEnvOptions,
  FtsIndexDoc,
  FtsMode,
  GraphBfsHit,
  GraphPath,
  Instance,
  InstanceNode,
  LogsResponse,
  MetricsResponse,
  MetricsSummaryResponse,
  NetworkRequest,
  NetworkRequestKind,
  PaymentMethodView,
  PendingPaymentResponse,
  PgwireStatus,
  PitrArchiveResponse,
  WhoamiIp,
  Plan,
  PlansResponse,
  ProvisionResponse,
  QueryMetricsResponse,
  RankedHit,
  RequestOptions,
  SchemaUsage,
  SetupIntent,
  SnapshotView,
  SqlResp,
  SqlSelect,
  Subscription,
  TenantConfiguration,
  TenantUsage,
  User,
  VecDeleteResp,
  VecHit,
  VecIndexKind,
  VecMetric,
  VecPutReq,
  VecTopkReq,
} from "./types.js";

// ── Helpers ──────────────────────────────────────────────────────────────

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Crockford base32 alphabet (ULID), lowercased to match engine tenant ids. */
const ULID_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

/** Re-encode a UUID's 128 bits as a 26-char lowercase ULID — the engine's
 * tenant-id format. Free-tier endpoints (`<uuid>.free.originchain.ai`)
 * carry the raw instance UUID in the subdomain, but every engine
 * `/v1/tenants/:tenant/...` path wants the ULID re-encoding of those same
 * bytes; sending the UUID gets a 400 "invalid tenant id: invalid length". */
function uuidToUlid(uuid: string): string {
  let n = BigInt("0x" + uuid.replace(/-/g, ""));
  let out = "";
  for (let i = 0; i < 26; i++) {
    out = ULID_ALPHABET[Number(n & 31n)] + out;
    n >>= 5n;
  }
  return out;
}

/** Parse the tenant id from a hostname like
 * `tnt-01h….ap-south-1.db.originchain.ai` → `tnt-01h…`. Free-tier
 * hostnames carry the instance UUID; it is re-encoded to the engine's
 * ULID form. Returns the empty string when the URL is unparseable so
 * callers get a clean error path.
 *
 * @deprecated Hostname inference is used only by the deprecated `baseUrl`
 * option and will be removed. Pass `url` (OC_URL, the database's address from
 * Connect) instead; the SDK never reads a tenant out of it. */
export function tenantIdFromEndpoint(endpoint: string): string {
  try {
    const label = new URL(endpoint).hostname.split(".")[0] ?? "";
    return UUID_RE.test(label) ? uuidToUlid(label) : label;
  } catch {
    return "";
  }
}

/** Resolve a fetch implementation lazily (at call time, not construct
 * time) so importing the SDK in an environment without `fetch` doesn't
 * crash at module load. */
function pickFetch(injected?: FetchLike): FetchLike {
  if (injected) return injected;
  return (input, init) => {
    const f = (globalThis as { fetch?: FetchLike }).fetch;
    if (!f) {
      throw new Error(
        "OriginChainClient: no fetch implementation found. Pass `fetch` in " +
          "options, run on Node >= 18, or polyfill `globalThis.fetch`.",
      );
    }
    return f(input, init);
  };
}

function joinUrl(base: string, path: string): string {
  return base.replace(/\/$/, "") + path;
}

/** Generate a fresh `Idempotency-Key` value (UUIDv4 in canonical hyphenated
 * form). Sent on writes for endpoints that implement deduplication; a key
 * alone does not make arbitrary SQL or writes safe to replay. Callers needing a stable key
 * across process restarts (e.g. distributed retries of the same logical
 * action) can pass `init.headers["idempotency-key"]` explicitly. */
function newIdempotencyKey(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  // Fallback for older runtimes that have getRandomValues but no randomUUID.
  if (c && typeof c.getRandomValues === "function") {
    const b = new Uint8Array(16);
    c.getRandomValues(b);
    b[6] = (b[6]! & 0x0f) | 0x40; // version 4
    b[8] = (b[8]! & 0x3f) | 0x80; // variant 1
    const h = Array.from(b, (x) => x.toString(16).padStart(2, "0"));
    return `${h.slice(0, 4).join("")}-${h.slice(4, 6).join("")}-${h.slice(6, 8).join("")}-${h.slice(8, 10).join("")}-${h.slice(10, 16).join("")}`;
  }
  // Last-resort: Math.random. Documented unsafe for cryptographic uniqueness
  // but the idempotency key only needs to be unique-enough within the
  // engine's 10k LRU cache, not unguessable.
  let out = "";
  for (let i = 0; i < 16; i++) {
    let r = (Math.random() * 256) | 0;
    if (i === 6) r = (r & 0x0f) | 0x40;
    if (i === 8) r = (r & 0x3f) | 0x80;
    out += r.toString(16).padStart(2, "0");
    if (i === 3 || i === 5 || i === 7 || i === 9) out += "-";
  }
  return out;
}

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** True in a browser page or a browser worker (web, shared or service worker),
 * where every custom request header must be on the engine's CORS allow-list. A
 * worker has no `document`, so it is recognised by its global scope. */
function inBrowser(): boolean {
  const g = globalThis as { document?: unknown; WorkerGlobalScope?: unknown };
  if (typeof g.document !== "undefined") return true;
  const scope = g.WorkerGlobalScope;
  return typeof scope === "function" && globalThis instanceof scope;
}

async function readBody(res: Response): Promise<unknown> {
  if (res.status === 204) return undefined;
  const text = await res.text();
  if (!text) return undefined;
  try {
    return parse(text, null, value => isSafeNumber(value) ? Number(value) : value);
  } catch {
    return text;
  }
}

/** Map an HTTP response into an `ApiError` subclass. Always throws. */
function raiseFor(status: number, body: unknown): never {
  // 402 + canonical add-on body → typed error.
  if (status === 402 && isAddonRequiredBody(body)) {
    throw new OCAddonRequiredError(
      body.msg ?? `This endpoint requires the ${body.name} add-on.`,
      body.addon,
      body.name,
      body.monthly_usd,
      Boolean(body.preview),
      Boolean(body.enterprise_only),
      body.purchase_url,
    );
  }
  if (status === 402) {
    const msg =
      (body && typeof body === "object" && "msg" in body
        ? String((body as { msg?: unknown }).msg ?? "")
        : "") || "payment required";
    throw new OCPaymentRequiredError(msg, body);
  }
  let code = "http_error";
  let message = `HTTP ${status}`;
  if (body && typeof body === "object") {
    const e = body as ApiErrorBody;
    if (typeof e.error === "string") {
      // Some endpoints return `{ "error": "snake_case_code" }` flat - map
      // that into the `code` slot so callers can switch on it.
      code = e.error;
      message = e.error;
    } else if (e.error && typeof e.error === "object") {
      code = e.error.code ?? code;
      message = e.error.message ?? message;
    }
  } else if (typeof body === "string" && body) {
    message = body;
  }
  throw new ApiError(status, code, message);
}

// ── Engine client ────────────────────────────────────────────────────────

/** Database client. One instance per (address, token) pair.
 *
 * The application path is `OriginChainClient.fromEnv()`, or
 * `new OriginChainClient({ url, token })`: HTTPS to the database's address
 * (OC_URL, from Connect) with an access token (OC_TOKEN) sent as
 * `Authorization: Bearer`. The address is used exactly as given and each call
 * appends its door path, for example `POST <url>/sql`. */
export class OriginChainClient {
  readonly sql: SqlApi;
  readonly rows: Rows;
  readonly schemas: Schemas;
  readonly vector: Vector;
  readonly fts: Fts;
  /** The database's address with any trailing slash removed. Every database
   * call appends its door path to it, for example `<url>/sql`. With the
   * deprecated `baseUrl` option it is `<baseUrl>/v1/tenants/<tenantId>`. */
  readonly url: string;
  /** @deprecated With `url`, this is only the origin of `url` (scheme, host and
   * port). With the deprecated `baseUrl` option, it is that value. */
  readonly baseUrl: string;
  /** The token sent as `Authorization: Bearer`. */
  readonly bearer: string;
  /** @deprecated Set only with the deprecated `baseUrl` option. The SDK never
   * reads a tenant out of `url`, so a client built from `url` or `fromEnv()`
   * has no `tenantId`. */
  readonly tenantId: string | undefined;
  readonly graph: GraphMethods;

  private readonly identityHeaders: Record<string, string>;
  private readonly fetch: FetchLike;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly diagnostics: DiagnosticsQueue | undefined;
  private readonly tokenProvider: TokenProvider | undefined;
  private readonly onRequest: ((event: RequestEvent) => void) | undefined;
  /** What `_request` paths are appended to: `url`, or `baseUrl` in legacy mode. */
  private readonly root: string;
  /** Legacy mode only: the tenant path prefix the deprecated options imply. */
  private readonly legacyPrefix: string | undefined;
  /** The path part of the address, so diagnostics report the full request path. */
  private readonly reportPrefix: string;

  /** Build a client from the environment: `OC_URL` (the database's address,
   * from Connect) and `OC_TOKEN` (an access token from Access tokens).
   *
   * `OC_URL` is used exactly as given; each call appends its door path. It must
   * be https:// (plain http only on localhost, 127.0.0.1 or [::1]) with no user
   * name, password, query or fragment. Names that earlier examples used are
   * still read for this release, each with a one-time warning that names the
   * replacement, and will stop being read after it.
   *
   * Reads `process.env` when the runtime has one. Pass `env` to read another
   * map instead, for example a Workers `env` binding. */
  static fromEnv(options: FromEnvOptions = {}): OriginChainClient {
    const { env, ...rest } = options;
    if (rest.tokenProvider) {
      return new OriginChainClient({ ...rest, url: (env ?? processEnv() ?? {}).OC_URL });
    }
    const resolved = connectionFromEnv(env ?? processEnv() ?? {});
    const { token, ...address } = resolved;
    return new OriginChainClient({ ...rest, ...address, token });
  }

  constructor(opts: ClientOptions) {
    if (opts.url !== undefined && opts.baseUrl !== undefined) {
      throw new Error("OriginChainClient: pass url or the deprecated baseUrl, not both");
    }
    if (opts.url !== undefined && opts.tenantId !== undefined) {
      throw new Error("OriginChainClient: tenantId cannot be combined with url; url is the database's whole address");
    }
    if (opts.token !== undefined && opts.bearer !== undefined) {
      throw new Error("OriginChainClient: pass token or the deprecated bearer, not both");
    }
    const legacy = opts.url === undefined;
    if (legacy && !opts.baseUrl) {
      throw new Error("OriginChainClient: url required (OC_URL, the database's address from Connect)");
    }
    let token: string;
    if (opts.tokenProvider !== undefined) {
      if (typeof opts.tokenProvider !== "function" || opts.token !== undefined || opts.bearer !== undefined)
        throw new TypeError("Configure tokenProvider or token, not both");
      token = "";
    } else if (opts.token !== undefined) {
      token = checkToken(opts.token, "token");
    } else if (opts.bearer) {
      token = opts.bearer;
    } else {
      throw new Error("OriginChainClient: token required (OC_TOKEN, an access token from Access tokens)");
    }
    const identity = [opts.dbUser, opts.dbKey];
    if (identity.some((v) => v !== undefined) &&
        identity.some((v) => typeof v !== "string" || !v.trim() || /[^\x20-\x7e]/.test(v))) {
      throw new Error("dbUser and dbKey must both be non-empty printable ASCII header values");
    }
    this.identityHeaders = opts.dbUser !== undefined
      ? { "x-oc-db-user": opts.dbUser, "x-oc-db-key": opts.dbKey! } : {};
    this.bearer = token;
    this.tokenProvider = opts.tokenProvider;
    this.onRequest = opts.onRequest;
    if (legacy) {
      // Deprecated: unchanged behaviour for one release.
      this.baseUrl = opts.baseUrl!.replace(/\/$/, "");
      this.tenantId = opts.tenantId ?? tenantIdFromEndpoint(this.baseUrl);
      this.legacyPrefix = `/v1/tenants/${this.tenantId}`;
      this.root = this.baseUrl;
      this.url = this.baseUrl + this.legacyPrefix;
      this.reportPrefix = "";
    } else {
      // The address is opaque: checked, never built, edited or split.
      this.url = checkAddress(opts.url, "url");
      const parsed = new URL(this.url);
      this.baseUrl = parsed.origin;
      this.tenantId = undefined;
      this.legacyPrefix = undefined;
      this.root = this.url;
      this.reportPrefix = parsed.pathname.replace(/\/+$/, "");
    }
    this.fetch = pickFetch(opts.fetch);
    // Default 60 s. The dashboard's snapshot listing endpoint can take
    // 20-40 s on its first (uncached) call against the managed snapshot
    // service; later calls hit a 5-min response cache on the backend.
    this.timeoutMs = opts.timeoutMs ?? 60000;
    this.maxRetries = opts.maxRetries ?? 0;
    if (!Number.isInteger(this.maxRetries) || this.maxRetries < 0 || this.maxRetries > 99) {
      throw new RangeError("maxRetries must be an integer between 0 and 99");
    }
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0 || this.timeoutMs > 2147483647) {
      throw new RangeError("timeoutMs must be between 0 (exclusive) and 2147483647");
    }
    this.sql = createSqlApi(this.runSqlRaw.bind(this));
    this.rows = new Rows(this);
    this.schemas = new Schemas(this);
    this.vector = new Vector(this);
    this.fts = new Fts(this);
    this.graph = new GraphMethods(this);
    this.diagnostics = opts.diagnostics
      ? new DiagnosticsQueue((batch) => this.sendDiagnostics(batch))
      : undefined;
  }

  /** Send any queued diagnostics now (for example before a serverless function
   * returns). A no-op when diagnostics are off. Never throws. */
  async flushDiagnostics(): Promise<void> {
    await this.diagnostics?.flush();
  }

  /** Post one diagnostics batch straight to the engine: not through `_request`,
   * so reporting never reports itself and never adds correlation headers. */
  private async sendDiagnostics(batch: DiagnosticEvent[]): Promise<void> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    try {
      const token = this.tokenProvider ? await this.resolveToken(ctrl.signal) : this.bearer;
      await this.fetch(
        joinUrl(this.root, this._door(DIAGNOSTICS_PATH_SUFFIX)),
        {
          method: "POST",
          headers: {
            ...this.identityHeaders,
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          redirect: this.identityHeaders["x-oc-db-user"] ? "error" : "manual",
          body: JSON.stringify({ events: batch }),
          signal: ctrl.signal,
        },
      );
    } finally {
      clearTimeout(timer);
    }
  }

  // ── Internal request plumbing ──────────────────────────────────────────

  private async resolveToken(signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    if (!this.tokenProvider) return this.bearer;
    try {
      const pending = Promise.resolve().then(() => { signal.throwIfAborted(); return this.tokenProvider!(signal); });
      return checkToken(await abortable(pending, signal), "tokenProvider");
    } catch {
      signal.throwIfAborted();
      throw new CredentialError();
    }
  }

  /** @internal The `_request` path for a door path such as `/sql`: the door
   * path itself with `url`, or the tenant path the deprecated options imply. */
  _door(path: string): string {
    return this.legacyPrefix === undefined ? path : this.legacyPrefix + path;
  }

  /** @internal `path` is appended to `url` (or, with the deprecated `baseUrl`
   * option, to `baseUrl`). */
  async _request<T>(
    path: string,
    init: RequestInit & { rawBody?: boolean; retrySafe?: boolean } = {},
  ): Promise<T> {
    const requestStarted = now();
    let observedStatus: number | undefined;
    let observedId: string | undefined;
    let errorKind: string | undefined;
    const headers = requestHeaders({
      ...this.identityHeaders,
      authorization: `Bearer ${this.bearer}`,
      accept: "application/json",
    }, init.headers);
    if (!init.rawBody && init.body !== undefined) {
      headers["content-type"] ??= "application/json";
    }
    // Mutating requests get an Idempotency-Key by default. Server-side cache
    // is bounded (LRU 10k + 24h TTL) so fresh-per-call is safe. Callers that
    // need a stable key (e.g. distributed retry of the same logical action)
    // override by passing `init.headers["idempotency-key"]` themselves.
    const method = (init.method ?? "GET").toUpperCase();
    if (MUTATING_METHODS.has(method) && !headers["idempotency-key"]) {
      headers["idempotency-key"] = newIdempotencyKey();
    }
    // Correlation: one id per call, recorded by the engine next to its own
    // request id. Retry attempts share the id and increment the attempt header.
    // Not sent from a browser: they are custom headers, so an engine whose CORS
    // allow-list predates them would refuse the preflight and every call would
    // fail. A browser still gets the engine's own `x-oc-request-id` on errors.
    // A caller's own id is kept when it is a UUID; the engine ignores anything
    // else, so diagnostics then carry a fresh one instead.
    const supplied = headers["x-oc-logical-request-id"];
    const logicalRequestId =
      supplied && UUID_RE.test(supplied) ? supplied.toLowerCase() : newIdempotencyKey();
    if (!inBrowser()) {
      headers["x-oc-logical-request-id"] ??= logicalRequestId;
      headers["x-oc-attempt"] ??= "1";
    }
    const report = this.diagnostics;
    // Public SDK calls serialize bodies to strings. Never replay a one-shot stream.
    const replayable = init.body == null || typeof init.body === "string";
    const retries = retryEligible(method, init.retrySafe) && replayable ? this.maxRetries : 0;
    const deadline = now() + this.timeoutMs;
    const cancellation = requestSignal(this.timeoutMs, init.signal);
    const { rawBody: _rawBody, retrySafe: _retrySafe, ...fetchInit } = init;
    const wait = async (delay: number): Promise<boolean> => {
      if (delay >= deadline - now()) return false;
      await waitForRetry(delay, cancellation.signal);
      cancellation.signal.throwIfAborted();
      return now() < deadline;
    };
    try {
      if (this.tokenProvider) headers.authorization = `Bearer ${await this.resolveToken(cancellation.signal)}`;
      for (let attempt = 0; ; attempt++) {
        const startedAt = now();
        if (!inBrowser()) headers["x-oc-attempt"] = String(attempt + 1);
        const event = { method, path: this.reportPrefix + path, startedAt, logicalRequestId, attempt: attempt + 1 };
        let res: Response;
        let body: unknown;
        try {
          cancellation.signal.throwIfAborted();
          res = await this.fetch(joinUrl(this.root, path), {
            ...fetchInit,
            redirect: this.identityHeaders["x-oc-db-user"] ? "error" : "manual",
            headers: { ...headers },
            signal: cancellation.signal,
          });
          observedStatus = res.status;
          observedId = res.headers.get("x-oc-request-id") ?? undefined;
          body = await readBody(res);
        } catch (err) {
          report?.push(diagnosticEvent({ ...event, failure: cancellation.failure() }));
          if (!cancellation.signal.aborted && attempt < retries && await wait(backoff(attempt))) continue;
          throw err;
        }
        const requestId = engineRequestId(res.headers.get("x-oc-request-id"));
        if (!res.ok) {
          try {
            raiseFor(res.status, body);
          } catch (err) {
            if (err instanceof ApiError) {
              err.requestId = requestId;
              err.retryAfter = res.headers.get("retry-after") ?? undefined;
              err.logicalRequestId = logicalRequestId;
            }
            report?.push(diagnosticEvent({
              ...event, status: res.status, requestId,
              errorCode: err instanceof ApiError && err.code !== "http_error" ? err.code : undefined,
            }));
            if (attempt < retries && RETRYABLE_STATUSES.has(res.status) &&
                await wait(retryAfter(res.headers.get("retry-after")) ?? backoff(attempt))) continue;
            throw err;
          }
        }
        report?.push(diagnosticEvent({ ...event, status: res.status, requestId }));
        return body as T;
      }
    } catch (error) {
      errorKind = cancellation.signal.aborted ? (cancellation.failure() === "timeout" ? "timeout" : "canceled")
        : error instanceof CredentialError ? "credential"
        : error instanceof ApiError ? ({401: "authentication", 403: "permission", 429: "rate_limit"}[error.status] ?? "http")
        : error instanceof SyntaxError ? "protocol" : "transport";
      throw error;
    } finally {
      cancellation.cleanup();
      const door = this.legacyPrefix && path.startsWith(this.legacyPrefix) ? path.slice(this.legacyPrefix.length) : path;
      observe(this.onRequest, { method, operation: operation(door), durationMs: now() - requestStarted,
        status: observedStatus, requestId: observedId, errorKind });
    }
  }

  // ── Schemas ────────────────────────────────────────────────────────────

  listSchemas( options: RequestOptions = {}): Promise<string[]> {
    return this._request<string[]>(this._door(`/schemas`), requestOptions(options));
  }

  getSchema(schema: string, options: RequestOptions = {}): Promise<string> {
    return this._request<string>(
      this._door(`/schemas/${segment(schema)}`), requestOptions(options),
    );
  }

  registerSchema(toml: string, options: RequestOptions = {}): Promise<{ id: string; tenant: string }> {
    return this._request<{ id: string; tenant: string }>(
      this._door(`/schemas`),
      requestOptions(options, {
        method: "POST",
        body: toml,
        headers: { "content-type": "text/plain" },
        rawBody: true,
      }),
    );
  }

  // ── Usage ──────────────────────────────────────────────────────────────

  /** Live usage counters + the tenant's compute configuration.
   *
   * The response `tier` is the configuration slug
   * (`entry`/`standard`/`advanced`/`custom`). Prefer the richer
   * `configuration` object for the full spec + list price. Both are
   * absent in legacy per-addon mode. */
  usage( options: RequestOptions = {}): Promise<TenantUsage> {
    return this._request<TenantUsage>(
      this._door(`/usage`), requestOptions(options),
    );
  }

  /** Read tenant query metrics using a service credential or query administrator.
   * Supported minutes/bucketSeconds pairs: 60/60, 1440/600, 10080/3600.
   * Results cover the executing process and reset with that process. */
  queryMetrics(minutes = 60, bucketSeconds = 60, options: RequestOptions = {}): Promise<QueryMetricsResponse> {
    const query = new URLSearchParams({ minutes: String(minutes), bucket_seconds: String(bucketSeconds) });
    return this._request<QueryMetricsResponse>(
      this._door(`/query-metrics?${query}`), requestOptions(options),
    );
  }

  // ── SQL ────────────────────────────────────────────────────────────────

  /** Execute a SQL statement. Returns a discriminated union on `kind`:
   * `"select"` (rows), `"insert"` (typed row payload and optional rows_buffered),
   * or `"delete"` (optional nullable PK, rows_affected and rows_buffered). Bulk
   * deletes can omit the PK; buffered rows are not a committed count. Counts are
   * omitted by older translation-only engines; never infer execution from kind.
   * SELECT metadata is optional. Cell values retain their JSON representation,
   * including numeric and temporal strings; no Date or Number conversion occurs. */
  private runSqlRaw(query: string, params?: unknown[], options: RequestOptions = {}): Promise<SqlResp> {
    const body: { sql: string; params?: unknown[] } = { sql: query };
    if (params !== undefined) body.params = params;
    return this._request<SqlResp>(this._door(`/sql`), {
      method: "POST",
      body: JSON.stringify(body),
      signal: options.signal,
      retrySafe: options.retrySafe,
      headers: options.idempotencyKey !== undefined
        ? { "idempotency-key": options.idempotencyKey } : undefined,
    });
  }

  /** Convenience: run a SELECT and return the first row, or `null`. Raises
   * `ApiError` if the statement isn't a SELECT - there's no "first" of an
   * INSERT or DELETE result. */
  async sqlOne(
    query: string,
    params?: unknown[],
    options: RequestOptions = {},
  ): Promise<Record<string, unknown> | null> {
    const resp = await this.sql(query, params, options);
    if (resp.kind !== "select") {
      throw new ApiError(
        400,
        "validation_failed",
        `sqlOne expected SELECT, got ${resp.kind}`,
      );
    }
    const sel = resp as SqlSelect;
    if (!sel.rows.length) return null;
    const first = sel.rows[0];
    if (first && typeof first === "object" && !Array.isArray(first)) {
      return first as Record<string, unknown>;
    }
    return { value: first };
  }

  // ── Vector ─────────────────────────────────────────────────────────────

  vectorPut(
    table: string,
    opts: {
      id: string;
      embedding: number[];
      dim: number;
      metric?: VecMetric;
      metadata?: Record<string, unknown>;
    }, options: RequestOptions = {}
  ): Promise<void> {
    const body: VecPutReq = {
      id: opts.id,
      embedding: opts.embedding,
      dim: opts.dim,
    };
    if (opts.metric !== undefined) body.metric = opts.metric;
    if (opts.metadata !== undefined) body.metadata = opts.metadata;
    return this._request<void>(
      this._door(`/vector/${segment(table)}/put`),
      requestOptions(options, { method: "POST", body: JSON.stringify(body) }),
    );
  }

  vectorTopk(
    table: string,
    opts: {
      query: number[];
      k: number;
      dim: number;
      metric?: VecMetric;
      filter?: Record<string, unknown>;
      mode?: "fast" | "high_recall";
    }, options: RequestOptions = {}
  ): Promise<VecHit[]> {
    const body: VecTopkReq = {
      query: opts.query,
      k: opts.k,
      dim: opts.dim,
    };
    if (opts.metric !== undefined) body.metric = opts.metric;
    if (opts.filter !== undefined) body.filter = opts.filter;
    if (opts.mode !== undefined) body.mode = opts.mode;
    return this._request<VecHit[]>(
      this._door(`/vector/${segment(table)}/topk`),
      requestOptions(options, { method: "POST", body: JSON.stringify(body) }),
    );
  }

  /** Delete a single vector by id. Idempotent: `deleted` is `false` when the
   * id wasn't resident (the server returns 200, not 404). `index` picks the
   * engine family (default `"hnsw"`); `repair` opts into HNSW graph repair
   * across the hole (ignored on IVF / IVF-PQ). */
  vectorDelete(
    table: string,
    id: string,
    opts: { index?: VecIndexKind; repair?: boolean } = {}, options: RequestOptions = {}
  ): Promise<VecDeleteResp> {
    const qs = new URLSearchParams();
    if (opts.index !== undefined) qs.set("index", opts.index);
    if (opts.repair !== undefined) qs.set("repair", String(opts.repair));
    const query = qs.toString();
    const path =
      this._door(`/vector/${segment(table)}/${encodeURIComponent(id)}`) +
      (query ? `?${query}` : "");
    return this._request<VecDeleteResp>(path, requestOptions(options, { method: "DELETE" }));
  }

  // ── Full-text ──────────────────────────────────────────────────────────

  ftsIndex(
    table: string,
    field: string,
    opts: { doc_id: string; text: string }, options: RequestOptions = {}
  ): Promise<void> {
    const doc: FtsIndexDoc = { doc_id: opts.doc_id, text: opts.text };
    return this._request<void>(
      this._door(`/fts/${segment(table)}/${segment(field)}`),
      requestOptions(options, { method: "POST", body: JSON.stringify(doc) }),
    );
  }

  /** Full-text search.
   *
   * `mode="boolean"` (default) AND-matches all tokens and returns unranked
   * `doc_id` strings. `mode="bm25"` returns the top-`k` hits ranked by BM25.
   * `mode="phrase"` requires the tokens in order. The response shape varies
   * by mode - boolean/phrase return `string[]`, bm25 returns
   * `{ doc_id, score }[]`. */
  ftsSearch(
    table: string,
    field: string,
    opts: { q: string; mode?: FtsMode; k?: number }, options: RequestOptions = {}
  ): Promise<string[] | RankedHit[]> {
    const qs = new URLSearchParams({ q: opts.q });
    if (opts.mode) qs.set("mode", opts.mode);
    if (typeof opts.k === "number") qs.set("k", String(opts.k));
    return this._request<string[] | RankedHit[]>(
      this._door(`/fts/${segment(table)}/${segment(field)}?${qs.toString()}`), requestOptions(options),
    );
  }

  // ── Structured query ──────────────────────────────────────────────────

  query(plan: unknown, options: RequestOptions = {}): Promise<unknown[]> {
    return this._request<unknown[]>(this._door(`/query`), requestOptions(options, {
      method: "POST",
      body: JSON.stringify(plan),
    }));
  }
}

// ── Graph methods (sub-namespace) ────────────────────────────────────────

export class GraphMethods {
  private readonly p: OriginChainClient;
  constructor(parent: OriginChainClient) {
    this.p = parent;
  }

  query(cypher: string, params: Record<string, unknown> = {}, options: RequestOptions = {}): Promise<unknown> {
    if (typeof cypher !== "string" || !cypher.trim()) throw new TypeError("Cypher statement must not be empty");
    if (params === null || typeof params !== "object" || Array.isArray(params)) throw new TypeError("Cypher parameters must be an object");
    return this.p._request(this.p._door("/cypher"), requestOptions(options, { method: "POST", body: JSON.stringify({ cypher, params }) }));
  }

  neighbors(
    schema: string,
    opts: { rel: string; pk: string }, options: RequestOptions = {}
  ): Promise<string[]> {
    const qs = new URLSearchParams({ rel: opts.rel, pk: opts.pk });
    return this.p._request<string[]>(
      this.p._door(`/graph/${segment(schema)}/neighbors?${qs.toString()}`), requestOptions(options),
    );
  }

  reverseNeighbors(
    schema: string,
    opts: { rel: string; pk: string }, options: RequestOptions = {}
  ): Promise<string[]> {
    const qs = new URLSearchParams({ rel: opts.rel, pk: opts.pk });
    return this.p._request<string[]>(
      this.p._door(`/graph/${segment(schema)}/reverse?${qs.toString()}`), requestOptions(options),
    );
  }

  bfs(
    schema: string,
    opts: { rel: string; pk: string; max_depth?: number }, options: RequestOptions = {}
  ): Promise<GraphBfsHit[]> {
    const qs = new URLSearchParams({ rel: opts.rel, pk: opts.pk });
    if (typeof opts.max_depth === "number") {
      qs.set("max_depth", String(opts.max_depth));
    }
    return this.p._request<GraphBfsHit[]>(
      this.p._door(`/graph/${segment(schema)}/bfs?${qs.toString()}`), requestOptions(options),
    );
  }

  path(
    schema: string,
    opts: { rel: string; src: string; dst: string; max_depth?: number }, options: RequestOptions = {}
  ): Promise<GraphPath> {
    const qs = new URLSearchParams({
      rel: opts.rel,
      src: opts.src,
      dst: opts.dst,
    });
    if (typeof opts.max_depth === "number") {
      qs.set("max_depth", String(opts.max_depth));
    }
    return this.p._request<GraphPath>(
      this.p._door(`/graph/${segment(schema)}/path?${qs.toString()}`), requestOptions(options),
    );
  }

  /** Dijkstra over a typed relation. The `weights` map is JSON-stringified
   * into the `weights_json` query parameter (NOT a request body) - backend
   * reads `q.weights_json`. */
  dijkstra(
    schema: string,
    opts: {
      rel: string;
      src: string;
      dst: string;
      weights: Record<string, number>;
    }, options: RequestOptions = {}
  ): Promise<DijkstraResult> {
    const qs = new URLSearchParams({
      rel: opts.rel,
      src: opts.src,
      dst: opts.dst,
      weights_json: JSON.stringify(opts.weights),
    });
    return this.p._request<DijkstraResult>(
      this.p._door(`/graph/${segment(schema)}/dijkstra?${qs.toString()}`), requestOptions(options),
    );
  }
}

// ── Admin (control-plane) client ─────────────────────────────────────────

/** Control-plane client. Cookie-auth in the browser; pass `bearer` to use
 * from Node. */
export class OriginChainAdminClient {
  readonly baseUrl: string;
  readonly auth: AuthMethods;
  readonly plans: PlansMethods;
  readonly subscriptions: SubscriptionsMethods;
  readonly instances: InstancesMethods;
  readonly addons: AddonsMethods;
  readonly billing: BillingMethods;
  readonly events: EventsMethods;

  private readonly fetch: FetchLike;
  private readonly timeoutMs: number;
  private readonly credentials: RequestCredentials;
  private readonly bearer: string | undefined;

  constructor(opts: AdminClientOptions) {
    if (!opts.baseUrl)
      throw new Error("OriginChainAdminClient: baseUrl required");
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.fetch = pickFetch(opts.fetch);
    // Default 60 s. The dashboard's snapshot listing endpoint can take
    // 20-40 s on its first (uncached) call against the managed snapshot
    // service; later calls hit a 5-min response cache on the backend.
    this.timeoutMs = opts.timeoutMs ?? 60000;
    this.credentials = opts.credentials ?? "include";
    this.bearer = opts.bearer;
    this.auth = new AuthMethods(this);
    this.plans = new PlansMethods(this);
    this.subscriptions = new SubscriptionsMethods(this);
    this.instances = new InstancesMethods(this);
    this.addons = new AddonsMethods(this);
    this.billing = new BillingMethods(this);
    this.events = new EventsMethods(this);
  }

  /** @internal */
  async _request<T>(
    path: string,
    init: RequestInit & { rawBody?: boolean } = {},
  ): Promise<T> {
    const headers = requestHeaders({
      accept: "application/json",
    }, init.headers);
    if (!init.rawBody && init.body !== undefined) {
      headers["content-type"] ??= "application/json";
    }
    if (this.bearer) headers["authorization"] = `Bearer ${this.bearer}`;
    // Auto-Idempotency-Key on mutating control-plane calls. Operation-backend
    // doesn't enforce idempotency today (the body is harmless and ignored),
    // but stamping the header keeps the wire shape consistent with the engine
    // client and lets us light it up on the control plane without a SDK
    // version bump later.
    const method = (init.method ?? "GET").toUpperCase();
    if (MUTATING_METHODS.has(method) && !headers["idempotency-key"]) {
      headers["idempotency-key"] = newIdempotencyKey();
    }
    const cancellation = requestSignal(this.timeoutMs, init.signal);
    try {
      const { rawBody: _rawBody, ...fetchInit } = init;
      cancellation.signal.throwIfAborted();
      const res = await this.fetch(joinUrl(this.baseUrl, path), {
        credentials: this.credentials,
        ...fetchInit,
        headers,
        signal: cancellation.signal,
      });
      const body = await readBody(res);
      if (!res.ok) raiseFor(res.status, body);
      return body as T;
    } finally {
      cancellation.cleanup();
    }
  }

  health(): Promise<string> {
    return this._request<string>("/health");
  }
}

// Sub-namespaces: each takes a private parent reference. They exist for
// caller ergonomics (`admin.instances.list()` reads better than
// `admin.listInstances()`) but stay thin - no state, no mutation.

class AuthMethods {
  constructor(private readonly p: OriginChainAdminClient) {}
  /** @deprecated `POST /v1/auth/signup` now returns `410 Gone` — signup is
   *  OTP-verified. Use {@link signupOtpRequest} + {@link signupOtpVerify}
   *  instead. */
  signup(body: { email: string; password: string; org_name: string }) {
    return this.p._request<AuthResponse>("/v1/auth/signup", {
      method: "POST",
      body: JSON.stringify(body),
    });
  }
  signin(body: { email: string; password: string }) {
    return this.p._request<AuthResponse>("/v1/auth/signin", {
      method: "POST",
      body: JSON.stringify(body),
    });
  }
  /** Request a 6-digit OTP for OTP-based signin. Always returns sent=true
   *  regardless of whether the email matches a registered account
   *  (account-enumeration posture). The OTP is emailed via SES; the
   *  customer pastes it back to /v1/auth/login/otp/verify. */
  loginOtpRequest(body: { email: string }) {
    return this.p._request<{ sent: boolean; expires_at: string }>(
      "/v1/auth/login/otp/request",
      { method: "POST", body: JSON.stringify(body) },
    );
  }
  /** Verify a login OTP. On success returns AuthResponse + sets the
   *  session cookie. Failure shape is always 401 regardless of which
   *  check failed (wrong code / expired / no row). */
  loginOtpVerify(body: { email: string; code: string }) {
    return this.p._request<AuthResponse>("/v1/auth/login/otp/verify", {
      method: "POST",
      body: JSON.stringify(body),
    });
  }
  /** Start an OTP-verified signup. A 6-digit OTP is emailed to `email`;
   *  the customer pastes it back to {@link signupOtpVerify}. Replaces the
   *  deprecated one-shot {@link signup}. */
  signupOtpRequest(body: { email: string; password: string; org_name: string }) {
    return this.p._request<{ sent: boolean; expires_at: string }>(
      "/v1/auth/signup/request",
      { method: "POST", body: JSON.stringify(body) },
    );
  }
  /** Verify a signup OTP. On success creates the account + org, returns
   *  AuthResponse, and sets the session cookie. */
  signupOtpVerify(body: { email: string; code: string }) {
    return this.p._request<AuthResponse>("/v1/auth/signup/verify", {
      method: "POST",
      body: JSON.stringify(body),
    });
  }
  signout() {
    return this.p._request<void>("/v1/auth/signout", { method: "POST" });
  }
  me() {
    return this.p._request<User>("/v1/auth/me");
  }
  changePassword(body: { current_password: string; new_password: string }) {
    return this.p._request<void>("/v1/auth/password", {
      method: "POST",
      body: JSON.stringify(body),
    });
  }
  revokeAllOtherSessions() {
    return this.p._request<{ revoked: number }>(
      "/v1/auth/sessions/revoke-all",
      { method: "POST" },
    );
  }
  /** Request a password-reset email. The backend always returns
   *  `{ sent: true }` regardless of whether the email is registered -
   *  do not surface "no such user" hints in the UI. */
  forgotPassword(body: { email: string }) {
    return this.p._request<{ sent: boolean }>(
      "/v1/auth/forgot-password",
      { method: "POST", body: JSON.stringify(body) },
    );
  }
  /** Redeem a reset token + set a new password. The backend revokes
   *  every active session for the user as a side effect. */
  resetPassword(body: { token: string; new_password: string }) {
    return this.p._request<void>(
      "/v1/auth/reset-password",
      { method: "POST", body: JSON.stringify(body) },
    );
  }
}

class PlansMethods {
  constructor(private readonly p: OriginChainAdminClient) {}
  list() {
    return this.p._request<PlansResponse>("/v1/plans");
  }
}

class SubscriptionsMethods {
  constructor(private readonly p: OriginChainAdminClient) {}
  list() {
    return this.p._request<Subscription[]>("/v1/subscriptions");
  }
  create(body: { compute_plan_id: string; storage_plan_id: string }) {
    return this.p._request<Subscription>("/v1/subscriptions", {
      method: "POST",
      body: JSON.stringify(body),
    });
  }
}

class InstancesMethods {
  constructor(private readonly p: OriginChainAdminClient) {}
  list(opts: { include_deleted?: boolean } = {}) {
    const path = opts.include_deleted
      ? "/v1/instances?include_deleted=true"
      : "/v1/instances";
    return this.p._request<Instance[]>(path);
  }
  get(id: string) {
    return this.p._request<Instance>(`/v1/instances/${id}`);
  }
  /** The EC2 nodes (shard writers + HA standbys) backing this instance. */
  nodes(id: string) {
    return this.p._request<InstanceNode[]>(`/v1/instances/${id}/nodes`);
  }
  /** The instance's IP Access List. Empty `entries` = open to all. */
  getAllowlist(id: string) {
    return this.p._request<Allowlist>(`/v1/instances/${id}/allowlist`);
  }
  /** Replace the IP Access List. Each entry is a bare IP (→ /32) or a CIDR,
   * with an optional description. Applies to the live instance immediately
   * (443 + 5432). An empty list re-opens the instance to 0.0.0.0/0. */
  setAllowlist(id: string, entries: AllowlistEntry[]) {
    return this.p._request<Allowlist>(`/v1/instances/${id}/allowlist`, {
      method: "PUT",
      body: JSON.stringify({ entries }),
    });
  }
  /** The caller's public IP as seen by the control plane (for "Add my IP"). */
  myIp() {
    return this.p._request<WhoamiIp>(`/v1/whoami/ip`);
  }
  /** Advanced Network Access requests (VPC peering / private endpoint). */
  networkRequests(id: string) {
    return this.p._request<NetworkRequest[]>(
      `/v1/instances/${id}/network-requests`,
    );
  }
  /** File a peering / private-endpoint request. Persisted + ops-notified. */
  createNetworkRequest(
    id: string,
    body: { kind: NetworkRequestKind; details: Record<string, unknown> },
  ) {
    return this.p._request<NetworkRequest>(
      `/v1/instances/${id}/network-requests`,
      { method: "POST", body: JSON.stringify(body) },
    );
  }
  /** Withdraw a previously-filed network request. */
  deleteNetworkRequest(id: string, req: string) {
    return this.p._request<void>(
      `/v1/instances/${id}/network-requests/${req}`,
      { method: "DELETE" },
    );
  }
  /** The instance's shared database login status and credential.
   * @deprecated The shared database password is retired. SQL tools (psql,
   * DBeaver, BI tools) use a per-user database login created in Connect, under
   * Database client. */
  getPgwire(id: string) {
    return this.p._request<PgwireStatus>(`/v1/instances/${id}/pgwire`);
  }
  /** Turn on the shared database login: mints a credential, restarts the
   * engine with the listener on, returns the connection details. Single-node
   * only.
   * @deprecated The shared database password is retired. SQL tools (psql,
   * DBeaver, BI tools) use a per-user database login created in Connect, under
   * Database client. */
  enablePgwire(id: string) {
    return this.p._request<PgwireStatus>(`/v1/instances/${id}/pgwire`, {
      method: "POST",
    });
  }
  /** Turn off the shared database login (removes the listener and clears the
   * credential).
   * @deprecated The shared database password is retired. SQL tools (psql,
   * DBeaver, BI tools) use a per-user database login created in Connect, under
   * Database client. */
  disablePgwire(id: string) {
    return this.p._request<PgwireStatus>(`/v1/instances/${id}/pgwire`, {
      method: "DELETE",
    });
  }
  snapshots(id: string) {
    return this.p._request<SnapshotView[]>(`/v1/instances/${id}/snapshots`);
  }
  metrics(id: string, minutes = 60, period = 60) {
    return this.p._request<MetricsResponse>(
      `/v1/instances/${id}/metrics?minutes=${minutes}&period=${period}`,
    );
  }
  /// Per-shape latency tiles + storage panel rollup. Sibling of
  /// `metrics()`; the time-series endpoint stays unchanged. The
  /// backend may return `null` for `p99_ms`, `qps`, or any storage
  /// component when the engine doesn't yet emit the underlying
  /// counter - callers should render "-" rather than fabricate.
  metricsSummary(id: string) {
    return this.p._request<MetricsSummaryResponse>(
      `/v1/instances/${id}/metrics-summary`,
    );
  }
  /// Sealed-segment archive listing. Read-only - pause/resume of the
  /// tail-shipper is operator-only and intentionally absent.
  pitrArchive(id: string) {
    return this.p._request<PitrArchiveResponse>(
      `/v1/instances/${id}/pitr/archive`,
    );
  }
  logs(id: string, tail = 200) {
    return this.p._request<LogsResponse>(`/v1/instances/${id}/logs?tail=${tail}`);
  }
  listSchemas(id: string) {
    return this.p._request<string[]>(`/v1/instances/${id}/schemas`);
  }
  getSchema(id: string, schema: string) {
    return this.p._request<string>(`/v1/instances/${id}/schemas/${segment(schema)}`);
  }
  registerSchema(id: string, toml: string) {
    return this.p._request<{ id: string; tenant: string }>(
      `/v1/instances/${id}/schemas`,
      {
        method: "POST",
        body: toml,
        headers: { "content-type": "text/plain" },
        rawBody: true,
      },
    );
  }
  runQuery(id: string, plan: unknown) {
    return this.p._request<unknown[]>(`/v1/instances/${id}/query`, {
      method: "POST",
      body: JSON.stringify(plan),
    });
  }
  create(body: {
    name: string;
    region: string;
    compute_plan_id: string;
    storage_plan_id: string;
  }) {
    return this.p._request<ProvisionResponse | PendingPaymentResponse>(
      "/v1/instances",
      { method: "POST", body: JSON.stringify(body) },
    );
  }
  confirmPayment(id: string, body: ConfirmPaymentBody) {
    return this.p._request<ProvisionResponse>(
      `/v1/instances/${id}/confirm-payment`,
      { method: "POST", body: JSON.stringify(body) },
    );
  }
  delete(id: string) {
    return this.p._request<void>(`/v1/instances/${id}`, { method: "DELETE" });
  }
  rotateBearer(id: string) {
    return this.p._request<ProvisionResponse>(
      `/v1/instances/${id}/rotate-bearer`,
      { method: "POST" },
    );
  }
}

class AddonsMethods {
  constructor(private readonly p: OriginChainAdminClient) {}
  async list(instanceId: string): Promise<AddonRow[]> {
    const r = await this.p._request<{ addons: AddonRow[] }>(
      `/v1/instances/${instanceId}/addons`,
    );
    return r.addons;
  }
  enable(instanceId: string, addonId: string, previewConsent: boolean) {
    return this.p._request<AddonEnableResponse>(
      `/v1/instances/${instanceId}/addons`,
      {
        method: "POST",
        body: JSON.stringify({
          addon_id: addonId,
          preview_consent: previewConsent,
        }),
      },
    );
  }
  disable(instanceId: string, addonId: string) {
    return this.p._request<void>(
      `/v1/instances/${instanceId}/addons/${addonId}`,
      { method: "DELETE" },
    );
  }
}

class BillingMethods {
  constructor(private readonly p: OriginChainAdminClient) {}
  eligibility() {
    return this.p._request<Eligibility>("/v1/billing/eligibility");
  }
  setupIntent() {
    return this.p._request<SetupIntent>("/v1/billing/setup-intent", {
      method: "POST",
    });
  }
  confirmPaymentMethod(body: ConfirmPaymentMethodBody) {
    return this.p._request<PaymentMethodView>("/v1/billing/payment-method", {
      method: "POST",
      body: JSON.stringify(body),
    });
  }
  getPaymentMethod() {
    return this.p._request<PaymentMethodView>("/v1/billing/payment-method");
  }
  removePaymentMethod() {
    return this.p._request<void>("/v1/billing/payment-method", {
      method: "DELETE",
    });
  }
  /// Current-period billing rollup, per-org. Compute + addon line
  /// items from the DB, plus a placeholder overage line at $0 until
  /// usage metering is wired. The frontend's `/app/billing/usage`
  /// page renders this directly.
  currentUsage() {
    return this.p._request<CurrentUsageResponse>("/v1/usage/current");
  }
}

class EventsMethods {
  constructor(private readonly p: OriginChainAdminClient) {}
  list(limit = 20) {
    return this.p._request<EventView[]>(`/v1/events?limit=${limit}`);
  }
}

// Re-export for callers that want to construct typed Plan etc. directly.
export type {
  AddonEnableResponse,
  AddonRow,
  Allowlist,
  AllowlistEntry,
  AuthResponse,
  ClientOptions,
  ConfirmPaymentBody,
  CurrentUsageResponse,
  Eligibility,
  EventView,
  Instance,
  InstanceNode,
  LogsResponse,
  MetricsResponse,
  MetricsSummaryResponse,
  NetworkRequest,
  NetworkRequestKind,
  PaymentMethodView,
  PgwireStatus,
  PitrArchiveResponse,
  Plan,
  PlansResponse,
  ProvisionResponse,
  SetupIntent,
  SnapshotView,
  Subscription,
  TenantConfiguration,
  TenantUsage,
  SchemaUsage,
  User,
  WhoamiIp,
};
