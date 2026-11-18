import { describe, it, expect, afterEach } from 'vitest';
import { applyBackdropSupport } from '../../lib/glass';

describe('applyBackdropSupport', () => {
  afterEach(() => {
    delete window.__BETTER_IPTV_NO_BACKDROP_FILTER__;
    delete document.documentElement.dataset.backdrop;
  });

  it('marks the page when the backend says no backdrop filter is drawn', () => {
    window.__BETTER_IPTV_NO_BACKDROP_FILTER__ = true;
    applyBackdropSupport();
    expect(document.documentElement.dataset.backdrop).toBe('none');
  });

  it('leaves the page alone without the flag', () => {
    applyBackdropSupport();
    expect(document.documentElement.dataset.backdrop).toBeUndefined();
  });
});
