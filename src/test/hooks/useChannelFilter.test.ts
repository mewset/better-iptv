import { describe, it, expect, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { usePlayerStore } from '../../stores/player-store';
import { useChannelFilter } from '../../hooks/useChannelFilter';
import type { Channel } from '../../types';

const makeChannel = (overrides: Partial<Channel>): Channel => ({
  id: 1,
  name: 'Test',
  content_type: 'live',
  is_favorite: false,
  ...overrides,
});

describe('channel filtering logic', () => {
  beforeEach(() => {
    usePlayerStore.setState({
      channels: [],
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

  it('guide section lists all live channels even when live favourites exist', () => {
    const channels = [
      makeChannel({ id: 1, name: 'Live Fav', content_type: 'live', is_favorite: true }),
      makeChannel({ id: 2, name: 'Live Not Fav', content_type: 'live', is_favorite: false }),
      makeChannel({ id: 3, name: 'Fav Movie', content_type: 'vod', is_favorite: true }),
    ];
    usePlayerStore.getState().setChannels(channels);
    usePlayerStore.setState({ contentTypeFilter: 'guide' });

    const { result } = renderHook(() => useChannelFilter(''));

    expect(result.current.map((c) => c.name)).toEqual(['Live Fav', 'Live Not Fav']);
  });

  it('guide section lists only live channels', () => {
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

  it("returns the new section's list in the same render the section changes", () => {
    // Filtering in an effect committed one render of the new section with the
    // old list: posters for live channels, and cards mounted twice.
    usePlayerStore
      .getState()
      .setChannels([
        makeChannel({ id: 1, name: 'Live 1', content_type: 'live' }),
        makeChannel({ id: 2, name: 'Movie 1', content_type: 'vod' }),
      ]);
    const seen: Array<{ section: string; types: string[] }> = [];
    renderHook(() => {
      const list = useChannelFilter('');
      seen.push({
        section: usePlayerStore.getState().contentTypeFilter,
        types: list.map((c) => c.content_type),
      });
      return list;
    });

    act(() => usePlayerStore.getState().setContentTypeFilter('vod'));

    const vodRenders = seen.filter((r) => r.section === 'vod');
    expect(vodRenders.length).toBeGreaterThan(0);
    for (const r of vodRenders) expect(r.types).toEqual(['vod']);
  });

  it('applies a category chip in the same render', () => {
    usePlayerStore
      .getState()
      .setChannels([
        makeChannel({ id: 1, name: 'A', group_name: 'Sweden' }),
        makeChannel({ id: 2, name: 'B', group_name: 'Norway' }),
      ]);
    const { result } = renderHook(() => useChannelFilter(''));
    expect(result.current).toHaveLength(2);

    act(() => usePlayerStore.getState().setCategoryFilter('Norway'));

    expect(result.current.map((c) => c.name)).toEqual(['B']);
  });
});
