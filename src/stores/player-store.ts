import { create } from 'zustand';
import type { StoreApi } from 'zustand';
import type { Channel, Playlist, SeriesInfo } from '../types';
import {
  getChannels,
  getParentalSettings,
  LIBRARY_TYPES,
  LIVE_TYPES,
  toggleFavorite,
} from '../lib/tauri';
import type { TmdbCard, TmdbStatus } from '../lib/tauri';
import { applyEpgKeys } from '../lib/epgKeys';
import { logger } from '../lib/logger';

/**
 * A section of the app the user is browsing: the destinations behind the
 * icon rail (Home, Live TV, Movies, Series, Favorites, TV Guide). There is
 * no catch-all 'all' section. Home exists only while the TMDB background
 * scan runs with the user's own key.
 */
export type Section = 'home' | 'live' | 'vod' | 'series' | 'favorites' | 'guide';

/** Progress of one part of the channel list: live, or the library (vod + series). */
export type ChannelLoadStatus = 'loading' | 'loaded' | 'error';

/**
 * Bumped by loadChannels and setChannels. A load whose token is no longer
 * current was superseded and drops its results, including its status.
 */
let channelLoadToken = 0;

/** Guide keys of one playlist, as `get_channel_epg_keys` returns them. */
export interface EpgKeys {
  playlistId: number;
  pairs: Array<[number, string]>;
}

/**
 * The state after setting guide keys on the channels held (`applyEpgKeys`):
 * only live channels change, so the vod and series lists keep their
 * identity, and nothing changes at all when every key already holds.
 */
function withEpgKeys(state: PlayerState, pairs: EpgKeys['pairs']): Partial<PlayerState> {
  const channels = applyEpgKeys(state.channels, pairs);
  if (channels === state.channels) return {};
  const result: Partial<PlayerState> = {
    channels,
    liveChannels:
      state.liveChannels === state.channels
        ? channels
        : channels.filter((c) => c.content_type === 'live'),
    favoriteChannels: channels.filter((c) => c.is_favorite),
  };
  // The dock reads the playing channel's key; it may be a copy of the row.
  const current = state.currentChannel;
  if (current?.content_type === 'live') {
    const row = channels.find((c) => c.id === current.id);
    if (row && (row.epg_id ?? undefined) !== (current.epg_id ?? undefined)) {
      result.currentChannel = { ...current, epg_id: row.epg_id };
    }
  }
  return result;
}

/** Starts a load: takes a new token and returns the guard that says whether it may still write. */
function beginChannelLoad(playlistId: number): () => boolean {
  const token = ++channelLoadToken;
  return () =>
    token === channelLoadToken && usePlayerStore.getState().currentPlaylist?.id === playlistId;
}

/**
 * Fetches the library part (vod + series) and merges it after the live part
 * in state. Shared by loadChannels and the library-only retry.
 */
async function loadLibraryPart(
  playlistId: number,
  isCurrent: () => boolean,
  set: StoreApi<PlayerState>['setState']
): Promise<void> {
  let library: Channel[];
  try {
    library = await getChannels(playlistId, LIBRARY_TYPES);
  } catch (error) {
    if (!isCurrent()) return;
    logger.error('Failed to load library channels:', error);
    set({ channelLoad: { live: 'loaded', library: 'error' } });
    return;
  }
  if (!isCurrent()) return;
  // Favourites toggled while these titles were not in state yet win over the response
  const pending = usePlayerStore.getState().pendingFavorites;
  const withPending = (c: Channel): Channel => {
    const value = pending.get(c.id);
    return value === undefined || value === c.is_favorite ? c : { ...c, is_favorite: value };
  };
  const vodChannels = library.filter((c) => c.content_type === 'vod').map(withPending);
  const seriesChannels = library.filter((c) => c.content_type === 'series').map(withPending);

  // Merge onto liveChannels from state, not a response: a favourite toggled
  // in between must survive, and liveChannels keeps its identity
  set((state) => {
    const channels = [...state.liveChannels, ...vodChannels, ...seriesChannels];
    return {
      channels,
      vodChannels,
      seriesChannels,
      favoriteChannels: channels.filter((c) => c.is_favorite),
      pendingFavorites: new Map<number, boolean>(),
      channelLoad: { live: 'loaded', library: 'loaded' },
    };
  });
}

interface PlayerState {
  // Playlists
  playlists: Playlist[];
  currentPlaylist: Playlist | null;
  activeProfileId: number | null;
  setPlaylists: (playlists: Playlist[]) => void;
  setCurrentPlaylist: (playlist: Playlist | null) => void;
  setActiveProfileId: (id: number | null) => void;

  // Channels
  channels: Channel[];
  currentChannel: Channel | null;
  // Pre-filtered channels by type (for instant tab switching)
  liveChannels: Channel[];
  vodChannels: Channel[];
  seriesChannels: Channel[];
  favoriteChannels: Channel[];
  /**
   * Favourite values set for titles that were not in `channels` yet (Home can
   * open a vod/series title before the library part arrives). The library
   * merge applies them; setChannels and loadChannels clear them.
   */
  pendingFavorites: Map<number, boolean>;
  /** Live and library status; setChannels marks both loaded. */
  channelLoad: { live: ChannelLoadStatus; library: ChannelLoadStatus };
  /**
   * Guide keys that arrived while the live part was loading: that load may
   * have read the channels before the match that sent them, so they are
   * set on its live part when it lands.
   */
  pendingEpgKeys: EpgKeys | null;
  setChannels: (channels: Channel[]) => void;
  /** Fetches live channels, then the library, and merges them. Never rejects. */
  loadChannels: (playlistId: number) => Promise<void>;
  /** Refetches only the library after a library-only error, else loadChannels for the current playlist. */
  retryChannels: () => Promise<void>;
  setCurrentChannel: (channel: Channel | null) => void;
  /**
   * `currentValue` is the caller's view of the favourite state; it is only used
   * for a title that is not in `channels` yet.
   */
  toggleChannelFavorite: (channelId: number, currentValue?: boolean) => Promise<void>;
  /**
   * Sets the guide keys of the current playlist's live channels in place,
   * after a match changed them (`epg-refreshed`), without reading the list
   * again. Keys of another playlist than the current one are dropped.
   */
  setEpgKeys: (keys: EpgKeys) => void;

  // Search
  searchQuery: string;
  setSearchQuery: (query: string) => void;

  // Content Type Filter
  contentTypeFilter: Section;
  setContentTypeFilter: (filter: Section) => void;

  // TMDB status, fetched once at boot so the start section is known before MainScreen mounts
  tmdbStatus: TmdbStatus | null;
  setTmdbStatus: (status: TmdbStatus | null) => void;

  // Category Filter (provider categories like "Sweden", "Norway", etc.)
  categoryFilter: string | null;
  /** null while the section's categories are being fetched, [] when it has none */
  categories: string[] | null;
  setCategoryFilter: (category: string | null) => void;
  setCategories: (categories: string[] | null) => void;

  // Playback
  isPlaying: boolean;
  setIsPlaying: (playing: boolean) => void;

  // TMDB cards for movies and series (channelId -> card)
  tmdbCards: Map<number, TmdbCard>;
  /** Bumped by clearTmdbCards so consumers ask for the visible ids again. */
  tmdbCardsEpoch: number;
  setTmdbCards: (cards: TmdbCard[]) => void;
  clearTmdbCards: () => void;

  // Series Navigation
  currentSeries: SeriesInfo | null;
  selectedSeason: string | null;
  setCurrentSeries: (series: SeriesInfo | null) => void;
  setSelectedSeason: (seasonNumber: string | null) => void;

  // A short-lived notice at the bottom of the screen (one at a time)
  toast: { id: number; message: string } | null;
  showToast: (message: string) => void;
  dismissToast: () => void;

  // UI State
  isSetupComplete: boolean;
  setIsSetupComplete: (complete: boolean) => void;
  isLoading: boolean;
  setIsLoading: (loading: boolean) => void;

  // Parental Controls
  parentalEnabled: boolean;
  parentalUnlocked: boolean;
  parentalUnlockExpiry: number | null;
  blockedChannelIds: Set<number>;
  blockedCategories: string[];
  parentalVisibility: 'hide' | 'lock' | 'blur';
  parentalAutoDetect: boolean;
  setParentalEnabled: (enabled: boolean) => void;
  setParentalUnlocked: (unlocked: boolean, duration?: number) => void;
  setBlockedChannelIds: (ids: Set<number>) => void;
  setBlockedCategories: (categories: string[]) => void;
  setParentalVisibility: (mode: 'hide' | 'lock' | 'blur') => void;
  setParentalAutoDetect: (enabled: boolean) => void;
  loadParentalSettings: () => Promise<void>;
  checkChannelBlocked: (channel: Channel) => boolean;
}

export const usePlayerStore = create<PlayerState>((set, get) => ({
  // Playlists
  playlists: [],
  currentPlaylist: null,
  activeProfileId: null,
  setPlaylists: (playlists) => set({ playlists }),
  setCurrentPlaylist: (playlist) => set({ currentPlaylist: playlist }),
  setActiveProfileId: (id) => set({ activeProfileId: id }),

  // Channels
  channels: [],
  currentChannel: null,
  liveChannels: [],
  vodChannels: [],
  seriesChannels: [],
  favoriteChannels: [],
  pendingFavorites: new Map<number, boolean>(),
  channelLoad: { live: 'loading', library: 'loading' },
  pendingEpgKeys: null,
  setChannels: (channels) => {
    // Supersedes a load in flight (refresh flows and Setup)
    channelLoadToken++;

    // Pre-filter channels by type for instant tab switching. `channels` is
    // grouped live, vod, series (stable within each type), the same order the
    // two-part load produces, so every path agrees.
    const liveChannels = channels.filter((c) => c.content_type === 'live');
    const vodChannels = channels.filter((c) => c.content_type === 'vod');
    const seriesChannels = channels.filter((c) => c.content_type === 'series');
    const grouped = [...liveChannels, ...vodChannels, ...seriesChannels];
    const favoriteChannels = grouped.filter((c) => c.is_favorite);

    set({
      channels: grouped,
      pendingFavorites: new Map(),
      pendingEpgKeys: null,
      liveChannels,
      vodChannels,
      seriesChannels,
      favoriteChannels,
      channelLoad: { live: 'loaded', library: 'loaded' },
    });
  },

  loadChannels: async (playlistId) => {
    const currentId = get().currentPlaylist?.id;
    if (playlistId !== currentId) {
      logger.warn(`loadChannels skipped: playlist ${playlistId} is not the current ${currentId}`);
      return;
    }
    const isCurrent = beginChannelLoad(playlistId);

    set({
      channels: [],
      liveChannels: [],
      vodChannels: [],
      seriesChannels: [],
      favoriteChannels: [],
      pendingFavorites: new Map(),
      channelLoad: { live: 'loading', library: 'loading' },
    });

    let live: Channel[];
    try {
      live = await getChannels(playlistId, LIVE_TYPES);
    } catch (error) {
      if (!isCurrent()) return;
      logger.error('Failed to load live channels:', error);
      set({ channelLoad: { live: 'error', library: 'error' }, pendingEpgKeys: null });
      return;
    }
    if (!isCurrent()) return;
    const pending = get().pendingEpgKeys;
    const keyed = pending?.playlistId === playlistId ? applyEpgKeys(live, pending.pairs) : live;
    set({
      channels: keyed,
      liveChannels: keyed,
      favoriteChannels: keyed.filter((c) => c.is_favorite),
      pendingEpgKeys: null,
      channelLoad: { live: 'loaded', library: 'loading' },
    });

    await loadLibraryPart(playlistId, isCurrent, set);
  },

  retryChannels: async () => {
    const { currentPlaylist, channelLoad } = get();
    const playlistId = currentPlaylist?.id;
    if (playlistId === undefined) return;
    if (channelLoad.live !== 'loaded' || channelLoad.library !== 'error') {
      await get().loadChannels(playlistId);
      return;
    }

    // Live is fine: keep it on screen and fetch only the library again
    const isCurrent = beginChannelLoad(playlistId);
    set({ channelLoad: { live: 'loaded', library: 'loading' } });
    await loadLibraryPart(playlistId, isCurrent, set);
  },

  setCurrentChannel: (channel) => set({ currentChannel: channel }),

  toggleChannelFavorite: async (channelId, currentValue) => {
    // Call backend IPC to persist the favorite toggle
    await toggleFavorite(channelId);

    // Update local state: rebuild only affected arrays
    set((state) => {
      if (!state.channels.some((c) => c.id === channelId)) {
        // Not loaded yet: remember the new value for the library merge
        const next = !(state.pendingFavorites.get(channelId) ?? currentValue ?? false);
        const pendingFavorites = new Map(state.pendingFavorites);
        pendingFavorites.set(channelId, next);
        return { pendingFavorites };
      }
      const updatedChannels = state.channels.map((c) =>
        c.id === channelId ? { ...c, is_favorite: !c.is_favorite } : c
      );

      const targetChannel = state.channels.find((c) => c.id === channelId);
      const contentType = targetChannel?.content_type;

      const result: Partial<PlayerState> = {
        channels: updatedChannels,
        favoriteChannels: updatedChannels.filter((c) => c.is_favorite),
      };

      // Only rebuild the specific content type array that contains this channel
      if (contentType === 'live') {
        result.liveChannels = updatedChannels.filter((c) => c.content_type === 'live');
      } else if (contentType === 'vod') {
        result.vodChannels = updatedChannels.filter((c) => c.content_type === 'vod');
      } else if (contentType === 'series') {
        result.seriesChannels = updatedChannels.filter((c) => c.content_type === 'series');
      }

      return result;
    });
  },

  setEpgKeys: ({ playlistId, pairs }) =>
    set((state) => {
      if (state.currentPlaylist?.id !== playlistId) return {};
      if (state.channelLoad.live === 'loading') {
        return { pendingEpgKeys: { playlistId, pairs } };
      }
      return withEpgKeys(state, pairs);
    }),

  // Search
  searchQuery: '',
  setSearchQuery: (query) => set({ searchQuery: query }),

  // Content Type Filter
  contentTypeFilter: 'live',
  setContentTypeFilter: (filter) => set({ contentTypeFilter: filter, categoryFilter: null }),

  // TMDB status
  tmdbStatus: null,
  setTmdbStatus: (status) => set({ tmdbStatus: status }),

  // Category Filter
  categoryFilter: null,
  categories: null,
  setCategoryFilter: (category) => set({ categoryFilter: category }),
  setCategories: (categories) => set({ categories }),

  // Playback
  isPlaying: false,
  setIsPlaying: (playing) => set({ isPlaying: playing }),

  tmdbCards: new Map(),
  setTmdbCards: (cards) =>
    set((state) => {
      if (cards.length === 0) return {};
      const next = new Map(state.tmdbCards);
      for (const card of cards) next.set(card.channel_id, card);
      return { tmdbCards: next };
    }),
  tmdbCardsEpoch: 0,
  clearTmdbCards: () =>
    set((state) => ({ tmdbCards: new Map(), tmdbCardsEpoch: state.tmdbCardsEpoch + 1 })),

  // Series Navigation
  currentSeries: null,
  selectedSeason: null,
  setCurrentSeries: (series) => set({ currentSeries: series }),
  setSelectedSeason: (seasonNumber) => set({ selectedSeason: seasonNumber }),

  toast: null,
  showToast: (message) => set({ toast: { id: Date.now(), message } }),
  dismissToast: () => set({ toast: null }),

  // UI State
  isSetupComplete: false,
  setIsSetupComplete: (complete) => set({ isSetupComplete: complete }),
  isLoading: false,
  setIsLoading: (loading) => set({ isLoading: loading }),

  // Parental Controls
  parentalEnabled: false,
  parentalUnlocked: false,
  parentalUnlockExpiry: null,
  blockedChannelIds: new Set(),
  blockedCategories: [],
  parentalVisibility: 'hide',
  parentalAutoDetect: false,

  setParentalEnabled: (enabled) => set({ parentalEnabled: enabled }),

  setParentalUnlocked: (unlocked, duration) => {
    const expiry = duration ? Date.now() + duration : null;
    set({ parentalUnlocked: unlocked, parentalUnlockExpiry: expiry });
  },

  setBlockedChannelIds: (ids) => set({ blockedChannelIds: ids }),
  setBlockedCategories: (categories) => set({ blockedCategories: categories }),
  setParentalVisibility: (mode) => set({ parentalVisibility: mode }),
  setParentalAutoDetect: (enabled) => set({ parentalAutoDetect: enabled }),

  loadParentalSettings: async () => {
    try {
      const settings = await getParentalSettings();

      set({
        parentalEnabled: settings.enabled,
        blockedChannelIds: new Set(settings.blocked_channels),
        blockedCategories: settings.blocked_categories,
        parentalVisibility: settings.visibility,
        parentalAutoDetect: settings.auto_detect,
      });
    } catch (error) {
      console.error('Failed to load parental settings:', error);
    }
  },

  checkChannelBlocked: (channel) => {
    const state = usePlayerStore.getState();
    if (!state.parentalEnabled || state.parentalUnlocked) return false;
    if (channel.id && state.blockedChannelIds.has(channel.id)) return true;
    if (channel.group_name && state.blockedCategories.includes(channel.group_name)) return true;
    return false;
  },
}));
