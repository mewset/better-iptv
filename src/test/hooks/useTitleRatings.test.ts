import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { usePlayerStore } from '../../stores/player-store';
import { useTitleRatings } from '../../hooks/useTitleRatings';
import { getTitleRatings } from '../../lib/tauri';
import type { Playlist } from '../../types';

vi.mock('../../lib/tauri', () => ({ getTitleRatings: vi.fn() }));

const playlist = { id: 7, name: 'P' } as Playlist;

describe('useTitleRatings', () => {
  beforeEach(() => {
    vi.mocked(getTitleRatings).mockReset();
    vi.mocked(getTitleRatings).mockResolvedValue({ 1: { rating: 8, votes: 900, year: 2021 } });
    usePlayerStore.setState({ currentPlaylist: playlist, titleRatings: {} });
  });

  it('loads them for a section sorted by rating or by year, and for no other sort', async () => {
    usePlayerStore.setState({ titleSorts: { vod: 'year', series: 'rating' } });
    renderHook(() => useTitleRatings());

    await waitFor(() => expect(usePlayerStore.getState().titleRatings.vod).toBeDefined());
    await waitFor(() => expect(usePlayerStore.getState().titleRatings.series).toBeDefined());
    expect(getTitleRatings).toHaveBeenCalledWith(7, 'vod');
    expect(getTitleRatings).toHaveBeenCalledWith(7, 'series');
    expect(usePlayerStore.getState().titleRatings.vod?.[1]?.year).toBe(2021);
  });

  it('asks for nothing while both sections are sorted another way', () => {
    usePlayerStore.setState({ titleSorts: { vod: 'name', series: 'provider' } });
    renderHook(() => useTitleRatings());

    expect(getTitleRatings).not.toHaveBeenCalled();
  });
});
