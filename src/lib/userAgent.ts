/**
 * The default HTTP user-agent, kept identical to the one the Rust side sends.
 *
 * Both halves are built from the same version: Rust from `CARGO_PKG_VERSION`
 * and this from `package.json`, which `dev-scripts/sync-version.cjs` keeps in
 * step. Before this the version was a literal on both sides and had said 2.1.1
 * since the setting was added.
 */
const USER_AGENT_PREFIX = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Better-IPTV/';

/** The app version this build was compiled from. */
export const APP_VERSION = __APP_VERSION__;

export function buildDefaultUserAgent(version: string): string {
  return `${USER_AGENT_PREFIX}${version}`;
}

/** What the backend sends when the user-agent mode is `default`. */
export const DEFAULT_USER_AGENT = buildDefaultUserAgent(APP_VERSION);
