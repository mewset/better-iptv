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
  /** Each watched series' episode list as the viewer last saw it (its page). */
  knownEpisodes: Record<number, string[]>;
  /** Episodes added since, per series (`useNewEpisodeCheck`); cleared by opening the series. */
  newEpisodes: Record<number, string[]>;
  /** The series' page opened: its list is seen, nothing on it is new any more. */
  markSeen: (channelId: number, episodeIds: string[]) => void;
  /** A check's result: a series never checked only gets its list remembered. */
  recordCheck: (channelId: number, episodeIds: string[], newIds: string[]) => void;
}

const KNOWN_KEY = 'better-iptv.series-known';
const NEW_KEY = 'better-iptv.series-new';

function loadRecord(key: string): Record<number, string[]> {
  try {
    const raw = localStorage.getItem(key);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? (parsed as Record<number, string[]>) : {};
  } catch {
    return {};
  }
}

function saveRecord(key: string, value: Record<number, string[]>): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private mode or blocked storage: only this session remembers
  }
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

function sameEntries(a: WatchProgress[], b: WatchProgress[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (
      x.channel_id !== y.channel_id ||
      x.episode_id !== y.episode_id ||
      x.updated_at !== y.updated_at ||
      x.watched !== y.watched ||
      x.position_secs !== y.position_secs
    )
      return false;
  }
  return true;
}

export const useProgressStore = create<ProgressState>((set, get) => ({
  playlistId: null,
  entries: [],
  index: EMPTY,
  finales: loadFinales(),
  knownEpisodes: loadRecord(KNOWN_KEY),
  newEpisodes: loadRecord(NEW_KEY),
  markSeen: (channelId, episodeIds) => {
    const knownEpisodes = { ...get().knownEpisodes, [channelId]: episodeIds };
    const newEpisodes = { ...get().newEpisodes };
    delete newEpisodes[channelId];
    set({ knownEpisodes, newEpisodes });
    saveRecord(KNOWN_KEY, knownEpisodes);
    saveRecord(NEW_KEY, newEpisodes);
  },
  recordCheck: (channelId, episodeIds, newIds) => {
    if (!get().knownEpisodes[channelId]) {
      const knownEpisodes = { ...get().knownEpisodes, [channelId]: episodeIds };
      set({ knownEpisodes });
      saveRecord(KNOWN_KEY, knownEpisodes);
      return;
    }
    const newEpisodes = { ...get().newEpisodes };
    if (newIds.length > 0) newEpisodes[channelId] = newIds;
    else delete newEpisodes[channelId];
    set({ newEpisodes });
    saveRecord(NEW_KEY, newEpisodes);
  },
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
      // Unchanged (most reloads while nothing plays, or between saves): keep
      // the same objects, so posters and Home do not re-render for nothing
      if (sameEntries(get().entries, list)) return;
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
