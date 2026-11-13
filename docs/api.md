# Using the client

Create `db` as shown in the [quickstart](../README.md). These independent examples
assume an existing `demo.items` schema and an appropriate search index.

```typescript
const result = await db.sql.run("SELECT $1 AS value", [7]);
const row = await db.rows.get("demo.items", "one");
const vectors = await db.vector.search("demo.items", [1, 0]);
const indexed = await db.vectorIndexes.search("products", "catalog", { k: 5, vector: [1, 0] });
const text = await db.fts.search("demo.items", "body", "hello");
const graph = await db.graph.query("MATCH (n) RETURN $name", { name: "one" });
```

## Results, errors, and lifetime

`SqlResult.rows` contains objects. `rows_affected` is a safe integer or
`undefined`; `raw` preserves the envelope. Unsafe JSON numeric literals become
strings. Vector hits expose `id`, `score`, `metadata`, and `raw`. Full-text results
expose `hits`, `facets`, and `raw`.

Catch `ApiError`; inspect `status` and `requestId`. `BatchError.result` contains
the partial SQL result. `ProtocolError` identifies malformed responses.

Use `Client.fromEnv({ timeoutMs: 10000 })` to change the deadline. All database
operations return promises. In browsers, supply the URL and token explicitly;
use a narrowly scoped token because browser users can inspect it.

See the [shared behavior contract](contract.md) for parameter binding, batch
semantics, defaults, and retry behavior. The [contract consumer](../tests/consumer.mjs)
exercises the full common API against a local fixture.
