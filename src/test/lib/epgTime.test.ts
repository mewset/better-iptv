import { describe, it, expect } from 'vitest';
import {
  formatClock,
  formatClockAt,
  progressPercent,
  minutesLeft,
  cardEpg,
  isNowNextStale,
  shownNowNext,
  nowNextBoundary,
} from '../../lib/epgTime';
import { nowNext, programme } from '../epgFixtures';

const T = Date.parse('2026-09-24T18:00:00Z');
const iso = (min: number) => new Date(T + min * 60000).toISOString();

describe('epgTime', () => {
  it('formats a clock time as two-digit hours and minutes', () => {
    expect(formatClock(iso(0))).toMatch(/^\d{2}:\d{2}$/);
  });
  it('never writes local midnight as 24:', () => {
    // The night the clocks go back in the EU: built from local fields, so
    // it is midnight in whatever zone the run uses.
    const midnight = new Date(2026, 9, 25, 0, 0).getTime();
    const afternoon = new Date(2026, 9, 25, 13, 5).getTime();
    for (const locale of ['en-US', 'sv-SE', 'de-DE']) {
      expect(formatClockAt(midnight, locale)).toMatch(/^00\D00$/);
      expect(formatClock(new Date(midnight).toISOString(), locale)).toMatch(/^00\D00$/);
      expect(formatClockAt(afternoon, locale)).toMatch(/^13\D05$/);
    }
    expect(formatClockAt(midnight)).not.toMatch(/^24/);
  });
  it('returns an empty string for an unparsable time', () => {
    expect(formatClock('not a date')).toBe('');
  });
  it('computes progress through a programme', () => {
    expect(progressPercent(iso(-15), iso(45), T)).toBe(25);
  });
  it('clamps progress to 0..100', () => {
    expect(progressPercent(iso(10), iso(40), T)).toBe(0);
    expect(progressPercent(iso(-60), iso(-30), T)).toBe(100);
  });
  it('returns null progress when times are missing, invalid or inverted', () => {
    expect(progressPercent('', iso(10), T)).toBeNull();
    expect(progressPercent('x', 'y', T)).toBeNull();
    expect(progressPercent(iso(10), iso(0), T)).toBeNull();
  });
  it('rounds minutes left up and never goes negative', () => {
    expect(minutesLeft(iso(17.2), T)).toBe(18);
    expect(minutesLeft(iso(-5), T)).toBe(0);
    expect(minutesLeft('bad', T)).toBeNull();
  });

  it('marks an entry stale once its current programme has ended', () => {
    expect(isNowNextStale(nowNext(programme('A', iso(-30), iso(-1))), T)).toBe(true);
    expect(isNowNextStale(nowNext(programme('A', iso(-30), iso(10))), T)).toBe(false);
    expect(nowNextBoundary(nowNext(programme('A', iso(-30), iso(10))))).toBe(T + 10 * 60000);
  });
  it('marks an off-air entry stale once its next programme has begun', () => {
    expect(isNowNextStale(nowNext(null, programme('B', iso(-1), iso(30))), T)).toBe(true);
    expect(isNowNextStale(nowNext(null, programme('B', iso(30), iso(60))), T)).toBe(false);
    expect(nowNextBoundary(nowNext(null, programme('B', iso(30), iso(60))))).toBe(T + 30 * 60000);
  });
  it('never marks an entry without usable times stale', () => {
    expect(isNowNextStale(nowNext(programme('A', iso(-30), 'bad')), T)).toBe(false);
    expect(isNowNextStale(nowNext(null, null), T)).toBe(false);
    expect(nowNextBoundary(nowNext(null, null))).toBeNull();
  });
  it('hides a stale entry from cards and the dock alike', () => {
    const ended = nowNext(programme('A', iso(-30), iso(-1)));
    const airing = nowNext(programme('A', iso(-30), iso(30)));
    expect(shownNowNext(ended, T)).toBeUndefined();
    expect(shownNowNext(airing, T)).toBe(airing);
    expect(shownNowNext(undefined, T)).toBeUndefined();
    expect(cardEpg(ended, T)).toEqual({ epg: undefined, progress: null });
  });
  it('gives a card the entry itself and its rounded progress', () => {
    const airing = nowNext(programme('A', iso(-15), iso(45)));
    const card = cardEpg(airing, T);
    expect(card.epg).toBe(airing);
    expect(card.progress).toBe(25);
    const offAir = nowNext(null, programme('B', iso(30), iso(60)));
    expect(cardEpg(offAir, T)).toEqual({ epg: offAir, progress: null });
  });
});
