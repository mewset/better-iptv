import { describe, it, expect } from 'vitest';
import {
  channelIndex,
  findChannels,
  hitDetails,
  hitTitle,
  manualTarget,
  matchLookup,
  matchState,
} from '../../lib/epgMatchView';
import type { ManualMatch } from '../../lib/epgIpc';
import type { Channel } from '../../types';

const live = (id: number, name: string, epg_id?: string): Channel => ({
  id,
  name,
  content_type: 'live',
  is_favorite: false,
  epg_id,
});

const manual = (overrides: Partial<ManualMatch> = {}): ManualMatch => ({
  channel_id: 2,
  channel_name: 'TV4',
  key: 'tv4hd.se',
  guide_name: 'TV4 HD',
  has_programmes: true,
  ...overrides,
});

describe('findChannels', () => {
  const index = channelIndex([
    live(1, 'Kanal SVT1'),
    live(2, 'SVT1 HD'),
    live(3, 'TV4'),
    live(4, 'svt1'),
    live(5, 'Ämne'),
  ]);

  it('finds names containing the query in any case, names starting with it first', () => {
    const { hits, total } = findChannels(index, ' SVT1 ');
    expect(hits.map((c) => c.id)).toEqual([2, 4, 1]);
    expect(total).toBe(3);
    expect(findChannels(index, 'ämne').hits.map((c) => c.id)).toEqual([5]);
  });

  it('finds nothing for an empty query', () => {
    expect(findChannels(index, '   ')).toEqual({ hits: [], total: 0 });
  });

  it('lists at most the limit but counts every hit', () => {
    const many = channelIndex(
      Array.from({ length: 150_000 }, (_, i) => live(i, i % 2 ? `Kanal ${i}` : `Sport ${i}`))
    );
    const { hits, total } = findChannels(many, 'kanal', 50);
    expect(hits).toHaveLength(50);
    expect(total).toBe(75_000);
    expect(hits[0].id).toBe(1);
  });
});

describe('matchState', () => {
  const lookup = matchLookup({
    manual: [manual(), manual({ channel_id: 3, has_programmes: false, guide_name: null })],
    by_name: [5],
  });

  it('names each way a channel finds its guide', () => {
    expect(matchState(live(1, 'SVT1', 'svt1.se'), lookup)).toEqual({
      kind: 'id',
      text: 'Matched by id · svt1.se',
    });
    expect(matchState(live(5, 'Sjuan', 'sjuan.se'), lookup).text).toBe(
      'Matched by name · sjuan.se'
    );
    expect(matchState(live(2, 'TV4', 'tv4hd.se'), lookup).text).toBe('Set by hand · TV4 HD');
    expect(matchState(live(3, 'Kanal 9', 'tv4hd.se'), lookup)).toEqual({
      kind: 'manual_empty',
      text: 'Set by hand, guide has no programmes now',
    });
    expect(matchState(live(4, 'SVT2'), lookup)).toEqual({ kind: 'none', text: 'No guide' });
  });

  it('does not guess how a channel was matched before the details are known', () => {
    expect(matchState(live(1, 'SVT1', 'svt1.se'), null)).toEqual({
      kind: 'matched',
      text: 'Matched · svt1.se',
    });
    expect(matchState(live(4, 'SVT2'), null).kind).toBe('none');
  });
});

describe('hit and manual wording', () => {
  it('names a guide channel by its name, or its key when it has none', () => {
    const hit = { key: 'svt1.se', name: 'SVT1', source_id: 1, source_label: 'epg.example' };
    expect(hitTitle(hit)).toBe('SVT1');
    expect(hitTitle({ ...hit, name: null })).toBe('svt1.se');
    expect(hitDetails(hit)).toBe('svt1.se · epg.example');
  });

  it('says what a manual match shows', () => {
    expect(manualTarget(manual())).toBe('TV4 HD (tv4hd.se)');
    expect(manualTarget(manual({ guide_name: null }))).toBe('tv4hd.se');
    expect(manualTarget(manual({ has_programmes: false, guide_name: null }))).toBe(
      'tv4hd.se (guide has no programmes now)'
    );
  });
});
