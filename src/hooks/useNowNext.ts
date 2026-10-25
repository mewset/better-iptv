import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MISS_RETRY_MS, useEpgStore } from '../stores/epg-store';
import { getEpgNowNext, NOW_NEXT_BATCH, type NowNext } from '../lib/epgIpc';
import { isNowNextStale, nowNextBoundary } from '../lib/epgTime';
import { logger } from '../lib/logger';
import type { Channel } from '../types';

/** Wait after the wanted keys change before asking (scrolling settles). */
const DEBOUNCE_MS = 500;
/** A key the guide had nothing for, or a failed request, is not asked again for this long. */
export const EMPTY_RETRY_MS = MISS_RETRY_MS;
/** Ask this long after a programme boundary, so the next programme has begun. */
const BOUNDARY_SLACK_MS = 1000;
/** The boundary timer never waits longer than this; it re-arms on firing. */
const MAX_TIMER_MS = 60 * 60_000;
// Joins keys into one dependency; a NUL never appears in an EPG id.
const SEP = '\u0000';

/**
 * The guide key of a live channel with an `epg_id`, else null. `epg_id` is
 * the backend's match key already, so it is the key as it is.
 */
export function epgKey(channel: Channel): string | null {
  if (channel.content_type !== 'live' || !channel.epg_id) return null;
  return channel.epg_id;
}

/** A channel's now/next entry in `nowNext`, if any. */
export function nowNextFor(nowNext: Map<string, NowNext>, channel: Channel): NowNext | undefined {
  const key = epgKey(channel);
  return key === null ? undefined : nowNext.get(key);
}

/**
 * Whether the guide has answered for a channel: it has no guide key (so it has
 * no guide data), or its key was answered in this generation (`fetchedIn`).
 */
export function guideAnswered(fetchedIn: ReadonlySet<string>, channel: Channel): boolean {
  const key = epgKey(channel);
  return key === null || fetchedIn.has(key);
}

type EpgCache = Pick<ReturnType<typeof useEpgStore.getState>, 'nowNext' | 'fetchedIn' | 'missedAt'>;

/**
 * Whether `key` has to be asked for at `now`: never answered in this
 * generation, a miss older than `EMPTY_RETRY_MS`, or an entry whose
 * programme boundary has passed.
 */
function isDue(cache: EpgCache, key: string, now: number): boolean {
  if (!cache.fetchedIn.has(key)) return true;
  const missed = cache.missedAt.get(key);
  if (missed !== undefined) return now - missed >= EMPTY_RETRY_MS;
  const entry = cache.nowNext.get(key);
  return entry === undefined || isNowNextStale(entry, now);
}

/**
 * Now and next for the channels on screen and the playing channel, from
 * the epg store; returns the store's map, read with `nowNextFor`.
 *
 * Wanted keys are those of the live channels passed in, the playing
 * channel's first so the batch cap never drops it, each key once however
 * many channels share it. A key is asked for when it is due (`isDue`), in
 * requests of at most `NOW_NEXT_BATCH` keys; a capped request is followed
 * by the next one, so keys without guide data never hold up the rest.
 *
 * Instead of polling, one timer fires just after the earliest programme
 * boundary among the wanted entries (or when a miss may be asked again) and
 * asks for what has become due. An `epg-refreshed` event (a new store
 * generation) asks for every wanted key again; entries stay on screen until
 * their answer replaces them.
 */
export function useNowNext(channels: Channel[], playing?: Channel | null): Map<string, NowNext> {
  // Only what the cards show and what starts a request: a batch of misses
  // changes neither, and re-renders nothing.
  const nowNext = useEpgStore((s) => s.nowNext);
  const generation = useEpgStore((s) => s.generation);

  const wantedKey = useMemo(() => {
    const keys = new Set<string>();
    const first = playing ? epgKey(playing) : null;
    if (first !== null) keys.add(first);
    for (const channel of channels) {
      const key = epgKey(channel);
      if (key !== null) keys.add(key);
    }
    return [...keys].join(SEP);
  }, [channels, playing]);
  const wantedRef = useRef<string[]>([]);
  wantedRef.current = wantedKey === '' ? [] : wantedKey.split(SEP);

  const alive = useRef(true);
  const inFlight = useRef(false);
  // A request was wanted while one ran: ask again when it ends.
  const askAgain = useRef(false);
  // When the last request failed; null after a success.
  const failedAt = useRef<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [pass, setPass] = useState(0);

  // `schedule` and `fetchDue` call each other; the ref breaks the cycle.
  const scheduleRef = useRef<() => void>(() => {});

  const fetchDue = useCallback(async () => {
    if (inFlight.current) {
      askAgain.current = true;
      return;
    }
    const cache = useEpgStore.getState();
    const started = Date.now();
    const due = wantedRef.current.filter((key) => isDue(cache, key, started));
    if (due.length === 0) return;
    const batch = due.slice(0, NOW_NEXT_BATCH);
    let more = due.length > NOW_NEXT_BATCH;

    inFlight.current = true;
    try {
      const answer = await getEpgNowNext(batch);
      const now = Date.now();
      const entries: Array<[string, NowNext]> = [];
      const misses: string[] = [];
      for (const key of batch) {
        const entry = answer[key];
        // Nothing usable, or an entry already past its boundary (storing it
        // would only ask again at once): remember the miss.
        if (!entry || (!entry.now && !entry.next) || isNowNextStale(entry, now)) {
          misses.push(key);
        } else {
          entries.push([key, entry]);
        }
      }
      useEpgStore
        .getState()
        .setNowNext(entries, misses, now, cache.generation, new Set(wantedRef.current));
      failedAt.current = null;
    } catch (err) {
      logger.debug('Failed to fetch now/next:', err);
      // Not again at once: the timer asks again after EMPTY_RETRY_MS.
      more = false;
      failedAt.current = Date.now();
    } finally {
      inFlight.current = false;
    }
    if (!alive.current) return;
    scheduleRef.current();
    if (more || askAgain.current) {
      askAgain.current = false;
      setPass((p) => p + 1);
    }
  }, []);

  /**
   * (Re)arms the one timer: just after the earliest programme boundary
   * among the wanted entries, when a miss or a failed request may be asked
   * again, at most MAX_TIMER_MS ahead. A wanted entry already past its
   * boundary (the timer was cleared by a re-run after the boundary, before
   * it fired), or a miss already due, is asked for at once.
   */
  const schedule = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    if (!alive.current || wantedRef.current.length === 0) return;
    const cache = useEpgStore.getState();
    const now = Date.now();
    let at = Infinity;
    let dueNow = false;
    const consider = (t: number) => {
      if (t > now) at = Math.min(at, t);
      else dueNow = true;
    };
    if (failedAt.current !== null) consider(failedAt.current + EMPTY_RETRY_MS);
    for (const key of wantedRef.current) {
      // Not answered in this generation: the request effect asks for it.
      if (!cache.fetchedIn.has(key)) continue;
      const missed = cache.missedAt.get(key);
      if (missed !== undefined) {
        consider(missed + EMPTY_RETRY_MS);
        continue;
      }
      const entry = cache.nowNext.get(key);
      const boundary = entry ? nowNextBoundary(entry) : null;
      if (boundary === null) continue;
      if (boundary <= now) dueNow = true;
      else consider(boundary + BOUNDARY_SLACK_MS);
    }
    // After a failure only the retry time asks again, never a loop.
    if (dueNow && failedAt.current === null) void fetchDue();
    if (at === Infinity) return;
    timer.current = setTimeout(
      () => {
        timer.current = null;
        void fetchDue();
        scheduleRef.current();
      },
      Math.min(at - now, MAX_TIMER_MS)
    );
  }, [fetchDue]);
  scheduleRef.current = schedule;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = null;
    };
  }, []);

  // New wanted keys, a new generation, or the next capped batch.
  useEffect(() => {
    if (wantedKey === '') return;
    const t = setTimeout(fetchDue, DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [wantedKey, generation, pass, fetchDue]);

  // Other keys, or a new generation, move the earliest boundary; answers
  // re-arm the timer from fetchDue.
  useEffect(() => {
    schedule();
  }, [wantedKey, generation, schedule]);

  return nowNext;
}
