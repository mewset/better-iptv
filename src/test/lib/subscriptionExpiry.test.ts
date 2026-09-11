import { describe, it, expect } from 'vitest';
import { formatSubscriptionExpiry } from '../../lib/subscriptionExpiry';

// A fixed "now" keeps the past/future wording deterministic.
const NOW = new Date('2026-03-01T12:00:00Z');

describe('formatSubscriptionExpiry', () => {
  it('words a future date as the subscription ending', () => {
    const line = formatSubscriptionExpiry('2026-03-15T00:00:00+00:00', NOW);
    expect(line).toMatch(/^Subscription ends /);
  });

  it('words a date that has passed in the past tense', () => {
    const line = formatSubscriptionExpiry('2026-02-01T00:00:00+00:00', NOW);
    expect(line).toMatch(/^Subscription ended /);
  });

  it('includes the date itself', () => {
    const line = formatSubscriptionExpiry('2026-03-15T00:00:00+00:00', NOW);
    expect(line).toContain(
      new Date('2026-03-15T00:00:00+00:00').toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      })
    );
  });

  it('shows no clock time, only the day', () => {
    const line = formatSubscriptionExpiry('2026-03-15T18:45:00+00:00', NOW);
    expect(line).not.toMatch(/\d{1,2}:\d{2}/);
  });

  it('returns null when there is no date', () => {
    expect(formatSubscriptionExpiry(null, NOW)).toBeNull();
  });

  it('returns null for a value that is not a date', () => {
    // A corrupted row must render nothing rather than "Invalid Date".
    expect(formatSubscriptionExpiry('not-a-date', NOW)).toBeNull();
    expect(formatSubscriptionExpiry('', NOW)).toBeNull();
  });
});
