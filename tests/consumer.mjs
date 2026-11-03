import assert from 'node:assert/strict';
import { OriginChainClient, BatchError, ApiError, ProtocolError } from '../dist/index.mjs';

const client = OriginChainClient.fromEnv();
let result = await client.sql.run('contract:select', [7, "quote' / 雪", null]);
assert.equal(result.rows[0].id, '9007199254740993');
assert.equal(result.rows[0].amount, '1.00000000000000001');
assert.equal(result.raw.future_field.kept, true);
result = await client.sql.run('contract:update');
assert.equal(result.rows_affected, 2); assert.equal(result.rows_buffered, 3);
assert.equal(result.rows.length, 1); assert.deepEqual(result.columns, ['id']);
result = await client.sql.run('contract:unknown');
assert.equal(result.kind, 'future_statement'); assert.equal(result.rows_affected, undefined);
for (const name of ['batch', 'unavailable', 'unauthorized', 'redirect', 'malformed', 'invalid-rows']) {
  await assert.rejects(client.sql.run('contract:' + name), error => {
    assert.ok(error instanceof ApiError);
    if (name === 'batch') { assert.ok(error instanceof BatchError); assert.equal(error.result.results[0].rows_affected, 1); }
    if (name === 'unauthorized') { assert.equal(error.status, 401); assert.equal(error.requestId, '84f92822-5837-432e-981a-7b24ad65e16c'); }
    if (name === 'unavailable') assert.equal(error.status, 503);
    if (name === 'malformed' || name === 'invalid-rows') assert.ok(error instanceof ProtocolError);
    return true;
  });
}
await client.rows.get('demo/items', 'a b?/%');
await client.rows.put('demo.items', { id: 'one', nullable: null });
await client.rows.putBatch('demo.items', [{ id: 'one' }, { id: 'two' }]);
await client.schemas.list(); await client.schemas.register('[schema]\nname="demo.items"\n');
await client.vector.put('demo.items', 'one', [1, 0], { tag: 'test' });
assert.deepEqual((await client.vector.search('demo.items', [1, 0])).map(hit => hit.id), ['one', 'two']); await client.vector.delete('demo.items', 'one');
await client.fts.index('demo.items', 'body', 'one', 'hello world'); assert.equal((await client.fts.search('demo.items', 'body', 'hello')).hits[0].doc_id, 'one');
const phrase = await client.fts.search('demo.items', 'body', 'phrase', { mode: 'phrase' });
assert.equal(phrase.hits[0].doc_id, 'two'); assert.equal(phrase.hits[0].score, 0);
const enriched = await client.fts.search('demo.items', 'body', 'highlight', { highlight: true, facets: ['tag'] });
assert.ok(enriched.facets); assert.ok(enriched.hits[0].highlights);
await client.graph.query('MATCH (n) RETURN $name', { name: 'one' });
await client.graph.neighbors('demo.items', { pk: 'one', rel: 'related' });
await client.graph.bfs('demo.items', { pk: 'one', rel: 'related', max_depth: 5 });
console.log('TypeScript installed-build consumer assertions passed');
