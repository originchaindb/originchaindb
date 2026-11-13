import assert from 'node:assert/strict';
import { ApiError, BatchWriteError, OCRecordApiNotEnabledError, OriginChainClient } from '../dist/index.mjs';

const REQUEST_ID = '84f92822-5837-432e-981a-7b24ad65e16c';
const collect = async (iterator) => { const out = []; for await (const item of iterator) out.push(item); return out; };

const vi = OriginChainClient.fromEnv().vectorIndexes;
assert.equal((await vi.createIndex('demo', { dimension: 2, metric: 'cosine' })).future_field.kept, true);
assert.equal((await vi.describeIndex('demo/one')).name, 'demo');
assert.deepEqual((await collect(vi.iterIndexes({ limit: 1 }))).map(index => index.name), ['demo', 'zeta']);

const out = await vi.upsert('demo', 'ns', [
  { id: 'one', values: [1.0, 0.0], metadata: { tag: 'test', n: 1 } },
  { id: 'two', sparse_values: { indices: [3], values: [0.5] } },
]);
assert.equal(out.upserted_count, 2); assert.equal(out.namespace_created, true); assert.equal(out.batches, 1);
await assert.rejects(vi.upsert('demo-partial', 'ns', Array.from({ length: 5 }, (_, i) => ({ id: `p${i}` })), { batchSize: 2 }), error => {
  // p0-p1 acknowledged; p2-p3 failed; p4 never sent.
  assert.ok(error instanceof BatchWriteError);
  assert.deepEqual([error.offset, error.count, error.outcome], [2, 2, 'unknown']);
  assert.ok(error.cause instanceof ApiError);
  assert.equal(error.cause.code, 'configuration_limit_exceeded');
  assert.equal(error.cause.reason, 'exact_index_capacity');
  return true;
});

const res = await vi.search('demo', 'ns', { k: 2, vector: [1.0, 0.0], quality: 'exact',
  filter_expr: { tag: { $eq: 'test' } }, include_metadata: true });
assert.deepEqual(res.hits.map(hit => hit.id), ['one', 'two']);
assert.deepEqual(res.hits[0].metadata, { tag: 'test', n: 1 }); assert.equal(res.future_field, true);
const hybrid = await vi.search('demo', 'ns', { k: 2, vector: [1.0, 0.0], lexical: { field: 'body', query: 'hello' } });
assert.equal(hybrid.mode, 'hybrid');
const got = await vi.fetch('demo', 'ns', ['one', 'missing'], { include_values: true });
assert.deepEqual(got.records.one.values, [1, 0]); assert.deepEqual(got.missing, ['missing']);
assert.equal((await vi.delete('demo', 'ns', ['one'])).deleted, 1);
const job = await vi.deleteByFilter('demo', 'ns', { filter_expr: { tag: { $in: ['a', 'b'] } } });
assert.equal((await vi.getJob('demo', job.job_id)).state, 'succeeded');
assert.equal((await vi.listNamespaces('demo')).namespaces[0].name, 'ns');
assert.equal((await vi.indexStats('demo')).total_record_count, 1);
assert.equal((await vi.count('demo', 'ns', { filter: { tag: 'test' } })).count, 1);

const failures = [
  [() => vi.describeIndex('contract-unauthorized'), ApiError, 401, 'unauthorized'],
  [() => vi.describeIndex('contract-key-scope'), ApiError, 403, 'key_scope_insufficient'],
  [() => vi.describeIndex('contract-missing'), ApiError, 404, 'index_not_found'],
  [() => vi.search('demo', 'ns', { k: 1, sparse: { indices: [3], values: [0.5] } }), ApiError, 409, 'index_capability_missing'],
  [() => vi.describeIndex('contract-not-enabled'), OCRecordApiNotEnabledError, 501, 'not_implemented'],
  [() => vi.search('demo', 'ns', { k: 3, vector: [1.0, 0.0] }), ApiError, 503, 'index_rebuilding'],
  [() => vi.describeIndex('contract-redirect'), ApiError, 307, 'http_error'],
];
for (const [call, kind, status, code] of failures) {
  await assert.rejects(call(), error => {
    assert.ok(error instanceof kind, `${error?.name} is not ${kind.name}`);
    assert.equal(error.status, status); assert.equal(error.code, code);
    assert.equal(error.requestId, REQUEST_ID);
    if (code !== 'http_error') assert.equal(error.message, 'server detail');
    return true;
  });
}
console.log('TypeScript vector index consumer assertions passed');
