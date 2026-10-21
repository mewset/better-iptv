import { useEffect, useId, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Minus, Plus } from 'lucide-react';
import {
  setEpgTimePolicy,
  type EpgSource,
  type EpgStatus,
  type TimePolicy,
} from '../../lib/epgIpc';
import {
  SHIFT_MAX_MINUTES,
  SHIFT_MIN_MINUTES,
  SHIFT_STEP_MINUTES,
  clampShift,
  errorText,
  formatShift,
  samePolicy,
  shiftPreview,
} from '../../lib/epgSourceView';
import { describeClock, nextClockChangeText } from '../../lib/clockChange';
import { useEpgStore } from '../../stores/epg-store';
import { logger } from '../../lib/logger';

/** A change waits this long for the next one before it is sent. */
export const POLICY_DEBOUNCE_MS = 800;

/**
 * A policy change on its way: waiting out the debounce, sent, or answered.
 * `generation` is the store's when it was sent, so only a later
 * `epg-refreshed` counts; `statusAtAnswer` the status when the call
 * returned, so only a later one counts.
 */
interface Applying {
  phase: 'waiting' | 'sent' | 'answered';
  policy: TimePolicy;
  seq: number;
  generation: number;
  statusAtAnswer: EpgStatus | null;
}

interface TimeCorrectionProps {
  source: EpgSource;
  /** Epoch ms, from the shared ticker. */
  now: number;
}

const stepButton =
  'flex h-8 w-8 items-center justify-center rounded-lg border border-border-strong bg-text/5 text-text transition-colors hover:bg-text/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-40';

/**
 * A source's time correction, behind a disclosure: the shift stepper
 * first, the local-time reading behind "Advanced". Every change is sent on
 * its own after a short pause (no Save); the row reads "Applying…" until
 * the backend has re-read the guide or said it could not yet.
 */
export default function TimeCorrection({ source, now }: TimeCorrectionProps) {
  const id = useId();
  const [open, setOpen] = useState(false);
  // Open by default only where there is something to look at.
  const [advancedOpen, setAdvancedOpen] = useState(
    () =>
      source.policy.shift_minutes !== 0 ||
      source.policy.interpret === 'local_zone' ||
      source.unknown_zone_count > 0
  );
  const [draft, setDraft] = useState<TimePolicy>(source.policy);
  const [applying, setApplying] = useState<Applying | null>(null);
  const [error, setError] = useState<string | null>(null);

  const status = useEpgStore((s) => s.status);
  const generation = useEpgStore((s) => s.generation);
  const lastRefreshed = useEpgStore((s) => s.lastRefreshed);

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draftRef = useRef(draft);
  const seqRef = useRef(0);
  const sourceRef = useRef(source);
  sourceRef.current = source;

  // Follow the backend's policy while nothing is being changed here.
  const { interpret, shift_minutes } = source.policy;
  useEffect(() => {
    if (applying !== null || timer.current !== null) return;
    const policy = { interpret, shift_minutes };
    draftRef.current = policy;
    setDraft(policy);
  }, [interpret, shift_minutes, applying]);

  // "Applying…" ends when the new policy is in the store, when the guide
  // was refreshed for this source, when there is no cached feed to re-read
  // (the next download applies it), or at the first status after the call
  // returned: a re-read that failed only sends a status, so waiting longer
  // could wait forever.
  useEffect(() => {
    if (applying === null || applying.phase === 'waiting') return;
    const row = status?.sources.find((s) => s.id === source.id);
    const written = row !== undefined && samePolicy(row.policy, applying.policy);
    const applied = written && !row.policy_pending;
    const nothingToReRead = written && !row.has_cached_feed;
    const refreshed =
      generation > applying.generation &&
      lastRefreshed !== null &&
      (lastRefreshed.source_id === null || lastRefreshed.source_id === source.id);
    const statusAfterAnswer = applying.phase === 'answered' && status !== applying.statusAtAnswer;
    if (row === undefined || applied || nothingToReRead || refreshed || statusAfterAnswer) {
      setApplying(null);
    }
  }, [applying, status, generation, lastRefreshed, source.id]);

  const send = () => {
    timer.current = null;
    const policy = draftRef.current;
    const seq = ++seqRef.current;
    const store = useEpgStore.getState();
    setApplying({
      phase: 'sent',
      policy,
      seq,
      generation: store.generation,
      statusAtAnswer: null,
    });
    setEpgTimePolicy(sourceRef.current.id, policy)
      .then(() => {
        const statusAtAnswer = useEpgStore.getState().status;
        setApplying((a) => (a?.seq === seq ? { ...a, phase: 'answered', statusAtAnswer } : a));
      })
      .catch((err) => {
        logger.error('Failed to set the guide time correction:', err);
        setError(`Could not change the time correction: ${errorText(err)}`);
        setApplying((a) => (a?.seq === seq ? null : a));
      });
  };
  const sendRef = useRef(send);
  sendRef.current = send;

  // Leaving Settings inside the pause still sends the last change.
  useEffect(
    () => () => {
      if (timer.current === null) return;
      clearTimeout(timer.current);
      timer.current = null;
      setEpgTimePolicy(sourceRef.current.id, draftRef.current).catch((err) =>
        logger.error('Failed to set the guide time correction:', err)
      );
    },
    []
  );

  const change = (next: TimePolicy) => {
    draftRef.current = next;
    setDraft(next);
    setError(null);
    // seq 0 matches no call: an answer to an earlier one must not end
    // the wait for this change.
    setApplying({ phase: 'waiting', policy: next, seq: 0, generation, statusAtAnswer: null });
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => sendRef.current(), POLICY_DEBOUNCE_MS);
  };

  const shift = draft.shift_minutes;
  const setShift = (minutes: number) => change({ ...draft, shift_minutes: clampShift(minutes) });
  const localZone = draft.interpret === 'local_zone';

  const summary = [localZone ? 'local time' : null, shift !== 0 ? formatShift(shift) : null]
    .filter(Boolean)
    .join(', ');
  const note = applying
    ? 'Applying…'
    : source.policy_pending
      ? 'Takes effect at the next update'
      : null;

  const panelId = `${id}-panel`;
  const advancedId = `${id}-advanced`;
  const valueId = `${id}-value`;
  const nextChange = open && advancedOpen ? nextClockChangeText(now) : null;

  return (
    <div className="mt-3 border-t border-border pt-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((o) => !o)}
          className="flex items-center gap-1 rounded text-sm font-medium text-text-muted transition-colors hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          {open ? (
            <ChevronDown className="h-4 w-4" aria-hidden="true" />
          ) : (
            <ChevronRight className="h-4 w-4" aria-hidden="true" />
          )}
          Time correction
          {summary && <span className="font-normal text-text-faint">· {summary}</span>}
        </button>
        <span aria-live="polite" className="text-xs text-text-muted">
          {note}
        </span>
      </div>

      {open && (
        <div id={panelId} className="mt-3 space-y-3 pl-5">
          <div className="flex flex-wrap items-center gap-3">
            <span id={`${id}-label`} className="text-sm text-text">
              Guide times are off by:
            </span>
            <div
              role="group"
              aria-labelledby={`${id}-label ${valueId}`}
              className="flex items-center gap-2"
            >
              <button
                type="button"
                aria-label="Shift guide times 30 minutes earlier"
                disabled={shift <= SHIFT_MIN_MINUTES}
                onClick={() => setShift(shift - SHIFT_STEP_MINUTES)}
                className={stepButton}
              >
                <Minus className="h-4 w-4" aria-hidden="true" />
              </button>
              <span
                id={valueId}
                aria-live="polite"
                className="min-w-[6.5rem] text-center text-sm font-semibold tabular-nums text-text"
              >
                {formatShift(shift)}
              </span>
              <button
                type="button"
                aria-label="Shift guide times 30 minutes later"
                disabled={shift >= SHIFT_MAX_MINUTES}
                onClick={() => setShift(shift + SHIFT_STEP_MINUTES)}
                className={stepButton}
              >
                <Plus className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>
            {shift !== 0 && (
              <button
                type="button"
                onClick={() => setShift(0)}
                className="rounded px-2 py-1 text-sm text-text-muted transition-colors hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                Reset
              </button>
            )}
          </div>
          {shift !== 0 && <p className="text-xs text-text-faint">{shiftPreview(shift)}</p>}

          <div>
            <button
              type="button"
              aria-expanded={advancedOpen}
              aria-controls={advancedId}
              onClick={() => setAdvancedOpen((o) => !o)}
              className="flex items-center gap-1 rounded text-xs font-medium text-text-muted transition-colors hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              {advancedOpen ? (
                <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
              )}
              Advanced
            </button>
            {advancedOpen && (
              <div id={advancedId} className="mt-2 space-y-1.5 pl-5">
                <label className="flex items-center gap-3">
                  <input
                    type="checkbox"
                    checked={localZone}
                    onChange={(e) =>
                      change({
                        ...draft,
                        interpret: e.target.checked ? 'local_zone' : 'as_written',
                      })
                    }
                    className="h-4 w-4 accent-accent"
                  />
                  <span className="text-sm text-text">
                    Treat the guide&apos;s times as this computer&apos;s local time
                  </span>
                </label>
                <p className="text-xs text-text-faint">
                  For a guide that writes local times but labels them wrong: times then follow this
                  computer&apos;s clock changes, and during the hour that repeats when clocks go
                  back, programmes without a stated offset are placed in the first occurrence.
                </p>
                <p className="text-xs tabular-nums text-text-muted">
                  Your clock: {describeClock(now)}
                </p>
                {nextChange && (
                  <p className="text-xs text-text-muted">Next clock change: {nextChange}</p>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {error && (
        <p role="alert" className="mt-2 text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
