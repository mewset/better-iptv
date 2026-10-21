import { create } from 'zustand';
import { getEpgStatus, type EpgStatus, type NowNext } from '../lib/epgIpc';
import { logger } from '../lib/logger';

/**
 * The guide's frontend cache, apart from player-store so a guide answer
 * re-renders only what reads it.
 *
 * Now/next is kept per guide key (a channel's normalized `epg_id`), so two
 * channels with one key share one entry and one request, and the cards and
 * the dock read the same entry. `generation` counts `epg-refreshed` events:
 * an entry fetched in an earlier generation is shown until its key is asked
 * again, and is asked again the next time it is wanted.
 */
interface EpgState {
  /** Now/next per key. */
  nowNext: Map<string, NowNext>;
  /** The generation each key in `nowNext` or `missedAt` was answered in. */
  fetchedIn: Map<string, number>;
  /** Keys the guide had nothing for in this generation, and when (epoch ms). */
  missedAt: Map<string, number>;
  /** Bumped by `invalidate`; answers to requests of an earlier one are dropped. */
  generation: number;
  /** The status for the active profile; null until the first answer or event. */
  status: EpgStatus | null;
  /** The status request failed and no event has brought one since. */
  statusFailed: boolean;
  /** A status request is running. */
  statusLoading: boolean;
  /**
   * Stores one now/next answer at once (one copy of each map, one
   * notification): `entries` are hits, `misses` keys without data.
   * `generation` is the one the request was made in; a stale answer is
   * dropped.
   */
  setNowNext: (
    entries: Array<[string, NowNext]>,
    misses: string[],
    now: number,
    generation: number
  ) => void;
  /** Everything cached is stale (`epg-refreshed`). */
  invalidate: () => void;
  setStatus: (status: EpgStatus) => void;
  /** Asks for the status once, unless one is known or being asked for. */
  loadStatus: () => void;
}

export const useEpgStore = create<EpgState>((set, get) => ({
  nowNext: new Map(),
  fetchedIn: new Map(),
  missedAt: new Map(),
  generation: 0,
  status: null,
  statusFailed: false,
  statusLoading: false,

  setNowNext: (entries, misses, now, generation) =>
    set((state) => {
      if (generation !== state.generation || (entries.length === 0 && misses.length === 0)) {
        return {};
      }
      const fetchedIn = new Map(state.fetchedIn);
      const missedAt = new Map(state.missedAt);
      // A miss only touches nowNext when it drops an entry: keep its
      // identity otherwise, so a batch of misses re-renders no card.
      const dropsEntry = misses.some((key) => state.nowNext.has(key));
      const nowNext = entries.length > 0 || dropsEntry ? new Map(state.nowNext) : state.nowNext;
      for (const [key, entry] of entries) {
        nowNext.set(key, entry);
        missedAt.delete(key);
        fetchedIn.set(key, generation);
      }
      for (const key of misses) {
        nowNext.delete(key);
        missedAt.set(key, now);
        fetchedIn.set(key, generation);
      }
      return { nowNext, fetchedIn, missedAt };
    }),

  invalidate: () =>
    set((state) => ({ generation: state.generation + 1, missedAt: new Map<string, number>() })),

  setStatus: (status) => set({ status, statusFailed: false }),

  loadStatus: () => {
    const { status, statusLoading } = get();
    if (status !== null || statusLoading) return;
    set({ statusLoading: true });
    getEpgStatus()
      .then((answer) => {
        // An epg-status event that arrived meanwhile is at least as new.
        set((state) => (state.status === null ? { status: answer, statusFailed: false } : {}));
      })
      .catch((err) => {
        logger.warn('Failed to read the EPG status:', err);
        set((state) => (state.status === null ? { statusFailed: true } : {}));
      })
      .finally(() => set({ statusLoading: false }));
  },
}));
