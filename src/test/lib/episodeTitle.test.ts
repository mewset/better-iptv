import { describe, expect, it } from 'vitest';
import { cleanEpisodeTitle } from '../../lib/episodeTitle';

describe('cleanEpisodeTitle', () => {
  const absentia = ['Absentia'];

  it('keeps only the episode name from "Series - S01E01 - Name"', () => {
    expect(cleanEpisodeTitle('Absentia - S01E01 - Comeback', absentia)).toBe('Comeback');
    expect(cleanEpisodeTitle('Absentia - S01E03 - The Emily Show', absentia)).toBe(
      'The Emily Show'
    );
  });

  it('handles the other common shapes', () => {
    expect(cleanEpisodeTitle('Absentia 1x01: Comeback', absentia)).toBe('Comeback');
    expect(cleanEpisodeTitle('S01 E01 | Comeback', absentia)).toBe('Comeback');
    expect(cleanEpisodeTitle('Season 1 Episode 1 - Comeback', absentia)).toBe('Comeback');
    expect(cleanEpisodeTitle('Episode 4: Me You Him Me', absentia)).toBe('Me You Him Me');
    expect(cleanEpisodeTitle('E02 – Reset', absentia)).toBe('Reset');
    expect(cleanEpisodeTitle('S01E01-E02 - Pilot', absentia)).toBe('Pilot');
    expect(cleanEpisodeTitle('Comeback (S01E01)', absentia)).toBe('Comeback');
    expect(cleanEpisodeTitle('absentia: s01e01 - Comeback', absentia)).toBe('Comeback');
  });

  it('matches the series name without its year or provider prefix', () => {
    expect(cleanEpisodeTitle('Absentia - S01E01 - Comeback', ['Absentia (2017)'])).toBe('Comeback');
    expect(cleanEpisodeTitle('Doctor Who S14E01 The Church on Ruby Road', ['UK: Doctor Who'])).toBe(
      'The Church on Ruby Road'
    );
  });

  it('leaves a plain episode name alone', () => {
    expect(cleanEpisodeTitle('Comeback', absentia)).toBe('Comeback');
    expect(cleanEpisodeTitle('Pilot', ['Breaking Bad'])).toBe('Pilot');
    // Words that merely start like a code or the series stay
    expect(cleanEpisodeTitle('Episodes of Doubt', absentia)).toBe('Episodes of Doubt');
    expect(cleanEpisodeTitle('Absentias Return', absentia)).toBe('Absentias Return');
    expect(cleanEpisodeTitle('Exodus', absentia)).toBe('Exodus');
    // Its own punctuation stays
    expect(cleanEpisodeTitle('Outlast - S01E01 - Fire. Water. Flare.', ['Outlast'])).toBe(
      'Fire. Water. Flare.'
    );
  });

  it('returns null when nothing of the episode own is left', () => {
    expect(cleanEpisodeTitle('Absentia - S01E01', absentia)).toBeNull();
    expect(cleanEpisodeTitle('S01E01', absentia)).toBeNull();
    expect(cleanEpisodeTitle('Absentia', absentia)).toBeNull();
    expect(cleanEpisodeTitle('  ', absentia)).toBeNull();
    expect(cleanEpisodeTitle(undefined, absentia)).toBeNull();
    expect(cleanEpisodeTitle('Episode 3', absentia)).toBeNull();
  });
});
