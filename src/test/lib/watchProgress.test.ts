import { describe, it, expect } from 'vitest';
import {
  continueWatching,
  finaleOf,
  formatPosition,
  indexProgress,
  nextUp,
  progressFraction,
  resumeSecs,
} from '../../lib/watchProgress';
import type { WatchProgress } from '../../lib/tauri';
import type { Episode, SeriesInfo } from '../../types';

function p(
  channel_id: number,
  episode_id: string,
  position_secs: number,
  updated_at: number,
  watched = false
): WatchProgress {
  return { channel_id, episode_id, position_secs, duration_secs: 2400, watched, updated_at };
}

function ep(id: string, num: number): Episode {
  return { id, episode_num: num, title: id, container_extension: 'mp4', season: 0, info: {} };
}

const show: SeriesInfo = {
  info: { name: 'Show' },
  seasons: [],
  episodes: { '0': [ep('s1', 1)], '2': [ep('21', 1)], '1': [ep('12', 2), ep('11', 1)] },
};

describe('watch progress helpers', () => {
  it('resumes a title left part-way, not a watched or barely started one', () => {
    expect(resumeSecs(p(1, '', 600, 1))).toBe(600);
    expect(resumeSecs(p(1, '', 12, 1))).toBeUndefined();
    expect(resumeSecs(p(1, '', 600, 1, true))).toBeUndefined();
    expect(progressFraction(p(1, '', 600, 1))).toBe(0.25);
    expect(progressFraction(p(1, '', 600, 1, true))).toBe(1);
  });

  it('formats positions', () => {
    expect(formatPosition(65)).toBe('1:05');
    expect(formatPosition(3725)).toBe('1:02:05');
  });

  it('carries a series on: resume, then the next episode across seasons, else the first', () => {
    expect(nextUp(show, 5, indexProgress([]))).toMatchObject({
      season: '1',
      episode: { id: '11' },
      kind: 'start',
    });
    expect(nextUp(show, 5, indexProgress([p(5, '12', 300, 2)]))).toMatchObject({
      episode: { id: '12' },
      resumeSecs: 300,
      kind: 'resume',
    });
    // The last episode of season 1 watched: season 2 is next (specials come last)
    expect(nextUp(show, 5, indexProgress([p(5, '12', 2300, 3, true)]))).toMatchObject({
      season: '2',
      episode: { id: '21' },
      kind: 'next',
    });
  });

  it('lists films left part-way and series being watched, most recent first, once each', () => {
    const entries = [
      p(7, '', 600, 9),
      p(8, '', 2300, 8, true),
      p(5, '21', 100, 7),
      p(5, '11', 2300, 6, true),
      p(9, '', 10, 5),
    ];
    expect(continueWatching(entries, (id) => id === 5)).toEqual([7, 5]);
    // A series whose final episode is watched is finished
    const done = [p(5, '21', 2300, 7, true), ...entries.slice(3)];
    expect(
      continueWatching(
        done,
        (id) => id === 5,
        () => '21'
      )
    ).toEqual([]);
    expect(finaleOf(show)).toBe('21');
  });

  it('skips episodes already watched when a season was marked at once', () => {
    // Season 1 marked together: episode 1 happens to be the latest row
    const marked = indexProgress([p(5, '11', 0, 4, true), p(5, '12', 0, 4, true)]);
    expect(nextUp(show, 5, marked)).toMatchObject({ episode: { id: '21' }, kind: 'next' });
  });
});
