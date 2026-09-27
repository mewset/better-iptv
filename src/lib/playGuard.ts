/**
 * One gate for every Play button. Pressing Play repeatedly used to spawn MPV
 * once per press; each spawn opens a provider connection, and IPTV lines that
 * allow one connection (and rate-limit bursts) then refuse all of them.
 *
 * A start is let through only when no other start is in flight and at least
 * two seconds have passed since the previous one. Stopping is never gated.
 */
const COOLDOWN_MS = 2000;

let inFlight = false;
let lastStart = Number.NEGATIVE_INFINITY;

/** Claim the gate; false means ignore this press. */
export function beginPlaybackStart(now: number = Date.now()): boolean {
  if (inFlight || now - lastStart < COOLDOWN_MS) return false;
  inFlight = true;
  lastStart = now;
  return true;
}

/** Release the gate once the start has finished, successfully or not. */
export function endPlaybackStart(): void {
  inFlight = false;
}

/** Test helper: forget any previous start. */
export function resetPlaybackGuard(): void {
  inFlight = false;
  lastStart = Number.NEGATIVE_INFINITY;
}
