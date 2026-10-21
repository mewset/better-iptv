import { useMemo } from 'react';
import { shouldBlockChannel, type ParentalChannel } from '../lib/parentalControls';
import { usePlayerStore } from '../stores/player-store';

/**
 * The rule the channel list hides channels by: parental controls on, locked,
 * and set to hide. `null` while nothing is hidden, so a caller can skip the
 * pass; otherwise true for a channel that stays out of view.
 */
export function useParentalHiding(): ((channel: ParentalChannel) => boolean) | null {
  const enabled = usePlayerStore((s) => s.parentalEnabled);
  const unlocked = usePlayerStore((s) => s.parentalUnlocked);
  const visibility = usePlayerStore((s) => s.parentalVisibility);
  const autoDetect = usePlayerStore((s) => s.parentalAutoDetect);
  const blockedIds = usePlayerStore((s) => s.blockedChannelIds);
  const blockedCategories = usePlayerStore((s) => s.blockedCategories);
  return useMemo(() => {
    if (!enabled || unlocked || visibility !== 'hide') return null;
    const settings = { enabled, autoDetect, blockedIds, blockedCategories, unlocked };
    return (channel: ParentalChannel) => shouldBlockChannel(channel, settings);
  }, [enabled, unlocked, visibility, autoDetect, blockedIds, blockedCategories]);
}

/** Parental controls are on and not unlocked. */
export function useParentalLocked(): boolean {
  return usePlayerStore((s) => s.parentalEnabled && !s.parentalUnlocked);
}
