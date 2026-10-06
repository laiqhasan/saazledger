import { defineConfig } from 'vitest/config';

// Test-only config (takes precedence over vite.config.ts when running vitest).
export default defineConfig({
  test: {
    setupFiles: ['./tests/setup/isolatedDataDir.ts'],
  },
});
