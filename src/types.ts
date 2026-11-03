// Wire-format types for the OriginChain HTTP API.
//
// Names and casing mirror the engine's JSON exactly (snake_case for fields
// that come back from the engine; camelCase only for SDK-local extensions).
// Keep these in sync with `backend/crates/oc-http` types - when the engine
// adds a field, mirror it here in the same PR.

// ── Auth / org / billing (control-plane) ──────────────────────────────────

export type User = {
  id: string;
  email: string;
  created_at: string;
};

export type AuthResponse = {
  user: User;
  org_id: string;
};

export type Plan = {
  id: string;
  kind: "compute" | "storage";
  display_name: string;
  monthly_cents: number;
  specs: Record<string, unknown>;
};

export type PlansResponse = {
  compute: Plan[];
  storage: Plan[];
};

export type Subscription = {
  id: string;
  org_id: string;
  compute_plan_id: string;
  storage_plan_id: string;
  status: "trialing" | "active" | "past_due" | "canceled";
  trial_ends_at: string | null;
  current_period_end: string | null;
};

export type Instance = {
  id: string;
  org_id: string;
  name: string;
  region: string;
  compute_plan_id: string;
  storage_plan_id: string;
  status:
    | "pending_payment"
    | "provisioning"
    | "running"
    | "suspending"
    | "suspended"
    | "deleting"
    | "deleted"
    | "failed";
  endpoint: string | null;
  created_at: string;
  /** Observed engine health for a running instance: "ok" | "unreachable".
   * Absent on non-running rows / older control planes. */
  health?: string;
  /** Number of nodes (shards) backing the instance; >1 = a sharded multi-node
   * cluster. Absent on control planes that predate node_count exposure. */
  node_count?: number;
  /** Resilience / HA mode. "ha" gives each shard a cross-AZ standby replica. */
  resilience?: "single" | "ha" | "multi" | string;
};

/** One EC2 node (shard writer or standby) backing an instance.
 * From GET /v1/instances/:id/nodes. */
export type InstanceNode = {
  instance_id: string;
  /** Shard index this node serves (0-based). */
  shard: number;
  /** "writer" (owns the shard) or "standby" (its cross-AZ HA replica). */
  role: "writer" | "standby" | string;
  private_ip: string | null;
  public_ip: string | null;
  az: string | null;
  /** EC2 lifecycle state ("running", "stopped", …). */
  state: string;
  name: string;
};

/** One IP Access List entry: a CIDR (or bare IP, normalised to /32 or /128 on
 * write) plus an optional label. From GET /v1/instances/:id/allowlist. */
export type AllowlistEntry = {
  cidr: string;
  description: string;
};

/** An instance's IP Access List. Empty `entries` = open to the internet
 * (0.0.0.0/0). Gates the engine endpoint (443) and pgwire (5432); cross-shard
 * node-to-node traffic is unaffected. */
export type Allowlist = {
  entries: AllowlistEntry[];
};

/** The caller's public source IP as seen by the control plane. From
 * GET /v1/whoami/ip — powers the console's "Add my current IP" button. */
export type WhoamiIp = { ip: string };

/** The instance's shared database login for SQL tools, as returned by
 * GET/POST/DELETE /v1/instances/:id/pgwire. `password` is present only when
 * `enabled`.
 *
 * @deprecated The shared database password is retired. SQL tools (psql,
 * DBeaver, BI tools) use a per-user database login created in Connect, under
 * Database client. Applications use `OriginChainClient` with OC_URL and
 * OC_TOKEN. */
export type PgwireStatus = {
  enabled: boolean;
  host: string | null;
  port: number;
  user: string;
  database: string;
  /** Present only when enabled. */
  password?: string;
};

export type NetworkRequestKind = "peering" | "private_endpoint";

/** A VPC-peering or private-endpoint (PrivateLink) connectivity request.
 * From GET/POST /v1/instances/:id/network-requests. `details` is the per-kind
 * payload (peering: aws_account_id/vpc_id/vpc_cidr/region; private_endpoint:
 * aws_account_id/region). */
export type NetworkRequest = {
  id: string;
  kind: NetworkRequestKind | string;
  details: Record<string, unknown>;
  status: "requested" | "in_progress" | "active" | "rejected" | "deleted" | string;
  created_at: string;
};

export type EventView = {
  id: string;
  // Stable kind enum from operation-backend (`events::Kind::as_str`).
  kind:
    | "INSTANCE_CREATED"
    | "INSTANCE_DELETED"
    | "INSTANCE_BEARER_ROTATED"
    | "SUBSCRIPTION_STARTED"
    | "SUBSCRIPTION_CANCELLED"
    | string;
  target_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
};

export type ProvisionResponse = {
  instance: Instance;
  /** Shown once, never re-derivable - the store only keeps an argon2 hash. */
  bearer_token: string;
};

/** Returned by POST /v1/instances when the new pending_payment flow kicks in.
 * Frontend must open Razorpay Checkout with `razorpay_subscription_id`, then
 * POST /v1/instances/:id/confirm-payment with the signature to complete. */
export type PendingPaymentResponse = {
  instance: Instance;
  razorpay_subscription_id: string;
  razorpay_key_id: string;
  razorpay_customer_id: string;
};

export type ConfirmPaymentBody = {
  razorpay_payment_id: string;
  razorpay_signature: string;
};

export type CardSummary = {
  last4: string;
  brand: string;
};

export type Eligibility = {
  has_used_trial: boolean;
  pm_status: "none" | "pm_pending" | "pm_active";
  card: CardSummary | null;
  active_subscriptions: number;
  trial_available: boolean;
};

export type SetupIntent = {
  razorpay_order_id: string;
  razorpay_key_id: string;
  amount_cents: number;
  currency: string;
};

export type PaymentMethodView = {
  id: string;
  last4: string;
  brand: string;
  status: "active" | "expired" | "removed";
};

export type ConfirmPaymentMethodBody = {
  razorpay_payment_id: string;
  razorpay_order_id: string;
  razorpay_signature: string;
  razorpay_token_id?: string;
  last4?: string;
  brand?: string;
};

export type RemoveBlockedBody = {
  error: "active_instances";
  active_count: number;
  instance_ids: string[];
};

// ── Add-ons ──────────────────────────────────────────────────────────────

/** Mirrors `operation-backend/src/addons/model.rs::AddonView`. */
export type AddonRow = {
  addon_id: string;
  preview: boolean;
  enabled_at: string;
  monthly_usd: number;
};

/** Mirrors `addons::routes::EnableResponse`. */
export type AddonEnableResponse = {
  addon_id: string;
  enabled_at: string;
};

// ── Per-instance observability ────────────────────────────────────────────

export type SnapshotView = {
  recovery_point_arn: string;
  created_at: string;
  size_bytes: number;
  status: string;
  resource_type: string;
};

export type MetricPoint = { t: string; v: number };
export type MetricSeries = {
  metric: string;
  label: string;
  points: MetricPoint[];
};
export type MetricsResponse = {
  series: MetricSeries[];
  from: string;
  to: string;
};

export type LogLine = {
  timestamp: number;
  level: string;
  message: string;
};
export type LogsResponse = {
  lines: LogLine[];
  instance_id: string;
  fetched_at: string;
};

/** One per-shape tile on `/app/metrics`. The backend may return `null`
 * for `p99_ms` / `qps` when the engine doesn't yet emit the underlying
 * counter - render "-" rather than fabricating a number. `enabled` is
 * sourced from the real `tenant_addons` row. */
export type ShapeStat = {
  p99_ms: number | null;
  qps: number | null;
  enabled: boolean;
};

/** Storage panel on `/app/metrics`. v0 returns nulls for every field
 * because the engine doesn't expose a per-shape size diagnostic yet;
 * the frontend renders dashes. */
export type StorageBreakdown = {
  rows_gb: number | null;
  indexes_gb: number | null;
  vectors_gb: number | null;
  fts_gb: number | null;
};

/** Mirrors `observe::handlers::MetricsSummaryResponse`. */
export type MetricsSummaryResponse = {
  shapes: Record<string, ShapeStat>;
  storage: StorageBreakdown;
};

/** One sealed segment / checkpoint shipped to S3 by `oc-pitr`. Mirrors
 * `observe::handlers::ArchiveSegment`. */
export type ArchiveSegment = {
  lsn_start: number;
  lsn_end: number;
  sealed_at: string | null;
  sha256: string | null;
  size_bytes: number;
  compressed: boolean;
  kind: "segment" | "checkpoint";
  s3_key: string;
};

/** Mirrors `observe::handlers::PitrArchiveResponse`. */
export type PitrArchiveResponse = {
  segments: ArchiveSegment[];
  tail_status: "active" | "paused" | "unknown";
  rpo_seconds: number | null;
};

/** One line on the usage breakdown. `kind` is the canonical group
 * compute / addon / overage. */
export type UsageLine = {
  kind: "compute" | "addon" | "overage";
  name: string;
  amount_usd: number;
};

/** Mirrors `usage::handlers::CurrentUsageResponse`. */
export type CurrentUsageResponse = {
  period_start: string;
  period_end: string;
  lines: UsageLine[];
  total_usd: number;
};

/** Neutral, spec-based compute configuration returned by the engine's
 * `GET /v1/tenants/:t/usage`.
 *
 * `slug` is the stable machine id (`entry`/`standard`/`advanced`/
 * `custom`); `label` is display text such as "4 vCPU / 16 GB, HA".
 * Quantitative fields and `monthly_price` are omitted for the
 * sales-sized `custom` configuration. */
export type TenantConfiguration = {
  slug: string;
  label: string;
  vcpu?: number;
  ram_gb?: number;
  storage_gb?: number;
  ha: boolean;
  monthly_price?: number;
};

/** Per-schema row / byte / segment breakdown from `/usage`. */
export type SchemaUsage = {
  schema: string;
  rows: number;
  bytes: number;
  segments: number;
};

/** Response of the engine's `GET /v1/tenants/:t/usage`.
 *
 * `tier` is the configuration slug
 * (`entry`/`standard`/`advanced`/`custom`). Prefer the richer
 * `configuration` object. `tier`, `configuration`, and `limits` are all
 * absent in legacy per-addon mode. */
export type TenantUsage = {
  tenant: string;
  /** Configuration slug — same value as `configuration.slug`. */
  tier?: string;
  configuration?: TenantConfiguration;
  limits?: Record<string, number>;
  used: {
    store_keys: number;
    vector_embeddings?: number;
    reactive_subscriptions?: number;
  };
  schemas: SchemaUsage[];
};

/** One query-metrics time bucket. Latency is null when no calls completed. */
export type QueryMetricBucket = {
  /** Unix timestamp in milliseconds. */
  at: number;
  calls: number;
  failed: number;
  mean_latency_ms: number | null;
  /** Actual observed duration; use this for rates instead of the nominal bucket size. */
  observed_seconds: number;
};

/** Tenant query metrics from the executing process, not a cluster-wide total.
 * Timestamps are Unix milliseconds. Integers use JavaScript numbers and are
 * exact only within Number.MAX_SAFE_INTEGER. */
export type QueryMetricsResponse = {
  schema_version: number;
  tenant_id: string;
  from: number;
  to: number;
  bucket_seconds: number;
  collection_started_at: number;
  scope: string;
  retention_seconds: number;
  buckets: QueryMetricBucket[];
  dropped_events: number;
};

// ── Engine: SQL ──────────────────────────────────────────────────────────

export type SqlReq = { sql: string; params?: unknown[] };
export type SqlSelect = {
  kind: "select";
  rows: unknown[];
  /** Projection order, including columns that have no non-NULL cells. */
  columns?: string[];
  /** Server-declared SQL types by output name; absent on older engines. */
  column_types?: Record<string, string>;
};
export type SqlInsert = { kind: "insert"; schema: string; rows?: unknown[]; inserted?: number; rows_buffered?: number };
/** A bulk DELETE can omit `pk`. Buffered rows do not establish a committed count. */
export type SqlDelete = { kind: "delete"; schema: string; pk?: string | null; rows_affected?: number; rows_buffered?: number };
export type SqlResp = SqlSelect | SqlInsert | SqlDelete;

// ── Engine: Vector ───────────────────────────────────────────────────────

export type VecMetric = "cosine" | "dot" | "l2";

export type VecPutReq = {
  id: string;
  embedding: number[];
  dim: number;
  metric?: VecMetric;
  metadata?: Record<string, unknown>;
};

export type VecTopkReq = {
  query: number[];
  k: number;
  dim: number;
  metric?: VecMetric;
  filter?: Record<string, unknown>;
  /** `"fast"` favours latency, `"high_recall"` favours recall. Server defaults
   * to `"high_recall"` when the field is absent. */
  mode?: "fast" | "high_recall";
};

export type VecHit = { id: string; score: number };

/** Which engine index family dispatches a vector delete. Mirrors the Rust
 * `oc_vector::IndexKind` snake_case serde representation. */
export type VecIndexKind = "hnsw" | "ivf" | "ivf_pq";

/** Response body for a vector delete. `deleted` is `false` on an idempotent
 * no-op (the id wasn't resident under `(tenant, table, id)`). */
export type VecDeleteResp = { deleted: boolean };

// ── Engine: Full-text ────────────────────────────────────────────────────

export type FtsMode = "boolean" | "bm25" | "phrase";
export type FtsIndexDoc = { doc_id: string; text: string };
export type RankedHit = { doc_id: string; score: number };

// ── Engine: Graph ────────────────────────────────────────────────────────

export type GraphBfsHit = { pk: string; depth: number };
export type GraphPath = { reachable: boolean };
export type DijkstraResult = { cost: number | null };

// ── SDK config ───────────────────────────────────────────────────────────

/** Minimal subset of the global `fetch` signature the SDK actually uses.
 * Lets callers inject mocks (e.g. msw, nock-fetch, vitest's `vi.fn`) without
 * pulling in `lib.dom.d.ts`. */
export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

/** Per-call controls for database requests. Reuse a key only for the same logical write. */
export type RequestOptions = {
  signal?: AbortSignal;
  idempotencyKey?: string;
  /** Assert this operation can safely run again. POST and mutations default to false. */
  retrySafe?: boolean;
};

export type ClientOptions = {
  /** The database's address (OC_URL), exactly as shown in Connect. Each call
   * appends its door path, for example `<url>/sql`; the SDK never builds,
   * edits or parses it. It must be https:// (plain http only on localhost,
   * 127.0.0.1 or [::1]) with no user name, password, query or fragment. */
  url?: string;
  /** OC_TOKEN: an access token from Access tokens, or, on a database where
   * access tokens are not supported yet, that database's key. Sent unchanged
   * as `Authorization: Bearer <token>`. It reaches data once its owner has a
   * database identity on this database. */
  token?: string;
  /** @deprecated Use `url` (OC_URL). The engine origin; the SDK appends
   * `/v1/tenants/<tenantId>` to it. Will be removed. */
  baseUrl?: string;
  /** @deprecated Use `token` (OC_TOKEN). Will be removed. */
  bearer?: string;
  /** @deprecated An access token carries its own database identity: use it as
   * `token`. Supply both or neither. Will be removed. */
  dbUser?: string;
  /** @deprecated See `dbUser`. */
  dbKey?: string;
  /** Override the global `fetch` (testing, instrumentation). Defaults to
   * `globalThis.fetch`. */
  fetch?: FetchLike;
  /** Maximum additional attempts for retry-safe calls. Default: 0; range: 0..99. */
  maxRetries?: number;
  /** Timeout for the whole call, including retries and waits. Default: 60000. */
  timeoutMs?: number;
  /** @deprecated Only with the deprecated `baseUrl`; never with `url`, which is
   * already the database's whole address. Without it, the deprecated `baseUrl`
   * mode reads the tenant from the first DNS label of `baseUrl`. Will be
   * removed. */
  tenantId?: string;
  /** Opt-in client diagnostics. Default `false`: nothing is reported. When
   * `true`, the client reports each call's method, path, outcome, duration,
   * status and request ids to your own engine, which keeps only the route
   * template. No SQL, parameters, row data, search text or error messages are
   * ever sent. See the README's "Diagnostics" section. */
  diagnostics?: boolean;
};

/** Options for `OriginChainClient.fromEnv()`. The address and token always
 * come from the environment (OC_URL and OC_TOKEN). */
export type FromEnvOptions = Omit<
  ClientOptions,
  "url" | "token" | "baseUrl" | "bearer" | "tenantId" | "dbUser" | "dbKey"
> & {
  /** Variables to read instead of `process.env`, for example a Workers `env`
   * binding. */
  env?: Record<string, string | undefined>;
};

export type AdminClientOptions = {
  /** Control-plane base URL, e.g. `https://api.originchain.ai`. */
  baseUrl: string;
  /** Override the global `fetch`. */
  fetch?: FetchLike;
  /** Per-request timeout in milliseconds. */
  timeoutMs?: number;
  /** Send cookies with every request. Defaults to `"include"` for the
   * browser (matches the previous frontend behaviour). Set to `"omit"` for
   * Node-side use with explicit auth headers. */
  credentials?: RequestCredentials;
  /** Optional bearer to add to control-plane calls (e.g. when running from
   * Node where cookies aren't available). */
  bearer?: string;
};
