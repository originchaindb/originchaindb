import assert from 'node:assert/strict';
import { Client, BatchWriteError, ProtocolError } from '../dist/index.mjs';

const db = Client.fromEnv();
function* source(consumed) {
  const row = {};
  for (const key of 'abcde') { consumed.push(key); row.id = key; yield row; }
}
async function collect(iterator) { const result = []; for await (const row of iterator) result.push(row); return result; }
let consumed = [];
const batches = db.rows.writeBatches('bulk.ok', source(consumed), { batchSize: 2 });
assert.equal(consumed.length, 0);
assert.deepEqual((await batches.next()).value, { offset: 0, count: 2, inserted: 2 });
assert.equal(consumed.length, 2);
assert.deepEqual(await collect(batches), [{ offset: 2, count: 2, inserted: 2 }, { offset: 4, count: 1, inserted: 1 }]);
for (const [name, offset, count] of [['fail', 2, 4], ['lost', 0, 2], ['unknown', 0, 2]]) {
  consumed = [];
  await assert.rejects(collect(db.rows.writeBatches(`bulk.${name}`, source(consumed), { batchSize: 2 })), error => {
    assert.ok(error instanceof BatchWriteError);
    assert.equal(error.offset, offset); assert.equal(error.count, 2); assert.equal(error.outcome, 'unknown');
    assert.ok(error.cause); return true;
  });
  assert.equal(consumed.length, count);
}
assert.deepEqual((await collect(db.rows.writeBatches('bulk.bytes', [...'abc'].map(id => ({ id, value: 'x'.repeat(20) })), { maxBytes: 64 }))).map(x => x.count), [1, 1, 1]);
consumed = [];
for await (const _ of db.rows.writeBatches('bulk.stop', source(consumed), { batchSize: 2 })) break;
assert.equal(consumed.length, 2);
assert.deepEqual(await collect(db.rows.writeBatches('bulk.never', [])), []);
await assert.rejects(collect(db.rows.writeBatches('bulk.never', [{ id: 'too-large' }], { maxBytes: 4 })), e => e instanceof BatchWriteError && e.offset === 0 && e.outcome === 'not_sent');
await assert.rejects(collect(db.rows.writeBatches('bulk.never', [], { batchSize: 0 })), RangeError);
const controller = new AbortController(); controller.abort();
await assert.rejects(collect(db.rows.writeBatches('bulk.never', source([]), { signal: controller.signal })), e => e.name === 'AbortError');

assert.deepEqual((await collect(db.rows.scan('scan.items', 'id', { pageSize: 2 }))).map(r => r.id), [...'abcde']);
for await (const row of db.rows.scan('scan.stop', 'id', { pageSize: 2 })) { assert.equal(row.id, 'a'); break; }
const pages = await collect(db.rows.pages('scan.resume', 'id', { pageSize: 2, after: 'b' }));
assert.deepEqual(pages.map(p => p.nextCursor), ['d', null]);
assert.deepEqual(pages.flatMap(p => p.rows.map(r => r.id)), [...'cde']);
for (const name of ['bad', 'numeric', 'oversize']) await assert.rejects(collect(db.rows.pages(`scan.${name}`, 'id', { pageSize: 2 })), ProtocolError);
assert.deepEqual(await collect(db.rows.scan('scan.empty', 'id', { pageSize: 2 })), []);
await assert.rejects(collect(db.rows.scan('scan.items;DELETE', 'id')), TypeError);
console.log('TypeScript iteration assertions passed');
