import { describe, it, expect, vi, beforeEach } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { usePlayerStore } from '../../stores/player-store';
import { logger } from '../../lib/logger';
import type { Playlist } from '../../types';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('../../lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const playlist = (id: number) => ({ id, name: `P${id}` }) as Playlist;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe('toggleCategoryPin', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    vi.mocked(logger.error).mockReset();
    usePlayerStore.setState({
      currentPlaylist: playlist(1),
      contentTypeFilter: 'live',
      categoryFilter: null,
      categories: ['Sweden', 'Norway'],
      pinnedCategories: [],
    });
  });

  it('pins a category and applies the answer', async () => {
    vi.mocked(invoke).mockResolvedValue({ pinned: ['Norway'], others: ['Sweden'] });
    await usePlayerStore.getState().toggleCategoryPin('Norway');
    expect(invoke).toHaveBeenCalledWith('set_category_pinned', {
      playlistId: 1,
      contentType: 'live',
      groupName: 'Norway',
      pinned: true,
    });
    const s = usePlayerStore.getState();
    expect(s.pinnedCategories).toEqual(['Norway']);
    expect(s.categories).toEqual(['Sweden']);
  });

  it('unpins a pinned category', async () => {
    usePlayerStore.setState({ categories: ['Sweden'], pinnedCategories: ['Norway'] });
    vi.mocked(invoke).mockResolvedValue({ pinned: [], others: ['Sweden', 'Norway'] });
    await usePlayerStore.getState().toggleCategoryPin('Norway');
    expect(invoke).toHaveBeenCalledWith(
      'set_category_pinned',
      expect.objectContaining({ groupName: 'Norway', pinned: false })
    );
    expect(usePlayerStore.getState().pinnedCategories).toEqual([]);
  });

  it('uses the Live TV pins in the guide', async () => {
    usePlayerStore.setState({ contentTypeFilter: 'guide' });
    vi.mocked(invoke).mockResolvedValue({ pinned: ['Norway'], others: ['Sweden'] });
    await usePlayerStore.getState().toggleCategoryPin('Norway');
    expect(invoke).toHaveBeenCalledWith(
      'set_category_pinned',
      expect.objectContaining({ contentType: 'live' })
    );
  });

  it('keeps the selected category', async () => {
    usePlayerStore.setState({
      categoryFilter: 'Norway',
      categories: ['Sweden'],
      pinnedCategories: ['Norway'],
    });
    vi.mocked(invoke).mockResolvedValue({ pinned: [], others: ['Sweden', 'Norway'] });
    await usePlayerStore.getState().toggleCategoryPin('Norway');
    const s = usePlayerStore.getState();
    expect(s.categoryFilter).toBe('Norway');
    expect(s.categories).toEqual(['Sweden', 'Norway']);
  });

  it('drops a late answer after a profile switch', async () => {
    const answer = deferred<unknown>();
    vi.mocked(invoke).mockReturnValue(answer.promise);
    const pending = usePlayerStore.getState().toggleCategoryPin('Norway');
    usePlayerStore.setState({
      currentPlaylist: playlist(2),
      categories: ['Denmark'],
      pinnedCategories: [],
    });
    answer.resolve({ pinned: ['Norway'], others: ['Sweden'] });
    await pending;
    const s = usePlayerStore.getState();
    expect(s.categories).toEqual(['Denmark']);
    expect(s.pinnedCategories).toEqual([]);
  });

  it('drops a late answer after a section switch', async () => {
    const answer = deferred<unknown>();
    vi.mocked(invoke).mockReturnValue(answer.promise);
    const pending = usePlayerStore.getState().toggleCategoryPin('Norway');
    usePlayerStore.setState({ contentTypeFilter: 'vod', categories: ['Movies'] });
    answer.resolve({ pinned: ['Norway'], others: ['Sweden'] });
    await pending;
    const s = usePlayerStore.getState();
    expect(s.categories).toEqual(['Movies']);
    expect(s.pinnedCategories).toEqual([]);
  });

  it('leaves the state on an error', async () => {
    vi.mocked(invoke).mockRejectedValue(new Error('db locked'));
    await usePlayerStore.getState().toggleCategoryPin('Norway');
    const s = usePlayerStore.getState();
    expect(s.categories).toEqual(['Sweden', 'Norway']);
    expect(s.pinnedCategories).toEqual([]);
    expect(logger.error).toHaveBeenCalled();
  });

  it('does nothing outside a section with categories', async () => {
    usePlayerStore.setState({ contentTypeFilter: 'favorites' });
    await usePlayerStore.getState().toggleCategoryPin('Norway');
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe('setCategoryGroups', () => {
  it('sets both lists at once and resets the pins while loading', () => {
    usePlayerStore.getState().setCategoryGroups({ pinned: ['A'], others: ['B'] });
    expect(usePlayerStore.getState().pinnedCategories).toEqual(['A']);
    expect(usePlayerStore.getState().categories).toEqual(['B']);
    usePlayerStore.getState().setCategoryGroups(null);
    expect(usePlayerStore.getState().pinnedCategories).toEqual([]);
    expect(usePlayerStore.getState().categories).toBeNull();
  });
});
