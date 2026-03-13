import { describe, it, expect, beforeEach } from 'vitest';
import { usePlayerStore } from '../../stores/player-store';

/**
 * Documents that Zustand store action references (like toggleChannelFavorite)
 * are stable across state changes. This is a Zustand design guarantee.
 *
 * The actual memo fix for scroll performance is in handlePlayChannel
 * (MainScreen.tsx), which uses getState() to avoid reactive dependencies.
 * These tests ensure the OTHER callback prop (onToggleFavorite) doesn't
 * also break memo() — it doesn't, because Zustand functions are stable.
 */
describe('ChannelCard memo stability', () => {
  beforeEach(() => {
    usePlayerStore.setState({
      channels: [],
      filteredChannels: [],
      liveChannels: [],
      vodChannels: [],
      seriesChannels: [],
      favoriteChannels: [],
      searchQuery: '',
      contentTypeFilter: 'live',
      categoryFilter: null,
    });
  });

  it('toggleChannelFavorite reference should be stable across state changes', () => {
    const ref1 = usePlayerStore.getState().toggleChannelFavorite;

    // Trigger unrelated state change
    usePlayerStore.getState().setSearchQuery('test');

    const ref2 = usePlayerStore.getState().toggleChannelFavorite;
    expect(ref1).toBe(ref2);
  });

  it('setChannels should not change toggleChannelFavorite reference', () => {
    const ref1 = usePlayerStore.getState().toggleChannelFavorite;

    usePlayerStore.getState().setChannels([
      {
        id: 1,
        name: 'Ch1',
        url: 'http://test',
        playlist_id: 1,
        content_type: 'live',
        is_favorite: false,
        sort_order: 0,
      },
    ]);

    const ref2 = usePlayerStore.getState().toggleChannelFavorite;
    expect(ref1).toBe(ref2);
  });
});
