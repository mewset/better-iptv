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
