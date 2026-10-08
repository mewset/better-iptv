import { useEffect, useRef, useCallback, useMemo, useState } from 'react';
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
  /** A channel the guide had nothing for is not asked about again for this long (ms) */
  EMPTY_RETRY: 300000,
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
 * - Fetches EPG for the channels passed in (the cards in view) with debouncing
 * - Fetches them in a single IPC call and stores the answer in one update
 * - Periodic refresh every 5 minutes
 * - Responds to external refresh triggers
 * - Skips channels whose cached entry still describes the present, and
 *   channels the guide had nothing for in the last few minutes, so a run of
 *   channels without guide data never holds up the ones after it
 * - Always includes the playing channel (first, so the batch cap never drops
 *   it), so the dock keeps up even when the channel is not in view
 */
export function useEpgData(
  visibleChannels: Channel[],
  playingChannel?: Channel | null
): UseEpgDataResult {
  const channelEpgData = usePlayerStore((s) => s.channelEpgData);
  const setChannelEpgs = usePlayerStore((s) => s.setChannelEpgs);
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
  // Channel id -> when a fetch last came back without a usable entry for it.
  // Without this, channels the guide knows nothing about would be asked for
  // again on every pass, and a hundred of them in a row would fill every batch.
  const emptyAtRef = useRef<Map<number, number>>(new Map());
  // Bumped after a batch that had to leave channels out, so the rest get
  // their turn even when the batch stored nothing (all misses).
  const [pass, setPass] = useState(0);

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

      // Skip channels whose cached entry still describes the present (unless
      // force refresh), and channels the guide recently had nothing for.
      if (!forceRefresh) {
        const now = Date.now();
        channelsWithEpg = channelsWithEpg.filter((c) => {
          const emptyAt = emptyAtRef.current.get(c.id);
          if (emptyAt !== undefined && now - emptyAt < EPG_CONFIG.EMPTY_RETRY) return false;
          const cached = channelEpgData.get(c.id);
          return !cached || isEpgEntryStale(cached, now);
        });
      }

      // Limit to MAX_CHANNELS to avoid overwhelming the backend
      const leftOver = channelsWithEpg.length > EPG_CONFIG.MAX_CHANNELS;
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

        const now = Date.now();
        const entries: Array<[number, EpgEntry]> = [];
        for (const channel of channelsWithEpg) {
          const raw = epgById[channel.epg_id!];
          // A channel between broadcasts has no current programme but still a
          // next one, and the card shows it as off air instead of "No guide data".
          const entry: EpgEntry | null =
            raw?.current || raw?.next
              ? {
                  current: raw.current ?? undefined,
                  currentStart: raw.current_start ?? undefined,
                  currentEnd: raw.current_end ?? undefined,
                  next: raw.next ?? undefined,
                  nextStart: raw.next_start ?? undefined,
                }
              : null;
          // Nothing usable, or an entry that is already stale (storing it would
          // only re-trigger the refetch above in a loop): remember the miss.
          if (!entry || isEpgEntryStale(entry, now)) {
            emptyAtRef.current.set(channel.id, now);
            continue;
          }
          emptyAtRef.current.delete(channel.id);
          entries.push([channel.id, entry]);
        }
        setChannelEpgs(entries);
        if (leftOver) setPass((p) => p + 1);
      } catch (err) {
        logger.debug('Failed to fetch EPG batch:', err);
      } finally {
        isFetchingRef.current = false;
        abortControllerRef.current = null;
      }
    },
    [channelEpgData, setChannelEpgs]
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
    // pass: a capped batch asks for the next one.
  }, [channels, fetchEpgForChannels, pass]);

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
      emptyAtRef.current = new Map();
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
