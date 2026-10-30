import { defineConfig } from 'vitest/config';

// Two projects share one config so a single `vitest run --coverage` measures
// unit and integration tests together:
//   npm test           → unit only (no services needed)
//   npm run test:int   → integration only (DynamoDB Local :8000, MinIO :9000)
//   npm run test:cov   → both, with coverage and thresholds (what CI gates on)
export default defineConfig({
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          environment: 'node',
          include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          environment: 'node',
          include: ['tests/integration/**/*.test.ts'],
          globalSetup: ['tests/integration/global-setup.ts'],
          // Every response is checked against openapi.yaml.
          setupFiles: ['tests/integration/contract-setup.ts'],
          testTimeout: 30_000,
          pool: 'forks',
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'json-summary', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/local.ts', 'src/lambda.ts', '**/*.d.ts'],
      // Floors. Raise them as tests land; never lower them to make a PR pass.
      // The PR gate also fails on a drop of more than 1 point against main.
      thresholds: {
        lines: 85,
        branches: 68,
        // Money maths: every line covered (the uncovered branches are
        // defensive `?? 0` fallbacks).
        'src/services/sessions/allocation.ts': { lines: 100, branches: 80, functions: 100 },
      },
    },
  },
});
