import { useEffect, useMemo, useState } from 'react';
import { getGuide, type GuideProgram } from '../lib/tauri';
import { guideChannels, guideWindow } from '../lib/guideLayout';
import { logger } from '../lib/logger';
import type { Channel } from '../types';

const REFRESH_MS = 5 * 60_000;
// Joins ids into one dependency key; a NUL never appears in an EPG id.
const SEP = '\u0000';

interface GuideState {
  programs: Record<string, GuideProgram[]>;
  window: { from: number; to: number };
  loading: boolean;
}

/**
 * Guide programmes for the first 100 channels with an `epg_id`, keyed by the
 * trimmed id. Fetches on mount, when `dayOffset` or the set of ids changes,
 * and every 5 minutes (Today's window moves with the clock on that tick). A
 * rejected request is logged and leaves no programmes, so rows show their
 * "No guide data" state instead of the view failing.
 */
export function useGuide(channels: Channel[], dayOffset: number): GuideState {
  const idsKey = useMemo(() => {
    const ids = new Set<string>();
    for (const channel of guideChannels(channels)) ids.add(channel.epg_id!.trim());
    return [...ids].join(SEP);
  }, [channels]);

  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), REFRESH_MS);
    return () => clearInterval(id);
  }, []);

  const [state, setState] = useState<GuideState>(() => ({
    programs: {},
    window: guideWindow(Date.now(), dayOffset),
    loading: idsKey !== '',
  }));

  useEffect(() => {
    const win = guideWindow(Date.now(), dayOffset);
    const ids = idsKey === '' ? [] : idsKey.split(SEP);
    if (ids.length === 0) {
      setState({ programs: {}, window: win, loading: false });
      return;
    }

    let cancelled = false;
    setState((s) => ({ ...s, window: win, loading: true }));
    getGuide(ids, new Date(win.from).toISOString(), new Date(win.to).toISOString())
      .then((programs) => {
        if (!cancelled) setState({ programs: programs ?? {}, window: win, loading: false });
      })
      .catch((err) => {
        logger.error('Failed to load the TV guide:', err);
        if (!cancelled) setState({ programs: {}, window: win, loading: false });
      });
    return () => {
      cancelled = true;
    };
  }, [idsKey, dayOffset, tick]);

  return state;
}
