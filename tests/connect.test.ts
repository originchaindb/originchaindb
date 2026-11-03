// The application path: HTTPS to OC_URL with OC_TOKEN. OC_URL is opaque, so the
// same client code must work for every address shape, and the SDK must never
// build, edit or split it.
//
// The old environment names appear here only to prove that they are read for
// one release with a one-time warning, and that OC_URL / OC_TOKEN win.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OriginChainClient, type FetchLike } from "../src/index.js";
import { _resetEnvWarnings } from "../src/connect.js";

type Call = { url: string; init: RequestInit };

function recorder(body: unknown = { kind: "select", columns: ["one"], rows: [{ one: 1 }] }) {
  const calls: Call[] = [];
  const fetch: FetchLike = async (input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  };
  return { fetch, calls };
}

const TOKEN = "oc_pat_test_only_0123456789";
// Today's address shape and the tenant-less shape the engine is moving to.
const SHAPES = {
  "tenant path": "https://db.example.invalid/v1/tenants/01jbz5q3x8r8m4t2vkp6d1c9aa",
  "no tenant": "https://db.example.invalid/v1",
};

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  _resetEnvWarnings();
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe.each(Object.entries(SHAPES))("OC_URL used as given (%s)", (_shape, ocUrl) => {
  it("appends each door path to the address and sends the token unchanged", async () => {
    const { fetch, calls } = recorder();
    const db = OriginChainClient.fromEnv({ env: { OC_URL: ocUrl, OC_TOKEN: TOKEN }, fetch });
    const result = await db.sql("SELECT n FROM a WHERE n > $1", [10]);
    expect(result).toEqual({ kind: "select", columns: ["one"], rows: [{ one: 1 }] });
    await db.listSchemas();
    await db.vectorTopk("docs", { query: [1, 0], k: 2, dim: 2 });
    await db.ftsSearch("docs", "body", { q: "tea" });
    await db.graph.neighbors("people", { rel: "knows", pk: "a" });
    await db.queryMetrics();
    expect(calls.map((c) => c.url)).toEqual([
      `${ocUrl}/sql`,
      `${ocUrl}/schemas`,
      `${ocUrl}/vector/docs/topk`,
      `${ocUrl}/fts/docs/body?q=tea`,
      `${ocUrl}/graph/people/neighbors?rel=knows&pk=a`,
      `${ocUrl}/query-metrics?minutes=60&bucket_seconds=60`,
    ]);
    const first = calls[0]!;
    expect(first.init.method).toBe("POST");
    expect(JSON.parse(first.init.body as string)).toEqual({ sql: "SELECT n FROM a WHERE n > $1", params: [10] });
    for (const call of calls) {
      const headers = new Headers(call.init.headers);
      expect(headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
      expect(headers.has("x-oc-db-user")).toBe(false);
      expect(headers.has("x-oc-db-key")).toBe(false);
    }
    // Negative control for the warning tests below: the canonical names warn nothing.
    expect(warn).not.toHaveBeenCalled();
  });

  it("treats a trailing slash as the same address", async () => {
    const { fetch, calls } = recorder();
    await new OriginChainClient({ url: `${ocUrl}/`, token: TOKEN, fetch }).sql("SELECT 1");
    expect(calls[0]!.url).toBe(`${ocUrl}/sql`);
  });

  it("exposes the address, only its origin as baseUrl, and no tenant", () => {
    const db = new OriginChainClient({ url: ocUrl, token: TOKEN });
    expect(db.url).toBe(ocUrl);
    expect(db.baseUrl).toBe("https://db.example.invalid");
    expect(db.tenantId).toBeUndefined();
  });

  it("sends opt-in diagnostics to the same address, with the full request path", async () => {
    const { fetch, calls } = recorder();
    const db = new OriginChainClient({ url: ocUrl, token: TOKEN, fetch, diagnostics: true });
    await db.sql("SELECT 1");
    await db.flushDiagnostics();
    if (ocUrl.includes("/v1/tenants/")) {
      expect(calls.map((c) => c.url)).toEqual([`${ocUrl}/sql`, `${ocUrl}/diagnostics`]);
      const [event] = JSON.parse(calls[1]!.init.body as string).events;
      expect(event.path).toBe(`${new URL(ocUrl).pathname}/sql`);
    } else {
      // The engine's diagnostics contract accepts tenant paths only and refuses
      // a whole batch for one invalid event, so another shape is not reported.
      // The call itself is unaffected.
      expect(calls.map((c) => c.url)).toEqual([`${ocUrl}/sql`]);
    }
  });
});

it("never reads a tenant out of the hostname when given an address", async () => {
  // A free-tier style hostname: the deprecated baseUrl mode would re-encode
  // this UUID label as a tenant id and put it in the path.
  const ocUrl = "https://0192f5d3-7c4e-7a10-8b2f-3c9d4e5f6a7b.free.example.invalid/v1/tenants/x";
  const { fetch, calls } = recorder();
  await new OriginChainClient({ url: ocUrl, token: TOKEN, fetch }).sql("SELECT 1");
  expect(calls[0]!.url).toBe(`${ocUrl}/sql`);
  // Positive control: the deprecated mode does infer, so the check above can fail.
  const legacy = recorder();
  await new OriginChainClient({ baseUrl: new URL(ocUrl).origin, bearer: TOKEN, fetch: legacy.fetch }).sql("SELECT 1");
  expect(legacy.calls[0]!.url).not.toBe(`${ocUrl}/sql`);
  expect(legacy.calls[0]!.url).toMatch(/\/v1\/tenants\/[0-9a-z]{26}\/sql$/);
});

it("never checks the token's prefix", async () => {
  const { fetch, calls } = recorder();
  const key = "database-key-without-a-prefix";
  await OriginChainClient.fromEnv({ env: { OC_URL: SHAPES["no tenant"], OC_TOKEN: key }, fetch }).sql("SELECT 1");
  expect(new Headers(calls[0]!.init.headers).get("authorization")).toBe(`Bearer ${key}`);
});

describe("plain http is refused except on loopback", () => {
  const allowed = [
    "http://localhost:8080/v1",
    "http://LOCALHOST/v1",
    "http://127.0.0.1:9/v1/tenants/x",
    "http://127.10.20.30/v1",
    "http://[::1]:8080/v1",
    "https://db.example.invalid/v1",
  ];
  const refused = [
    "http://db.example.invalid/v1",
    "http://10.0.0.5/v1",
    "http://localhost.example.invalid/v1",
    "http://127.0.0.1.example.invalid/v1",
    "http://[::2]/v1",
    "ftp://db.example.invalid/v1",
    "ws://localhost/v1",
  ];

  it.each(allowed)("accepts %s", (address) => {
    expect(() => new OriginChainClient({ url: address, token: TOKEN })).not.toThrow();
    expect(() => OriginChainClient.fromEnv({ env: { OC_URL: address, OC_TOKEN: TOKEN } })).not.toThrow();
  });

  it.each(refused)("refuses %s before any request", (address) => {
    const { fetch, calls } = recorder();
    expect(() => new OriginChainClient({ url: address, token: TOKEN, fetch })).toThrow(/https:\/\//);
    expect(() => OriginChainClient.fromEnv({ env: { OC_URL: address, OC_TOKEN: TOKEN }, fetch }))
      .toThrow(/^OC_URL must start with https:\/\//);
    expect(calls).toHaveLength(0);
  });
});

describe("addresses that are not usable as given are refused without echoing them", () => {
  const SECRET = "s3cr3t-in-address";
  it.each<[string, RegExp]>([
    [`https://user:${SECRET}@db.example.invalid/v1`, /user name or password/],
    [`https://${SECRET}@db.example.invalid/v1`, /user name or password/],
    [`https://db.example.invalid/v1?key=${SECRET}`, /query \(\?\) or fragment/],
    [`https://db.example.invalid/v1?`, /query \(\?\) or fragment/],
    [`https://db.example.invalid/v1#${SECRET}`, /query \(\?\) or fragment/],
    [`https://db.example.invalid/v1/${SECRET}\n`, /whitespace, an invisible character or a control character/],
    [` https://db.example.invalid/v1/${SECRET}`, /whitespace, an invisible character or a control character/],
    // Invisible when pasted, and otherwise sent inside the path (a 404 with no hint):
    // no-break, thin and ideographic spaces, zero-width characters, word joiner,
    // byte-order mark, next line.
    ...["\u00a0", "\u2009", "\u3000", "\u200b", "\u200c", "\u200d", "\u2060", "\ufeff", "\u0085"].map(
      (ch): [string, RegExp] => [`https://db.example.invalid/v1/${SECRET}${ch}`, /whitespace, an invisible character or a control character/],
    ),
    [`db.example.invalid/v1/${SECRET}`, /not an absolute https:\/\/ address/],
  ])("%s", (address, reason) => {
    for (const build of [
      () => new OriginChainClient({ url: address, token: TOKEN }),
      () => OriginChainClient.fromEnv({ env: { OC_URL: address, OC_TOKEN: TOKEN } }),
    ]) {
      let message = "";
      try {
        build();
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toMatch(reason);
      expect(message).not.toContain(SECRET);
    }
  });
});

it("accepts visible non-ASCII in an address (negative control for the invisible-character check)", async () => {
  const { fetch, calls } = recorder();
  await new OriginChainClient({ url: "https://db.example.invalid/v1/caf\u00e9", token: TOKEN, fetch }).sql("SELECT 1");
  expect(calls).toHaveLength(1);
});

describe("the token must be one header-safe line", () => {
  it.each([`${TOKEN}\n`, `${TOKEN}\r`, ` ${TOKEN}`, "tok en"])("refuses %j without echoing it", (token) => {
    for (const build of [
      () => new OriginChainClient({ url: SHAPES["no tenant"], token }),
      () => OriginChainClient.fromEnv({ env: { OC_URL: SHAPES["no tenant"], OC_TOKEN: token } }),
    ]) {
      let message = "";
      try {
        build();
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toMatch(/one line of printable ASCII/);
      expect(message).not.toContain(token.trim());
    }
  });
});

describe("fromEnv", () => {
  it("names both variables and the answer sentence when nothing is set", () => {
    expect(() => OriginChainClient.fromEnv({ env: {} })).toThrow(
      "OriginChainClient.fromEnv: set OC_URL and OC_TOKEN. Connect over HTTPS with two values: " +
        "OC_URL (your database's address, from Connect) and OC_TOKEN (an access token from Access tokens). " +
        "Send Authorization: Bearer $OC_TOKEN to $OC_URL/sql.",
    );
    expect(() => OriginChainClient.fromEnv({ env: { OC_URL: SHAPES["no tenant"] } })).toThrow("set OC_TOKEN.");
    expect(() => OriginChainClient.fromEnv({ env: { OC_TOKEN: TOKEN, OC_URL: "" } })).toThrow("set OC_URL.");
  });

  it("reads process.env by default", async () => {
    vi.stubEnv("OC_URL", SHAPES["tenant path"]);
    vi.stubEnv("OC_TOKEN", TOKEN);
    const { fetch, calls } = recorder();
    await OriginChainClient.fromEnv({ fetch }).sql("SELECT 1");
    expect(calls[0]!.url).toBe(`${SHAPES["tenant path"]}/sql`);
  });

  it("passes the other client options through", async () => {
    const { fetch, calls } = recorder();
    const db = OriginChainClient.fromEnv({
      env: { OC_URL: SHAPES["no tenant"], OC_TOKEN: TOKEN },
      fetch, timeoutMs: 1234, maxRetries: 1,
    });
    await db.sql("SELECT 1");
    expect(calls).toHaveLength(1);
    expect(() => OriginChainClient.fromEnv({ env: { OC_URL: SHAPES["no tenant"], OC_TOKEN: TOKEN }, maxRetries: -1 }))
      .toThrow("maxRetries");
  });

  it("works where the runtime has no process (browsers, workers)", () => {
    vi.stubGlobal("process", undefined);
    let message = "";
    try {
      OriginChainClient.fromEnv();
    } catch (error) {
      message = (error as Error).message;
    }
    vi.unstubAllGlobals();
    expect(message).toMatch(/^OriginChainClient\.fromEnv: set OC_URL and OC_TOKEN\./);
  });
});

describe("old environment names: read for one release, with a one-time warning", () => {
  const OLD = { OC_BASE_URL: "https://legacy.example.invalid", OC_TENANT: "legacy-tenant", OC_BEARER: "legacy-bearer-value" };

  it("still connects the old way and warns once per name group, naming the replacement", async () => {
    const { fetch, calls } = recorder();
    await OriginChainClient.fromEnv({ env: OLD, fetch }).sql("SELECT 1");
    await OriginChainClient.fromEnv({ env: OLD, fetch }).sql("SELECT 1");
    expect(calls.map((c) => c.url)).toEqual([
      "https://legacy.example.invalid/v1/tenants/legacy-tenant/sql",
      "https://legacy.example.invalid/v1/tenants/legacy-tenant/sql",
    ]);
    expect(new Headers(calls[0]!.init.headers).get("authorization")).toBe("Bearer legacy-bearer-value");
    // Positive control: these MUST warn; exactly once each across both calls.
    const messages = warn.mock.calls.map((args: unknown[]) => String(args[0]));
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatch(/OC_BASE_URL and OC_TENANT are deprecated .* Set OC_URL to your database's address from Connect\./);
    expect(messages[1]).toMatch(/OC_BEARER is deprecated .* Set OC_TOKEN to an access token from Access tokens\./);
    for (const message of messages) {
      expect(message).toMatch(/^@originchain\/sdk: /);
      for (const value of Object.values(OLD)) expect(message).not.toContain(value);
    }
  });

  it("prefers OC_URL and OC_TOKEN and says the old names are ignored", async () => {
    const { fetch, calls } = recorder();
    await OriginChainClient.fromEnv({
      env: { ...OLD, OC_URL: SHAPES["no tenant"], OC_TOKEN: TOKEN }, fetch,
    }).sql("SELECT 1");
    expect(calls[0]!.url).toBe(`${SHAPES["no tenant"]}/sql`);
    expect(new Headers(calls[0]!.init.headers).get("authorization")).toBe(`Bearer ${TOKEN}`);
    const messages = warn.mock.calls.map((args: unknown[]) => String(args[0]));
    expect(messages).toEqual([
      "@originchain/sdk: OC_URL is set, so OC_BASE_URL and OC_TENANT are ignored. OC_URL is the database's whole address; remove the old names.",
      "@originchain/sdk: OC_TOKEN is set, so OC_BEARER is ignored; remove it.",
    ]);
  });

  it("mixes one old name with one new name", async () => {
    const { fetch, calls } = recorder();
    await OriginChainClient.fromEnv({ env: { OC_URL: SHAPES["tenant path"], OC_BEARER: "legacy-bearer-value" }, fetch })
      .sql("SELECT 1");
    expect(calls[0]!.url).toBe(`${SHAPES["tenant path"]}/sql`);
    expect(new Headers(calls[0]!.init.headers).get("authorization")).toBe("Bearer legacy-bearer-value");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain("OC_BEARER is deprecated");
  });

  it("refuses plain http in the old address too", () => {
    expect(() => OriginChainClient.fromEnv({ env: { ...OLD, OC_BASE_URL: "http://legacy.example.invalid" } }))
      .toThrow(/^OC_BASE_URL must start with https:\/\//);
  });

  it("keeps an old database identity for one release rather than silently widening access", async () => {
    const { fetch, calls } = recorder();
    await OriginChainClient.fromEnv({
      env: { OC_URL: SHAPES["no tenant"], OC_TOKEN: TOKEN, OC_DB_USER: "alice", OC_DB_KEY: "legacy-db-key-value" }, fetch,
    }).sql("SELECT 1");
    const headers = new Headers(calls[0]!.init.headers);
    expect(headers.get("x-oc-db-user")).toBe("alice");
    expect(headers.get("x-oc-db-key")).toBe("legacy-db-key-value");
    expect(calls[0]!.init.redirect).toBe("error");
    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]![0]);
    expect(message).toContain("OC_DB_USER and OC_DB_KEY are deprecated");
    expect(message).toContain("An access token carries its own database identity: set it as OC_TOKEN.");
    expect(message).not.toContain("legacy-db-key-value");
  });

  it("refuses half of an old identity without echoing it", () => {
    let message = "";
    try {
      OriginChainClient.fromEnv({ env: { OC_URL: SHAPES["no tenant"], OC_TOKEN: TOKEN, OC_DB_KEY: "legacy-db-key-value" } });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("dbUser and dbKey");
    expect(message).not.toContain("legacy-db-key-value");
  });
});

describe("constructor options", () => {
  it.each([
    [{ url: SHAPES["no tenant"], baseUrl: "https://x.invalid", token: TOKEN }, "pass url or the deprecated baseUrl"],
    [{ url: SHAPES["no tenant"], tenantId: "t", token: TOKEN }, "tenantId cannot be combined with url"],
    [{ url: SHAPES["no tenant"], token: TOKEN, bearer: TOKEN }, "pass token or the deprecated bearer"],
    [{ token: TOKEN }, "url required (OC_URL"],
    [{ url: SHAPES["no tenant"] }, "token required (OC_TOKEN"],
    [{ url: "", token: TOKEN }, "url is required"],
  ])("refuses %j", (options, message) => {
    expect(() => new OriginChainClient(options)).toThrow(message);
  });

  it("keeps the deprecated baseUrl and bearer options working unchanged", async () => {
    const { fetch, calls } = recorder();
    const db = new OriginChainClient({ baseUrl: "https://legacy.example.invalid/", tenantId: "t1", bearer: "b", fetch });
    await db.sql("SELECT 1");
    expect(calls[0]!.url).toBe("https://legacy.example.invalid/v1/tenants/t1/sql");
    expect(db.url).toBe("https://legacy.example.invalid/v1/tenants/t1");
    expect(db.tenantId).toBe("t1");
    expect(warn).not.toHaveBeenCalled();
  });
});
