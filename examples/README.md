# Run a query

From the repository root, install/build the local SDK:

```sh
npm ci
npm run build
node examples/query.mjs --help
```

Set two variables: `OC_URL`, your database's address from Connect, and `OC_TOKEN`, an access token from Access tokens. The examples call `OriginChainClient.fromEnv()`, which uses `OC_URL` exactly as given and sends `OC_TOKEN` as `Authorization: Bearer`. Use your shell's environment-variable syntax or a secret manager; no credentials belong in these files. Examples use a 30-second timeout and no automatic retries.

| Command | Additional environment | Existing data required |
| --- | --- | --- |
| `node examples/query.mjs sql` | None | None; binds a string to `SELECT $1 AS message`. |
| `node examples/query.mjs fts` | `OC_TABLE`, `OC_FTS_FIELD`, `OC_QUERY` | An indexed full-text field containing documents. |
| `node examples/query.mjs vector` | `OC_TABLE`, `OC_QUERY_VECTOR` | Vectors indexed with cosine distance. Query dimension/model must match. |
| `node examples/query.mjs graph` | `OC_TABLE`, `OC_RELATION`, `OC_NODE_ID` | A registered relation and source node. |

With an access token, `sql` uses a path that is supported today. The `fts`, `vector` and `graph` commands are not yet covered for access tokens.

For example, a two-dimensional toy index can use `OC_QUERY_VECTOR=[1,0]`. It is an illustration of the wire input, not an embedding model. Use real model output for real data. Table names may be `namespace.table`; identifiers are validated before use. The commands only read; they do not create schemas, insert fixtures, or delete user data. Empty search output can simply mean no matches.

Configure data using the [schema](https://originchaindb.com/docs/schemas), [full-text](https://originchaindb.com/docs/fts), [vector](https://originchaindb.com/docs/vector) and [graph](https://originchaindb.com/docs/graph/quickstart) guides. Engine features and permissions still apply.

CI runs these same scripts against a loopback HTTP fixture to check request and response behavior. That check does not certify a live database or new server features. See [Contributing](../CONTRIBUTING.md) for the exact check command.
