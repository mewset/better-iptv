import { useEffect, useRef, useCallback, useMemo } from 'react';
import { listen } from '@tauri-apps/api/event';
import { usePlayerStore } from '../stores/player-store';
import type { EpgEntry } from '../stores/player-store';
import { getChannelsEpg } from '../lib/tauri';
import { isEpgEntryStale } from '../lib/epgTime';
import { logger } from '../lib/logger';
import type { Channel } from '../types';

/**
 * Configuration for EPG fetching
 */
const EPG_CONFIG = {
  /** Interval between full EPG refreshes (ms) */
  REFRESH_INTERVAL: 300000, // 5 minutes
  /** Debounce delay for channel list changes (ms) */
  DEBOUNCE_DELAY: 500,
  /** Maximum channels to fetch EPG for at once (backend caps at 500) */
  MAX_CHANNELS: 100,
};

/**
 * Hook result for EPG data
 */
interface UseEpgDataResult {
  /** EPG data map (channel ID -> EpgEntry) */
  channelEpgData: Map<number, EpgEntry>;
  /** Trigger a manual refresh of EPG data */
  refreshEpg: () => void;
}

/**
 * Custom hook for managing EPG (Electronic Program Guide) data
 *
 * Consolidates all EPG-related logic:
 * - Fetches EPG for visible live channels with debouncing
 * - Fetches all visible channels in a single IPC call
 * - Periodic refresh every 5 minutes
 * - Responds to external refresh triggers
 * - Skips channels that already have cached EPG data
 * - Always includes the playing channel (first, so the batch cap never drops
 *   it), and refetches it once its cached programme has ended, so the dock
 *   keeps up even when the channel is not in the visible list
 */
export function useEpgData(
  visibleChannels: Channel[],
  playingChannel?: Channel | null
): UseEpgDataResult {
  const channelEpgData = usePlayerStore((s) => s.channelEpgData);
  const setChannelEpg = usePlayerStore((s) => s.setChannelEpg);
  const epgRefreshTrigger = usePlayerStore((s) => s.epgRefreshTrigger);
  const triggerEpgRefresh = usePlayerStore((s) => s.triggerEpgRefresh);
  const clearAllEpg = usePlayerStore((s) => s.clearAllEpg);

  // Track if we're currently fetching to avoid duplicate requests
  const isFetchingRef = useRef(false);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  // Last epgRefreshTrigger value already acted on. Without this, the "manual
  // refresh trigger" effect below would refire every time fetchEpgForChannels
  // is recreated (which happens on every completed fetch, since it closes
  // over channelEpgData) as long as epgRefreshTrigger stayed > 0 - an
  // infinite forced-refetch loop.
  const lastHandledTriggerRef = useRef(0);

  const playingId = playingChannel?.id;
  const channels = useMemo(() => {
    if (!playingChannel) return visibleChannels;
    return [playingChannel, ...visibleChannels.filter((c) => c.id !== playingChannel.id)];
  }, [visibleChannels, playingChannel]);

  // Fetch EPG for channels with debouncing
  const fetchEpgForChannels = useCallback(
    async (channelsToFetch: Channel[], forceRefresh = false) => {
      if (isFetchingRef.current) return;

      // Filter to live channels with EPG IDs
      let channelsWithEpg = channelsToFetch.filter(
        (c) => c.epg_id && c.id && c.content_type === 'live'
      );

      // Skip channels that already have cached data (unless force refresh).
      // The playing channel's entry counts as missing
      // once its programme has ended.
      if (!forceRefresh) {
        const now = Date.now();
        channelsWithEpg = channelsWithEpg.filter((c) => {
          const cached = channelEpgData.get(c.id);
          if (!cached) return true;
          return c.id === playingId && isEpgEntryStale(cached, now);
        });
      }

      // Limit to MAX_CHANNELS to avoid overwhelming the backend
      channelsWithEpg = channelsWithEpg.slice(0, EPG_CONFIG.MAX_CHANNELS);

      if (channelsWithEpg.length === 0) return;

      isFetchingRef.current = true;
      abortControllerRef.current = new AbortController();

      try {
        const epgIds = channelsWithEpg.map((c) => c.epg_id!);
        const epgById = await getChannelsEpg(epgIds);

        // The channel list changed while the request was in flight; the
        // effect that aborted us will schedule a fresh fetch.
        if (abortControllerRef.current?.signal.aborted) return;

        for (const channel of channelsWithEpg) {
          const raw = epgById[channel.epg_id!];
          // A channel between broadcasts has no current programme but still a
          // next one, and the card shows it as off air instead of "No guide data".
          if (!channel.id || (!raw?.current && !raw?.next)) continue;
          const entry: EpgEntry = {
            current: raw.current ?? undefined,
            currentStart: raw.current_start ?? undefined,
            currentEnd: raw.current_end ?? undefined,
            next: raw.next ?? undefined,
            nextStart: raw.next_start ?? undefined,
          };
          // Storing an already-stale entry for the playing channel would only
          // re-trigger the refetch above in a loop; the dock falls back to the
          // playback strings until the next refresh brings a fresh one.
          if (channel.id === playingId && isEpgEntryStale(entry)) continue;
          setChannelEpg(channel.id, entry);
        }
      } catch (err) {
        logger.debug('Failed to fetch EPG batch:', err);
      } finally {
        isFetchingRef.current = false;
        abortControllerRef.current = null;
      }
    },
    [channelEpgData, setChannelEpg, playingId]
  );

  // Debounced fetch when channels change
  useEffect(() => {
    if (channels.length === 0) return;

    // Clear previous timer
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }

    // Cancel ongoing fetch if channel list changed
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }

    // Debounce the fetch
    debounceTimerRef.current = setTimeout(() => {
      fetchEpgForChannels(channels, false);
    }, EPG_CONFIG.DEBOUNCE_DELAY);

    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, [channels, fetchEpgForChannels]);

  // Handle manual refresh trigger (force refresh all)
  useEffect(() => {
    if (epgRefreshTrigger > lastHandledTriggerRef.current && channels.length > 0) {
      lastHandledTriggerRef.current = epgRefreshTrigger;
      fetchEpgForChannels(channels, true);
    }
  }, [epgRefreshTrigger, channels, fetchEpgForChannels]);

  // Periodic EPG refresh
  useEffect(() => {
    const interval = setInterval(() => {
      triggerEpgRefresh();
    }, EPG_CONFIG.REFRESH_INTERVAL);

    return () => clearInterval(interval);
  }, [triggerEpgRefresh]);

  // The backend refreshed EPG on its own schedule: drop the cache so the next
  // fetch reads fresh titles for every channel, then trigger that fetch.
  useEffect(() => {
    const unlisten = listen('epg-refreshed', () => {
      clearAllEpg();
      triggerEpgRefresh();
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, [clearAllEpg, triggerEpgRefresh]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, []);

  return {
    channelEpgData,
    refreshEpg: triggerEpgRefresh,
  };
}

/**
 * Hook for EPG data for a specific channel
 * Useful when you only need EPG for the current channel
 */
export function useChannelEpg(channelId: number | undefined): EpgEntry | undefined {
  const channelEpgData = usePlayerStore((s) => s.channelEpgData);

  if (!channelId) return undefined;
  return channelEpgData.get(channelId);
}
