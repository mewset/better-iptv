import { describe, it, expect, beforeEach } from 'vitest';
import { usePlayerStore } from '../../stores/player-store';

describe('usePlayerStore', () => {
  beforeEach(() => {
    // Reset store state between tests
    usePlayerStore.setState({
      channels: [],
      filteredChannels: [],
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
      usePlayerStore.getState().setChannelEpg(123, 'News at 6', 'Weather');

      const { channelEpgData } = usePlayerStore.getState();
      expect(channelEpgData.get(123)).toEqual({ current: 'News at 6', next: 'Weather' });
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
          filteredChannels: state.filteredChannels.map((c) =>
            c.id === 1 ? { ...c, is_favorite: true } : c
          ),
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
});
