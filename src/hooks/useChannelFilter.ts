import { useEffect, useMemo } from 'react';
import { usePlayerStore } from '../stores/player-store';
import type { Section } from '../stores/player-store';
import { shouldBlockChannel } from '../lib/parentalControls';
import type { Channel } from '../types';

/**
 * Consolidated channel filtering hook.
 *
 * Applies filters in order:
 * 1. Content type (instant via pre-filtered arrays) — bypassed in favour of
 *    every channel while a non-empty search query is active, except in the
 *    guide, whose search stays scoped to its own live list.
 * 2. Category filter
 * 3. Parental controls (hide mode)
 * 4. Search query
 *
 * Syncs result to store via setFilteredChannels.
 */
export function useChannelFilter(debouncedSearchQuery: string): Channel[] {
  const channels = usePlayerStore((s) => s.channels);
  const filteredChannels = usePlayerStore((s) => s.filteredChannels);
  const liveChannels = usePlayerStore((s) => s.liveChannels);
  const vodChannels = usePlayerStore((s) => s.vodChannels);
  const seriesChannels = usePlayerStore((s) => s.seriesChannels);
  const favoriteChannels = usePlayerStore((s) => s.favoriteChannels);
  const contentTypeFilter = usePlayerStore((s) => s.contentTypeFilter);
  const categoryFilter = usePlayerStore((s) => s.categoryFilter);
  const setFilteredChannels = usePlayerStore((s) => s.setFilteredChannels);
  const parentalEnabled = usePlayerStore((s) => s.parentalEnabled);
  const parentalUnlocked = usePlayerStore((s) => s.parentalUnlocked);
  const blockedChannelIds = usePlayerStore((s) => s.blockedChannelIds);
  const blockedCategories = usePlayerStore((s) => s.blockedCategories);
  const parentalAutoDetect = usePlayerStore((s) => s.parentalAutoDetect);
  const parentalVisibility = usePlayerStore((s) => s.parentalVisibility);

  // Step 1: Select base list by content type (O(1) - pre-computed).
  // A non-empty search spans every content type (design doc: "search stays
  // cross-type") except in the guide, whose search stays scoped to its own
  // live list.
  const baseList = useMemo(() => {
    const hasQuery = debouncedSearchQuery.trim() !== '';
    if (hasQuery && contentTypeFilter !== 'guide') {
      return channels;
    }
    switch (contentTypeFilter) {
      case 'live':
        return liveChannels;
      case 'vod':
        return vodChannels;
      case 'series':
        return seriesChannels;
      case 'favorites':
        return favoriteChannels;
      case 'guide':
        // Every live channel; the guide's own Favorites chip narrows it.
        return liveChannels;
    }
  }, [
    contentTypeFilter,
    liveChannels,
    vodChannels,
    seriesChannels,
    favoriteChannels,
    channels,
    debouncedSearchQuery,
  ]);

  // Step 2-4: Apply category, parental, and search filters
  useEffect(() => {
    let result = baseList;

    // Category filter
    if (categoryFilter) {
      result = result.filter((c) => c.group_name === categoryFilter);
    }

    // Parental controls (hide mode only)
    if (parentalEnabled && !parentalUnlocked && parentalVisibility === 'hide') {
      result = result.filter(
        (c) =>
          !shouldBlockChannel(c, {
            enabled: parentalEnabled,
            autoDetect: parentalAutoDetect,
            blockedIds: blockedChannelIds,
            blockedCategories: blockedCategories,
            unlocked: parentalUnlocked,
          })
      );
    }

    // Search filter
    if (debouncedSearchQuery.trim() !== '') {
      const query = debouncedSearchQuery.toLowerCase();
      result = result.filter(
        (c) => c.name.toLowerCase().includes(query) || c.group_name?.toLowerCase().includes(query)
      );
    }

    setFilteredChannels(result);
  }, [
    baseList,
    categoryFilter,
    debouncedSearchQuery,
    parentalEnabled,
    parentalUnlocked,
    parentalAutoDetect,
    blockedChannelIds,
    blockedCategories,
    parentalVisibility,
    setFilteredChannels,
  ]);

  return filteredChannels;
}

/**
 * Content type filter options. Re-exports `Section` so the store stays the
 * single source of truth for the type.
 */
export type ContentTypeFilter = Section;

/**
 * Hook to manage content type filter state
 */
export function useContentTypeFilter() {
  const contentTypeFilter = usePlayerStore((s) => s.contentTypeFilter);
  const setContentTypeFilter = usePlayerStore((s) => s.setContentTypeFilter);

  return {
    activeFilter: contentTypeFilter,
    setFilter: setContentTypeFilter,
  };
}

/**
 * Hook to manage search query state
 */
export function useSearchQuery() {
  const searchQuery = usePlayerStore((s) => s.searchQuery);
  const setSearchQuery = usePlayerStore((s) => s.setSearchQuery);

  return {
    query: searchQuery,
    setQuery: setSearchQuery,
  };
}
