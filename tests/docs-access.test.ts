// Guard: the documentation and examples teach one way in, HTTPS to OC_URL with
// OC_TOKEN, and nothing else.
//
// Matching is case-sensitive fixed-string search (String.prototype.includes),
// the equivalent of `grep -F` without `-i`. Every term has a positive control
// (it must be found), the canonical text is a near-miss negative control (it
// must not be found), and the exempt sources are checked to be exempt by scope,
// not because the matcher is blind to them.
//
// Scope: what an application developer or a maintainer reads, including what
// ships in the package (README, CHANGELOG). Exempt from the never-access names:
// `src/`, which reads the old names for one release with a warning, and
// `tests/`, which proves that it does. The JSDoc in `src/` ships in the package's
// type declarations, so `src/` is still scanned for database-client terms.
//
// The README connect block is to be generated from the connect contract,
// operation-backend `src/connect/contract.v1.json` (branch
// feat/one-access-contract), once it merges; until then it follows section 2.1
// of the one-access plan. Those internal names stay here, out of the package.

import { describe, expect, it } from "vitest";
// Read as text by the test runner (Vite `?raw`), so no Node type definitions are needed.
import readme from "../README.md?raw";
import changelog from "../CHANGELOG.md?raw";
import contributing from "../CONTRIBUTING.md?raw";
import contract from "../docs/contract.md?raw";
import examplesReadme from "../examples/README.md?raw";
import examplesQuery from "../examples/query.mjs?raw";
import clientSource from "../src/client.ts?raw";
import connectSource from "../src/connect.ts?raw";
import diagnosticsSource from "../src/diagnostics.ts?raw";
import errorsSource from "../src/errors.ts?raw";
import indexSource from "../src/index.ts?raw";
import retrySource from "../src/retry.ts?raw";
import transportSource from "../src/transport.ts?raw";
import typesSource from "../src/types.ts?raw";
import connectTest from "./connect.test.ts?raw";

// From the connect contract (one-access plan, section 2.1).
const NEVER_ACCESS = [
  "ORIGINCHAIN_HOST", "ORIGINCHAIN_PORT", "ORIGINCHAIN_USER", "ORIGINCHAIN_PASSWORD", "ORIGINCHAIN_DB",
  "ORIGINCHAIN_TOKEN", "ORIGINCHAIN_URL", "ORIGINCHAIN_TENANT", "ORIGINCHAIN_DB_USER", "ORIGINCHAIN_CA",
  "OC_HOST", "OC_TENANT", "OC_BASE_URL", "OC_BEARER", "OC_API_KEY", "OC_ENDPOINT", "OC_DB_USER", "OC_DB_KEY",
  "OC_DB_PASSWORD", "OC_ES_URL", "X-OC-DB-User", "x-oc-db-user", "X-OC-DB-Key", "x-oc-db-key", "X-OC-Tenant",
  "/v1/tenants/$", "/v1/tenants/{tenant}", "/v1/tenants/YOUR_TENANT", "oc_live_",
];
// OC_URL is opaque (decision D2), so no document shows a tenant path in any
// spelling, including route patterns such as `/v1/tenants/:t`.
const TENANT_PATHS = ["/v1/tenants/"];
// Database-client terms: never on an application path, which all of these files are.
const WIRE_TERMS = ["psycopg", "node-postgres", "postgresql://", "PGPASSWORD", ":5432", "sslmode"];
const LEGACY_PREFIXES = ["oc_u_", "oc_cli_"];
const TERMS = [...NEVER_ACCESS, ...TENANT_PATHS, ...WIRE_TERMS, ...LEGACY_PREFIXES];
// What `src/` must not say in the JSDoc that ships as type declarations.
const SOURCE_TERMS = [...WIRE_TERMS, ...LEGACY_PREFIXES];
// Internal names that must not reach the npm package.
const INTERNAL = ["operation-backend", "feat/one-access-contract", "one-access plan", "contract.v1.json"];

const SCANNED: Record<string, string> = {
  "README.md": readme,
  "CHANGELOG.md": changelog,
  "CONTRIBUTING.md": contributing,
  "docs/contract.md": contract,
  "examples/README.md": examplesReadme,
  "examples/query.mjs": examplesQuery,
};
// The files `package.json` "files" ships besides `dist/`.
const SHIPPED: Record<string, string> = { "README.md": readme, "CHANGELOG.md": changelog };
const SOURCES: Record<string, string> = {
  "src/client.ts": clientSource,
  "src/connect.ts": connectSource,
  "src/diagnostics.ts": diagnosticsSource,
  "src/errors.ts": errorsSource,
  "src/index.ts": indexSource,
  "src/retry.ts": retrySource,
  "src/transport.ts": transportSource,
  "src/types.ts": typesSource,
};
const EXEMPT: Record<string, string> = {
  "src/connect.ts": connectSource,
  "tests/connect.test.ts": connectTest,
};

const ANSWER =
  "Connect over HTTPS with two values: OC_URL (your database's address, from Connect) and OC_TOKEN " +
  "(an access token from Access tokens). Send Authorization: Bearer $OC_TOKEN to $OC_URL/sql.";

const find = (terms: string[], text: string) => terms.filter((term) => text.includes(term));
const hits = (text: string) => find(TERMS, text);

describe("the matcher can fail", () => {
  it.each(TERMS)("positive control: flags %s", (term) => {
    expect(hits(`text before ${term} text after`)).toContain(term);
  });

  it("positive control: flags a term added to a scanned file, through the same read path", () => {
    expect(hits(SCANNED["README.md"] + "\nexport OC_BEARER=...\n")).toEqual(["OC_BEARER"]);
    expect(hits(SCANNED["CHANGELOG.md"] + "\n- reads `GET /v1/tenants/:t/usage`\n")).toEqual(["/v1/tenants/"]);
  });

  it("positive control: flags a database-client term added to a source file, through the same read path", () => {
    expect(find(SOURCE_TERMS, SOURCES["src/types.ts"] + "\n/** a postgresql:// string */\n")).toEqual(["postgresql://"]);
  });

  it("positive control: flags an internal name added to a shipped file, through the same read path", () => {
    expect(find(INTERNAL, SHIPPED["README.md"] + "\n<!-- see operation-backend -->\n")).toEqual(["operation-backend"]);
  });

  it("negative control: the canonical names and request are not flagged", () => {
    const canonical =
      `${ANSWER} OC_URL OC_TOKEN oc_pat_ "$OC_URL/sql" fromEnv() url token https://db.example.invalid/v1`;
    expect(hits(canonical)).toEqual([]);
  });

  it("negative control: a separate database login is not an application credential", () => {
    const line = "SQL tools such as psql use a separate login from Connect.";
    expect(hits(line)).toEqual([]);
  });

  it("negative control: exempt sources are exempt by scope, not by a blind matcher", () => {
    for (const [path, text] of Object.entries(EXEMPT)) {
      expect(Object.keys(SCANNED)).not.toContain(path);
      expect(hits(text)).toContain("OC_BEARER");
    }
  });
});

describe.each(Object.entries(SCANNED))("%s", (_path, text) => {
  it("is not empty", () => {
    expect(text.length).toBeGreaterThan(100);
  });
  it("names no other way in", () => {
    expect(hits(text)).toEqual([]);
  });
});

describe.each(Object.entries(SOURCES))("%s (JSDoc ships in the type declarations)", (_path, text) => {
  it("is not empty", () => {
    expect(text.length).toBeGreaterThan(100);
  });
  it("names no database-client term", () => {
    expect(find(SOURCE_TERMS, text)).toEqual([]);
  });
});

describe.each(Object.entries(SHIPPED))("%s (ships in the package)", (_path, text) => {
  it("names no internal repository, branch or plan", () => {
    expect(find(INTERNAL, text)).toEqual([]);
  });
});
