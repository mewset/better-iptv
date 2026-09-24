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
import { GuideView } from './GuideView';
import { ChannelCard } from './ChannelCard';
import { PosterCard } from './PosterCard';
import { MoviesHero } from './MoviesHero';
import { NowPlayingBar } from './NowPlayingBar';
import { Rail } from './Rail';
import { TopBar } from './TopBar';
import { Search } from 'lucide-react';
import SeriesView from './SeriesView';
import Settings from './Settings';
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
import { newestTitle } from '../lib/newestTitle';

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
  const categoryFilter = usePlayerStore((s) => s.categoryFilter);
  const setSearchQuery = usePlayerStore((s) => s.setSearchQuery);
  const setContentTypeFilter = usePlayerStore((s) => s.setContentTypeFilter);
  const setCategories = usePlayerStore((s) => s.setCategories);
  const debouncedSearchQuery = useDebouncedValue(searchQuery, 300);
  const trimmedQuery = debouncedSearchQuery.trim();

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
  const [view, setView] = useState<'browse' | 'series' | 'settings'>('browse');
  // Which Settings section opens with the view (the guide's empty state asks for 'epg').
  const [settingsTab, setSettingsTab] = useState('general');
  // The section G and Escape return to when leaving the guide.
  const guideReturnRef = useRef<Exclude<Section, 'guide'>>('live');
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

  // The "Recently added" hero: the newest Movies title, shown only while
  // browsing Movies unfiltered (no category, no search) - the same
  // conditions that give `kind === 'poster'` for this section, plus "a
  // newest title exists". A blocked title (parental hide/lock/blur) is never
  // the hero; hide mode already removes blocked channels from
  // `filteredChannels`, but lock/blur keep them in the list with `blockedMap`
  // flagging them, so this excludes those explicitly.
  const heroChannel = useMemo(() => {
    if (contentTypeFilter !== 'vod' || categoryFilter || trimmedQuery !== '') return null;
    const eligible = filteredChannels.filter((c) => !blockedMap.get(c.id!));
    return newestTitle(eligible);
  }, [contentTypeFilter, categoryFilter, trimmedQuery, filteredChannels, blockedMap]);
  const showHero = heroChannel !== null;

  // Virtual scrolling setup - virtualize by rows (dynamic items per row).
  // Live and poster rows are genuinely different heights (fixed 208px vs a
  // formula that depends on the viewport and, until Task 13's rail lands,
  // real padding this component doesn't model). `estimatedRowHeight` is only
  // the *initial guess* for a not-yet-rendered row; each row measures its own
  // actual height via `measureElement` below, which is what keeps rows from
  // overlapping when that guess is wrong or when a kind switch would
  // otherwise leave stale cached sizes from the other kind's rows.
  //
  // The hero (when shown) is virtual row 0, ahead of every card row: card
  // rows shift by one so their `startIndex` math still lines up with
  // `filteredChannels`. Its `272 + 20` estimate is only the initial guess -
  // like every other row, it measures its own real height via
  // `measureElement`.
  const gridRowCount = Math.ceil(filteredChannels.length / columns);
  const rowCount = gridRowCount + (showHero ? 1 : 0);

  const rowVirtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => parentRef.current,
    estimateSize: (index) => (showHero && index === 0 ? 272 + 20 : estimatedRowHeight),
    overscan: 5, // Pre-render 5 rows above/below for smoother scroll on large lists
  });

  // A `kind` (and therefore column count) switch invalidates every cached row
  // measurement: a Live row and a Movies row can coincidentally share the
  // same rowCount, so TanStack Virtual has no other signal that the old
  // sizes no longer apply. Force a remeasure so the new kind's rows don't
  // inherit the previous kind's cached heights. Showing/hiding the hero shifts
  // every card row's index by one, which needs the same remeasure.
  useEffect(() => {
    rowVirtualizer.measure();
  }, [kind, columns, showHero, rowVirtualizer]);

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
      const from = usePlayerStore.getState().contentTypeFilter;
      if (section === 'guide' && from !== 'guide') guideReturnRef.current = from;
      setContentTypeFilter(section);
      closeSeries();
    },
    [setContentTypeFilter, closeSeries]
  );

  const openSettings = useCallback((tab = 'general') => {
    setSettingsTab(tab);
    setView('settings');
  }, []);

  // G: guide <-> the section it was entered from. Settings keeps G to itself
  // (its text fields and Ctrl+1-6), so the toggle does nothing there.
  const handleToggleGuide = useCallback(() => {
    if (view === 'settings') return;
    if (contentTypeFilter === 'guide') {
      handleSection(guideReturnRef.current);
    } else {
      handleSection('guide');
    }
  }, [view, contentTypeFilter, handleSection]);

  // Escape, after Settings / the profile menu / the guide's detail panel had
  // their chance (they preventDefault). True means "handled, keep playing".
  // Settings closes itself (respecting its inner dialogs), so a 'settings'
  // view only swallows the key here.
  const handleEscapeView = useCallback((): boolean => {
    if (view === 'settings') return true;
    if (seriesOpen) {
      closeSeries();
      return true;
    }
    if (contentTypeFilter === 'guide') {
      handleSection(guideReturnRef.current);
      return true;
    }
    return false;
  }, [view, seriesOpen, closeSeries, contentTypeFilter, handleSection]);

  // Global keyboard shortcuts (Space=play/stop, /=focus search, G=guide,
  // Escape=close view, else stop)
  useKeyboardShortcuts(searchInputRef, {
    onToggleGuide: handleToggleGuide,
    onEscapeView: handleEscapeView,
  });

  const handleOpenUpdate = useCallback(() => {
    if (!update) return;
    openUrl(update.url).catch((err) => logger.warn('Failed to open the release page:', err));
  }, [update]);

  const activeProfile = playlists.find((p) => p.id === activeProfileId);
  const profileInitial = activeProfile?.name.trim().charAt(0).toUpperCase() || '?';

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
        view={view === 'settings' ? 'settings' : 'browse'}
        onSettings={() => openSettings()}
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

        {view === 'settings' ? (
          <Settings onClose={() => setView('browse')} initialTab={settingsTab} />
        ) : seriesOpen ? (
          // Its own error screen covers an unparsable Xtream URL.
          <SeriesView
            loadSeries={loadSeries}
            onBack={closeSeries}
            onPlayEpisode={handlePlayEpisode}
          />
        ) : contentTypeFilter === 'guide' ? (
          <GuideView
            channels={filteredChannels}
            playingChannelId={isPlaying ? (currentChannel?.id ?? null) : null}
            onPlay={handlePlayChannel}
            onOpenEpgSettings={() => openSettings('epg')}
            dockVisible={Boolean(currentChannel)}
            blockedMap={blockedMap}
          />
        ) : (
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
                    const isHeroRow = showHero && virtualRow.index === 0;

                    if (isHeroRow) {
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
                          {/* pb-5 (20px) carries the gap below the hero, the
                              same estimate the virtualiser's initial guess
                              uses (272 + 20); the row still measures its own
                              real height via `measureElement` above. */}
                          <div className="pb-5">
                            <MoviesHero channel={heroChannel!} onPlay={handlePlayChannel} />
                          </div>
                        </div>
                      );
                    }

                    const cardRowIndex = showHero ? virtualRow.index - 1 : virtualRow.index;
                    const startIndex = cardRowIndex * columns;
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
