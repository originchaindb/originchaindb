import { performance } from 'node:perf_hooks';
import { Client } from '../dist/index.mjs';

const db = Client.fromEnv();
const report = {};
async function query(mode) {
  const start = performance.now();
  const result = await db.sql.query('bench:' + mode);
  if (result.rows.length !== (mode === 'large' ? 2048 : 1)) throw new Error('Unexpected result size');
  return performance.now() - start;
}
for (let i = 0; i < 10; i++) await query('warm');
for (const [mode, count] of [['sequential', 100], ['concurrent', 64], ['large', 10]]) {
  const start = performance.now(), values = [];
  if (mode === 'concurrent') {
    await Promise.all(Array.from({length: 8}, async () => { for (let i = 0; i < count / 8; i++) values.push(await query(mode)); }));
  } else for (let i = 0; i < count; i++) values.push(await query(mode));
  report[mode + '_ms'] = values;
  report[mode + '_rps'] = count * 1000 / (performance.now() - start);
}
console.log('OC_BENCHMARK ' + JSON.stringify(report));
