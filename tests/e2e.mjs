// Live end-to-end smoke for @originchain/sdk against a real engine.
// Not a vitest spec (no .test/.spec suffix) — run explicitly: `node tests/e2e.mjs`
// after `npm run build`. Guarded: exits 0 without running when OC_BASE is unset
// (e.g. a fork PR without secrets) so it never fails a credential-less build.
//
//   OC_BASE=https://<tenant>.<region>.db.originchain.ai \
//   OC_BEARER=<bearer> OC_TENANT=<tenant-ulid> [OC_NS=tsdemo] node tests/e2e.mjs
//
// Graph uses a self-relation FK (the real engine model): the edge runs from a
// row's PK to the value in from_col.
import * as sdk from "@originchain/sdk";

if (process.env.OC_REQUIRE_LIVE === "1") {
  for (const name of ["OC_BASE", "OC_BEARER", "OC_TENANT"]) {
    if (!process.env[name]) throw new Error(`Required live-test setting missing: ${name}`);
  }
}
if (!process.env.OC_BASE) {
  console.log("OC_BASE unset — skipping live E2E (set OC_BASE/OC_BEARER/OC_TENANT to run).");
  process.exit(0);
}

const C = sdk.OriginChainClient || sdk.default;
const oc = new C({ baseUrl: process.env.OC_BASE, bearer: process.env.OC_BEARER, tenantId: process.env.OC_TENANT, dbUser: process.env.OC_DB_USER || undefined, dbKey: process.env.OC_DB_KEY || undefined });

const NS = process.env.OC_NS || "tsdemo";
const TOML = `version = 1
namespace = "${NS}"
table = "products"
primary_key = ["id"]
extractions = []
foreign_keys = []
check_constraints = []
triggers = []

[[columns]]
name = "id"
ty = "str"
required = true

[[columns]]
name = "name"
ty = "str"

[[columns]]
name = "price"
ty = "f64"

[[columns]]
name = "description"
ty = "str"

[[columns]]
name = "related_to"
ty = "str"

[[relations]]
name = "related"
from_col = "related_to"
bidirectional = true

[relations.target]
namespace = "${NS}"
table = "products"
pk = "id"
`;
const VEC = [0.1, 0.2, 0.1, 0.0, 0.3, 0.1, 0.2, 0.0];
const results = [];
async function step(name, fn, expectFail = false) {
  try {
    const v = await fn();
    results.push([name, !expectFail, JSON.stringify(v)?.slice(0, 90)]);
  } catch (e) {
    results.push([name, expectFail && (e.status === 400 || e.status === 422), `${e.name || "Error"}: ${e.message}`.slice(0, 130)]);
  }
}

await step("registerSchema", () => oc.registerSchema(TOML));
await step("listSchemas", () => oc.listSchemas());
await step("sql INSERT", () => oc.sql(`INSERT INTO ${NS}.products (id,name,price,description,related_to) VALUES ('p1','Widget',9.99,'a small blue widget for testing','p2')`));
await step("sql INSERT p2", () => oc.sql(`INSERT INTO ${NS}.products (id,name,price,description) VALUES ('p2','Gadget',2.5,'a tiny red gadget gizmo')`));
await step("sql SELECT", () => oc.sql(`SELECT id,name,price FROM ${NS}.products WHERE price > 5`));
await step("sqlOne COUNT", () => oc.sqlOne(`SELECT COUNT(*) FROM ${NS}.products`));
await step("vectorPut", () => oc.vectorPut(`${NS}.products`, { id: "p1", embedding: VEC, dim: VEC.length }));
await step("vectorTopk", () => oc.vectorTopk(`${NS}.products`, { query: VEC, k: 5, dim: VEC.length, metric: "cosine" }));
await step("ftsIndex", () => oc.ftsIndex(`${NS}.products`, "description", { doc_id: "p1", text: "a small blue widget for testing" }));
await step("ftsSearch", () => oc.ftsSearch(`${NS}.products`, "description", { q: "widget", mode: "bm25", k: 5 }));
await step("graph.neighbors ->[p2]", async () => {
  const n = await oc.graph.neighbors(`${NS}.products`, { rel: "related", pk: "p1" });
  if (JSON.stringify(n) !== JSON.stringify(["p2"])) throw new Error(`expected ["p2"], got ${JSON.stringify(n)}`);
  return n;
});
await step("graph weighted and missing", async () => {
  const result = await oc.graph.dijkstra(`${NS}.products`, { rel: "related", src: "p1", dst: "p2", weights: { "p1|p2": 1.5 } });
  const missing = await oc.graph.dijkstra(`${NS}.products`, { rel: "related", src: "p1", dst: "p2", weights: {} });
  if (result.cost !== 1.5 || missing.cost !== null) throw new Error("node-pair weight semantics failed");
  return { cost: result.cost, missing: missing.cost };
});
await step("bound SQL and delete count", async () => {
  await oc.sql(`INSERT INTO ${NS}.products (id,name) VALUES ($1,$2)`, ["delete-probe", "SDK probe"]);
  const before = await oc.sql(`SELECT name FROM ${NS}.products WHERE id = $1`, ["delete-probe"]);
  if (before.kind !== "select" || before.rows[0]?.name !== "SDK probe") throw new Error("Bound SQL did not return probe");
  const deleted = await oc.sql(`DELETE FROM ${NS}.products WHERE id = $1`, ["delete-probe"]);
  if (deleted.kind !== "delete" || deleted.rows_affected !== 1) throw new Error("DELETE execution count missing");
  const after = await oc.sql(`SELECT id FROM ${NS}.products WHERE id = $1`, ["delete-probe"]);
  if (after.kind !== "select" || after.rows.length !== 0) throw new Error("Probe row remains after DELETE");
  return "Bound SQL and verified row deletion passed";
});
await step("usage", () => oc.usage());
await step("query metrics and idle latency", async () => {
  const metrics = await oc.queryMetrics();
  if (metrics.tenant_id?.toLowerCase() !== process.env.OC_TENANT.toLowerCase() ||
      metrics.schema_version !== 1 || metrics.scope !== "local-process" ||
      !Number.isSafeInteger(metrics.from) || metrics.from <= 2147483647 ||
      !Number.isSafeInteger(metrics.to) || metrics.to <= metrics.from ||
      metrics.bucket_seconds !== 60 || !Array.isArray(metrics.buckets)) {
    throw new Error("Query metrics tenant, large timestamps or bucket shape did not match");
  }
  for (const bucket of metrics.buckets) {
    if (!Number.isSafeInteger(bucket.at) || bucket.at <= 2147483647 ||
        !Number.isSafeInteger(bucket.calls) || bucket.calls < 0 ||
        !Number.isSafeInteger(bucket.failed) || bucket.failed < 0 ||
        typeof bucket.observed_seconds !== "number" || bucket.observed_seconds < 0 ||
        (bucket.calls === 0) !== (bucket.mean_latency_ms === null) ||
        (bucket.mean_latency_ms !== null && (typeof bucket.mean_latency_ms !== "number" || bucket.mean_latency_ms < 0))) {
      throw new Error("Invalid query metrics bucket");
    }
  }
  // Busy or freshly restarted processes need not have an idle bucket. Validate
  // every returned bucket and record actual null coverage instead of inventing it.
  return { idleNullBuckets: metrics.buckets.filter(bucket => bucket.mean_latency_ms === null).length,
    buckets: metrics.buckets.length, scope: metrics.scope };
});
await step("sql SELECT 1", () => oc.sql("SELECT 1"));
await step("invalid SQL (want-fail)", () => oc.sql("SELECT FROM WHERE"), true);

console.log(`\n=== TYPESCRIPT SDK ${sdk.VERSION || "@originchain/sdk"} E2E (ns=${NS}) ===`);
let np = 0;
for (const [n, ok, d] of results) { console.log(`${ok ? "PASS" : "FAIL"}  ${n.padEnd(26)} ${d}`); np += ok; }
console.log(`=== ${np}/${results.length} passed ===`);
process.exit(np === results.length ? 0 : 1);
