import { useMemo } from 'react';
import { usePlayerStore } from '../stores/player-store';
import { shouldBlockChannel } from '../lib/parentalControls';
import { sortTitles } from '../lib/titleSort';
import { collapseVersions, groupVersions } from '../lib/versions';
import { searchChannels } from '../lib/searchText';
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
 */
export function useChannelFilter(debouncedSearchQuery: string): Channel[] {
  const channels = usePlayerStore((s) => s.channels);
  const liveChannels = usePlayerStore((s) => s.liveChannels);
  const vodChannels = usePlayerStore((s) => s.vodChannels);
  const versionPrefs = usePlayerStore((s) => s.versionPrefs);
  // Every movie's versions (standard, 4K, dubs), for one card per film
  const movieVersions = useMemo(() => groupVersions(vodChannels), [vodChannels]);
  const seriesChannels = usePlayerStore((s) => s.seriesChannels);
  const favoriteChannels = usePlayerStore((s) => s.favoriteChannels);
  const contentTypeFilter = usePlayerStore((s) => s.contentTypeFilter);
  const categoryFilter = usePlayerStore((s) => s.categoryFilter);
  const parentalEnabled = usePlayerStore((s) => s.parentalEnabled);
  const parentalUnlocked = usePlayerStore((s) => s.parentalUnlocked);
  const blockedChannelIds = usePlayerStore((s) => s.blockedChannelIds);
  const blockedCategories = usePlayerStore((s) => s.blockedCategories);
  const parentalAutoDetect = usePlayerStore((s) => s.parentalAutoDetect);
  const parentalVisibility = usePlayerStore((s) => s.parentalVisibility);
  const titleSorts = usePlayerStore((s) => s.titleSorts);

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
      case 'home':
        // Home lists nothing of its own; its rows come from get_home_rows.
        return [];
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

  // Step 2-4: Apply category, parental, and search filters. Derived during
  // render: filtering in an effect committed one render of a new section
  // with the previous section's list (posters for live channels, every
  // visible card mounted twice).
  return useMemo(() => {
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

    // Search filter: name or category, whatever the case, accents or stray spaces
    result = searchChannels(result, debouncedSearchQuery);

    // Movies and Series take the user's sort while browsing; a search spans
    // every content type, so its results keep the playlist order.
    if (
      (contentTypeFilter === 'vod' || contentTypeFilter === 'series') &&
      debouncedSearchQuery.trim() === ''
    ) {
      result = sortTitles(result, titleSorts[contentTypeFilter]);
    }

    // One card per film in Movies (unless a category is chosen, which lists
    // exactly its own entries) and in search results: the preferred version
    // stands in for its standard, 4K and dubbed copies, which the detail view
    // offers. Series and channels are left as they are.
    const searching = debouncedSearchQuery.trim() !== '' && contentTypeFilter !== 'guide';
    if ((contentTypeFilter === 'vod' && !categoryFilter) || searching) {
      result = collapseVersions(result, movieVersions, versionPrefs);
    }
    return result;
  }, [
    movieVersions,
    versionPrefs,
    baseList,
    contentTypeFilter,
    titleSorts,
    categoryFilter,
    debouncedSearchQuery,
    parentalEnabled,
    parentalUnlocked,
    parentalAutoDetect,
    blockedChannelIds,
    blockedCategories,
    parentalVisibility,
  ]);
}
