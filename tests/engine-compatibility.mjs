// Private integration worker. Commands arrive over stdin; credentials are never logged.
import assert from 'node:assert/strict';
import { createInterface } from 'node:readline';
import { Client, ApiError } from '../dist/index.mjs';
let current = 'unset', calls = 0;
const db = new Client({url: process.env.OC_URL, tokenProvider: () => { calls++; return current; }});
for await (const line of createInterface({input: process.stdin, crlfDelay: Infinity})) {
  const command = JSON.parse(line); current = command.token;
  const before = calls; let status = 200;
  try {
    if (command.action === 'query') {
      const result = await db.sql.run(command.sql, command.params ?? []);
      assert.equal(command.status, 200, 'Unexpected successful query');
      assert.equal(result.rows.length, command.rows ?? 0);
    } else if (command.action === 'bulk') {
      const reports = [];
      for await (const batch of db.rows.writeBatches(command.schema, [...'abcde'].map((id,value) => ({id,value})), {batchSize:2})) reports.push(batch);
      assert.deepEqual(reports, [{offset:0,count:2,inserted:2},{offset:2,count:2,inserted:2},{offset:4,count:1,inserted:1}]);
    } else if (command.action === 'scan') {
      const ids = [];
      for await (const row of db.rows.scan(command.schema,'id',{pageSize:2})) ids.push(row.id);
      assert.deepEqual(ids,[...'abcde']);
    } else throw new Error('Unknown compatibility action');
  } catch(error) {
    if (!(error instanceof ApiError)) throw error;
    status = error.status;
    assert.notEqual(command.status, 200, 'Unexpected HTTP error');
    assert.equal(status,command.status,'Unexpected HTTP outcome');
  }
  assert.equal(calls-before,command.requests,'Unexpected request replay or prefetch');
  console.log(JSON.stringify({ok:true,status,requests:calls-before}));
}
