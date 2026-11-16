import { create } from 'zustand';
import {
  getWatchProgress,
  setWatched as setWatchedCommand,
  type WatchProgress,
} from '../lib/tauri';
import { indexProgress, type ProgressIndex } from '../lib/watchProgress';
import { logger } from '../lib/logger';

/**
 * The profile's watch progress (`watch_progress`), reloaded while something
 * plays and after it stops (`useWatchProgressSync`).
 */
interface ProgressState {
  playlistId: number | null;
  entries: WatchProgress[];
  index: ProgressIndex;
  load: (playlistId: number | null) => Promise<void>;
  setWatched: (channelId: number, episodeId: string | null, watched: boolean) => Promise<void>;
  /** Several episodes of one series at once (a season), with one reload. */
  setEpisodesWatched: (channelId: number, episodeIds: string[], watched: boolean) => Promise<void>;
  /**
   * Each series' final episode id, learned when its page loads (episodes
   * only play from there), so a finished series leaves Continue watching.
   */
  finales: Record<number, string>;
  setFinale: (channelId: number, episodeId: string | undefined) => void;
}

const FINALES_KEY = 'better-iptv.series-finales';

function loadFinales(): Record<number, string> {
  try {
    const raw = localStorage.getItem(FINALES_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? (parsed as Record<number, string>) : {};
  } catch {
    return {};
  }
}

const EMPTY = indexProgress([]);

export const useProgressStore = create<ProgressState>((set, get) => ({
  playlistId: null,
  entries: [],
  index: EMPTY,
  finales: loadFinales(),
  setFinale: (channelId, episodeId) => {
    if (episodeId === undefined || get().finales[channelId] === episodeId) return;
    const finales = { ...get().finales, [channelId]: episodeId };
    set({ finales });
    try {
      localStorage.setItem(FINALES_KEY, JSON.stringify(finales));
    } catch {
      // Private mode or blocked storage: only this session remembers
    }
  },
  load: async (playlistId) => {
    if (playlistId === null) {
      set({ playlistId, entries: [], index: EMPTY });
      return;
    }
    // Another profile's entries never show under this one
    if (get().playlistId !== playlistId) set({ playlistId, entries: [], index: EMPTY });
    try {
      const entries = await getWatchProgress(playlistId);
      const list = Array.isArray(entries) ? entries : [];
      // A profile switch meanwhile wins
      if (get().playlistId !== playlistId) return;
      set({ entries: list, index: indexProgress(list) });
    } catch (err) {
      logger.warn('Could not load watch progress:', err);
    }
  },
  setWatched: async (channelId, episodeId, watched) => {
    try {
      await setWatchedCommand(channelId, episodeId, watched);
    } catch (err) {
      logger.warn('Could not change the watched mark:', err);
    }
    await get().load(get().playlistId);
  },
  setEpisodesWatched: async (channelId, episodeIds, watched) => {
    try {
      await Promise.all(episodeIds.map((id) => setWatchedCommand(channelId, id, watched)));
    } catch (err) {
      logger.warn('Could not change the watched marks:', err);
    }
    await get().load(get().playlistId);
  },
}));
