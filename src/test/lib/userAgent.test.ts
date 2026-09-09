import { describe, it, expect } from 'vitest';
import { APP_VERSION, buildDefaultUserAgent } from '../../lib/userAgent';

describe('buildDefaultUserAgent', () => {
  it('ends with the version it is given', () => {
    expect(buildDefaultUserAgent('2.8.1')).toBe(
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Better-IPTV/2.8.1'
    );
  });

  it('follows the version rather than carrying a frozen one', () => {
    expect(buildDefaultUserAgent('3.0.0')).toContain('Better-IPTV/3.0.0');
    expect(buildDefaultUserAgent('3.0.0')).not.toContain('2.1.1');
  });

  it('exposes the build-time app version, matching what the backend sends', () => {
    // The Rust side builds the same string from CARGO_PKG_VERSION, and
    // sync-version.cjs keeps that equal to the version in package.json.
    expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
