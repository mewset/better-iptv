import { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { usePlayerStore, type Section } from '../stores/player-store';
import {
  getChannelGroups,
  getStalePlaylistIds,
  getChannels,
  getSeriesInfo,
  getLocalSeriesInfo,
} from '../lib/tauri';
import { CategoryBar } from './CategoryBar';
import { ChannelCard } from './ChannelCard';
import { PosterCard } from './PosterCard';
import { NowPlayingBar } from './NowPlayingBar';
import { Rail } from './Rail';
import { TopBar } from './TopBar';
import { Search } from 'lucide-react';
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
import { useUpdateCheck } from '../hooks/useUpdateCheck';
import { openUrl } from '@tauri-apps/plugin-opener';

/** Xtream series URLs end in `/SERIES_ID.ext`; returns null when that is not the case. */
function parseXtreamSeriesId(url: string): number | null {
  const last = url.split('/').pop() ?? '';
  const id = parseInt(last.replace(/\.\w+$/, ''), 10);
  return Number.isNaN(id) ? null : id;
}

const SECTION_TITLES: Record<Section, string> = {
  live: 'Live TV',
  vod: 'Movies',
  series: 'Series',
  favorites: 'Favorites',
  guide: 'TV Guide',
};

// [singular, plural] count nouns per section. While a search spans every
// content type the list is no longer one kind, so it counts "results".
const SECTION_COUNT_NOUNS: Record<Exclude<Section, 'guide'>, [string, string]> = {
  live: ['channel', 'channels'],
  vod: ['title', 'titles'],
  series: ['series', 'series'],
  favorites: ['favorite', 'favorites'],
};
const RESULT_NOUNS: [string, string] = ['result', 'results'];

function countLabel(n: number, [one, many]: [string, string]): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

const guideDateFormat = new Intl.DateTimeFormat(undefined, {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
});
const guideTimeFormat = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

/** "Thursday 24 September · 20:12" in the user's locale; render-time value. */
function guideSubtitle(now: Date): string {
  return `${guideDateFormat.format(now)} · ${guideTimeFormat.format(now)}`;
}

export default function MainScreen() {
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
  // The profile the series was opened under. A series belongs to one
  // provider: after a profile switch its id means nothing to the new one.
  const [seriesPlaylistId, setSeriesPlaylistId] = useState<number | null>(null);
  // Settings becomes a view in Task 15; until then 'settings' is never set
  // and the Settings rail button opens the modal below.
  const [view, setView] = useState<'browse' | 'series' | 'settings'>('browse');
  const [showSettings, setShowSettings] = useState(false);
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  // Which control opened the profile menu, so focus returns there on close.
  const [profileMenuFromRail, setProfileMenuFromRail] = useState(false);
  const railProfileRef = useRef<globalThis.HTMLButtonElement>(null);
  const playlists = usePlayerStore((s) => s.playlists);
  const activeProfileId = usePlayerStore((s) => s.activeProfileId);
  const [showPinModal, setShowPinModal] = useState(false);
  const [pendingChannel, setPendingChannel] = useState<Channel | null>(null);
  const parentRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<globalThis.HTMLInputElement>(null);
  const [showStalePrompt, setShowStalePrompt] = useState(false);
  const [stalePlaylistId, setStalePlaylistId] = useState<number | null>(null);
  const [showRefreshModal, setShowRefreshModal] = useState(false);

  // Global keyboard shortcuts (Space=play/stop, /=focus search, Escape=stop)
  useKeyboardShortcuts(searchInputRef);

  // Responsive grid configuration. Movies and series get the poster grid,
  // but only while browsing them unfiltered: a non-empty search spans every
  // content type (design doc: "search stays cross-type"), so a cross-type
  // result list keeps the live-shaped grid, same as Favorites.
  const update = useUpdateCheck();
  const kind =
    (contentTypeFilter === 'vod' || contentTypeFilter === 'series') &&
    debouncedSearchQuery.trim() === ''
      ? 'poster'
      : 'live';
  const { columns, estimatedRowHeight } = useResponsiveGrid(kind);

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

    const contentType = contentTypeFilter === 'guide' ? 'live' : contentTypeFilter;
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

  // Virtual scrolling setup - virtualize by rows (dynamic items per row).
  // Live and poster rows are genuinely different heights (fixed 208px vs a
  // formula that depends on the viewport and, until Task 13's rail lands,
  // real padding this component doesn't model). `estimatedRowHeight` is only
  // the *initial guess* for a not-yet-rendered row; each row measures its own
  // actual height via `measureElement` below, which is what keeps rows from
  // overlapping when that guess is wrong or when a kind switch would
  // otherwise leave stale cached sizes from the other kind's rows.
  const rowCount = Math.ceil(filteredChannels.length / columns);

  const rowVirtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => parentRef.current,
    estimateSize: () => estimatedRowHeight,
    overscan: 5, // Pre-render 5 rows above/below for smoother scroll on large lists
  });

  // A `kind` (and therefore column count) switch invalidates every cached row
  // measurement: a Live row and a Movies row can coincidentally share the
  // same rowCount, so TanStack Virtual has no other signal that the old
  // sizes no longer apply. Force a remeasure so the new kind's rows don't
  // inherit the previous kind's cached heights.
  useEffect(() => {
    rowVirtualizer.measure();
  }, [kind, columns, rowVirtualizer]);

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
        setSeriesPlaylistId(usePlayerStore.getState().currentPlaylist?.id ?? null);
        setView('series');
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
        if (
          currentPlaylist.url &&
          currentPlaylist.xtream_username &&
          currentPlaylist.xtream_password
        ) {
          await playEpisodeAction(episodeId, extension, title, currentPlaylist, remainingEpisodes);
        } else {
          const ids = (
            remainingEpisodes && remainingEpisodes.length > 0
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
    // Never ask a different profile's provider about this series.
    if (currentPlaylist?.id !== seriesPlaylistId) {
      throw new Error('The series belongs to another profile');
    }
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
  }, [selectedSeries, seriesPlaylistId, currentPlaylist]);

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

  const closeSeries = useCallback(() => {
    setSelectedSeries(null);
    setSeriesPlaylistId(null);
    setView('browse');
  }, []);

  // A profile switch closes the series detail. The render below already
  // hides SeriesView the moment the profiles differ, so it unmounts before
  // its load effect could run with the new profile; this effect then resets
  // the state so the view is really back to browse.
  const currentPlaylistId = currentPlaylist?.id ?? null;
  const seriesOpen =
    view === 'series' && selectedSeries !== null && seriesPlaylistId === currentPlaylistId;
  useEffect(() => {
    if (view === 'series' && seriesPlaylistId !== currentPlaylistId) closeSeries();
  }, [view, seriesPlaylistId, currentPlaylistId, closeSeries]);

  const handleSection = useCallback(
    (section: Section) => {
      setContentTypeFilter(section);
      closeSeries();
    },
    [setContentTypeFilter, closeSeries]
  );

  const handleOpenUpdate = useCallback(() => {
    if (!update) return;
    openUrl(update.url).catch((err) => logger.warn('Failed to open the release page:', err));
  }, [update]);

  const activeProfile = playlists.find((p) => p.id === activeProfileId);
  const profileInitial = activeProfile?.name.trim().charAt(0).toUpperCase() || '?';

  const trimmedQuery = debouncedSearchQuery.trim();

  // Title and count follow the section; the count is the filtered list, not
  // the playlist total.
  let title = SECTION_TITLES[contentTypeFilter];
  let subtitle =
    contentTypeFilter === 'guide'
      ? guideSubtitle(new Date())
      : countLabel(
          filteredChannels.length,
          trimmedQuery ? RESULT_NOUNS : SECTION_COUNT_NOUNS[contentTypeFilter]
        );
  if (view === 'settings') {
    title = 'Settings';
    subtitle = 'Ctrl+1–6 switches sections';
  } else if (seriesOpen && selectedSeries) {
    subtitle = selectedSeries.name;
  }

  return (
    <div className="flex h-screen bg-bg text-text">
      <Rail
        section={contentTypeFilter}
        onSection={handleSection}
        view={view === 'settings' || showSettings ? 'settings' : 'browse'}
        onSettings={() => setShowSettings(true)}
        profileInitial={profileInitial}
        onProfile={() => {
          setProfileMenuFromRail(true);
          setProfileMenuOpen(true);
        }}
        profileButtonRef={railProfileRef}
      />
      <main className="relative flex min-w-0 flex-1 flex-col">
        <TopBar
          title={title}
          subtitle={subtitle}
          searchRef={searchInputRef}
          query={searchQuery}
          onQuery={setSearchQuery}
          update={update}
          onOpenUpdate={handleOpenUpdate}
          showSearch={view === 'browse'}
          profileMenuOpen={profileMenuOpen}
          onProfileMenuOpenChange={(open) => {
            if (open) setProfileMenuFromRail(false);
            setProfileMenuOpen(open);
          }}
          profileMenuReturnFocus={profileMenuFromRail ? railProfileRef : undefined}
        />

        {seriesOpen ? (
          // Its own error screen covers an unparsable Xtream URL.
          <SeriesView
            loadSeries={loadSeries}
            onBack={closeSeries}
            onPlayEpisode={handlePlayEpisode}
          />
        ) : (
          // 'guide' renders the live grid until the TV Guide view (Task 20).
          <>
            <div className="px-10 pt-6">
              <CategoryBar />
            </div>

            {/* Channel list with virtual scrolling */}
            <div
              ref={parentRef}
              className="flex-1 overflow-y-auto px-10 pb-32 pt-5"
              id="channel-list"
              role="region"
              aria-label="Channel list"
            >
              {filteredChannels.length === 0 ? (
                <div className="flex flex-col items-center gap-3 py-16 text-center text-text-muted">
                  {trimmedQuery ? (
                    <>
                      <Search className="h-6 w-6" aria-hidden="true" />
                      <p>No matches for &ldquo;{trimmedQuery}&rdquo;</p>
                    </>
                  ) : (
                    <p>Nothing in this section yet</p>
                  )}
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
                        ref={rowVirtualizer.measureElement}
                        data-index={virtualRow.index}
                        style={{
                          position: 'absolute',
                          top: 0,
                          left: 0,
                          width: '100%',
                          transform: `translateY(${virtualRow.start}px)`,
                        }}
                      >
                        {/* No forced height: the row measures its own real
                            content height via `measureElement` above, since a
                            formula-only estimate drifts from the actual layout
                            (padding, scrollbar). `pb-4` carries the 16px row
                            gap inside the measured element, because rows are
                            absolutely positioned and stacked by `translateY`
                            rather than a normal-flow gap. */}
                        <div className={`grid ${getGridClasses(columns)} gap-4 pb-4`}>
                          {rowItems.map((channel) => {
                            const isChannelBlocked = blockedMap.get(channel.id!) ?? false;

                            return kind === 'poster' ? (
                              <PosterCard
                                key={channel.id}
                                channel={channel}
                                onOpen={handlePlayChannel}
                                onToggleFavorite={toggleChannelFavorite}
                                isBlocked={isChannelBlocked}
                                parentalVisibility={parentalVisibility}
                              />
                            ) : (
                              <ChannelCard
                                key={channel.id}
                                channel={channel}
                                isPlaying={currentChannel?.id === channel.id && isPlaying}
                                onPlay={handlePlayChannel}
                                onToggleFavorite={toggleChannelFavorite}
                                epg={channelEpgData.get(channel.id)}
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
          </>
        )}

        {/* Now Playing Bar */}
        {currentChannel && (
          <NowPlayingBar
            channel={currentChannel}
            epg={channelEpgData.get(currentChannel.id)}
            currentProgram={currentProgram}
            nextProgram={nextProgram}
            onStop={handleStop}
          />
        )}
      </main>

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
