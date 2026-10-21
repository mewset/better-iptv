import { describe, it, expect } from 'vitest';
import { describeClock, localOffset, nextClockChange } from '../../lib/clockChange';

const FROM = Date.parse('2026-10-21T12:00:00Z');

/** A zone at UTC+2 (offset −120) that moves to UTC+1 at `change`. */
const oneChangeAt =
  (change: number) =>
  (t: number): number =>
    t < change ? -120 : -60;

describe('nextClockChange', () => {
  it('finds a change to the minute', () => {
    const change = Date.parse('2026-10-25T01:00:00Z');
    expect(nextClockChange(FROM, oneChangeAt(change))).toBe(change);
  });

  it('finds a change on the first day and on the last day scanned', () => {
    const soon = FROM + 3 * 3_600_000;
    expect(nextClockChange(FROM, oneChangeAt(soon))).toBe(soon);
    const late = FROM + 364 * 86_400_000 + 7 * 60_000;
    expect(nextClockChange(FROM, oneChangeAt(late))).toBe(late);
  });

  it('is null for a zone without clock changes, or one beyond a year', () => {
    expect(nextClockChange(FROM, () => 0)).toBeNull();
    expect(nextClockChange(FROM, oneChangeAt(FROM + 400 * 86_400_000))).toBeNull();
  });

  // `npm run test:tz` runs the suite in Pacific/Auckland; the default run
  // uses the machine's zone. Either way the answer is a real change.
  it("follows this computer's zone", () => {
    const change = nextClockChange(FROM);
    if (Intl.DateTimeFormat().resolvedOptions().timeZone === 'Pacific/Auckland') {
      // NZDT ends on the first Sunday of April at 03:00 (UTC+13).
      expect(change).toBe(Date.parse('2027-04-03T14:00:00Z'));
    }
    if (change !== null) {
      expect(localOffset(change - 60_000)).not.toBe(localOffset(change));
      expect(change).toBeGreaterThan(FROM);
    } else {
      expect(localOffset(FROM + 182 * 86_400_000)).toBe(localOffset(FROM));
    }
  });
});

describe('describeClock', () => {
  it("names the time and this computer's zone", () => {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect(describeClock(FROM)).toMatch(/^\d{2}:\d{2} \(/);
    expect(describeClock(FROM)).toContain(zone);
  });
});
