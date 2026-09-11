/**
 * Ask the backend for each Xtream profile's subscription expiry.
 *
 * One call per profile, in parallel. The backend asks the provider on every
 * call, so a renewal shows up without waiting for a playlist refresh, and
 * falls back to the value it stored last time when the provider cannot be
 * reached. A failure means no line on that card, never an error the user has
 * to read.
 */
import { useEffect, useState } from 'react';
import { getSubscriptionExpiry } from '../lib/tauri';
import { logger } from '../lib/logger';

export function useSubscriptionExpiries(playlistIds: number[]): Record<number, string | null> {
  const [expiries, setExpiries] = useState<Record<number, string | null>>({});

  // A joined key keeps the effect from re-running on every render, which a
  // freshly built array argument would otherwise cause.
  const key = playlistIds.join(',');

  useEffect(() => {
    if (!key) return;

    const ids = key.split(',').map(Number);
    let cancelled = false;

    Promise.all(
      ids.map(async (id) => {
        try {
          return [id, await getSubscriptionExpiry(id)] as const;
        } catch (err) {
          logger.debug(`Subscription expiry lookup failed for profile ${id}:`, err);
          return [id, null] as const;
        }
      })
    ).then((entries) => {
      if (!cancelled) setExpiries(Object.fromEntries(entries));
    });

    return () => {
      cancelled = true;
    };
  }, [key]);

  return expiries;
}
