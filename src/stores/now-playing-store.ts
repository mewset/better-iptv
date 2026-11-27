import { create } from 'zustand';
import type { Channel } from '../types';

/** One queued episode as the player has it ("S1 E2 · Name"). */
export interface QueuedTitle {
  id: string;
  title: string;
}

/**
 * What the now-playing bar shows beyond the playing channel: what kind of
 * thing plays, the film or series it belongs to, an episode queue, and
 * whether the player is paused (read from MPV while something plays).
 */
export interface NowPlaying {
  kind: 'live' | 'film' | 'episode';
  /** The live channel, the film, or the series. */
  channel: Channel;
  /** Episodes only: the queue the player was given, in order. */
  queue?: QueuedTitle[];
}

interface NowPlayingState {
  info: NowPlaying | null;
  paused: boolean;
  setInfo: (info: NowPlaying | null) => void;
  setPaused: (paused: boolean) => void;
}

export const useNowPlayingStore = create<NowPlayingState>((set) => ({
  info: null,
  paused: false,
  setInfo: (info) => set({ info, paused: false }),
  setPaused: (paused) => set({ paused }),
}));
