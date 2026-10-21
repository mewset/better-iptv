import { useEffect, useId, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Minus, Plus } from 'lucide-react';
import { setEpgTimePolicy, type EpgSource, type TimePolicy } from '../../lib/epgIpc';
import {
  SHIFT_MAX_MINUTES,
  SHIFT_MIN_MINUTES,
  SHIFT_STEP_MINUTES,
  clampShift,
  errorText,
  formatShift,
  shiftPreview,
} from '../../lib/epgSourceView';
import { describeClock, nextClockChangeText } from '../../lib/clockChange';
import { logger } from '../../lib/logger';

/** A change waits this long for the next one before it is sent. */
export const POLICY_DEBOUNCE_MS = 800;

interface TimeCorrectionProps {
  source: EpgSource;
  /** Epoch ms, from the shared ticker. */
  now: number;
  /** The source is being removed: a change still waiting is dropped, not sent. */
  removing?: boolean;
}

const stepButton =
  'flex h-8 w-8 items-center justify-center rounded-lg border border-border-strong bg-text/5 text-text transition-colors hover:bg-text/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-40';

/**
 * A source's time correction, behind a disclosure: the shift stepper
 * first, the local-time reading behind "Advanced". Every change is sent on
 * its own after a short pause (no Save). "Applying…" comes from the
 * backend's `applying` flag; from the click until the call returns the row
 * shows it on its own.
 */
export default function TimeCorrection({ source, now, removing = false }: TimeCorrectionProps) {
  const id = useId();
  const [open, setOpen] = useState(false);
  // Null follows the source: open where there is something to look at,
  // unknown zones that appear later included. A click decides from then on.
  const [advancedChoice, setAdvancedChoice] = useState<boolean | null>(null);
  const advancedOpen =
    advancedChoice ??
    (source.policy.shift_minutes !== 0 ||
      source.policy.interpret === 'local_zone' ||
      source.unknown_zone_count > 0);
  const [draft, setDraft] = useState<TimePolicy>(source.policy);
  // A change made here that its call has not answered yet.
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draftRef = useRef(draft);
  // Bumped by every change: an answer to an older call is not this change's.
  const seqRef = useRef(0);
  const sourceRef = useRef(source);
  sourceRef.current = source;
  const earlierRef = useRef<globalThis.HTMLButtonElement>(null);

  // Follow the backend's policy while no change of this row is on its way;
  // after a refused change this puts the stepper back.
  const { interpret, shift_minutes } = source.policy;
  useEffect(() => {
    if (waiting) return;
    const policy = { interpret, shift_minutes };
    draftRef.current = policy;
    setDraft(policy);
  }, [interpret, shift_minutes, waiting]);

  const send = (seq: number) => {
    timer.current = null;
    setEpgTimePolicy(sourceRef.current.id, draftRef.current)
      .catch((err) => {
        logger.error('Failed to set the guide time correction:', err);
        if (seq === seqRef.current) {
          setError(`Could not change the time correction: ${errorText(err)}`);
        }
      })
      .finally(() => {
        if (seq === seqRef.current) setWaiting(false);
      });
  };
  const sendRef = useRef(send);
  sendRef.current = send;

  // Leaving Settings inside the pause still sends the last change; a
  // source on its way out gets none.
  const removingRef = useRef(removing);
  removingRef.current = removing;
  useEffect(() => {
    if (!removing || timer.current === null) return;
    clearTimeout(timer.current);
    timer.current = null;
    seqRef.current++;
    setWaiting(false);
  }, [removing]);
  useEffect(
    () => () => {
      if (timer.current === null) return;
      clearTimeout(timer.current);
      timer.current = null;
      if (removingRef.current) return;
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
    setWaiting(true);
    const seq = ++seqRef.current;
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => sendRef.current(seq), POLICY_DEBOUNCE_MS);
  };

  const shift = draft.shift_minutes;
  const setShift = (minutes: number) => change({ ...draft, shift_minutes: clampShift(minutes) });
  const localZone = draft.interpret === 'local_zone';

  const summary = [localZone ? 'local time' : null, shift !== 0 ? formatShift(shift) : null]
    .filter(Boolean)
    .join(', ');
  const note =
    waiting || source.applying
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
                ref={earlierRef}
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
                onClick={() => {
                  setShift(0);
                  // The Reset button goes away; keep focus on the stepper.
                  earlierRef.current?.focus();
                }}
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
              onClick={() => setAdvancedChoice(!advancedOpen)}
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
                <p className="text-xs text-text-muted">Your clock: {describeClock(now)}</p>
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
