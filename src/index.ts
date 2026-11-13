// Public surface of `@originchain/sdk`.
//
// Two clients:
//   * `OriginChainClient`      - talks to one database: HTTPS to OC_URL with
//                                OC_TOKEN as `Authorization: Bearer`
//   * `OriginChainAdminClient` - talks to the control plane (cookie + bearer)

export {
  OriginChainClient,
  OriginChainClient as Client,
  OriginChainAdminClient,
  GraphMethods,
  tenantIdFromEndpoint,
} from "./client.js";

export {
  ApiError,
  OCAddonRequiredError,
  OCPaymentRequiredError,
  OCRecordApiNotEnabledError,
  isAddonRequiredBody,
} from "./errors.js";

export type { ApiErrorBody, AddonRequiredBody } from "./errors.js";

export type {
  AddonEnableResponse,
  AddonRow,
  AdminClientOptions,
  ArchiveSegment,
  AuthResponse,
  CardSummary,
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
  LogLine,
  LogsResponse,
  MetricPoint,
  MetricSeries,
  MetricsResponse,
  MetricsSummaryResponse,
  PaymentMethodView,
  PendingPaymentResponse,
  PitrArchiveResponse,
  Plan,
  PlansResponse,
  ProvisionResponse,
  QueryMetricBucket,
  QueryMetricsResponse,
  RankedHit,
  RequestOptions,
  RemoveBlockedBody,
  SetupIntent,
  ShapeStat,
  SnapshotView,
  SqlDelete,
  SqlInsert,
  SchemaUsage,
  SqlReq,
  SqlResp,
  SqlSelect,
  StorageBreakdown,
  Subscription,
  TenantConfiguration,
  TenantUsage,
  UsageLine,
  User,
  VecDeleteResp,
  VecHit,
  VecIndexKind,
  VecMetric,
  VecPutReq,
  VecTopkReq,
} from "./types.js";

export { BatchError, ProtocolError, RowDecodeError, mapRows } from "./sql.js";
export { CredentialError } from "./integration.js";
export type { RequestEvent, TokenProvider } from "./integration.js";
export type { SqlApi, SqlResult } from "./sql.js";
export type { FtsHit, FtsResult } from "./search.js";
export type { FtsSearchOptions, VectorSearchOptions } from "./resources.js";
export type { VectorHit } from "./vector.js";

export { BatchWriteError } from "./iteration.js";
export type { BatchResult, BatchOptions, RowPage, PageOptions } from "./iteration.js";

export {
  VectorIndexes,
  VECTOR_INDEX_DEFAULT_NAMESPACE,
  VECTOR_INDEX_UPSERT_MAX_BODY_BYTES,
  VECTOR_INDEX_UPSERT_MAX_RECORDS,
} from "./vector-indexes.js";
export type {
  VectorIndex,
  VectorIndexAnswer,
  VectorIndexChanges,
  VectorIndexCount,
  VectorIndexDeleteByFilter,
  VectorIndexDeleteResult,
  VectorIndexFetchByFilter,
  VectorIndexFetchResult,
  VectorIndexFilter,
  VectorIndexFilterJob,
  VectorIndexIdPage,
  VectorIndexJob,
  VectorIndexMetric,
  VectorIndexNamespace,
  VectorIndexNamespacePage,
  VectorIndexPage,
  VectorIndexProjection,
  VectorIndexRecord,
  VectorIndexRecordPage,
  VectorIndexRequestOptions,
  VectorIndexSearch,
  VectorIndexSearchHit,
  VectorIndexSearchQuality,
  VectorIndexSearchResult,
  VectorIndexSparseValues,
  VectorIndexSpec,
  VectorIndexStats,
  VectorIndexStoredRecord,
  VectorIndexTextField,
  VectorIndexUpdate,
  VectorIndexUpdateByFilter,
  VectorIndexUpsertBatch,
  VectorIndexUpsertOptions,
  VectorIndexUpsertResult,
  VectorIndexValues,
} from "./vector-indexes.js";
