import { useEffect, useRef, useCallback } from 'react';
import { usePlayerStore } from '../stores/player-store';
import { getChannelsEpg } from '../lib/tauri';
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
  /** EPG data map (channel ID -> current and next program titles) */
  channelEpgData: Map<number, { current: string; next?: string }>;
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
 */
export function useEpgData(channels: Channel[]): UseEpgDataResult {
  const channelEpgData = usePlayerStore((s) => s.channelEpgData);
  const setChannelEpg = usePlayerStore((s) => s.setChannelEpg);
  const epgRefreshTrigger = usePlayerStore((s) => s.epgRefreshTrigger);
  const triggerEpgRefresh = usePlayerStore((s) => s.triggerEpgRefresh);

  // Track if we're currently fetching to avoid duplicate requests
  const isFetchingRef = useRef(false);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  // Fetch EPG for channels with debouncing
  const fetchEpgForChannels = useCallback(
    async (channelsToFetch: Channel[], forceRefresh = false) => {
      if (isFetchingRef.current) return;

      // Filter to live channels with EPG IDs
      let channelsWithEpg = channelsToFetch.filter(
        (c) => c.epg_id && c.id && c.content_type === 'live'
      );

      // Skip channels that already have cached data (unless force refresh)
      if (!forceRefresh) {
        channelsWithEpg = channelsWithEpg.filter((c) => c.id && !channelEpgData.has(c.id));
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
          const entry = epgById[channel.epg_id!];
          if (entry?.current && channel.id) {
            setChannelEpg(channel.id, entry.current, entry.next);
          }
        }
      } catch (err) {
        logger.debug('Failed to fetch EPG batch:', err);
      } finally {
        isFetchingRef.current = false;
        abortControllerRef.current = null;
      }
    },
    [channelEpgData, setChannelEpg]
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
    if (epgRefreshTrigger > 0 && channels.length > 0) {
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
export function useChannelEpg(
  channelId: number | undefined
): { current: string; next?: string } | undefined {
  const channelEpgData = usePlayerStore((s) => s.channelEpgData);

  if (!channelId) return undefined;
  return channelEpgData.get(channelId);
}
