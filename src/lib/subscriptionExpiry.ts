/**
 * Wording for the Xtream subscription expiry shown in settings.
 *
 * The backend hands over an RFC 3339 instant, or nothing at all when the
 * account has no expiry date, the playlist is not an Xtream one, or the
 * provider could not be reached. Anything unreadable renders as nothing
 * rather than as "Invalid Date".
 */
export function formatSubscriptionExpiry(
  expiresAt: string | null | undefined,
  now: Date = new Date()
): string | null {
  if (!expiresAt) return null;

  const expiry = new Date(expiresAt);
  if (Number.isNaN(expiry.getTime())) return null;

  // The day is what matters for a subscription; the clock time is noise.
  const day = expiry.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  return expiry.getTime() < now.getTime()
    ? `Subscription ended ${day}`
    : `Subscription ends ${day}`;
}
