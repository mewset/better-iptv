import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { usePlayerStore } from '../../stores/player-store';
import { useChannelFilter } from '../../hooks/useChannelFilter';
import type { Channel } from '../../types';

const makeChannel = (overrides: Partial<Channel>): Channel => ({
  id: 1,
  name: 'Test',
  url: 'http://test',
  playlist_id: 1,
  content_type: 'live',
  is_favorite: false,
  sort_order: 0,
  ...overrides,
});

describe('channel filtering logic', () => {
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

  it('should pre-filter channels by content type on setChannels', () => {
    const channels = [
      makeChannel({ id: 1, name: 'Live 1', content_type: 'live' }),
      makeChannel({ id: 2, name: 'Movie 1', content_type: 'vod' }),
      makeChannel({ id: 3, name: 'Series 1', content_type: 'series' }),
    ];

    usePlayerStore.getState().setChannels(channels);
    const state = usePlayerStore.getState();

    expect(state.liveChannels).toHaveLength(1);
    expect(state.vodChannels).toHaveLength(1);
    expect(state.seriesChannels).toHaveLength(1);
  });

  it('should track favorite channels separately', () => {
    const channels = [
      makeChannel({ id: 1, name: 'Fav', is_favorite: true }),
      makeChannel({ id: 2, name: 'Not Fav', is_favorite: false }),
    ];

    usePlayerStore.getState().setChannels(channels);
    expect(usePlayerStore.getState().favoriteChannels).toHaveLength(1);
    expect(usePlayerStore.getState().favoriteChannels[0].name).toBe('Fav');
  });

  it('search spans all content types when a query is set', () => {
    const channels = [
      makeChannel({ id: 1, name: 'Sport Live', content_type: 'live' }),
      makeChannel({ id: 2, name: 'Sport Movie', content_type: 'vod' }),
      makeChannel({ id: 3, name: 'Drama Series', content_type: 'series' }),
    ];
    usePlayerStore.getState().setChannels(channels);
    usePlayerStore.setState({ contentTypeFilter: 'vod' });

    const { result } = renderHook(() => useChannelFilter('sport'));

    expect(result.current).toHaveLength(2);
    expect(result.current.map((c) => c.name).sort()).toEqual(['Sport Live', 'Sport Movie']);
  });

  it('search in the guide stays live-only', () => {
    const channels = [
      makeChannel({ id: 1, name: 'Sport News', content_type: 'live' }),
      makeChannel({ id: 2, name: 'Sport Movie', content_type: 'vod' }),
    ];
    usePlayerStore.getState().setChannels(channels);
    usePlayerStore.setState({ contentTypeFilter: 'guide' });

    const { result } = renderHook(() => useChannelFilter('sport'));

    expect(result.current).toHaveLength(1);
    expect(result.current[0].name).toBe('Sport News');
  });

  it('guide section lists live favourites when there are any', () => {
    const channels = [
      makeChannel({ id: 1, name: 'Live Fav', content_type: 'live', is_favorite: true }),
      makeChannel({ id: 2, name: 'Live Not Fav', content_type: 'live', is_favorite: false }),
    ];
    usePlayerStore.getState().setChannels(channels);
    usePlayerStore.setState({ contentTypeFilter: 'guide' });

    const { result } = renderHook(() => useChannelFilter(''));

    expect(result.current).toHaveLength(1);
    expect(result.current[0].name).toBe('Live Fav');
  });

  it('guide section falls back to all live channels without live favourites', () => {
    const channels = [
      makeChannel({ id: 1, name: 'Live 1', content_type: 'live', is_favorite: false }),
      makeChannel({ id: 2, name: 'Fav Movie', content_type: 'vod', is_favorite: true }),
    ];
    usePlayerStore.getState().setChannels(channels);
    usePlayerStore.setState({ contentTypeFilter: 'guide' });

    const { result } = renderHook(() => useChannelFilter(''));

    expect(result.current).toHaveLength(1);
    expect(result.current[0].name).toBe('Live 1');
  });
});
