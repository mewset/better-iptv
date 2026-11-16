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

  it('keeps an episode name that starts with the series name', () => {
    expect(cleanEpisodeTitle('Chuck Versus the Intersect', ['Chuck'])).toBe(
      'Chuck Versus the Intersect'
    );
    expect(cleanEpisodeTitle('Chuck - S01E01 - Chuck Versus the Intersect', ['Chuck'])).toBe(
      'Chuck Versus the Intersect'
    );
    expect(cleanEpisodeTitle("House - S04E15 - House's Head", ['House'])).toBe("House's Head");
    expect(cleanEpisodeTitle('Lucifer - S01E02 - Lucifer, Stay. Good Devil.', ['Lucifer'])).toBe(
      'Lucifer, Stay. Good Devil.'
    );
    expect(cleanEpisodeTitle('Dexter - S01E01 - Dexter', ['Dexter'])).toBe('Dexter');
    expect(cleanEpisodeTitle('24 Hours Later', ['24'])).toBe('24 Hours Later');
  });

  it('keeps an episode name that starts or ends with a number', () => {
    expect(cleanEpisodeTitle('Breaking Bad - S02E09 - 4 Days Out', ['Breaking Bad'])).toBe(
      '4 Days Out'
    );
    expect(cleanEpisodeTitle('24 - S01E01 - 12:00 A.M.-1:00 A.M.', ['24'])).toBe(
      '12:00 A.M.-1:00 A.M.'
    );
    expect(cleanEpisodeTitle('Star Trek - S01E15 - 11001001', ['Star Trek'])).toBe('11001001');
    expect(cleanEpisodeTitle('Step 2', absentia)).toBe('Step 2');
    expect(cleanEpisodeTitle('Deep 6', absentia)).toBe('Deep 6');
    expect(cleanEpisodeTitle('Phase2', absentia)).toBe('Phase2');
    expect(cleanEpisodeTitle('Twin Peaks - S03E08 - Part 8', ['Twin Peaks'])).toBe('Part 8');
  });

  it('removes one address, not everything that looks like one', () => {
    // The episode really is called "Episode 2"
    expect(cleanEpisodeTitle('Twin Peaks - S01E03 - Episode 2', ['Twin Peaks'])).toBe('Episode 2');
    expect(cleanEpisodeTitle('Lost - S01E17 - ...In Translation', ['Lost'])).toBe(
      '...In Translation'
    );
    expect(cleanEpisodeTitle('...In Translation', ['Lost'])).toBe('...In Translation');
    expect(cleanEpisodeTitle('S01E01-02 - Pilot', absentia)).toBe('Pilot');
    expect(cleanEpisodeTitle('Comeback - S01E01', absentia)).toBe('Comeback');
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
