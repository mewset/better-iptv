import { useEffect, useMemo, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { getGuide, getGuideEpgIds, type GuideProgram } from '../lib/tauri';
import { guideChannels, guideDataRange, guideWindow, normalizeEpgId } from '../lib/guideLayout';
import { logger } from '../lib/logger';
import type { Channel } from '../types';

const REFRESH_MS = 5 * 60_000;
// Joins ids into one dependency key; a NUL never appears in an EPG id.
const SEP = '\u0000';
/** Ids per get_guide request (the backend's GUIDE_MAX_IDS). */
export const GUIDE_REQUEST_IDS = 5000;

export interface GuideState {
  /** Channels with guide data in the five days (all with an id if the lookup failed). */
  rows: Channel[];
  /** Programmes in the visible window, keyed by normalized EPG id. */
  programs: Record<string, GuideProgram[]>;
  window: { from: number; to: number };
  /** Programmes for the current window are loading. */
  loading: boolean;
  /** The first lookup of which ids have data has not answered yet. */
  rowsLoading: boolean;
}

/** Start of the local calendar day of `now`, in epoch ms. */
function dayStart(now: number): number {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/**
 * The guide's rows and programmes.
 *
 * Step 1 asks which EPG ids have programmes in the five days the guide
 * offers (on mount, on `epg-refreshed`, and when the date changes); the rows
 * are the channels whose id is among them, in list order. Step 2 fetches the
 * visible window for all rows at once (on a new id set, a day change and
 * every 5 minutes), in requests of at most `GUIDE_REQUEST_IDS` ids. A failed
 * lookup falls back to every channel with an id; a failed programme request
 * leaves rows without programmes. Both are logged, not shown.
 */
export function useGuide(channels: Channel[], dayOffset: number): GuideState {
  const [tick, setTick] = useState(0);
  const [today, setToday] = useState(() => dayStart(Date.now()));
  // A new calendar day goes through step 1, whose answer reads the
  // programmes again; the tick only refreshes programmes within a day.
  const todayRef = useRef(today);
  useEffect(() => {
    const id = setInterval(() => {
      const start = dayStart(Date.now());
      if (start !== todayRef.current) {
        todayRef.current = start;
        setToday(start);
      } else {
        setTick((t) => t + 1);
      }
    }, REFRESH_MS);
    return () => clearInterval(id);
  }, []);

  // Step 1. null: not answered yet; 'all': the lookup failed.
  const [idsWithData, setIdsWithData] = useState<Set<string> | 'all' | null>(null);
  // Bumped on every answer, so step 2 reads the programmes again after a
  // refresh even when the set of row ids came back unchanged.
  const [answers, setAnswers] = useState(0);
  const [lookupKey, setLookupKey] = useState(0);
  useEffect(() => {
    const unlisten = listen('epg-refreshed', () => setLookupKey((k) => k + 1));
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);
  useEffect(() => {
    let cancelled = false;
    const range = guideDataRange(today);
    getGuideEpgIds(new Date(range.from).toISOString(), new Date(range.to).toISOString())
      .then((ids) => {
        if (cancelled) return;
        setIdsWithData(new Set(ids));
        setAnswers((n) => n + 1);
      })
      .catch((err) => {
        logger.warn('Failed to look up which guide channels have data:', err);
        if (cancelled) return;
        setIdsWithData('all');
        setAnswers((n) => n + 1);
      });
    return () => {
      cancelled = true;
    };
  }, [today, lookupKey]);

  const rows = useMemo(
    () =>
      idsWithData === null
        ? []
        : guideChannels(channels, idsWithData === 'all' ? null : idsWithData),
    [channels, idsWithData]
  );
  const idsKey = useMemo(() => {
    const ids = new Set<string>();
    for (const channel of rows) ids.add(normalizeEpgId(channel.epg_id!));
    return [...ids].join(SEP);
  }, [rows]);

  // Step 2. `forKey` names the request the programmes in state answer: until
  // it matches the current one they are not this request's, and the guide
  // still counts as loading, so rows never flash "No guide data" between a
  // new set of ids and the request that fetches them.
  const requestKey = `${idsKey}\u0001${dayOffset}`;
  const [state, setState] = useState<
    Omit<GuideState, 'rows' | 'rowsLoading'> & { forKey: string | null }
  >(() => ({
    programs: {},
    window: guideWindow(Date.now(), dayOffset),
    loading: true,
    forKey: null,
  }));
  useEffect(() => {
    const forKey = `${idsKey}\u0001${dayOffset}`;
    const win = guideWindow(Date.now(), dayOffset);
    const ids = idsKey === '' ? [] : idsKey.split(SEP);
    if (ids.length === 0) {
      setState({ programs: {}, window: win, loading: false, forKey });
      return;
    }

    let cancelled = false;
    setState((s) => ({ ...s, window: win, loading: true }));
    const from = new Date(win.from).toISOString();
    const to = new Date(win.to).toISOString();
    const requests: Array<Promise<Record<string, GuideProgram[]>>> = [];
    for (let i = 0; i < ids.length; i += GUIDE_REQUEST_IDS) {
      requests.push(getGuide(ids.slice(i, i + GUIDE_REQUEST_IDS), from, to));
    }
    Promise.all(requests)
      .then((parts) => {
        if (!cancelled) {
          setState({ programs: Object.assign({}, ...parts), window: win, loading: false, forKey });
        }
      })
      .catch((err) => {
        logger.error('Failed to load the TV guide:', err);
        if (!cancelled) setState({ programs: {}, window: win, loading: false, forKey });
      });
    return () => {
      cancelled = true;
    };
    // answers: a new lookup answer (refresh, new day) reads the programmes
    // again once, with the ids it brought.
  }, [idsKey, dayOffset, tick, answers]);

  return {
    programs: state.programs,
    window: state.window,
    // Until the lookup answers there are no rows to load programmes for.
    loading: idsWithData === null || state.loading || state.forKey !== requestKey,
    rows,
    rowsLoading: idsWithData === null,
  };
}
