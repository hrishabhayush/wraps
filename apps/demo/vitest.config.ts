import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// The root config runs packages/*/test. This one runs the demo's tests. `npm test` runs both.
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
