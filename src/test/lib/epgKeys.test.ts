import { describe, it, expect } from 'vitest';
import { applyEpgKeys } from '../../lib/epgKeys';
import type { Channel } from '../../types';

const live = (id: number, epg_id?: string): Channel => ({
  id,
  name: `Live ${id}`,
  content_type: 'live',
  is_favorite: false,
  epg_id,
});

describe('applyEpgKeys', () => {
  it('sets the listed key on a live channel, copying only that channel', () => {
    const a = live(1);
    const b = live(2, 'tv4.se');
    const channels = [a, b];

    const out = applyEpgKeys(channels, [
      [1, 'svt1.se'],
      [2, 'tv4.se'],
    ]);

    expect(out).not.toBe(channels);
    expect(out[0]).toEqual({ ...a, epg_id: 'svt1.se' });
    expect(out[1]).toBe(b);
    expect(channels[0].epg_id).toBeUndefined();
  });

  it('replaces a changed key and clears the key of a live channel not listed', () => {
    const channels = [live(1, 'old.se'), live(2, 'gone.se')];

    const out = applyEpgKeys(channels, [[1, 'new.se']]);

    expect(out.map((c) => c.epg_id)).toEqual(['new.se', undefined]);
  });

  it('treats a null key from the wire as no key', () => {
    const unmatched = { ...live(1), epg_id: null } as unknown as Channel;
    const channels = [unmatched];

    expect(applyEpgKeys(channels, [])).toBe(channels);
  });

  it('never touches vod or series rows, listed or not', () => {
    const movie: Channel = { id: 3, name: 'Film', content_type: 'vod', is_favorite: false };
    const show: Channel = {
      id: 4,
      name: 'Show',
      content_type: 'series',
      is_favorite: false,
      epg_id: 'show.se',
    };
    const channels = [live(1, 'svt1.se'), movie, show];

    const out = applyEpgKeys(channels, [
      [1, 'svt1.se'],
      [3, 'film.se'],
    ]);

    expect(out).toBe(channels);
    expect(out[1]).toBe(movie);
    expect(out[2]).toBe(show);
  });

  it('returns the same array and objects when every key already holds', () => {
    const channels = [live(1, 'svt1.se'), live(2)];

    const out = applyEpgKeys(channels, [[1, 'svt1.se']]);

    expect(out).toBe(channels);
    expect(applyEpgKeys([], [[1, 'svt1.se']])).toEqual([]);
  });
});
