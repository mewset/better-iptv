import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import { useProfileSwitch } from '../../hooks/useProfileSwitch';
import { usePlayerStore } from '../../stores/player-store';
import type { Channel, Playlist } from '../../types';

const home: Playlist = { id: 1, name: 'Home', url: 'http://home.example', auto_refresh: false };
const cabin: Playlist = { id: 2, name: 'Cabin', url: 'http://cabin.example', auto_refresh: false };

const cabinChannels: Channel[] = [
  {
    id: 10,
    playlist_id: 2,
    name: 'Cabin One',
    url: 'http://cabin.example/1.ts',
    content_type: 'live',
    is_favorite: false,
    sort_order: 0,
  } as Channel,
];

const mockedInvoke = vi.mocked(invoke);

describe('useProfileSwitch', () => {
  beforeEach(() => {
    mockedInvoke.mockReset();
    usePlayerStore.setState({
      playlists: [home, cabin],
      activeProfileId: 1,
      currentPlaylist: home,
      channels: [],
    });
  });

  it('activates the profile in the backend, loads its channels and updates the store', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) =>
      cmd === 'get_channels' ? cabinChannels : undefined
    );

    const { result } = renderHook(() => useProfileSwitch());
    await act(async () => {
      await result.current.switchTo(cabin);
    });

    expect(mockedInvoke.mock.calls.map((c) => c[0])).toEqual([
      'set_active_profile_id',
      'get_channels',
    ]);
    expect(mockedInvoke).toHaveBeenNthCalledWith(1, 'set_active_profile_id', { profileId: 2 });
    expect(mockedInvoke).toHaveBeenNthCalledWith(2, 'get_channels', { playlistId: 2 });

    const state = usePlayerStore.getState();
    expect(state.activeProfileId).toBe(2);
    expect(state.currentPlaylist).toEqual(cabin);
    expect(state.channels).toEqual(cabinChannels);
    expect(result.current.error).toBeNull();
  });

  it('keeps the error and leaves the active profile alone when loading channels fails', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_channels') throw new Error('provider unreachable');
      return undefined;
    });

    const { result } = renderHook(() => useProfileSwitch());
    await act(async () => {
      await result.current.switchTo(cabin);
    });

    expect(result.current.error).toMatch(/provider unreachable/);
    const state = usePlayerStore.getState();
    expect(state.activeProfileId).toBe(1);
    expect(state.currentPlaylist).toEqual(home);
    expect(state.channels).toEqual([]);

    act(() => result.current.clearError());
    expect(result.current.error).toBeNull();
  });
});
