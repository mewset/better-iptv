import { describe, it, expect } from 'vitest';
import { newestTitle } from '../../lib/newestTitle';
import type { Channel } from '../../types';

function movie(id: number, created_at?: string): Channel {
  return {
    id,
    playlist_id: 1,
    name: `Movie ${id}`,
    url: `http://x/${id}`,
    content_type: 'vod',
    is_favorite: false,
    sort_order: 0,
    created_at,
  };
}

describe('newestTitle', () => {
  it('picks the channel with the greatest created_at', () => {
    const older = movie(1, '2026-01-01T00:00:00Z');
    const newer = movie(2, '2026-06-15T00:00:00Z');
    const middle = movie(3, '2026-03-01T00:00:00Z');
    expect(newestTitle([older, newer, middle])).toBe(newer);
  });

  it('ignores invalid or missing dates, sorting them last', () => {
    const valid = movie(1, '2026-01-01T00:00:00Z');
    const invalid = movie(2, 'not-a-date');
    const missing = movie(3, undefined);
    expect(newestTitle([invalid, missing, valid])).toBe(valid);
    // All invalid/missing: falls back to the first in list order.
    expect(newestTitle([invalid, missing])).toBe(invalid);
  });

  it('returns null on an empty list', () => {
    expect(newestTitle([])).toBeNull();
  });

  it('keeps list order on ties', () => {
    const first = movie(1, '2026-01-01T00:00:00Z');
    const second = movie(2, '2026-01-01T00:00:00Z');
    expect(newestTitle([first, second])).toBe(first);
  });
});
