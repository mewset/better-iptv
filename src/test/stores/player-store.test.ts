import { describe, it, expect, beforeEach, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { error as logError, warn as logWarn } from '@tauri-apps/plugin-log';
import { usePlayerStore } from '../../stores/player-store';
import type { Channel } from '../../types';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

describe('usePlayerStore', () => {
  beforeEach(() => {
    // Reset store state between tests
    usePlayerStore.setState({
      channels: [],
      liveChannels: [],
      vodChannels: [],
      seriesChannels: [],
      playlists: [],
      currentPlaylist: null,
      currentChannel: null,
      searchQuery: '',
      contentTypeFilter: 'live',
      isPlaying: false,
      isSetupComplete: false,
      currentProgram: null,
      nextProgram: null,
      channelEpgData: new Map(),
      epgRefreshTrigger: 0,
      activeProfileId: null,
    });
  });

  describe('channel management', () => {
    it('should initialize with empty channels', () => {
      const { channels } = usePlayerStore.getState();
      expect(channels).toHaveLength(0);
    });

    it('should set channels and automatically filter by content type', () => {
      const mockChannels = [
        {
          id: 1,
          name: 'Live Channel 1',
          content_type: 'live' as const,
          url: 'http://test',
          playlist_id: 1,
          is_favorite: false,
          sort_order: 0,
        },
        {
          id: 2,
          name: 'VOD Movie 1',
          content_type: 'vod' as const,
          url: 'http://test',
          playlist_id: 1,
          is_favorite: false,
          sort_order: 1,
        },
        {
          id: 3,
          name: 'Series 1',
          content_type: 'series' as const,
          url: 'http://test',
          playlist_id: 1,
          is_favorite: false,
          sort_order: 2,
        },
        {
          id: 4,
          name: 'Live Channel 2',
          content_type: 'live' as const,
          url: 'http://test',
          playlist_id: 1,
          is_favorite: false,
          sort_order: 3,
        },
      ];

      usePlayerStore.getState().setChannels(mockChannels);

      const state = usePlayerStore.getState();
      expect(state.channels).toHaveLength(4);
      expect(state.liveChannels).toHaveLength(2);
      expect(state.vodChannels).toHaveLength(1);
      expect(state.seriesChannels).toHaveLength(1);
    });

    it('should update filtered channels based on content type filter', () => {
      const mockChannels = [
        {
          id: 1,
          name: 'Live 1',
          content_type: 'live' as const,
          url: 'http://test',
          playlist_id: 1,
          is_favorite: false,
          sort_order: 0,
        },
        {
          id: 2,
          name: 'VOD 1',
          content_type: 'vod' as const,
          url: 'http://test',
          playlist_id: 1,
          is_favorite: false,
          sort_order: 1,
        },
      ];

      usePlayerStore.getState().setChannels(mockChannels);

      // Default filter is 'live'
      const state = usePlayerStore.getState();
      expect(state.contentTypeFilter).toBe('live');
    });
  });

  describe('search functionality', () => {
    it('should update search query', () => {
      usePlayerStore.getState().setSearchQuery('test search');
      expect(usePlayerStore.getState().searchQuery).toBe('test search');
    });
  });

  describe('playback state', () => {
    it('should track playing state', () => {
      expect(usePlayerStore.getState().isPlaying).toBe(false);

      usePlayerStore.getState().setIsPlaying(true);
      expect(usePlayerStore.getState().isPlaying).toBe(true);
    });

    it('should track current channel', () => {
      const mockChannel = {
        id: 1,
        name: 'Test Channel',
        content_type: 'live' as const,
        url: 'http://test',
        playlist_id: 1,
        is_favorite: false,
        sort_order: 0,
      };

      usePlayerStore.getState().setCurrentChannel(mockChannel);
      expect(usePlayerStore.getState().currentChannel).toEqual(mockChannel);

      usePlayerStore.getState().setCurrentChannel(null);
      expect(usePlayerStore.getState().currentChannel).toBeNull();
    });
  });

  describe('EPG data', () => {
    it('should store and retrieve channel EPG data', () => {
      usePlayerStore.getState().setChannelEpgs([[123, { current: 'News at 6', next: 'Weather' }]]);

      const { channelEpgData } = usePlayerStore.getState();
      expect(channelEpgData.get(123)).toEqual({ current: 'News at 6', next: 'Weather' });
    });

    it('stores several entries with times in one update and keeps the others', () => {
      usePlayerStore.getState().setChannelEpgs([[1, { current: 'Earlier' }]]);
      const before = usePlayerStore.getState().channelEpgData;
      usePlayerStore.getState().setChannelEpgs([
        [
          7,
          { current: 'Rapport', currentStart: 'a', currentEnd: 'b', next: 'Sport', nextStart: 'b' },
        ],
        [8, { next: 'Morgon' }],
      ]);
      const after = usePlayerStore.getState().channelEpgData;
      expect(after).not.toBe(before);
      expect(after.get(1)).toEqual({ current: 'Earlier' });
      expect(after.get(7)).toEqual({
        current: 'Rapport',
        currentStart: 'a',
        currentEnd: 'b',
        next: 'Sport',
        nextStart: 'b',
      });
      expect(after.get(8)).toEqual({ next: 'Morgon' });
    });

    it('leaves the map untouched for an empty batch', () => {
      const before = usePlayerStore.getState().channelEpgData;
      usePlayerStore.getState().setChannelEpgs([]);
      expect(usePlayerStore.getState().channelEpgData).toBe(before);
    });

    it('should trigger EPG refresh', () => {
      const initialTrigger = usePlayerStore.getState().epgRefreshTrigger;
      usePlayerStore.getState().triggerEpgRefresh();
      expect(usePlayerStore.getState().epgRefreshTrigger).toBe(initialTrigger + 1);
    });
  });

  describe('setup state', () => {
    it('should track setup completion', () => {
      expect(usePlayerStore.getState().isSetupComplete).toBe(false);

      usePlayerStore.getState().setIsSetupComplete(true);
      expect(usePlayerStore.getState().isSetupComplete).toBe(true);
    });
  });

  describe('toggleChannelFavorite', () => {
    it('should update favoriteChannels after toggle', () => {
      const channels = [
        {
          id: 1,
          name: 'A',
          content_type: 'live' as const,
          url: 'http://a',
          playlist_id: 1,
          is_favorite: false,
          sort_order: 0,
        },
      ];

      usePlayerStore.getState().setChannels(channels);
      expect(usePlayerStore.getState().favoriteChannels).toHaveLength(0);

      // Directly test state mutation (bypassing IPC)
      usePlayerStore.setState((state) => {
        const updatedChannels = state.channels.map((c) =>
          c.id === 1 ? { ...c, is_favorite: true } : c
        );
        return {
          channels: updatedChannels,
          liveChannels: updatedChannels.filter((c) => c.content_type === 'live'),
          favoriteChannels: updatedChannels.filter((c) => c.is_favorite),
        };
      });

      expect(usePlayerStore.getState().favoriteChannels).toHaveLength(1);
    });

    it('should only rebuild the affected content-type array', () => {
      const channels = [
        {
          id: 1,
          name: 'Live',
          content_type: 'live' as const,
          url: 'http://a',
          playlist_id: 1,
          is_favorite: false,
          sort_order: 0,
        },
        {
          id: 2,
          name: 'Movie',
          content_type: 'vod' as const,
          url: 'http://b',
          playlist_id: 1,
          is_favorite: false,
          sort_order: 1,
        },
      ];

      usePlayerStore.getState().setChannels(channels);
      const vodBefore = usePlayerStore.getState().vodChannels;

      // Toggle live channel favorite - vod array should keep same reference
      usePlayerStore.setState((state) => {
        const updatedChannels = state.channels.map((c) =>
          c.id === 1 ? { ...c, is_favorite: true } : c
        );
        const targetChannel = state.channels.find((c) => c.id === 1);
        const contentType = targetChannel?.content_type;

        const result: Partial<typeof state> = {
          channels: updatedChannels,
          favoriteChannels: updatedChannels.filter((c) => c.is_favorite),
        };

        if (contentType === 'live') {
          result.liveChannels = updatedChannels.filter((c) => c.content_type === 'live');
        }

        return result;
      });

      // VOD array should be same reference (untouched)
      expect(usePlayerStore.getState().vodChannels).toBe(vodBefore);
      expect(usePlayerStore.getState().favoriteChannels).toHaveLength(1);
    });
  });

  describe('profile management', () => {
    it('should track active profile ID', () => {
      expect(usePlayerStore.getState().activeProfileId).toBeNull();

      usePlayerStore.getState().setActiveProfileId(42);
      expect(usePlayerStore.getState().activeProfileId).toBe(42);
    });
  });

  describe('loadParentalSettings', () => {
    it('invokes get_parental_settings once and not get_blocked_channels', async () => {
      vi.mocked(invoke).mockReset();
      vi.mocked(invoke).mockImplementation(async (cmd: string) => {
        if (cmd === 'get_parental_settings') {
          return {
            enabled: true,
            has_pin: true,
            auto_detect: false,
            blocked_channels: [3, 5],
            blocked_categories: ['News'],
            unlock_duration: '0',
            visibility: 'hide',
          };
        }
        throw new Error(`unexpected command ${cmd}`);
      });

      await usePlayerStore.getState().loadParentalSettings();

      const commands = vi.mocked(invoke).mock.calls.map((c) => c[0]);
      expect(commands).toEqual(['get_parental_settings']);
      expect(usePlayerStore.getState().blockedChannelIds).toEqual(new Set([3, 5]));
      expect(usePlayerStore.getState().blockedCategories).toEqual(['News']);
    });
  });
  describe('loadChannels', () => {
    interface Deferred {
      promise: Promise<Channel[]>;
      resolve: (channels: Channel[]) => void;
      reject: (reason: unknown) => void;
    }

    // One pending get_channels call per "<playlistId>:<types>" key, resolved by the test
    let pending: Map<string, Deferred>;

    const ch = (
      id: number,
      content_type: Channel['content_type'],
      is_favorite = false
    ): Channel => ({
      id,
      name: `Channel ${id}`,
      content_type,
      is_favorite,
    });

    const call = (key: string): Deferred => {
      const d = pending.get(key);
      if (!d) throw new Error(`no pending get_channels call for ${key}`);
      return d;
    };

    // Lets the store's awaits after a resolve run to completion
    const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

    const playlist = (id: number) => ({ id, name: `P${id}`, auto_refresh: false });

    beforeEach(() => {
      pending = new Map();
      vi.mocked(invoke).mockReset();
      vi.mocked(invoke).mockImplementation((cmd: string, args?: unknown) => {
        if (cmd === 'toggle_favorite') return Promise.resolve();
        if (cmd !== 'get_channels') throw new Error(`unexpected command ${cmd}`);
        const { playlistId, contentTypes } = args as {
          playlistId: number;
          contentTypes: string[];
        };
        const d = {} as Deferred;
        d.promise = new Promise<Channel[]>((resolve, reject) => {
          d.resolve = resolve;
          d.reject = reject;
        });
        pending.set(`${playlistId}:${contentTypes.join(',')}`, d);
        return d.promise;
      });
      vi.mocked(logError).mockClear();
      vi.mocked(logWarn).mockClear();
      usePlayerStore.setState({
        currentPlaylist: playlist(1),
        favoriteChannels: [],
        channelLoad: { live: 'loading', library: 'loading' },
      });
    });

    it('starts with both parts loading', () => {
      expect(usePlayerStore.getInitialState().channelLoad).toEqual({
        live: 'loading',
        library: 'loading',
      });
    });

    it('loads live first, then merges the library', async () => {
      usePlayerStore.getState().setChannels([ch(99, 'vod')]);
      const load = usePlayerStore.getState().loadChannels(1);

      // Cleared and loading while the live part is in flight
      expect(usePlayerStore.getState().channels).toEqual([]);
      expect(usePlayerStore.getState().vodChannels).toEqual([]);
      expect(usePlayerStore.getState().channelLoad).toEqual({
        live: 'loading',
        library: 'loading',
      });
      expect([...pending.keys()]).toEqual(['1:live']);

      const live = [ch(1, 'live', true), ch(2, 'live')];
      call('1:live').resolve(live);
      await flush();

      let state = usePlayerStore.getState();
      expect(state.liveChannels).toEqual(live);
      expect(state.channels).toEqual(live);
      expect(state.favoriteChannels.map((c) => c.id)).toEqual([1]);
      expect(state.vodChannels).toEqual([]);
      expect(state.seriesChannels).toEqual([]);
      expect(state.channelLoad).toEqual({ live: 'loaded', library: 'loading' });
      const liveRef = state.liveChannels;

      call('1:vod,series').resolve([ch(3, 'series'), ch(4, 'vod', true), ch(5, 'vod')]);
      await load;

      state = usePlayerStore.getState();
      expect(state.channels.map((c) => c.id)).toEqual([1, 2, 4, 5, 3]);
      expect(state.vodChannels.map((c) => c.id)).toEqual([4, 5]);
      expect(state.seriesChannels.map((c) => c.id)).toEqual([3]);
      expect(state.favoriteChannels.map((c) => c.id)).toEqual([1, 4]);
      expect(state.liveChannels).toBe(liveRef);
      expect(state.channelLoad).toEqual({ live: 'loaded', library: 'loaded' });
    });

    it('keeps a favourite toggled before the library arrives', async () => {
      const load = usePlayerStore.getState().loadChannels(1);
      call('1:live').resolve([ch(1, 'live'), ch(2, 'live')]);
      await flush();

      await usePlayerStore.getState().toggleChannelFavorite(2);
      expect(usePlayerStore.getState().favoriteChannels.map((c) => c.id)).toEqual([2]);
      expect(usePlayerStore.getState().vodChannels).toEqual([]);

      call('1:vod,series').resolve([ch(3, 'vod')]);
      await load;

      const state = usePlayerStore.getState();
      expect(state.favoriteChannels.map((c) => c.id)).toEqual([2]);
      expect(state.channels.find((c) => c.id === 2)?.is_favorite).toBe(true);
      expect(state.liveChannels.find((c) => c.id === 2)?.is_favorite).toBe(true);
      expect(state.channels.map((c) => c.id)).toEqual([1, 2, 3]);
    });

    it('a toggle made before the library arrives survives the merge even if the response carries the old value', async () => {
      const load = usePlayerStore.getState().loadChannels(1);
      call('1:live').resolve([ch(1, 'live')]);
      await flush();

      // Title 3 is not in state yet (library still loading)
      await usePlayerStore.getState().toggleChannelFavorite(3, false);
      expect(usePlayerStore.getState().pendingFavorites.get(3)).toBe(true);

      call('1:vod,series').resolve([ch(3, 'vod', false)]);
      await load;

      const state = usePlayerStore.getState();
      expect(state.channels.find((c) => c.id === 3)?.is_favorite).toBe(true);
      expect(state.vodChannels.find((c) => c.id === 3)?.is_favorite).toBe(true);
      expect(state.favoriteChannels.map((c) => c.id)).toEqual([3]);
      expect(state.pendingFavorites.size).toBe(0);
    });

    it('setChannels groups live, vod, series like the two-part load', () => {
      usePlayerStore
        .getState()
        .setChannels([
          ch(1, 'series', true),
          ch(2, 'vod'),
          ch(3, 'live'),
          ch(4, 'vod', true),
          ch(5, 'live', true),
          ch(6, 'series'),
        ]);
      const state = usePlayerStore.getState();
      expect(state.channels.map((c) => c.id)).toEqual([3, 5, 2, 4, 1, 6]);
      expect(state.favoriteChannels.map((c) => c.id)).toEqual([5, 4, 1]);
    });

    it('drops results of a superseded load', async () => {
      const loadA = usePlayerStore.getState().loadChannels(1);
      usePlayerStore.setState({ currentPlaylist: playlist(2) });
      const loadB = usePlayerStore.getState().loadChannels(2);

      call('2:live').resolve([ch(20, 'live')]);
      await flush();
      call('2:vod,series').resolve([ch(21, 'vod')]);
      await loadB;

      // A finishes last, after the user came back to playlist 1 without a new load
      usePlayerStore.setState({ currentPlaylist: playlist(1) });
      call('1:live').resolve([ch(10, 'live')]);
      await loadA;

      const state = usePlayerStore.getState();
      expect(state.channels.map((c) => c.id)).toEqual([20, 21]);
      expect(state.liveChannels.map((c) => c.id)).toEqual([20]);
      expect(state.channelLoad).toEqual({ live: 'loaded', library: 'loaded' });
      expect(pending.has('1:vod,series')).toBe(false);
    });

    it('drops a load whose playlist is no longer current', async () => {
      const load = usePlayerStore.getState().loadChannels(1);
      usePlayerStore.setState({ currentPlaylist: playlist(2) });

      call('1:live').resolve([ch(10, 'live')]);
      await load;

      const state = usePlayerStore.getState();
      expect(state.channels).toEqual([]);
      expect(state.channelLoad).toEqual({ live: 'loading', library: 'loading' });
    });

    it('loadChannels for a non-current playlist leaves the store untouched and warns', async () => {
      const fresh = [ch(7, 'live'), ch(8, 'vod')];
      usePlayerStore.getState().setChannels(fresh);
      usePlayerStore.setState({ currentPlaylist: playlist(2) });

      await usePlayerStore.getState().loadChannels(1);

      const state = usePlayerStore.getState();
      expect(state.channels).toEqual(fresh);
      expect(state.channelLoad).toEqual({ live: 'loaded', library: 'loaded' });
      expect(vi.mocked(invoke)).not.toHaveBeenCalled();
      expect(logWarn).toHaveBeenCalledTimes(1);
      expect(vi.mocked(logWarn).mock.calls[0][0]).toMatch(/\b1\b.*\b2\b/);
    });

    it('drops a load overtaken by setChannels', async () => {
      const load = usePlayerStore.getState().loadChannels(1);
      const fresh = [ch(7, 'live'), ch(8, 'series')];
      usePlayerStore.getState().setChannels(fresh);
      expect(usePlayerStore.getState().channelLoad).toEqual({ live: 'loaded', library: 'loaded' });

      call('1:live').resolve([ch(1, 'live')]);
      await load;

      const state = usePlayerStore.getState();
      expect(state.channels).toEqual(fresh);
      expect(state.channelLoad).toEqual({ live: 'loaded', library: 'loaded' });
    });

    it('drops a failure overtaken by setChannels', async () => {
      const load = usePlayerStore.getState().loadChannels(1);
      call('1:live').resolve([ch(1, 'live')]);
      await flush();
      const fresh = [ch(7, 'live')];
      usePlayerStore.getState().setChannels(fresh);

      call('1:vod,series').reject(new Error('boom'));
      await load;

      expect(usePlayerStore.getState().channels).toEqual(fresh);
      expect(usePlayerStore.getState().channelLoad).toEqual({ live: 'loaded', library: 'loaded' });
    });

    it('marks library as error when only the library fails', async () => {
      const load = usePlayerStore.getState().loadChannels(1);
      call('1:live').resolve([ch(1, 'live')]);
      await flush();
      call('1:vod,series').reject(new Error('db locked'));
      await expect(load).resolves.toBeUndefined();

      const state = usePlayerStore.getState();
      expect(state.channelLoad).toEqual({ live: 'loaded', library: 'error' });
      expect(state.liveChannels.map((c) => c.id)).toEqual([1]);
      expect(state.channels.map((c) => c.id)).toEqual([1]);
      expect(logError).toHaveBeenCalledTimes(1);
    });

    it('marks both as error when live fails, without fetching the library', async () => {
      const load = usePlayerStore.getState().loadChannels(1);
      call('1:live').reject(new Error('db locked'));
      await expect(load).resolves.toBeUndefined();

      expect(usePlayerStore.getState().channelLoad).toEqual({ live: 'error', library: 'error' });
      expect(pending.has('1:vod,series')).toBe(false);
      expect(vi.mocked(invoke)).toHaveBeenCalledTimes(1);
      expect(logError).toHaveBeenCalledTimes(1);
    });

    it('retryChannels reloads the current playlist', async () => {
      const load = usePlayerStore.getState().loadChannels(1);
      call('1:live').reject(new Error('db locked'));
      await load;

      usePlayerStore.setState({ currentPlaylist: playlist(3) });
      const retry = usePlayerStore.getState().retryChannels();
      expect(usePlayerStore.getState().channelLoad).toEqual({
        live: 'loading',
        library: 'loading',
      });
      call('3:live').resolve([ch(30, 'live')]);
      await flush();
      call('3:vod,series').resolve([]);
      await retry;

      expect(usePlayerStore.getState().channels.map((c) => c.id)).toEqual([30]);
      expect(usePlayerStore.getState().channelLoad).toEqual({ live: 'loaded', library: 'loaded' });
    });

    // Loads playlist 1 with live ok and the library failing; returns the live array in state
    const loadWithLibraryError = async () => {
      const load = usePlayerStore.getState().loadChannels(1);
      call('1:live').resolve([ch(1, 'live', true), ch(2, 'live')]);
      await flush();
      call('1:vod,series').reject(new Error('db locked'));
      await load;
      expect(usePlayerStore.getState().channelLoad).toEqual({ live: 'loaded', library: 'error' });
      vi.mocked(invoke).mockClear();
      pending.clear();
      return usePlayerStore.getState().liveChannels;
    };

    it('retry after a library-only error keeps Live and refetches only the library', async () => {
      const liveRef = await loadWithLibraryError();

      const retry = usePlayerStore.getState().retryChannels();
      let state = usePlayerStore.getState();
      expect(state.channelLoad).toEqual({ live: 'loaded', library: 'loading' });
      expect(state.liveChannels).toBe(liveRef);
      expect(state.channels.map((c) => c.id)).toEqual([1, 2]);

      call('1:vod,series').resolve([ch(4, 'series'), ch(3, 'vod', true)]);
      await retry;

      state = usePlayerStore.getState();
      const calls = vi.mocked(invoke).mock.calls;
      expect(calls).toHaveLength(1);
      expect(calls[0][1]).toEqual({ playlistId: 1, contentTypes: ['vod', 'series'] });
      expect(state.liveChannels).toBe(liveRef);
      expect(state.channels.map((c) => c.id)).toEqual([1, 2, 3, 4]);
      expect(state.vodChannels.map((c) => c.id)).toEqual([3]);
      expect(state.seriesChannels.map((c) => c.id)).toEqual([4]);
      expect(state.favoriteChannels.map((c) => c.id)).toEqual([1, 3]);
      expect(state.channelLoad).toEqual({ live: 'loaded', library: 'loaded' });
    });

    it('retry after a library-only error that fails again stays on library error with Live intact', async () => {
      const liveRef = await loadWithLibraryError();

      const retry = usePlayerStore.getState().retryChannels();
      call('1:vod,series').reject(new Error('still locked'));
      await expect(retry).resolves.toBeUndefined();

      const state = usePlayerStore.getState();
      expect(vi.mocked(invoke)).toHaveBeenCalledTimes(1);
      expect(state.channelLoad).toEqual({ live: 'loaded', library: 'error' });
      expect(state.liveChannels).toBe(liveRef);
      expect(state.channels.map((c) => c.id)).toEqual([1, 2]);
      expect(state.favoriteChannels.map((c) => c.id)).toEqual([1]);
    });

    it('drops a library retry overtaken by setChannels', async () => {
      await loadWithLibraryError();

      const retry = usePlayerStore.getState().retryChannels();
      const fresh = [ch(7, 'live')];
      usePlayerStore.getState().setChannels(fresh);
      call('1:vod,series').resolve([ch(3, 'vod')]);
      await retry;

      expect(usePlayerStore.getState().channels).toEqual(fresh);
      expect(usePlayerStore.getState().channelLoad).toEqual({ live: 'loaded', library: 'loaded' });
    });

    it('retryChannels does nothing without a current playlist', async () => {
      usePlayerStore.setState({ currentPlaylist: null });
      await usePlayerStore.getState().retryChannels();
      expect(vi.mocked(invoke)).not.toHaveBeenCalled();
    });
  });
});
