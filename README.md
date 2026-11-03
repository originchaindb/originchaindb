# OriginChainDB for TypeScript / JavaScript

The official TypeScript / JavaScript client for SQL, vector search, full-text search, and graph queries.

[![CI](https://github.com/originchaindb/originchaindb/actions/workflows/ci.yml/badge.svg)](https://github.com/originchaindb/originchaindb/actions/workflows/ci.yml)

## Get started

Requires **Node.js 18+; modern browsers**. This is the unpublished 1.0 release candidate. Build from
source and pin a reviewed commit; registry publication is currently on hold.

```sh
git clone https://github.com/originchaindb/originchaindb.git
cd originchaindb
npm ci
npm run build
npm pack --ignore-scripts
# Install the resulting .tgz in your application.
```

Copy your database address and access token from Connect into `OC_URL` and
`OC_TOKEN`. Keep tokens in your server's environment or secret manager.

```typescript
import { Client } from "@originchain/sdk";

const db = Client.fromEnv();
const result = await db.sql.run("SELECT $1 AS value", [7]);
console.log(result.rows);
```

Reuse the client for your application's lifetime. Pass values as parameters;
do not interpolate application data into query text.

## One API family

Use `sql`, `schemas`, `rows`, `vector`, `fts`, and `graph` for the same database
concepts across every OriginChainDB SDK. Names use this language's normal casing.

- SQL results include returned rows, confirmed counts, metadata and batch results.
- Full-text search provides the same hit structure for ranked and unranked queries.
- Access tokens are sent as bearer credentials to the exact database address.
- Failed writes are not retried automatically.

[Using the client](docs/api.md) Â· [Behavior](docs/contract.md) Ã‚Â· [Contributing](CONTRIBUTING.md) Ã‚Â·
[Changes](CHANGELOG.md) Ã‚Â· [Security](SECURITY.md)

## Development

```sh
npm ci
npm run lint
npm test
npm run build
python tests/contract/run.py -- node tests/consumer.mjs
npm pack --ignore-scripts
```

The HTTP contract runner requires Python 3.10+ for testing only. No database
credentials are needed for the offline suite. Native runtime and dependency
requirements above apply to applications.
