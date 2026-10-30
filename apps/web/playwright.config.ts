import { defineConfig, devices } from '@playwright/test';

// Smoke tests stub the API with page.route, so no backend is needed.
// They run against `next start`, so build first: npm run build -w apps/web
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  retries: process.env.CI ? 2 : 0,
  use: { baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:8081', trace: 'on-first-retry' },
  projects: [
    { name: 'mobile', use: { ...devices['iPhone 13'] } },
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : { command: 'npm run start', url: 'http://localhost:8081', reuseExistingServer: true, timeout: 120_000 },
});
