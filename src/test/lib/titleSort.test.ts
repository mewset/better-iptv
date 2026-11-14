import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_TITLE_SORTS,
  loadTitleSorts,
  saveTitleSorts,
  sortTitles,
  titleYear,
} from '../../lib/titleSort';
import type { Channel } from '../../types';

function title(id: number, name: string, created_at?: string): Channel {
  return { id, name, content_type: 'vod', is_favorite: false, created_at };
}

const names = (list: Channel[]) => list.map((c) => c.name);

describe('sortTitles', () => {
  const list = [
    title(1, 'Rocky 10 (2030)', '2025-10-21 18:49:02'),
    title(2, '#Alive (2020)', '2025-11-02 09:00:00'),
    title(3, 'rocky 2 (1979)'),
    title(4, 'Élan (2020)', '2024-01-01 00:00:00'),
    title(5, 'Untitled Project', '2025-11-02 09:00:00'),
  ];

  it('keeps the playlist order for provider and returns the same list', () => {
    expect(sortTitles(list, 'provider')).toBe(list);
  });

  it('sorts by name ignoring case, accents and punctuation, numbers numerically', () => {
    expect(names(sortTitles(list, 'name'))).toEqual([
      '#Alive (2020)',
      'Élan (2020)',
      'rocky 2 (1979)',
      'Rocky 10 (2030)',
      'Untitled Project',
    ]);
    expect(names(sortTitles(list, 'name-desc'))).toEqual([
      'Untitled Project',
      'Rocky 10 (2030)',
      'rocky 2 (1979)',
      'Élan (2020)',
      '#Alive (2020)',
    ]);
  });

  it('sorts by year newest first; ties keep list order, no year goes last', () => {
    expect(names(sortTitles(list, 'year'))).toEqual([
      'Rocky 10 (2030)',
      '#Alive (2020)',
      'Élan (2020)',
      'rocky 2 (1979)',
      'Untitled Project',
    ]);
  });

  it('sorts by added date newest first; ties keep list order, undated goes last', () => {
    expect(names(sortTitles(list, 'added'))).toEqual([
      '#Alive (2020)',
      'Untitled Project',
      'Rocky 10 (2030)',
      'Élan (2020)',
      'rocky 2 (1979)',
    ]);
  });

  it('does not change the list it is given', () => {
    const copy = [...list];
    sortTitles(list, 'name');
    sortTitles(list, 'added');
    expect(list).toEqual(copy);
  });
});

describe('titleYear', () => {
  it('reads a trailing (YYYY) only', () => {
    expect(titleYear('Freaky (2020)')).toBe(2020);
    expect(titleYear('Freaky (2020)  ')).toBe(2020);
    expect(titleYear('2012 (2009)')).toBe(2009);
    expect(titleYear('Blade Runner 2049')).toBeNull();
    expect(titleYear('(2020) Something')).toBeNull();
  });
});

describe('loadTitleSorts / saveTitleSorts', () => {
  // The test environment has no Web Storage; a Map stands in for it
  beforeEach(() => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('falls back to the defaults when storage throws', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    });
    expect(() => saveTitleSorts({ vod: 'added', series: 'name' })).not.toThrow();
    expect(loadTitleSorts()).toEqual(DEFAULT_TITLE_SORTS);
  });

  it('defaults to provider order', () => {
    expect(loadTitleSorts()).toEqual(DEFAULT_TITLE_SORTS);
  });

  it('round-trips a saved choice per section', () => {
    saveTitleSorts({ vod: 'added', series: 'name' });
    expect(loadTitleSorts()).toEqual({ vod: 'added', series: 'name' });
  });

  it('ignores a corrupt or unknown value', () => {
    localStorage.setItem('better-iptv:title-sort', '{not json');
    expect(loadTitleSorts()).toEqual(DEFAULT_TITLE_SORTS);
    localStorage.setItem('better-iptv:title-sort', JSON.stringify({ vod: 'rating' }));
    expect(loadTitleSorts()).toEqual(DEFAULT_TITLE_SORTS);
  });
});
