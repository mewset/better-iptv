import { describe, it, expect } from 'vitest';
import { formatClock, progressPercent, minutesLeft, isEpgEntryStale } from '../../lib/epgTime';

const T = Date.parse('2026-09-24T18:00:00Z');
const iso = (min: number) => new Date(T + min * 60000).toISOString();

describe('epgTime', () => {
  it('formats a clock time as two-digit hours and minutes', () => {
    expect(formatClock(iso(0))).toMatch(/^\d{2}:\d{2}$/);
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
    expect(isEpgEntryStale({ current: 'A', currentEnd: iso(-1) }, T)).toBe(true);
    expect(isEpgEntryStale({ current: 'A', currentEnd: iso(10) }, T)).toBe(false);
  });
  it('marks an off-air entry stale once its next programme has begun', () => {
    expect(isEpgEntryStale({ next: 'B', nextStart: iso(-1) }, T)).toBe(true);
    expect(isEpgEntryStale({ next: 'B', nextStart: iso(30) }, T)).toBe(false);
  });
  it('never marks an entry without usable times stale', () => {
    expect(isEpgEntryStale({ current: 'A' }, T)).toBe(false);
    expect(isEpgEntryStale({ next: 'B', nextStart: 'bad' }, T)).toBe(false);
  });
});
