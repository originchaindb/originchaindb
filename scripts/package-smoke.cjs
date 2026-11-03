// Run a copy of this file from a fresh directory containing the installed tarball.
const assert = require("node:assert/strict");

async function check(sdk, format) {
  assert.equal(typeof sdk.OriginChainClient, "function");
  assert.equal(typeof sdk.OriginChainAdminClient, "function");
  assert.equal(typeof sdk.ApiError, "function");
  const admin = new sdk.OriginChainAdminClient({ baseUrl: "https://admin-test.example.invalid" });
  assert.equal("ask" in sdk.OriginChainClient.prototype, false);
  assert.equal("runAsk" in admin.instances, false);
  assert.equal("proxiedAsk" in admin.instances, false);
  let calls = 0;
  const typedResult = {
    kind: "select",
    columns: ["special", "label", "created_at", "amount", "empty"],
    column_types: { special: "float8", label: "text", created_at: "timestamp", amount: "numeric" },
    rows: [{ special: "NaN", label: "NaN", created_at: "2026-10-25 01:02:03.123456", amount: "12345678901234567890.1200" }],
  };
  const client = new sdk.OriginChainClient({
    baseUrl: "https://package-test.example.invalid", tenantId: "package-test",
    bearer: "mock-only", fetch: async (url, init) => {
      calls++;
      if (String(url).endsWith("/query-metrics?minutes=60&bucket_seconds=60")) {
        assert.equal(init.method ?? "GET", "GET");
        assert.equal(new Headers(init.headers).get("authorization"), "Bearer mock-only");
        return new Response(JSON.stringify({
          schema_version: 1, tenant_id: "package-test", from: 1792832400000, to: 1792836000000,
          bucket_seconds: 60, collection_started_at: 1792832400000, scope: "local-process",
          retention_seconds: 604800, dropped_events: 4294967298,
          buckets: [{ at: 1792832400000, calls: 0, failed: 0, mean_latency_ms: null, observed_seconds: 30 }],
        }));
      }
      assert.equal(String(url), "https://package-test.example.invalid/v1/tenants/package-test/sql");
      assert.equal(init.method, "POST");
      assert.equal(new Headers(init.headers).get("authorization"), "Bearer mock-only");
      const query = JSON.parse(init.body).sql;
      if (query === "SELECT * FROM demo.typed_values") {
        return new Response(JSON.stringify(typedResult));
      }
      if (query === "SELECT * FROM demo.typed_values WHERE false") {
        return new Response(JSON.stringify({ ...typedResult, rows: [] }));
      }
      if (query === "DELETE FROM demo.items") {
        return new Response(JSON.stringify({ kind: "delete", schema: "demo.items", rows_affected: 2 }));
      }
      if (query === "DELETE FROM demo.empty") {
        return new Response(JSON.stringify({ kind: "delete", schema: "demo.empty", pk: null, rows_affected: 0 }));
      }
      if (query === "DELETE FROM demo.buffered") {
        return new Response(JSON.stringify({ kind: "delete", schema: "demo.buffered", rows_buffered: 2 }));
      }
      assert.equal(query, "SELECT id FROM demo.items LIMIT 1");
      return new Response(JSON.stringify({ kind: "select", rows: [{ id: "one" }] }), {
        headers: { "content-type": "application/json" }
      });
    }
  });
  assert.deepEqual(await client.sql("SELECT id FROM demo.items LIMIT 1"), {
    kind: "select", rows: [{ id: "one" }]
  });
  assert.equal(calls, 1);
  const metrics = await client.queryMetrics();
  assert.equal(metrics.from, 1792832400000);
  assert.equal(metrics.dropped_events, 4294967298);
  assert.equal(metrics.buckets[0].mean_latency_ms, null);
  assert.equal(metrics.buckets[0].observed_seconds, 30);
  assert.equal(calls, 2);
  assert.deepEqual(await client.sql("DELETE FROM demo.items"), {
    kind: "delete", schema: "demo.items", rows_affected: 2,
  });
  assert.deepEqual(await client.sql("DELETE FROM demo.empty"), {
    kind: "delete", schema: "demo.empty", pk: null, rows_affected: 0,
  });
  assert.deepEqual(await client.sql("DELETE FROM demo.buffered"), {
    kind: "delete", schema: "demo.buffered", rows_buffered: 2,
  });
  assert.equal(calls, 5);
  assert.deepEqual(await client.sql("SELECT * FROM demo.typed_values"), typedResult);
  assert.deepEqual(await client.sql("SELECT * FROM demo.typed_values WHERE false"), { ...typedResult, rows: [] });
  assert.equal(calls, 7);
  // The application path: OC_URL used as given, door paths appended, both shapes.
  for (const address of ["https://package-test.example.invalid/v1/tenants/package-test", "https://package-test.example.invalid/v1"]) {
    const seen = [];
    const fetch = async (url, init) => {
      seen.push([String(url), new Headers(init.headers).get("authorization")]);
      return new Response(JSON.stringify({ kind: "select", columns: ["one"], rows: [{ one: 1 }] }));
    };
    const fromEnv = sdk.OriginChainClient.fromEnv({ env: { OC_URL: address, OC_TOKEN: "mock-only" }, fetch });
    assert.deepEqual(await fromEnv.sql("SELECT 1 AS one"), { kind: "select", columns: ["one"], rows: [{ one: 1 }] });
    await new sdk.OriginChainClient({ url: `${address}/`, token: "mock-only", fetch }).listSchemas();
    assert.deepEqual(seen, [[`${address}/sql`, "Bearer mock-only"], [`${address}/schemas`, "Bearer mock-only"]]);
    assert.equal(fromEnv.tenantId, undefined);
  }
  assert.throws(() => new sdk.OriginChainClient({ url: "http://package-test.example.invalid/v1", token: "mock-only" }), /https:\/\//);
  console.log(`${format}: installed package SQL metadata, value preservation, bulk DELETE, query metrics and OC_URL/OC_TOKEN passed`);
}
(async () => {
  await check(require("@originchain/sdk"), "CommonJS");
  await check(await import("@originchain/sdk"), "ESM");
})().catch(error => { console.error(error); process.exitCode = 1; });
