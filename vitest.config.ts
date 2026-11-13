import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { appVersion } from './scripts/app-version.mjs';

export default defineConfig({
  plugins: [react()],

  // Must match vite.config.ts, or the tests check a different string than the
  // app builds.
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    // Vitest's default of 5 s per test (and Testing Library's 1 s per
    // waitFor/findBy, raised in setup.ts) is met with a wide margin on an
    // idle machine but not on a loaded one: component tests that mount
    // MainScreen or Settings then time out without being broken. A longer
    // limit changes nothing for a test that passes, only how long one that
    // really hangs takes to fail.
    testTimeout: 30_000,
    // scripts/ holds build and CI tooling that CI depends on, so its tests
    // run with the rest rather than sitting unexecuted.
    include: ['src/**/*.{test,spec}.{js,ts,jsx,tsx}', 'scripts/**/*.test.mjs'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: ['node_modules/', 'src/test/', '**/*.d.ts', 'src/main.tsx'],
    },
  },
});
