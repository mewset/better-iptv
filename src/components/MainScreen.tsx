import { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { usePlayerStore } from '../stores/player-store';
import {
  getChannelGroups,
  getStalePlaylistIds,
  getChannels,
  getSeriesInfo,
  getLocalSeriesInfo,
} from '../lib/tauri';
import { CategoryBar } from './CategoryBar';
import { ChannelCard } from './ChannelCard';
import { SearchBar } from './SearchBar';
import { ContentTypeTabs } from './ContentTypeTabs';
import { NowPlayingBar } from './NowPlayingBar';
import { Settings as SettingsIcon } from 'lucide-react';
import SeriesView from './SeriesView';
import SettingsModal from './Settings';
import PinEntryModal from './modals/PinEntryModal';
import ConfirmationModal from './modals/ConfirmationModal';
import RefreshModal from './modals/RefreshModal';
import type { Channel, SeriesInfo } from '../types';
import { logger } from '../lib/logger';
import { useResponsiveGrid, getGridClasses } from '../hooks/useResponsiveGrid';
import { useEpgData } from '../hooks/useEpgData';
import { useKeyboardShortcuts } from '../hooks/useKeyboardShortcuts';
import { useChannelPlayback } from '../hooks/useChannelPlayback';
import { shouldBlockChannel } from '../lib/parentalControls';
import { useDebouncedValue } from '../hooks/useDebouncedValue';
import { useChannelFilter } from '../hooks/useChannelFilter';

/** Xtream series URLs end in `/SERIES_ID.ext`; returns null when that is not the case. */
function parseXtreamSeriesId(url: string): number | null {
  const last = url.split('/').pop() ?? '';
  const id = parseInt(last.replace(/\.\w+$/, ''), 10);
  return Number.isNaN(id) ? null : id;
}

export default function MainScreen() {
  // Channel data
  const channels = usePlayerStore((s) => s.channels);

  // Search & filters
  const searchQuery = usePlayerStore((s) => s.searchQuery);
  const contentTypeFilter = usePlayerStore((s) => s.contentTypeFilter);
  const setSearchQuery = usePlayerStore((s) => s.setSearchQuery);
  const setContentTypeFilter = usePlayerStore((s) => s.setContentTypeFilter);
  const setCategories = usePlayerStore((s) => s.setCategories);
  const debouncedSearchQuery = useDebouncedValue(searchQuery, 300);

  // Consolidated channel filtering (content type, category, parental, search)
  const filteredChannels = useChannelFilter(debouncedSearchQuery);

  // Playback (hook handles polling + EPG updates)
  const {
    currentChannel,
    isPlaying,
    currentProgram,
    nextProgram,
    play: playChannelAction,
    stop: stopPlaybackAction,
    playEpisode: playEpisodeAction,
    playLocalEpisodes: playLocalEpisodesAction,
  } = useChannelPlayback();
  const currentPlaylist = usePlayerStore((s) => s.currentPlaylist);
  const setChannels = usePlayerStore((s) => s.setChannels);
  const toggleChannelFavorite = usePlayerStore((s) => s.toggleChannelFavorite);

  // Parental
  const parentalEnabled = usePlayerStore((s) => s.parentalEnabled);
  const parentalUnlocked = usePlayerStore((s) => s.parentalUnlocked);
  const blockedChannelIds = usePlayerStore((s) => s.blockedChannelIds);
  const blockedCategories = usePlayerStore((s) => s.blockedCategories);
  const parentalAutoDetect = usePlayerStore((s) => s.parentalAutoDetect);
  const parentalVisibility = usePlayerStore((s) => s.parentalVisibility);
  const loadParentalSettings = usePlayerStore((s) => s.loadParentalSettings);

  // Use consolidated EPG hook for channel EPG data (with debouncing and caching)
  const { channelEpgData } = useEpgData(filteredChannels);

  const [selectedSeries, setSelectedSeries] = useState<Channel | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showPinModal, setShowPinModal] = useState(false);
  const [pendingChannel, setPendingChannel] = useState<Channel | null>(null);
  const parentRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<globalThis.HTMLInputElement>(null);
  const [showStalePrompt, setShowStalePrompt] = useState(false);
  const [stalePlaylistId, setStalePlaylistId] = useState<number | null>(null);
  const [showRefreshModal, setShowRefreshModal] = useState(false);

  // Global keyboard shortcuts (Space=play/stop, /=focus search, Escape=stop)
  useKeyboardShortcuts(searchInputRef);

  // Responsive grid configuration
  const { columns, cardHeight, estimatedRowHeight } = useResponsiveGrid();

  // Load parental settings on mount
  useEffect(() => {
    loadParentalSettings();
  }, [loadParentalSettings]);

  // Check for stale playlists on mount
  useEffect(() => {
    if (!currentPlaylist?.id) return;

    getStalePlaylistIds()
      .then((ids) => {
        if (ids.includes(currentPlaylist.id!)) {
          setStalePlaylistId(currentPlaylist.id!);
          setShowStalePrompt(true);
        }
      })
      .catch((err) => logger.error('Failed to check stale playlists:', err));
  }, [currentPlaylist?.id]);

  // Fetch categories when playlist or content type changes
  useEffect(() => {
    if (!currentPlaylist?.id) {
      setCategories([]);
      return;
    }

    if (contentTypeFilter === 'favorites') {
      setCategories([]);
      return;
    }

    const contentType = contentTypeFilter === 'all' ? undefined : contentTypeFilter;
    getChannelGroups(currentPlaylist.id, contentType)
      .then(setCategories)
      .catch((err) => {
        logger.error('Failed to fetch categories:', err);
        setCategories([]);
      });
  }, [currentPlaylist?.id, contentTypeFilter, setCategories]);

  // Pre-compute parental blocking results (avoids per-card shouldBlockChannel calls)
  const blockedMap = useMemo(() => {
    if (!parentalEnabled || parentalUnlocked) return new Map<number, boolean>();

    const map = new Map<number, boolean>();
    for (const channel of filteredChannels) {
      if (channel.id) {
        map.set(
          channel.id,
          shouldBlockChannel(channel, {
            enabled: parentalEnabled,
            autoDetect: parentalAutoDetect,
            blockedIds: blockedChannelIds,
            blockedCategories: blockedCategories,
            unlocked: parentalUnlocked,
          })
        );
      }
    }
    return map;
  }, [
    filteredChannels,
    parentalEnabled,
    parentalUnlocked,
    parentalAutoDetect,
    blockedChannelIds,
    blockedCategories,
  ]);

  // Virtual scrolling setup - virtualize by rows (dynamic items per row)
  const rowCount = Math.ceil(filteredChannels.length / columns);

  const rowVirtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => parentRef.current,
    estimateSize: () => estimatedRowHeight,
    overscan: 5, // Pre-render 5 rows above/below for smoother scroll on large lists
  });

  const handlePlayChannel = useCallback(
    async (channel: Channel) => {
      // Read parental state at call time (not render time) for callback stability
      const {
        parentalEnabled: enabled,
        parentalAutoDetect: autoDetect,
        blockedChannelIds: blockedIds,
        blockedCategories: blockedCats,
        parentalUnlocked: unlocked,
      } = usePlayerStore.getState();

      const isBlocked = shouldBlockChannel(channel, {
        enabled,
        autoDetect,
        blockedIds,
        blockedCategories: blockedCats,
        unlocked,
      });

      if (isBlocked) {
        setPendingChannel(channel);
        setShowPinModal(true);
        return;
      }

      const result = await playChannelAction(channel);
      if (result?.type === 'series') {
        setSelectedSeries(result.channel);
      }
    },
    [playChannelAction]
  );

  const handlePlayEpisode = useCallback(
    async (
      episodeId: string,
      extension: string,
      title: string,
      remainingEpisodes?: Array<{ id: string; title: string; extension: string }>
    ) => {
      if (!currentPlaylist) return;
      try {
        if (currentPlaylist.url && currentPlaylist.xtream_username && currentPlaylist.xtream_password) {
          await playEpisodeAction(episodeId, extension, title, currentPlaylist, remainingEpisodes);
        } else {
          const ids = (remainingEpisodes && remainingEpisodes.length > 0
            ? remainingEpisodes.map((ep) => ep.id)
            : [episodeId]
          ).map(Number);
          await playLocalEpisodesAction(ids, title);
        }
      } catch (err) {
        logger.error('Failed to play episode:', err);
      }
    },
    [currentPlaylist, playEpisodeAction, playLocalEpisodesAction]
  );

  // Xtream profiles fetch the series from the provider; M3U profiles read
  // the episodes grouped at import. Memoised: SeriesView re-loads when it changes.
  const loadSeries = useCallback(async (): Promise<SeriesInfo> => {
    if (!selectedSeries) throw new Error('No series selected');
    const url = currentPlaylist?.url;
    const username = currentPlaylist?.xtream_username;
    const password = currentPlaylist?.xtream_password;
    if (url && username && password) {
      const seriesId = parseXtreamSeriesId(selectedSeries.url);
      if (seriesId === null) {
        logger.error('Failed to parse series ID from URL:', selectedSeries.url);
        throw new Error('Failed to load series: Invalid URL format');
      }
      return getSeriesInfo(url, username, password, seriesId);
    }
    return getLocalSeriesInfo(selectedSeries.id);
  }, [selectedSeries, currentPlaylist]);

  const handlePinSuccess = useCallback(() => {
    setShowPinModal(false);
    if (pendingChannel) {
      playChannelAction(pendingChannel)
        .then(() => {
          setPendingChannel(null);
        })
        .catch((err) => {
          logger.error('Failed to play channel after PIN:', err);
        });
    }
  }, [pendingChannel, playChannelAction]);

  const handleStop = useCallback(async () => {
    await stopPlaybackAction();
  }, [stopPlaybackAction]);

  // If a series is selected, show the SeriesView. Its own error screen covers
  // an unparsable Xtream URL, so the dedicated fallback is gone.
  if (selectedSeries) {
    return (
      <SeriesView
        loadSeries={loadSeries}
        onBack={() => setSelectedSeries(null)}
        onPlayEpisode={handlePlayEpisode}
      />
    );
  }

  return (
    <div className="flex h-screen flex-col bg-gray-50 dark:bg-gray-900">
      {/* Header */}
      <div className="border-b border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
        <div className="mx-auto flex items-center justify-between px-2">
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Better IPTV</h1>
          <div className="flex items-center gap-4">
            <span className="text-sm text-gray-600 dark:text-gray-400">
              {channels.length} channels
            </span>
            <button
              onClick={() => setShowSettings(true)}
              className="rounded-lg p-2 transition-colors hover:bg-gray-100 dark:hover:bg-gray-700"
              title="Settings"
            >
              <SettingsIcon className="h-5 w-5 text-gray-600 dark:text-gray-400" />
            </button>
          </div>
        </div>
      </div>

      {/* Search Bar */}
      <SearchBar ref={searchInputRef} value={searchQuery} onChange={setSearchQuery} />

      {/* Content Type Tabs */}
      <ContentTypeTabs activeFilter={contentTypeFilter} onFilterChange={setContentTypeFilter} />

      {/* Category Bar - horizontal scrollable chips */}
      <CategoryBar />

      {/* Channel List with Virtual Scrolling */}
      <div
        ref={parentRef}
        className="flex-1 overflow-y-auto"
        id="channel-list"
        role="tabpanel"
        aria-label="Channel list"
      >
        <div className="mx-auto p-4">
          {filteredChannels.length === 0 ? (
            <div className="py-12 text-center">
              <p className="text-gray-500 dark:text-gray-400">
                {searchQuery ? 'No channels found' : 'No channels available'}
              </p>
            </div>
          ) : (
            <div
              style={{
                height: `${rowVirtualizer.getTotalSize()}px`,
                width: '100%',
                position: 'relative',
              }}
            >
              {rowVirtualizer.getVirtualItems().map((virtualRow) => {
                const startIndex = virtualRow.index * columns;
                const rowItems = filteredChannels.slice(startIndex, startIndex + columns);

                return (
                  <div
                    key={virtualRow.key}
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      width: '100%',
                      height: `${virtualRow.size}px`,
                      transform: `translateY(${virtualRow.start}px)`,
                    }}
                  >
                    <div className={`grid ${getGridClasses(columns)} gap-4`}>
                      {rowItems.map((channel) => {
                        const isChannelBlocked = blockedMap.get(channel.id!) ?? false;

                        return (
                          <ChannelCard
                            key={channel.id}
                            channel={channel}
                            isPlaying={currentChannel?.id === channel.id && isPlaying}
                            onPlay={handlePlayChannel}
                            onToggleFavorite={toggleChannelFavorite}
                            currentProgram={channelEpgData.get(channel.id)?.current}
                            nextProgram={channelEpgData.get(channel.id)?.next}
                            cardHeight={cardHeight}
                            isBlocked={isChannelBlocked}
                            parentalVisibility={parentalVisibility}
                          />
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Now Playing Bar */}
      {currentChannel && (
        <NowPlayingBar
          channel={currentChannel}
          currentProgram={currentProgram}
          nextProgram={nextProgram}
          onStop={handleStop}
        />
      )}

      {/* Settings Modal */}
      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}

      {/* PIN Entry Modal for blocked channels */}
      <PinEntryModal
        isOpen={showPinModal}
        onClose={() => {
          setShowPinModal(false);
          setPendingChannel(null);
        }}
        onSuccess={handlePinSuccess}
        mode="verify"
        title="Enter PIN to access this channel"
      />

      {/* Stale playlist prompt */}
      <ConfirmationModal
        isOpen={showStalePrompt}
        onClose={() => setShowStalePrompt(false)}
        onConfirm={() => {
          setShowStalePrompt(false);
          setShowRefreshModal(true);
        }}
        title="Playlist Update Available"
        message="Your playlist hasn't been updated in over 7 days. Would you like to refresh it now?"
        confirmText="Refresh Now"
        cancelText="Later"
      />

      {/* Refresh modal */}
      {stalePlaylistId && currentPlaylist && (
        <RefreshModal
          isOpen={showRefreshModal}
          onClose={() => {
            setShowRefreshModal(false);
            setStalePlaylistId(null);
          }}
          playlistId={stalePlaylistId}
          playlistName={currentPlaylist.name}
          onRefreshComplete={async () => {
            if (currentPlaylist.id) {
              try {
                const freshChannels = await getChannels(currentPlaylist.id);
                setChannels(freshChannels);
              } catch (err) {
                logger.error('Failed to reload channels after refresh:', err);
              }
            }
          }}
        />
      )}
    </div>
  );
}
