import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['e2e/**/*.e2e.test.ts'],
    // spawns the built CLI against real fixture sessions — generous timeouts
    testTimeout: 30_000,
  },
});
