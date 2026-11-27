import { describe, it, expect } from 'vitest';
import { allEpisodeIds, newEpisodeIds } from '../../lib/newEpisodes';
import type { Episode, SeriesInfo } from '../../types';

function ep(id: string, num: number): Episode {
  return { id, episode_num: num, title: id, container_extension: 'mp4', season: 0, info: {} };
}
const show: SeriesInfo = {
  info: { name: 'Show' },
  seasons: [],
  episodes: {
    '0': [ep('s1', 1)],
    '1': [ep('11', 1), ep('12', 2)],
    '2': [ep('21', 1), ep('22', 2)],
  },
};

describe('new episodes', () => {
  it('are the ones added since the list was last seen, not yet watched, specials aside', () => {
    expect(newEpisodeIds(show, ['11', '12'], () => false)).toEqual(['21', '22']);
    expect(newEpisodeIds(show, ['11', '12'], (id) => id === '21')).toEqual(['22']);
  });

  it('start from the current list for a series never checked', () => {
    expect(newEpisodeIds(show, undefined, () => false)).toEqual([]);
    expect(allEpisodeIds(show)).toEqual(['11', '12', '21', '22', 's1']);
  });
});
