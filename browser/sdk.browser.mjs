import { test, expect } from '@playwright/test';

test('page: real cross-origin requests and cancellation', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => (await import('/scenario.mjs')).exercise());
  expect(result).toEqual({
    sql: true, url: true, fromEnv: true, noProcess: true, noServerCorrelation: true, cancelled: true, worker: false,
  });
});

test('worker: real cross-origin requests and cancellation', async ({ page }) => {
  await page.goto('/');
  const message = await page.evaluate(() => new Promise((resolve, reject) => {
    const worker = new Worker('/worker.mjs', { type: 'module' });
    worker.onmessage = event => { worker.terminate(); resolve(event.data); };
    worker.onerror = event => { worker.terminate(); reject(new Error(event.message)); };
  }));
  expect(message).toEqual({ result: {
    sql: true, url: true, fromEnv: true, noProcess: true, noServerCorrelation: true, cancelled: true, worker: true,
  } });
});
