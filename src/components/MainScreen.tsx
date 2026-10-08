import { useEffect, useLayoutEffect, useState, useRef, useCallback, useMemo } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { usePlayerStore, type Section } from '../stores/player-store';
import {
  getChannelGroups,
  getStalePlaylistIds,
  getChannels,
  getSeriesInfo,
  getXtreamSeriesId,
  getLocalSeriesInfo,
  getTmdbStatus,
  type TmdbDetails,
  type TmdbStatus,
} from '../lib/tauri';
import { CategoryBar } from './CategoryBar';
import { GuideView } from './GuideView';
import { HomeView } from './HomeView';
import { ChannelCard } from './ChannelCard';
import { PosterCard } from './PosterCard';
import { MoviesHero } from './MoviesHero';
import { NowPlayingBar } from './NowPlayingBar';
import { Toast } from './Toast';
import { Rail } from './Rail';
import { TopBar } from './TopBar';
import { Search } from 'lucide-react';
import DetailView from './DetailView';
import Settings, { type SettingsHandle } from './Settings';
import PinEntryModal from './modals/PinEntryModal';
import ConfirmationModal from './modals/ConfirmationModal';
import RefreshModal from './modals/RefreshModal';
import TmdbMatchModal from './modals/TmdbMatchModal';
import { cardFromDetails } from '../lib/tmdb';
import type { Channel, SeriesInfo } from '../types';
import { logger } from '../lib/logger';
import { useResponsiveGrid, getGridClasses } from '../hooks/useResponsiveGrid';
import { useEpgData } from '../hooks/useEpgData';
import { useKeyboardShortcuts } from '../hooks/useKeyboardShortcuts';
import { useChannelPlayback } from '../hooks/useChannelPlayback';
import { isAdultContent, shouldBlockChannel } from '../lib/parentalControls';
import { useDebouncedValue } from '../hooks/useDebouncedValue';
import { useChannelFilter } from '../hooks/useChannelFilter';
import { useUpdateCheck } from '../hooks/useUpdateCheck';
import { useTmdbCards } from '../hooks/useTmdbCards';
import { useHomeRows } from '../hooks/useHomeRows';
import type { HomePickView } from './HomeView';
import { openUrl } from '@tauri-apps/plugin-opener';
import { newestTitles } from '../lib/newestTitle';

const SECTION_TITLES: Record<Section, string> = {
  home: 'Home',
  live: 'Live TV',
  vod: 'Movies',
  series: 'Series',
  favorites: 'Favorites',
  guide: 'TV Guide',
};

/** Slides shown per Home row after parental filtering; the backend sends twelve. */
const HOME_SLIDES = 8;
/** A Home row with fewer visible slides than this is dropped. */
const HOME_MIN_SLIDES = 3;

// [singular, plural] count nouns per section. While a search spans every
// content type the list is no longer one kind, so it counts "results".
const SECTION_COUNT_NOUNS: Record<Exclude<Section, 'guide' | 'home'>, [string, string]> = {
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

  // TMDB status drives the Home gate: feature on, own key, background scan on.
  const [tmdbStatus, setTmdbStatus] = useState<TmdbStatus | null>(null);
  const refreshTmdbStatus = useCallback(() => {
    getTmdbStatus()
      .then(setTmdbStatus)
      .catch((err) => logger.warn('Failed to read TMDB status:', err));
  }, []);
  useEffect(() => {
    refreshTmdbStatus();
  }, [refreshTmdbStatus, currentPlaylist?.id]);
  const homeAvailable = Boolean(
    tmdbStatus?.enabled && tmdbStatus.has_user_key && tmdbStatus.background_enrich
  );

  // Start on Home once, when the first status arrives and the user is still
  // on the default section. Any later status change only closes the gate.
  const startSectionDecided = useRef(false);
  useEffect(() => {
    if (startSectionDecided.current || tmdbStatus === null) return;
    startSectionDecided.current = true;
    if (homeAvailable && usePlayerStore.getState().contentTypeFilter === 'live') {
      setContentTypeFilter('home');
    }
  }, [tmdbStatus, homeAvailable, setContentTypeFilter]);

  // The movie or series open in the detail view.
  const [detailChannel, setDetailChannel] = useState<Channel | null>(null);
  // The profile the title was opened under. A title belongs to one
  // provider: after a profile switch its id means nothing to the new one.
  const [detailPlaylistId, setDetailPlaylistId] = useState<number | null>(null);
  const [view, setView] = useState<'browse' | 'detail' | 'settings'>('browse');
  // Manual TMDB re-match: the title being matched, and the details the
  // dialog stored, handed to DetailView so it shows them without a reload.
  const [matchTarget, setMatchTarget] = useState<{ channel: Channel; query: string } | null>(null);
  const [matchOverride, setMatchOverride] = useState<TmdbDetails | null>(null);
  const setTmdbCards = usePlayerStore((s) => s.setTmdbCards);
  // Which Settings section opens with the view (the guide's empty state asks for 'epg').
  const [settingsTab, setSettingsTab] = useState('general');
  // The section G and Escape return to when leaving the guide.
  const guideReturnRef = useRef<Exclude<Section, 'guide'>>('live');
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  // Which control opened the profile menu, so focus returns there on close.
  const [profileMenuFromRail, setProfileMenuFromRail] = useState(false);
  const railProfileRef = useRef<globalThis.HTMLButtonElement>(null);
  // Open Settings' unsaved-edits check; leaving the view goes through it.
  const settingsRef = useRef<SettingsHandle>(null);
  const playlists = usePlayerStore((s) => s.playlists);
  const activeProfileId = usePlayerStore((s) => s.activeProfileId);
  const [showPinModal, setShowPinModal] = useState(false);
  const [pendingChannel, setPendingChannel] = useState<Channel | null>(null);
  // True when the PIN was asked for opening the detail view, not for playing.
  const [pendingOpen, setPendingOpen] = useState(false);
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

    if (contentTypeFilter === 'favorites' || contentTypeFilter === 'home') {
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

  const channels = usePlayerStore((s) => s.channels);
  const {
    rows: homeRows,
    pick: homePick,
    loading: homeLoading,
    progress: homeProgress,
  } = useHomeRows(currentPlaylist?.id ?? null, homeAvailable && contentTypeFilter === 'home');
  const channelById = useMemo(() => {
    const map = new Map<number, Channel>();
    for (const c of channels) if (c.id) map.set(c.id, c);
    return map;
  }, [channels]);
  // Same rule as the hero: `isAdultContent` regardless of the parental
  // settings, plus the parental block. The backend sends twelve per row so
  // eight usually survive; a row under three is dropped.
  const homeParental = useMemo(
    () => ({
      enabled: parentalEnabled,
      autoDetect: parentalAutoDetect,
      blockedIds: blockedChannelIds,
      blockedCategories,
      unlocked: parentalUnlocked,
    }),
    [parentalEnabled, parentalAutoDetect, blockedChannelIds, blockedCategories, parentalUnlocked]
  );
  const homeVisibleRows = useMemo(() => {
    return homeRows
      .map((row) => ({
        ...row,
        items: row.items
          .filter((item) => {
            const c = channelById.get(item.channel_id);
            return (
              c !== undefined &&
              !isAdultContent(c.name, c.group_name) &&
              !shouldBlockChannel(c, homeParental)
            );
          })
          .slice(0, HOME_SLIDES),
      }))
      .filter((row) => row.items.length >= HOME_MIN_SLIDES);
  }, [homeRows, channelById, homeParental]);
  // The pick goes through the same parental rule as the rows; a blocked or
  // unknown title means no hero rather than a fallback.
  const homePickView = useMemo<HomePickView | null>(() => {
    if (!homePick) return null;
    const channel = channelById.get(homePick.item.channel_id);
    if (
      !channel ||
      isAdultContent(channel.name, channel.group_name) ||
      shouldBlockChannel(channel, homeParental)
    ) {
      return null;
    }
    return {
      channel,
      card: homePick.item,
      note:
        homePick.source === 'trending' ? 'Trending on TMDB today' : 'Highest rated in your library',
    };
  }, [homePick, channelById, homeParental]);

  // The "Recently added" hero: the newest title of the Movies or Series
  // section, shown only while browsing it unfiltered (no category, no
  // search). Two guards keep it from ever featuring the wrong thing:
  // 1. `isAdultContent` runs regardless of the parental settings (the hero
  //    is a full-width showcase, not a list entry), on top of the parental
  //    block map for lock/blur mode (hide already removed those).
  // 2. Only a title with a TMDB match is shown. TMDB searches run with
  //    `include_adult=false`, so anything the name heuristic misses never
  //    gets a card. Until the newest candidate's card has arrived the hero
  //    stays hidden rather than showing provider art; `heroWarmupIds` below
  //    asks for the candidates as soon as channels load, so this is a one-off
  //    per profile.
  const HERO_CANDIDATES = 10;
  const tmdbCards = usePlayerStore((s) => s.tmdbCards);
  const vodChannels = usePlayerStore((s) => s.vodChannels);
  const seriesChannels = usePlayerStore((s) => s.seriesChannels);
  const heroSafe = (c: Channel) => !isAdultContent(c.name, c.group_name);
  const heroWarmupIds = useMemo(
    () =>
      [
        ...newestTitles(vodChannels.filter(heroSafe), HERO_CANDIDATES),
        ...newestTitles(seriesChannels.filter(heroSafe), HERO_CANDIDATES),
      ].map((c) => c.id),
    [vodChannels, seriesChannels]
  );
  // The candidates depend on the list alone. Each arriving TMDB card (up to
  // five a second during the background scan) only re-checks these ten
  // instead of re-ranking the whole section.
  const heroCandidates = useMemo(() => {
    if (
      (contentTypeFilter !== 'vod' && contentTypeFilter !== 'series') ||
      categoryFilter ||
      trimmedQuery !== ''
    ) {
      return [];
    }
    const eligible = filteredChannels.filter((c) => !blockedMap.get(c.id!) && heroSafe(c));
    return newestTitles(eligible, HERO_CANDIDATES);
  }, [contentTypeFilter, categoryFilter, trimmedQuery, filteredChannels, blockedMap]);
  const heroChannel = useMemo(
    () => heroCandidates.find((c) => tmdbCards.has(c.id)) ?? null,
    [heroCandidates, tmdbCards]
  );
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

  // A new list starts at the top: switching section, picking a category
  // chip, or starting/clearing a search all replace `filteredChannels`, and
  // a scroll offset left over from the previous list would land the user
  // somewhere arbitrary in the new one. Returning from the detail view is
  // not a new list, so it keeps its place (nothing here changes then).
  // The virtualiser's offset is reset during render, before it picks the
  // rows below, so the first render of the new list already starts at the
  // top instead of mounting rows at the old list's depth. The DOM follows
  // before paint.
  const listKey = `${contentTypeFilter}\u0000${categoryFilter ?? ''}\u0000${trimmedQuery}`;
  const [renderedListKey, setRenderedListKey] = useState(listKey);
  if (renderedListKey !== listKey) {
    setRenderedListKey(listKey);
    rowVirtualizer.scrollOffset = 0;
  }
  useLayoutEffect(() => {
    if (parentRef.current) parentRef.current.scrollTop = 0;
  }, [listKey]);

  // The cards in view, overscan included. They feed the EPG and TMDB lookups,
  // so a 15,000-channel list only ever asks about what is on screen.
  const virtualItems = rowVirtualizer.getVirtualItems();
  const visibleChannels = useMemo(() => {
    const out: Channel[] = [];
    for (const row of virtualItems) {
      if (showHero && row.index === 0) continue;
      const start = (showHero ? row.index - 1 : row.index) * columns;
      for (let i = start; i < Math.min(start + columns, filteredChannels.length); i++) {
        out.push(filteredChannels[i]);
      }
    }
    return out;
  }, [virtualItems, showHero, columns, filteredChannels]);

  // EPG for the live cards in view. The playing channel always rides along so
  // the dock stays fresh, also in sections without a grid.
  const { channelEpgData } = useEpgData(visibleChannels, currentChannel);

  // Visible poster rows feed the TMDB lookup, after the hero candidates of
  // both sections so the banner is warm before its section opens. Live rows
  // never do.
  const visibleCardIds = useMemo(() => {
    const ids: number[] = [...heroWarmupIds];
    for (const c of visibleChannels) {
      // Live rows (search results, Favorites) still hold movies and series.
      if (kind === 'poster' || c.content_type !== 'live') ids.push(c.id);
    }
    return ids;
  }, [kind, heroWarmupIds, visibleChannels]);
  useTmdbCards(visibleCardIds);

  const openDetail = useCallback((channel: Channel) => {
    setDetailChannel(channel);
    setDetailPlaylistId(usePlayerStore.getState().currentPlaylist?.id ?? null);
    setMatchOverride(null);
    setView('detail');
  }, []);

  // Poster click: parental check, then the detail view (movies and series).
  const handleOpenTitle = useCallback(
    (channel: Channel) => {
      const s = usePlayerStore.getState();
      const isBlocked = shouldBlockChannel(channel, {
        enabled: s.parentalEnabled,
        autoDetect: s.parentalAutoDetect,
        blockedIds: s.blockedChannelIds,
        blockedCategories: s.blockedCategories,
        unlocked: s.parentalUnlocked,
      });
      if (isBlocked) {
        setPendingChannel(channel);
        setPendingOpen(true);
        setShowPinModal(true);
        return;
      }
      openDetail(channel);
    },
    [openDetail]
  );

  const handleOpenHomeItem = useCallback(
    (channelId: number) => {
      const channel = channelById.get(channelId);
      if (channel) handleOpenTitle(channel);
    },
    [channelById, handleOpenTitle]
  );

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
        setPendingOpen(false);
        setShowPinModal(true);
        return;
      }

      const result = await playChannelAction(channel);
      if (result?.type === 'series') openDetail(result.channel);
    },
    [playChannelAction, openDetail]
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
  // the episodes grouped at import. Memoised: DetailView re-loads when it changes.
  const loadSeries = useCallback(async (): Promise<SeriesInfo> => {
    if (!detailChannel) throw new Error('No series selected');
    if (detailChannel.content_type !== 'series') throw new Error('Not a series');
    // Never ask a different profile's provider about this series.
    if (currentPlaylist?.id !== detailPlaylistId) {
      throw new Error('The series belongs to another profile');
    }
    const url = currentPlaylist?.url;
    const username = currentPlaylist?.xtream_username;
    const password = currentPlaylist?.xtream_password;
    if (url && username && password) {
      const seriesId = await getXtreamSeriesId(detailChannel.id);
      if (seriesId === null) {
        logger.error('No Xtream series id in the URL of channel', detailChannel.id);
        throw new Error('Failed to load series: Invalid URL format');
      }
      return getSeriesInfo(url, username, password, seriesId);
    }
    return getLocalSeriesInfo(detailChannel.id);
  }, [detailChannel, detailPlaylistId, currentPlaylist]);
  // Movies have nothing to load; DetailView skips the loader when it is absent.
  const seriesLoader = detailChannel?.content_type === 'series' ? loadSeries : undefined;

  const handlePinSuccess = useCallback(() => {
    setShowPinModal(false);
    if (pendingChannel) {
      if (pendingOpen) {
        openDetail(pendingChannel);
        setPendingChannel(null);
        return;
      }
      playChannelAction(pendingChannel)
        .then(() => {
          setPendingChannel(null);
        })
        .catch((err) => {
          logger.error('Failed to play channel after PIN:', err);
        });
    }
  }, [pendingChannel, pendingOpen, openDetail, playChannelAction]);

  const handleStop = useCallback(async () => {
    await stopPlaybackAction();
  }, [stopPlaybackAction]);

  const closeDetail = useCallback(() => {
    setDetailChannel(null);
    setDetailPlaylistId(null);
    setMatchOverride(null);
    setView('browse');
  }, []);

  const handleFixMatch = useCallback((channel: Channel, details: TmdbDetails) => {
    setMatchTarget({ channel, query: details.title ?? channel.name });
  }, []);

  // Fresh details (the load or a re-match) update the grid card too. A manual
  // no-match yields no card, so the grid keeps the old one until the next
  // profile switch; the detail view already shows the provider data.
  const handleDetails = useCallback(
    (details: TmdbDetails) => {
      if (!detailChannel) return;
      const card = cardFromDetails(detailChannel.id, details);
      if (card) setTmdbCards([card]);
    },
    [detailChannel, setTmdbCards]
  );

  // A profile switch closes the detail view. The render below already
  // hides DetailView the moment the profiles differ, so it unmounts before
  // its load effect could run with the new profile; this effect then resets
  // the state so the view is really back to browse.
  const currentPlaylistId = currentPlaylist?.id ?? null;
  const detailOpen =
    view === 'detail' && detailChannel !== null && detailPlaylistId === currentPlaylistId;
  useEffect(() => {
    if (view === 'detail' && detailPlaylistId !== currentPlaylistId) closeDetail();
  }, [view, detailPlaylistId, currentPlaylistId, closeDetail]);

  const handleSection = useCallback(
    (section: Section) => {
      const from = usePlayerStore.getState().contentTypeFilter;
      if (section === 'guide' && from !== 'guide') guideReturnRef.current = from;
      setContentTypeFilter(section);
      closeDetail();
    },
    [setContentTypeFilter, closeDetail]
  );

  // The gate closed while Home was open (scan or key turned off in Settings).
  useEffect(() => {
    if (tmdbStatus !== null && !homeAvailable && contentTypeFilter === 'home') {
      handleSection('live');
    }
  }, [tmdbStatus, homeAvailable, contentTypeFilter, handleSection]);

  // Settings' Metadata tab can change any of the three gate inputs. Whatever
  // way the view leaves 'settings' (Escape, the Close button, or a rail
  // section click that goes through leaveSettingsThen), refresh the status
  // once, in this one place, so the gate and rail entry reflect the change.
  const prevView = useRef(view);
  useEffect(() => {
    if (prevView.current === 'settings' && view !== 'settings') refreshTmdbStatus();
    prevView.current = view;
  }, [view, refreshTmdbStatus]);

  // "/" on Home, where there is no search box: go to Live TV, then focus.
  const focusSearchPending = useRef(false);
  // Only while browsing: Settings and the detail view have no search box
  // either, and leaving them here would skip Settings' discard check.
  const handleSearchUnavailable = useCallback(() => {
    if (view !== 'browse' || contentTypeFilter !== 'home') return;
    focusSearchPending.current = true;
    handleSection('live');
  }, [view, contentTypeFilter, handleSection]);
  useEffect(() => {
    if (focusSearchPending.current && contentTypeFilter !== 'home') {
      focusSearchPending.current = false;
      searchInputRef.current?.focus();
    }
  }, [contentTypeFilter]);

  // Navigating away from Settings asks it first: unsaved edits get a
  // "Discard changes?" dialog, and `go` runs only on Discard.
  const leaveSettingsThen = useCallback(
    (go: () => void) => {
      if (view === 'settings' && settingsRef.current) settingsRef.current.requestLeave(go);
      else go();
    },
    [view]
  );

  // A rail or G section change also clears the search: it spans every
  // content type, so a leftover query would make the new section look empty.
  const handleRailSection = useCallback(
    (section: Section) =>
      leaveSettingsThen(() => {
        setSearchQuery('');
        handleSection(section);
      }),
    [leaveSettingsThen, handleSection, setSearchQuery]
  );

  const openSettings = useCallback((tab = 'general') => {
    setSettingsTab(tab);
    setView('settings');
  }, []);

  // G: guide <-> the section it was entered from. Settings keeps G to itself
  // (its text fields and Ctrl+1-7), so the toggle does nothing there.
  const handleToggleGuide = useCallback(() => {
    if (view === 'settings') return;
    setSearchQuery('');
    if (contentTypeFilter === 'guide') {
      handleSection(guideReturnRef.current);
    } else {
      handleSection('guide');
    }
  }, [view, contentTypeFilter, handleSection, setSearchQuery]);

  // Escape, after Settings / the profile menu / the guide's detail panel had
  // their chance (they preventDefault). True means "handled, keep playing".
  // Settings closes itself (respecting its inner dialogs), so a 'settings'
  // view only swallows the key here.
  const handleEscapeView = useCallback((): boolean => {
    if (view === 'settings') return true;
    if (detailOpen) {
      closeDetail();
      return true;
    }
    if (contentTypeFilter === 'guide') {
      handleSection(guideReturnRef.current);
      return true;
    }
    return false;
  }, [view, detailOpen, closeDetail, contentTypeFilter, handleSection]);

  // Global keyboard shortcuts (Space=play/stop, /=focus search, G=guide,
  // Escape=close view, else stop)
  useKeyboardShortcuts(searchInputRef, {
    onToggleGuide: handleToggleGuide,
    onEscapeView: handleEscapeView,
    onSearchUnavailable: handleSearchUnavailable,
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
      : contentTypeFilter === 'home'
        ? ''
        : countLabel(
            filteredChannels.length,
            trimmedQuery ? RESULT_NOUNS : SECTION_COUNT_NOUNS[contentTypeFilter]
          );
  if (view === 'settings') {
    title = 'Settings';
    subtitle = 'Ctrl+1–7 switches sections';
  } else if (detailOpen && detailChannel) {
    subtitle = detailChannel.name;
  }

  return (
    <div className="flex h-screen bg-bg text-text">
      <Rail
        section={contentTypeFilter}
        onSection={handleRailSection}
        view={view === 'settings' ? 'settings' : 'browse'}
        onSettings={() => openSettings()}
        profileInitial={profileInitial}
        onProfile={() => {
          setProfileMenuFromRail(true);
          setProfileMenuOpen(true);
        }}
        profileButtonRef={railProfileRef}
        homeAvailable={homeAvailable}
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
          showSearch={view === 'browse' && contentTypeFilter !== 'home'}
          profileMenuOpen={profileMenuOpen}
          onProfileMenuOpenChange={(open) => {
            if (open) setProfileMenuFromRail(false);
            setProfileMenuOpen(open);
          }}
          profileMenuReturnFocus={profileMenuFromRail ? railProfileRef : undefined}
        />

        {view === 'settings' ? (
          <Settings
            onClose={() => {
              setView('browse');
            }}
            initialTab={settingsTab}
            leaveRef={settingsRef}
          />
        ) : detailOpen && detailChannel ? (
          // Its own error screen covers an unparsable Xtream URL.
          <DetailView
            key={detailChannel.id}
            channel={detailChannel}
            loadSeries={seriesLoader}
            onBack={closeDetail}
            onPlay={handlePlayChannel}
            onPlayEpisode={handlePlayEpisode}
            onToggleFavorite={toggleChannelFavorite}
            isPlaying={isPlaying && currentChannel?.id === detailChannel.id}
            onFixMatch={handleFixMatch}
            onDetails={handleDetails}
            detailsOverride={matchOverride}
          />
        ) : contentTypeFilter === 'home' ? (
          <HomeView
            pick={homePickView}
            onPlay={handlePlayChannel}
            onOpenTitle={handleOpenTitle}
            isPlaying={isPlaying && currentChannel?.id === homePickView?.channel.id}
            rows={homeVisibleRows}
            loading={homeLoading}
            progress={homeProgress ?? tmdbStatus?.background_progress ?? null}
            onOpen={handleOpenHomeItem}
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
                  {virtualItems.map((virtualRow) => {
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
                            <MoviesHero
                              channel={heroChannel!}
                              onPlay={handlePlayChannel}
                              onOpen={handleOpenTitle}
                              isPlaying={isPlaying && currentChannel?.id === heroChannel!.id}
                              tmdb={tmdbCards.get(heroChannel!.id)}
                            />
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
                                onOpen={handleOpenTitle}
                                onPlay={handlePlayChannel}
                                tmdb={tmdbCards.get(channel.id)}
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
                                tmdb={tmdbCards.get(channel.id)}
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

        {/* Now Playing Bar. Not over Settings, where it would cover Save and
            Cancel; playback carries on and the dock returns on leaving. */}
        {currentChannel && view !== 'settings' && (
          <NowPlayingBar
            channel={currentChannel}
            epg={channelEpgData.get(currentChannel.id)}
            currentProgram={currentProgram}
            nextProgram={nextProgram}
            onStop={handleStop}
          />
        )}
        <Toast aboveDock={Boolean(currentChannel) && view !== 'settings'} />
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

      <TmdbMatchModal
        isOpen={matchTarget !== null}
        channel={matchTarget?.channel ?? null}
        initialQuery={matchTarget?.query ?? ''}
        onClose={() => setMatchTarget(null)}
        onMatched={(details) => setMatchOverride(details)}
      />

      {/* Stale playlist prompt */}
      <ConfirmationModal
        isOpen={showStalePrompt}
        onClose={() => setShowStalePrompt(false)}
        onConfirm={() => {
          setShowStalePrompt(false);
          setShowRefreshModal(true);
        }}
        title="Playlist update available"
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
