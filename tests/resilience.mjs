import assert from "node:assert/strict";
import { Client, ApiError, CredentialError, mapRows, RowDecodeError } from "../dist/index.mjs";

const url = process.env.OC_URL, token = process.env.OC_TOKEN;
const client = new Client({ url, token });
for (const [name, status] of [["expired", 401], ["revoked", 401], ["forbidden", 403], ["limited", 429]]) {
  await assert.rejects(client.sql.run(`fault:${name}`), error => {
    assert(error instanceof ApiError);
    assert.equal(error.status, status);
    assert.equal(error.requestId, "84f92822-5837-432e-981a-7b24ad65e16c");
    if (name === "limited") assert.equal(error.retryAfter, "2");
    return true;
  });
}
await assert.rejects(client.sql.run("fault:interrupted"));
const timeoutEvents = [];
await assert.rejects(new Client({ url, token, timeoutMs: 150, onRequest: e => timeoutEvents.push(e) }).sql.run("fault:timeout"));
assert.equal(timeoutEvents[0].errorKind, "timeout");

let calls = 0;
const events = [];
const rotating = new Client({ url, tokenProvider: async () => `rotate-${++calls}`, onRequest: e => events.push(e) });
await assert.rejects(rotating.sql.run("fault:rotate"), e => e instanceof ApiError && e.status === 401);
assert.equal(calls, 1);
const result = await rotating.sql.run("fault:rotate");
assert.equal(calls, 2);
assert.deepEqual(events.map(e => e.errorKind), ["authentication", undefined]);
assert(events.every(e => e.operation === "sql" && e.durationMs > 0));
assert(!JSON.stringify(events).includes("rotate-"));
assert(!JSON.stringify(events).includes(url));
const mapped = mapRows(result, row => {
  assert.equal(typeof row.id, "string");
  assert.equal(typeof row.amount, "string");
  return { id: BigInt(row.id), amount: row.amount };
});
assert.deepEqual(mapped, [{ id: 9007199254740993n, amount: "1.00000000000000001" }]);
mapRows(result, row => { row.id = "changed"; });
assert.equal(result.rows[0].id, "9007199254740993");
assert.throws(() => mapRows(result, row => { if (typeof row.id !== "number") throw new TypeError("wrong type"); }),
  e => e instanceof RowDecodeError && e.row === 0);
await assert.rejects(new Client({ url, tokenProvider: () => "bad\nheader" }).sql.run("fault:invalid-provider"), CredentialError);
const observed = new Client({ url, token, onRequest: () => { throw new Error("observer"); } });
assert.equal((await observed.sql.run("fault:observer")).rows.length, 1);
console.log("TypeScript resilience assertions passed");
