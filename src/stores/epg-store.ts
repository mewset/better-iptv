import { create } from 'zustand';
import { getEpgStatus, type EpgStatus, type NowNext } from '../lib/epgIpc';
import { isNowNextStale } from '../lib/epgTime';
import { logger } from '../lib/logger';

/** A key the guide had nothing for is not asked about again for this long (ms). */
export const MISS_RETRY_MS = 5 * 60_000;

/**
 * The guide's frontend cache, apart from player-store so a guide answer
 * re-renders only what reads it.
 *
 * Now/next is kept per guide key (a channel's `epg_id`, the backend's match
 * key), so two channels with one key share one entry and one request, and
 * the cards and the dock read the same entry. `generation` counts
 * `epg-refreshed` events: an entry fetched in an earlier generation is shown
 * until its key is asked again, and is asked again the next time it is
 * wanted.
 *
 * The maps hold the wanted keys and little else: every answer drops the
 * entries of keys no longer wanted that are from an earlier generation or
 * past their boundary, and the misses of unwanted keys that may be asked
 * again anyway. Scrolling through a long list therefore never grows them
 * past the keys still worth keeping.
 */
interface EpgState {
  /** Now/next per key. */
  nowNext: Map<string, NowNext>;
  /** Keys answered in the current generation (hits and misses). */
  fetchedIn: Set<string>;
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
   * notification): `entries` are hits, `misses` keys without data, at `now`.
   * `generation` is the one the request was made in; a stale answer is
   * dropped. `wanted` are the keys on screen: their entries are kept even
   * when old, so their cards do not flash while they are asked again.
   */
  setNowNext: (
    entries: Array<[string, NowNext]>,
    misses: string[],
    now: number,
    generation: number,
    wanted: ReadonlySet<string>
  ) => void;
  /** Everything cached is stale (`epg-refreshed`). */
  invalidate: () => void;
  setStatus: (status: EpgStatus) => void;
  /** Asks for the status once, unless one is known or being asked for. */
  loadStatus: () => void;
}

export const useEpgStore = create<EpgState>((set, get) => ({
  nowNext: new Map(),
  fetchedIn: new Set(),
  missedAt: new Map(),
  generation: 0,
  status: null,
  statusFailed: false,
  statusLoading: false,

  setNowNext: (entries, misses, now, generation, wanted) =>
    set((state) => {
      if (generation !== state.generation || (entries.length === 0 && misses.length === 0)) {
        return {};
      }
      const fetchedIn = new Set(state.fetchedIn);
      const missedAt = new Map(state.missedAt);
      // Entries no longer wanted that would be asked again anyway.
      const dropped: string[] = [];
      for (const [key, entry] of state.nowNext) {
        if (!wanted.has(key) && (!fetchedIn.has(key) || isNowNextStale(entry, now))) {
          dropped.push(key);
        }
      }
      for (const [key, at] of missedAt) {
        if (!wanted.has(key) && now - at >= MISS_RETRY_MS) {
          missedAt.delete(key);
          fetchedIn.delete(key);
        }
      }
      // nowNext keeps its identity when the answer changes no entry, so a
      // batch of misses re-renders no card.
      const changesEntries =
        entries.length > 0 || dropped.length > 0 || misses.some((key) => state.nowNext.has(key));
      const nowNext = changesEntries ? new Map(state.nowNext) : state.nowNext;
      for (const key of dropped) {
        nowNext.delete(key);
        fetchedIn.delete(key);
      }
      for (const [key, entry] of entries) {
        nowNext.set(key, entry);
        missedAt.delete(key);
        fetchedIn.add(key);
      }
      for (const key of misses) {
        nowNext.delete(key);
        missedAt.set(key, now);
        fetchedIn.add(key);
      }
      return { nowNext, fetchedIn, missedAt };
    }),

  invalidate: () =>
    set((state) => ({
      generation: state.generation + 1,
      fetchedIn: new Set<string>(),
      missedAt: new Map<string, number>(),
    })),

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
