import { OriginChainClient } from '@originchain/sdk';

const operation = process.argv[2];
if (!operation || operation === '--help') {
  console.log('Usage: node examples/query.mjs <sql|fts|vector|graph>');
  console.log("Connection: OC_URL (your database's address, from Connect) and OC_TOKEN (an access token from Access tokens).");
  console.log('Search inputs and setup: examples/README.md');
  process.exit(0);
}
function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name}`);
  return value;
}
function identifier(name) {
  const value = required(name);
  if (!/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/.test(value)) {
    throw new Error(`${name} must be an identifier, optionally namespace-qualified`);
  }
  return value;
}
async function main() {
  if (!['sql', 'fts', 'vector', 'graph'].includes(operation)) throw new Error('Unknown operation');
  // Reads OC_URL and OC_TOKEN. OC_URL is used exactly as given.
  const db = OriginChainClient.fromEnv({ timeoutMs: 30_000, maxRetries: 0 });
  let result;
  if (operation === 'sql') {
    result = await db.sql('SELECT $1 AS message', ['Hello from OriginChainDB']);
  } else if (operation === 'fts') {
    result = await db.ftsSearch(identifier('OC_TABLE'), identifier('OC_FTS_FIELD'), {
      q: required('OC_QUERY'), mode: 'bm25', k: 5,
    });
  } else if (operation === 'vector') {
    const query = JSON.parse(required('OC_QUERY_VECTOR'));
    if (!Array.isArray(query) || !query.length || !query.every(x => typeof x === 'number' && Number.isFinite(x))) {
      throw new Error('OC_QUERY_VECTOR must be a nonempty JSON array of finite numbers');
    }
    result = await db.vectorTopk(identifier('OC_TABLE'), { query, dim: query.length, k: 5, metric: 'cosine' });
  } else {
    result = await db.graph.neighbors(identifier('OC_TABLE'), { rel: identifier('OC_RELATION'), pk: required('OC_NODE_ID') });
  }
  console.log(JSON.stringify(result, null, 2));
}
try {
  await main();
} catch (error) {
  const status = Number.isInteger(error?.status) ? ` (HTTP ${error.status})` : '';
  console.error(`Query failed${status}. Check connection, permissions and example inputs.`);
  process.exitCode = 1;
}
