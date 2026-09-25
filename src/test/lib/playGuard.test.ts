import { describe, it, expect, beforeEach } from 'vitest';
import { beginPlaybackStart, endPlaybackStart, resetPlaybackGuard } from '../../lib/playGuard';

describe('playGuard', () => {
  beforeEach(() => resetPlaybackGuard());

  it('lets the first start through', () => {
    expect(beginPlaybackStart(10_000)).toBe(true);
  });

  it('ignores a second start while the first is still in flight', () => {
    beginPlaybackStart(10_000);
    expect(beginPlaybackStart(15_000)).toBe(false);
  });

  it('ignores a start within two seconds of the previous one', () => {
    beginPlaybackStart(10_000);
    endPlaybackStart();
    expect(beginPlaybackStart(11_999)).toBe(false);
  });

  it('allows a start two seconds after the previous one finished', () => {
    beginPlaybackStart(10_000);
    endPlaybackStart();
    expect(beginPlaybackStart(12_000)).toBe(true);
  });
});
