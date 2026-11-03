// How an application reaches one database: HTTPS to OC_URL with OC_TOKEN.
//
// OC_URL is the database's address, copied from Connect. It is opaque: the SDK
// uses it exactly as given and appends a door path (`/sql`, `/schemas`, ...).
// It never builds the address, edits it, or reads a tenant out of it, so the
// address can change shape without any client changing.
//
// OC_TOKEN is an access token from Access tokens (or, on a database where
// access tokens are not supported yet, that database's key). It is sent
// unchanged as `Authorization: Bearer <OC_TOKEN>`; its prefix is never checked.

/** The two names an application sets. */
export const URL_ENV = "OC_URL";
export const TOKEN_ENV = "OC_TOKEN";

/** The approved answer sentence, verbatim. */
const ANSWER =
  "Connect over HTTPS with two values: OC_URL (your database's address, from Connect) " +
  "and OC_TOKEN (an access token from Access tokens). Send Authorization: Bearer $OC_TOKEN to $OC_URL/sql.";

// Names earlier examples used. They are read for one release only, each with a
// one-time warning that names the replacement. Never document them.
const OLD_BASE = "OC_BASE_URL";
const OLD_TENANT = "OC_TENANT";
const OLD_TOKEN = "OC_BEARER";
const OLD_DB_USER = "OC_DB_USER";
const OLD_DB_KEY = "OC_DB_KEY";

export type EnvMap = Record<string, string | undefined>;

/** What `fromEnv` resolved. `url` and `baseUrl` are mutually exclusive. */
export type EnvConnection = {
  url?: string;
  baseUrl?: string;
  tenantId?: string;
  token: string;
  dbUser?: string;
  dbKey?: string;
};

/** `process.env` when the runtime has one (Node, Bun, Deno's Node mode), else
 * `undefined`. Read lazily so importing the SDK in a browser or a worker never
 * touches `process`. */
export function processEnv(): EnvMap | undefined {
  try {
    const p = (globalThis as { process?: { env?: unknown } }).process;
    const env = p?.env;
    return env && typeof env === "object" ? (env as EnvMap) : undefined;
  } catch {
    return undefined;
  }
}

const warned = new Set<string>();

/** Warn once per process for each `key`. Writes to stderr in Node
 * (`console.warn`), never to stdout, and never includes a value. */
function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  const c = (globalThis as { console?: { warn?: (...args: unknown[]) => void } }).console;
  c?.warn?.(`@originchain/sdk: ${message}`);
}

/** @internal Test hook: forget which one-time warnings were already shown. */
export function _resetEnvWarnings(): void {
  warned.clear();
}

function isLoopback(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === "localhost" || h === "[::1]" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/** Check a database address and return it with any trailing slash removed, so
 * a door path can be appended. Nothing else about it is changed or read.
 *
 * Refuses: anything that is not an absolute URL; any scheme but https, except
 * http on loopback (`localhost`, `127.0.0.0/8`, `[::1]`); a user name or
 * password; a query or fragment; whitespace (including non-ASCII spaces), control
 * characters, or invisible characters such as a zero-width space or a byte-order
 * mark. The value is never echoed, because a malformed address can carry a secret. */
export function checkAddress(raw: unknown, label: string): string {
  if (typeof raw !== "string" || raw === "") {
    throw new Error(`${label} is required. ${ANSWER}`);
  }
  // `\s` covers ASCII and Unicode spaces (U+00A0, U+2000-U+200A, U+3000, U+FEFF
  // and others); the rest are control characters and the zero-width characters
  // that `\s` leaves out.
  if (/[\s\u0000-\u001f\u007f-\u009f\u200b-\u200d\u2060\ufeff]/u.test(raw)) {
    throw new Error(
      `${label} contains whitespace, an invisible character or a control character. ` +
        "Copy it again from Connect, with no spaces or line breaks.",
    );
  }
  if (/[?#]/.test(raw)) {
    throw new Error(`${label} must not contain a query (?) or fragment (#). Use it exactly as shown in Connect.`);
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${label} is not an absolute https:// address. Copy it from Connect.`);
  }
  if (parsed.username || parsed.password || /^[A-Za-z][A-Za-z0-9+.-]*:\/*[^/]*@/.test(raw)) {
    throw new Error(`${label} must not contain a user name or password. Send the token as ${TOKEN_ENV} instead.`);
  }
  const https = parsed.protocol === "https:";
  const loopbackHttp = parsed.protocol === "http:" && isLoopback(parsed.hostname);
  if (!https && !loopbackHttp) {
    throw new Error(
      `${label} must start with https://. Plain http is allowed only for localhost, 127.0.0.1 and [::1].`,
    );
  }
  return raw.replace(/\/+$/, "");
}

/** Check a token is one header-safe line, without echoing it. The token is
 * otherwise sent unchanged; its prefix is never inspected. */
export function checkToken(raw: unknown, label: string): string {
  if (typeof raw !== "string" || raw === "") {
    throw new Error(`${label} is required. ${ANSWER}`);
  }
  if (!/^[\x21-\x7e]+$/.test(raw)) {
    throw new Error(
      `${label} must be one line of printable ASCII with no spaces. Check for a trailing newline or space.`,
    );
  }
  return raw;
}

function nonEmpty(env: EnvMap, name: string): string | undefined {
  const value = env[name];
  return typeof value === "string" && value !== "" ? value : undefined;
}

function list(names: string[]): string {
  return names.length === 1 ? names[0]! : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** Resolve the connection from environment variables: OC_URL and OC_TOKEN.
 * The old names are read for one release only, each with a one-time warning. */
export function connectionFromEnv(env: EnvMap): EnvConnection {
  const url = nonEmpty(env, URL_ENV);
  const token = nonEmpty(env, TOKEN_ENV);
  const oldBase = nonEmpty(env, OLD_BASE);
  const oldTenant = nonEmpty(env, OLD_TENANT);
  const oldToken = nonEmpty(env, OLD_TOKEN);

  const missing: string[] = [];
  if (!url && !oldBase) missing.push(URL_ENV);
  if (!token && !oldToken) missing.push(TOKEN_ENV);
  if (missing.length) {
    throw new Error(`OriginChainClient.fromEnv: set ${list(missing)}. ${ANSWER}`);
  }

  const out: EnvConnection = { token: "" };
  if (url) {
    out.url = checkAddress(url, URL_ENV);
    const ignored = [oldBase && OLD_BASE, oldTenant && OLD_TENANT].filter((n): n is string => !!n);
    if (ignored.length) {
      warnOnce(
        "address-ignored",
        `${URL_ENV} is set, so ${list(ignored)} ${ignored.length === 1 ? "is" : "are"} ignored. ` +
          `${URL_ENV} is the database's whole address; remove the old ${ignored.length === 1 ? "name" : "names"}.`,
      );
    }
  } else {
    out.baseUrl = checkAddress(oldBase, OLD_BASE);
    if (oldTenant) out.tenantId = oldTenant;
    const used = [OLD_BASE, oldTenant && OLD_TENANT].filter((n): n is string => !!n);
    warnOnce(
      "address-old",
      `${list(used)} ${used.length === 1 ? "is" : "are"} deprecated and will not be read after this release. ` +
        `Set ${URL_ENV} to your database's address from Connect.`,
    );
  }

  if (token) {
    out.token = checkToken(token, TOKEN_ENV);
    if (oldToken) {
      warnOnce("token-ignored", `${TOKEN_ENV} is set, so ${OLD_TOKEN} is ignored; remove it.`);
    }
  } else {
    out.token = checkToken(oldToken, OLD_TOKEN);
    warnOnce(
      "token-old",
      `${OLD_TOKEN} is deprecated and will not be read after this release. ` +
        `Set ${TOKEN_ENV} to an access token from Access tokens.`,
    );
  }

  // Honoured for one release so that a narrower identity configured the old way
  // is never silently widened; the constructor still requires both or neither.
  const dbUser = nonEmpty(env, OLD_DB_USER);
  const dbKey = nonEmpty(env, OLD_DB_KEY);
  if (dbUser !== undefined || dbKey !== undefined) {
    const used = [dbUser !== undefined && OLD_DB_USER, dbKey !== undefined && OLD_DB_KEY]
      .filter((n): n is string => !!n);
    warnOnce(
      "identity-old",
      `${list(used)} ${used.length === 1 ? "is" : "are"} deprecated and will not be read after this release. ` +
        `An access token carries its own database identity: set it as ${TOKEN_ENV}.`,
    );
    out.dbUser = dbUser;
    out.dbKey = dbKey;
  }
  return out;
}
