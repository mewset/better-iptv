import { describe, it, expect } from 'vitest';
import { queueFrom } from '../../lib/seriesQueue';
import type { Episode, SeriesInfo } from '../../types';

function ep(id: string, num: number): Episode {
  return { id, episode_num: num, title: id, container_extension: 'mkv', season: 0, info: {} };
}
const show: SeriesInfo = {
  info: { name: 'Show' },
  seasons: [],
  episodes: { '0': [ep('s1', 1)], '1': [ep('11', 1), ep('12', 2)], '2': [ep('21', 1)] },
};

describe('queueFrom', () => {
  it('queues from the episode on, into the next seasons, titled for the player', () => {
    expect(queueFrom(show, '12', (e) => `Name ${e.id}`)).toEqual([
      { id: '12', title: 'S1 E2 · Name 12', extension: 'mkv' },
      { id: '21', title: 'S2 E1 · Name 21', extension: 'mkv' },
    ]);
  });

  it('keeps specials apart, and knows no unknown episode', () => {
    expect(queueFrom(show, 's1', (e) => e.id).map((e) => e.id)).toEqual(['s1']);
    expect(queueFrom(show, 'nope', (e) => e.id)).toEqual([]);
  });
});
