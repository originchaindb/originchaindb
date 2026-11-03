import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { resolve } from 'node:path';

const entry = resolve(process.argv[2] || 'examples/query.mjs');
const requests = [];
const server = createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk;
  requests.push({ method: req.method, url: req.url, headers: req.headers, body: raw ? JSON.parse(raw) : null });
  res.setHeader('content-type', 'application/json');
  if (req.headers.authorization === 'Bearer rejected-fixture-token') {
    res.writeHead(401).end(JSON.stringify({ error: { code: 'unauthorized', message: 'fixture-private-row-marker' } }));
    return;
  }
  const path = req.url.split('?')[0];
  const value = path.endsWith('/sql') ? { kind: 'select', rows: [{ message: 'Hello from OriginChainDB' }] }
    : path.includes('/vector/') ? [{ id: 'item-1', score: 0.9 }]
    : path.includes('/fts/') ? [{ doc_id: 'item-1', score: 1.5 }] : ['neighbor-1'];
  res.end(JSON.stringify(value));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
// OC_URL is opaque: the fixture serves today's tenant-path shape and the
// tenant-less shape, and the example must work unchanged with both.
const origin = `http://127.0.0.1:${server.address().port}`;
const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('OC_'))),
  OC_URL: `${origin}/v1/tenants/fixture`, OC_TOKEN: 'fixture-token',
  OC_TABLE: 'sample.items', OC_FTS_FIELD: 'body',
  OC_QUERY: 'tea & mug', OC_QUERY_VECTOR: '[1,0]', OC_RELATION: 'related', OC_NODE_ID: 'item/1',
};
function run(operation, changes = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry, operation], { env: { ...env, ...changes } });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('example timeout')); }, 15000);
    child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
    child.on('error', reject); child.on('exit', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}
try {
  const expected = [
    ['sql', 'POST', '/v1/tenants/fixture/sql', { sql: 'SELECT $1 AS message', params: ['Hello from OriginChainDB'] }, { kind: 'select', rows: [{ message: 'Hello from OriginChainDB' }] }],
    ['fts', 'GET', '/v1/tenants/fixture/fts/sample.items/body?q=tea+%26+mug&mode=bm25&k=5', null, [{ doc_id: 'item-1', score: 1.5 }]],
    ['vector', 'POST', '/v1/tenants/fixture/vector/sample.items/topk', { query: [1, 0], dim: 2, k: 5, metric: 'cosine' }, [{ id: 'item-1', score: 0.9 }]],
    ['graph', 'GET', '/v1/tenants/fixture/graph/sample.items/neighbors?rel=related&pk=item%2F1', null, ['neighbor-1']],
  ];
  for (const [operation, method, url, body, output] of expected) {
    const result = await run(operation); assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), output);
    const request = requests.at(-1);
    assert.equal(requests.length, expected.findIndex(x => x[0] === operation) + 1);
    assert.equal(request.method, method); assert.equal(request.url, url); assert.deepEqual(request.body, body);
    assert.equal(request.headers.authorization, 'Bearer fixture-token');
    assert.equal(request.headers['x-oc-db-user'], undefined); assert.equal(request.headers['x-oc-db-key'], undefined);
    assert.doesNotMatch(result.stderr, /@originchain\/sdk:/, 'OC_URL and OC_TOKEN must not warn');
  }
  const tenantless = await run('sql', { OC_URL: `${origin}/v1` }); assert.equal(tenantless.code, 0, tenantless.stderr);
  assert.equal(requests.at(-1).url, '/v1/sql'); assert.deepEqual(requests.at(-1).body, expected[0][3]);
  const slash = await run('sql', { OC_URL: `${origin}/v1/` }); assert.equal(slash.code, 0, slash.stderr);
  assert.equal(requests.at(-1).url, '/v1/sql');
  assert.equal(requests.length, 6);
  assert.equal((await run('--help')).code, 0);
  assert.notEqual((await run('vector', { OC_QUERY_VECTOR: '["bad"]' })).code, 0);
  assert.notEqual((await run('sql', { OC_TOKEN: '' })).code, 0);
  assert.notEqual((await run('sql', { OC_URL: 'http://db.example.invalid/v1' })).code, 0);
  assert.equal(requests.length, 6, 'help and invalid inputs must not contact HTTP');
  const denied = await run('sql', { OC_TOKEN: 'rejected-fixture-token' });
  assert.notEqual(denied.code, 0);
  assert.match(denied.stderr, /HTTP 401/);
  assert.doesNotMatch(denied.stdout + denied.stderr, /fixture-private-row-marker|rejected-fixture-token/);
  assert.equal(requests.length, 7, 'failed request must not retry');
  console.log('Four executable SDK examples, two address shapes, four input controls and redacted API failure passed.');
} finally {
  server.closeAllConnections(); await new Promise(r => server.close(r));
}
