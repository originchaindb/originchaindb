import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './browser', testMatch: '*.browser.mjs', timeout: 20000,
  fullyParallel: true, forbidOnly: !!process.env.CI, retries: 0,
  reporter: 'list', use: { baseURL: 'http://127.0.0.1:32170' },
  projects: ['chromium', 'firefox', 'webkit'].map(name => ({ name, use: { browserName: name } })),
  webServer: { command: 'node browser/server.cjs', url: 'http://127.0.0.1:32170', timeout: 20000 },
});
