import { OriginChainClient } from "/sdk.mjs";

const API = "http://127.0.0.1:32171";
const TOKEN = "mock-browser-only";

async function checkSql(db, expectedPath, label) {
  const response = await db.sql("SELECT id FROM demo.items LIMIT 1");
  if (response.kind !== "select" || response.rows[0].id !== "one") throw new Error(`${label}: SQL response mismatch`);
  if (response.rows[0].path !== expectedPath) {
    throw new Error(`${label}: request went to ${response.rows[0].path}, expected ${expectedPath}`);
  }
  if (response.rows[0].correlation !== null || response.rows[0].attempt !== null) {
    throw new Error(`${label}: browser or worker sent server-only correlation headers`);
  }
}

export async function exercise() {
  // The application path: the address used exactly as given, in today's shape
  // and in the tenant-less shape, from options and from an env map.
  for (const path of ["/v1/tenants/browser-test", "/v1"]) {
    const url = API + path;
    await checkSql(new OriginChainClient({ url, token: TOKEN }), `${path}/sql`, `url ${path}`);
    await checkSql(OriginChainClient.fromEnv({ env: { OC_URL: url, OC_TOKEN: TOKEN } }), `${path}/sql`, `fromEnv ${path}`);
  }
  // There is no process here: fromEnv() without an env map must report the
  // missing variables, not fail on a missing global.
  let noProcess = false;
  try {
    OriginChainClient.fromEnv();
  } catch (error) {
    noProcess = /^OriginChainClient\.fromEnv: set OC_URL and OC_TOKEN\./.test(error.message);
  }
  if (!noProcess) throw new Error("fromEnv() without an env map did not report OC_URL and OC_TOKEN");
  // The deprecated options, unchanged for this release.
  const legacy = new OriginChainClient({ baseUrl: API, tenantId: "browser-test", bearer: TOKEN });
  await checkSql(legacy, "/v1/tenants/browser-test/sql", "deprecated options");

  const db = new OriginChainClient({ url: `${API}/v1`, token: TOKEN });
  const controller = new AbortController();
  const pending = db.vectorTopk("delayed", { query: [1], dim: 1, k: 1 }, { signal: controller.signal });
  setTimeout(() => controller.abort(), 40);
  let cancelled = false;
  try { await pending; } catch (error) { cancelled = error.name === "AbortError"; }
  if (!cancelled) throw new Error("Caller cancellation did not stop vector request");
  return {
    sql: true, url: true, fromEnv: true, noProcess: true, noServerCorrelation: true, cancelled: true,
    worker: typeof document === "undefined",
  };
}
