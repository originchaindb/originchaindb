# OriginChainDB for TypeScript and JavaScript

The official TypeScript and JavaScript SDK for working with OriginChainDB through SQL, rows,
vector search, full-text search, and graph relationships. Use one database client
for these operations, with native TypeScript and JavaScript types and conventions.

[![CI](https://github.com/originchaindb/originchaindb/actions/workflows/ci.yml/badge.svg)](https://github.com/originchaindb/originchaindb/actions/workflows/ci.yml)

**Requirements:** Node.js 18+ at runtime; Node.js 24+ to build this checkout; modern browsers. **Package:** `@originchain/sdk`.

> This README describes the **1.0.0-rc.1 source candidate**. It has not been
> published to package registries. Follow the source installation below; an older
> registry package may expose a different API.

[Install](#installation) | [Connect](#connect-and-run-your-first-query) |
[Examples](#product-catalog-example) | [Results](#understanding-sql-results) |
[Errors](#handling-errors) | [Source](#source-layout)

## Installation

Build the package using Node.js 24+:

```sh
git clone https://github.com/originchaindb/originchaindb.git
cd originchaindb
npm ci
npm run build
npm pack --ignore-scripts
```

From your application directory, install the resulting tarball. Replace the path:

```sh
npm install /absolute/path/to/originchaindb/originchain-sdk-1.0.0-rc.1.tgz
```

The package includes TypeScript declarations and both ESM and CommonJS exports.
For CommonJS, use `const { Client } = require("@originchain/sdk")`.

Pin a reviewed source commit in your application or build process. See the
[changelog](CHANGELOG.md) before updating.

## Connect and run your first query

Copy the complete database address from **Connect** into `OC_URL`, and the
database access token into `OC_TOKEN`. The SDK sends the token as a bearer
credential. It uses the address as supplied; do not add or derive a tenant path.

macOS/Linux shell:

```sh
export OC_URL="<database HTTPS address from Connect>"
export OC_TOKEN="<database access token>"
```

PowerShell:

```powershell
$env:OC_URL = "<database HTTPS address from Connect>"
$env:OC_TOKEN = "<database access token>"
```

Replace the placeholders, keep credentials out of source control, and use a
secret manager for deployed applications. HTTPS is required except for local
loopback development. SQL tools use a separate database login from Connect.

Save this as `app.mjs` and run `node app.mjs`, or use it in your TypeScript application.

```typescript
import { Client } from "@originchain/sdk";

const db = Client.fromEnv();
const result = await db.sql.run("SELECT $1 AS value", [7]);
console.log(result.rows);
```

The query needs no tables. Its returned row contains `value` equal to `7`.
`$1` binds the first parameter; `$2` binds the second. Bind values instead of
interpolating application input into SQL. Parameters do not substitute table or
column names; those identifiers must come from trusted application code.

## Product catalog example

The complete [catalog program](examples/catalog.mjs) creates a small product catalog and
demonstrates the same sequence shown below. It uses the included
[products.toml](examples/products.toml) schema and writes two rows plus search
data under `sdk_examples.products`. **Run it against a development database.**
Your token needs permission to register schemas and read/write the relevant data.

Run from the SDK checkout root after installation and setting the two variables:

```sh
node examples/catalog.mjs
```

The sections below are excerpts from that complete program. Reuse the `db` client from the quickstart.
Required imports are `import { readFile } from "node:fs/promises"`; the complete file includes them.

### Register the schema

The schema declares string columns `id`, `name`, `description`, and `related_to`.
`id` is the primary key. The `related` relation connects a product to the product
named by `related_to`. Registration reads the TOML file; it does not require
you to construct a schema request manually.

```typescript
const schema = "sdk_examples.products";
const toml = await readFile(new URL("./products.toml", import.meta.url), "utf8");
await db.schemas.register(toml);
```

### Write and read rows

Create the referenced product first, then the product pointing to it. `put`
writes the supplied row; `get` retrieves it by primary key. The example prints
the row for `p1`, named `Widget`.

```typescript
await db.rows.put(schema, { id: "p2", name: "Gadget", description: "A red gadget" });
await db.rows.put(schema, {
  id: "p1", name: "Widget", description: "A small blue widget", related_to: "p2",
});
const product = await db.rows.get(schema, "p1");
console.log(product);
```

For multiple rows, the rows namespace also provides a batch-put operation.
Treat its response as a batch report, not as a promise of transaction atomicity.

### Query with SQL

Use `sql.run` (with the language's casing) for a complete statement result.
`execute` is an alias; `query` is intended for SELECT results.

```typescript
const result = await db.sql.run(
  "SELECT id, name FROM sdk_examples.products WHERE id = $1", ["p1"],
);
for (const row of result.rows) console.log(row.id, row.name);
```

Use the same parameter binding for INSERT, UPDATE, and DELETE. Read the
server-reported write count rather than assuming a successful request changed a row.

### Search by vector similarity

Store an embedding with its product ID, then request up to five nearest hits.
The default metric is cosine. These four numbers are a small illustrative vector;
generate real embeddings with your chosen model, and use that same model and
dimension for stored vectors and queries. The SDK does not generate embeddings.

```typescript
const embedding = [0.1, 0.2, 0.3, 0.4];
await db.vector.put(schema, "p1", embedding, { category: "tools" });
const hits = await db.vector.search(schema, embedding, { k: 5 });
for (const hit of hits) console.log(hit.id, hit.score);
```

Each hit exposes an ID, score, optional metadata, and the original hit. Do not
assume the score is a probability; its interpretation depends on the metric.

### Search text

Index the description explicitly, then use ranked BM25 search. Search defaults
to ten hits; the example asks for five. Boolean and phrase modes, highlighting,
fuzzy matching, and facets are available through the language's search options.

```typescript
await db.fts.index(schema, "description", "p1", "A small blue widget");
const matches = await db.fts.search(schema, "description", "blue widget", { k: 5 });
for (const hit of matches.hits) console.log(hit.doc_id, hit.score);
```

The result contains `hits`, optional `facets`, and the original response.
Hits have a document ID and score; unranked modes use zero for the score.
Writing a row does not imply this example's separate full-text or vector index
entry has been updated: update the relevant index when your application changes data.

### Follow graph relationships

The schema's `related` relation and the `p1.related_to = p2` row value create the
connection used here. The result includes the neighbor `p2`.

```typescript
const neighbors = await db.graph.neighbors(schema, { pk: "p1", rel: "related" });
console.log(neighbors);
```

The graph namespace also supports breadth-first traversal and Cypher queries.
Cypher parameters bind **by name**; SQL parameters bind **by position**.
See the [API guide](docs/api.md) and source links below for exact signatures.

## Bulk writes and paginated reads

For larger datasets, `writeBatches` sends bounded batches and yields an acknowledgment
for each input range. `scan` reads rows lazily in ordered pages; `pages` also
exposes a continuation value for resumable processing. These operations use the
same limits and failure rules across all SDKs.

```javascript
for await (const batch of db.rows.writeBatches(schema, rows, { batchSize: 2 })) {
  console.log(batch.offset, batch.count, batch.inserted);
}
```

This excerpt uses `db`, `schema` and the lazy `rows` producer from the
[complete example](examples/bulk-and-scan.mjs). See the [bulk and pagination guide](docs/bulk-and-pagination.md)
for setup, reads, checkpoints, cancellation and recovery. Failed writes are never
replayed automatically; paginated reads require a unique immutable string key.

## Understanding SQL results

Rows are JavaScript objects; unsafe JSON numeric literals are preserved as strings. SQL returns a result object rather than only an array:

| Member | Meaning |
| --- | --- |
| `kind` | Statement kind, such as select, insert, update or delete |
| `rows` | Returned rows, including RETURNING rows when the server supplies them |
| `columns` | Column names, when supplied |
| `column_types` | Column type metadata, when supplied |
| `rows_affected` | Server-reported write count; missing means unknown |
| `rows_buffered` | Buffered count, when supplied; it is not proof of a committed write |
| `results` | Individual results for a multi-statement response |
| `raw` | Original response, including additional server fields |

Write counts use safe `number | undefined`; `undefined` means the server did not report
a count. Empty rows are not evidence of a failed statement: a write may return
only counts. Conversely, a malformed response is an error, not an empty success.

Numeric and temporal **strings** remain strings. Convert them deliberately in
your application when you know the column type. Unsupported write-count ranges
raise a protocol error instead of silently rounding.

Multi-statement batches can partially succeed. A failed batch exposes the
available statement results through its error. Do not assume batches are atomic
or replay an entire batch without checking which statements completed.

## Timeouts and client lifetime

The default timeout is 60 seconds. The option uses milliseconds; individual
calls can also receive an `AbortSignal`:

```typescript
const db = Client.fromEnv({ timeoutMs: 10_000 });
const controller = new AbortController();
const result = await db.sql.run("SELECT $1 AS value", [7], { signal: controller.signal });
// Call controller.abort() from your cancellation handler while a request is pending.
```

Reuse one client; it uses the runtime's Fetch implementation and has no `close()`
method. In a browser, pass `new Client({ url, token })` instead of relying on a
server environment. The database must allow the application's origin through
CORS. Browser tokens are visible to that user; use only credentials scoped for
that browser session. Never bundle an administrator token.

Requests are **not retried automatically by the SDK by default**, and redirects
are not followed. A timeout or disconnect can happen after a write committed.
Canceling the local wait does not prove rollback. Only retry an operation when
your application can safely reconcile or repeat it.

## Handling errors

```typescript
import { ApiError, BatchError } from "@originchain/sdk";

try {
  const result = await db.sql.run("SELECT $1 AS value", [7]);
  console.log(result.rows);
} catch (error) {
  if (error instanceof BatchError) {
    console.error("Partial batch:", error.result.results.length);
  } else if (error instanceof ApiError) {
    console.error("HTTP status:", error.status, "request ID:", error.requestId);
  } else {
    throw error;
  }
}
```

`ProtocolError` is an `ApiError` for malformed responses. Cancellation and local
configuration failures should be handled separately from HTTP errors.

| Symptom | What to check |
| --- | --- |
| 401 or 403 | Token validity, expiry, database access and operation grants |
| 404 | Complete database address, schema name and resource ID |
| 400 or 422 | SQL syntax, parameter order, schema fields and vector dimensions |
| 429 | Capacity/rate limits and any server-provided retry timing |
| Timeout or 5xx after a write | Check the outcome before retrying |
| Empty search results | Indexed data, query terms, dimensions, filters and feature availability |

Include the SDK version and request ID in a support report. Redact credentials
and application data. Available database features and token permissions still
determine which operations can run.

## Application integration

The [API v1 reference](docs/api/v1/README.md) covers typed row conversion,
rotating credentials, local request diagnostics, native HTTP configuration,
and cancellation. The [complete integration example](examples/integration.mjs) shows
these features together using a read-only query. See the
[migration guide](docs/migration-v1.md) when upgrading an earlier application.

## Source layout

| Path | Purpose |
| --- | --- |
| [src/client.ts](src/client.ts) | Connection and HTTP transport |
| [src/resources.ts](src/resources.ts) | Schema, row, vector and full-text services |
| [src/sql.ts](src/sql.ts) | SQL result decoding and batch errors |
| [src/types.ts](src/types.ts) | Request options and public operation types |
| [src/index.ts](src/index.ts) | Public exports |
| [examples/](examples/) | Quickstart, product catalog and schema |
| [tests/contract/run.py](tests/contract/run.py) | Shared offline HTTP conformance fixture |
| [docs/api.md](docs/api.md), [docs/contract.md](docs/contract.md) | Native API notes and shared behavior |

All eight SDKs share the same core concepts and HTTP contract. Method casing,
JSON types and concurrency follow each language. Historical Python/TypeScript
helpers are broader than this common core; do not assume every advanced helper
exists in every SDK.

## Development and support

From the checkout root:

```sh
npm ci
npm run lint
npm test
npm run build
python tests/contract/run.py -- node tests/consumer.mjs
npm pack --ignore-scripts
```

The contract runner requires Python 3.10+ for testing only and uses a local
fixture; it does not require database credentials. Application runtime
requirements are listed at the top. Live examples use your selected database.

Read [Contributing](CONTRIBUTING.md) before sending a change. Report bugs through
[GitHub issues](https://github.com/originchaindb/originchaindb/issues); report security concerns
privately as described in [Security](SECURITY.md). See [LICENSE](LICENSE) for MIT terms.

See [quality and build verification](docs/quality.md) for benchmarks, API compatibility checks, package installation checks and signed build provenance.
