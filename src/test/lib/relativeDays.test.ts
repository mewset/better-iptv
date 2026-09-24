import { describe, it, expect } from 'vitest';
import { daysSince, refreshedAgo } from '../../lib/relativeDays';

describe('refreshedAgo', () => {
  it('says "Refreshed today" for the same local day', () => {
    const now = new Date('2026-03-10T14:00:00Z');
    expect(refreshedAgo('2026-03-10T09:00:00Z', now.getTime())).toBe('Refreshed today');
  });

  it('says "Refreshed yesterday" for one whole calendar day back', () => {
    const now = new Date('2026-03-10T14:00:00Z');
    expect(refreshedAgo('2026-03-09T09:00:00Z', now.getTime())).toBe('Refreshed yesterday');
  });

  it('says "Refreshed {n} days ago" for several days back', () => {
    const now = new Date('2026-03-10T14:00:00Z');
    expect(refreshedAgo('2026-03-01T09:00:00Z', now.getTime())).toBe('Refreshed 9 days ago');
  });

  it('returns "" for undefined input', () => {
    expect(refreshedAgo(undefined, Date.now())).toBe('');
  });

  it('returns "" for a value that is not a date', () => {
    expect(refreshedAgo('not-a-date', Date.now())).toBe('');
  });

  it('counts whole local calendar days, not 24-hour spans', () => {
    // 23:50 "yesterday" and 00:10 "today", 20 minutes apart in real time, but
    // they cross a local midnight so this must read as one calendar day, not
    // "today".
    const now = new Date('2026-03-10T00:10:00');
    const lastUpdated = new Date('2026-03-09T23:50:00').toISOString();
    expect(refreshedAgo(lastUpdated, now.getTime())).toBe('Refreshed yesterday');
  });

  it('reads SQLite\'s "YYYY-MM-DD HH:MM:SS" last_updated as UTC', () => {
    // SQLite's CURRENT_TIMESTAMP is UTC without a T or Z. Read as local time
    // it shifts by the UTC offset, which moves it across local midnight here.
    const sqlite = (d: Date) => d.toISOString().slice(0, 19).replace('T', ' ');
    const lastUpdated = new Date('2026-03-09T23:50:00'); // local
    const now = new Date('2026-03-10T00:10:00').getTime(); // local, 20 min later
    expect(refreshedAgo(sqlite(lastUpdated), now)).toBe('Refreshed yesterday');
    expect(daysSince(sqlite(lastUpdated), now)).toBe(daysSince(lastUpdated.toISOString(), now));

    const sameDay = new Date('2026-03-10T00:05:00'); // local, just after midnight
    expect(refreshedAgo(sqlite(sameDay), now)).toBe('Refreshed today');
  });
});
