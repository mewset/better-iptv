import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
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

  it('activates the profile and loads its channels in the background', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) =>
      cmd === 'get_channels' ? cabinChannels : undefined
    );

    const { result } = renderHook(() => useProfileSwitch());
    await act(async () => {
      await result.current.switchTo(cabin);
    });

    expect(mockedInvoke).toHaveBeenNthCalledWith(1, 'set_active_profile_id', { profileId: 2 });
    expect(mockedInvoke.mock.calls.slice(1).every((c) => c[0] === 'get_channels')).toBe(true);
    expect(mockedInvoke.mock.calls.length).toBeGreaterThan(1);

    await waitFor(() => expect(usePlayerStore.getState().channelLoad.live).toBe('loaded'));
    const state = usePlayerStore.getState();
    expect(state.activeProfileId).toBe(2);
    expect(state.currentPlaylist).toEqual(cabin);
    expect(state.liveChannels).toEqual(cabinChannels);
    expect(result.current.error).toBeNull();
  });

  it('activates the profile and switches before its channels load', async () => {
    let release: (v: Channel[]) => void = () => {};
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_channels') return new Promise<Channel[]>((r) => (release = r));
      return undefined;
    });

    const { result } = renderHook(() => useProfileSwitch());
    await act(async () => {
      await result.current.switchTo(cabin);
    });

    const state = usePlayerStore.getState();
    expect(state.activeProfileId).toBe(2);
    expect(state.currentPlaylist).toEqual(cabin);
    expect(state.channelLoad.live).toBe('loading');

    await act(async () => release([]));
  });

  it('stays on the new profile with a load error when its channels fail', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_channels') throw new Error('provider unreachable');
      return undefined;
    });

    const { result } = renderHook(() => useProfileSwitch());
    await act(async () => {
      await result.current.switchTo(cabin);
    });

    await waitFor(() => expect(usePlayerStore.getState().channelLoad.live).toBe('error'));
    const state = usePlayerStore.getState();
    expect(state.activeProfileId).toBe(2);
    expect(state.currentPlaylist).toEqual(cabin);
    expect(result.current.error).toBeNull();
  });

  it('keeps the old profile when activating it in the backend fails', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'set_active_profile_id') throw new Error('db locked');
      return undefined;
    });

    const { result } = renderHook(() => useProfileSwitch());
    await act(async () => {
      await result.current.switchTo(cabin);
    });

    expect(result.current.error).toMatch(/db locked/);
    const state = usePlayerStore.getState();
    expect(state.activeProfileId).toBe(1);
    expect(state.currentPlaylist).toEqual(home);
    expect(mockedInvoke.mock.calls.map((c) => c[0])).toEqual(['set_active_profile_id']);

    act(() => result.current.clearError());
    expect(result.current.error).toBeNull();
  });
});
