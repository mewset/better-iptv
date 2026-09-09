import { readFileSync } from 'node:fs';

/**
 * The version in package.json, for build-time injection into the frontend.
 *
 * Both vite.config.ts and vitest.config.ts need it, and a copy in each is
 * exactly the drift that left the user-agent claiming 2.1.1 for six releases.
 */
export const appVersion = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf-8')
).version;
