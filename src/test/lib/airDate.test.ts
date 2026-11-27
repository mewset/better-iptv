import { describe, it, expect } from 'vitest';
import { airDateLabel } from '../../lib/airDate';

const today = new Date(2026, 10, 16);
const fmt = (y: number, m: number, d: number) =>
  new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' }).format(
    new Date(y, m - 1, d)
  );

describe('airDateLabel', () => {
  it('reads a calendar date, with or without a time', () => {
    expect(airDateLabel('2024-06-13', today)).toBe(fmt(2024, 6, 13));
    expect(airDateLabel('2019-07-26 00:00:00', today)).toBe(fmt(2019, 7, 26));
  });

  it('says when an episode is still to come', () => {
    expect(airDateLabel('2026-12-03', today)).toBe(`Airs ${fmt(2026, 12, 3)}`);
    expect(airDateLabel('2026-11-16', today)).toBe(fmt(2026, 11, 16));
  });

  it('gives nothing for missing or odd values', () => {
    expect(airDateLabel(null, today)).toBeNull();
    expect(airDateLabel('', today)).toBeNull();
    expect(airDateLabel('0000-00-00', today)).toBeNull();
    expect(airDateLabel('June 2024', today)).toBeNull();
  });
});
