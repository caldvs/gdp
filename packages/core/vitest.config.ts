import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts'],
    globals: false,
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'json-summary', 'lcov'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.test.ts', 'src/api/schema.d.ts', '**/*.d.ts'],
      // Floors. Raise them as tests land; never lower them to make a PR pass.
      // The PR gate also fails on a drop of more than 1 point against main.
      thresholds: {
        lines: 35,
        branches: 44,
      },
    },
  },
});
