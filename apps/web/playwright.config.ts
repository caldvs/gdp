import { defineConfig, devices } from '@playwright/test';

// Smoke tests stub the API with page.route, so no backend is needed.
// They run against `next start`, so build first: npm run build -w apps/web
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  retries: process.env.CI ? 2 : 0,
  // Multi-person tests wait on several polls; CI's WebKit runs are slow.
  timeout: process.env.CI ? 60_000 : 30_000,
  // Screens update by polling, and a loaded runner's WebKit can take more
  // than 5s to show the next state.
  expect: { timeout: process.env.CI ? 10_000 : 5_000 },
  use: { baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:8081', trace: 'on-first-retry' },
  projects: [
    // Every test runs on desktop Chromium. The iPhone (WebKit) runs only the
    // ones tagged @webkit: what Safari on a phone does differently (layout,
    // tap targets, the camera, sheets, the join link and the main flows).
    { name: 'mobile', use: { ...devices['iPhone 13'] }, grep: /@webkit/ },
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : { command: 'npm run start', url: 'http://localhost:8081', reuseExistingServer: true, timeout: 120_000 },
});
