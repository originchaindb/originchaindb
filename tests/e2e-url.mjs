// Live check of the application path: `OriginChainClient.fromEnv()` with
// OC_URL (the database's address, copied from Connect) and OC_TOKEN (an access
// token whose owner has a database identity on that database).
//
// Not a vitest spec (no .test/.spec suffix). Run it from a consumer that has
// the built package installed:
//
//   OC_URL=<address from Connect> OC_TOKEN=<access token> node e2e-url.mjs
//
// Without OC_URL and OC_TOKEN it exits 0 without running, unless
// OC_REQUIRE_LIVE=1, which makes a missing value a failure; the release sets
// it, so a release cannot pass until both repository secrets exist. Neither
// value is ever printed.
import * as sdk from "@originchain/sdk";

const C = sdk.OriginChainClient || sdk.default;
const NAMES = ["OC_URL", "OC_TOKEN"];

const missing = NAMES.filter((name) => !process.env[name]);
if (missing.length) {
  if (process.env.OC_REQUIRE_LIVE === "1") {
    throw new Error(`Required live-test setting missing: ${missing.join(", ")}`);
  }
  console.log("OC_URL or OC_TOKEN unset: skipping the OC_URL/OC_TOKEN live check.");
  process.exit(0);
}

// The application path must not touch a deprecated name. fromEnv() warns once
// for each one it reads, so any warning fails this check.
const warnings = [];
const originalWarn = console.warn;
console.warn = (...args) => { warnings.push(args.map(String).join(" ")); };

const probe = `e2e-url-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
const passed = [];

try {
  // Exactly what an application does: no options but a timeout, and retries
  // only for a statement that is safe to repeat (a database that is waking up
  // answers 503 with Retry-After).
  const db = C.fromEnv({ timeoutMs: 30_000, maxRetries: 2 });
  if (db.tenantId !== undefined) throw new Error("A client built from OC_URL has a tenantId");
  if (db.url !== process.env.OC_URL.replace(/\/+$/, "")) throw new Error("The client changed OC_URL");
  passed.push("fromEnv used OC_URL as given");

  const result = await db.sql("SELECT $1 AS message", [probe], { retrySafe: true });
  if (result.kind !== "select" || !Array.isArray(result.rows) || result.rows.length !== 1 ||
      result.rows[0]?.message !== probe) {
    throw new Error("POST $OC_URL/sql did not return the bound value");
  }
  passed.push("bound SQL through $OC_URL/sql");

  // Negative control: the same address with a token that cannot be valid must
  // be refused, or the check above proves nothing about the token.
  const wrong = new C({ url: process.env.OC_URL, token: `oc_pat_invalid_${probe}`, timeoutMs: 30_000 });
  let status;
  try {
    await wrong.sql("SELECT $1 AS message", [probe]);
  } catch (error) {
    status = error instanceof sdk.ApiError ? error.status : undefined;
    if (status === undefined) throw error;
  }
  if (status !== 401) {
    throw new Error(`An invalid token was not refused with 401 (got ${status ?? "data"})`);
  }
  passed.push("invalid token refused with 401");
} finally {
  console.warn = originalWarn;
}

if (warnings.length) {
  // The SDK's warnings name variables, never their values.
  throw new Error(`fromEnv read a deprecated name: ${warnings.join(" | ")}`);
}
passed.push("no deprecated name read");
for (const line of passed) console.log(`ok - ${line}`);
console.log("OC_URL/OC_TOKEN live check passed.");
