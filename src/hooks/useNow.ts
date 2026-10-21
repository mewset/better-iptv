import { useEffect, useState } from 'react';

/** How often `useNow` moves on. */
export const NOW_TICK_MS = 30_000;

// One interval for every component that shows the time (guide, cards,
// dock), running while any of them is mounted, so they all move together.
const subscribers = new Set<(now: number) => void>();
let timer: ReturnType<typeof setInterval> | null = null;

function subscribe(update: (now: number) => void): () => void {
  subscribers.add(update);
  if (timer === null) {
    timer = setInterval(() => {
      const now = Date.now();
      for (const fn of subscribers) fn(now);
    }, NOW_TICK_MS);
  }
  return () => {
    subscribers.delete(update);
    if (subscribers.size === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
}

/** The current time in epoch ms, updated every `NOW_TICK_MS` by one shared ticker. */
export function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => subscribe(setNow), []);
  return now;
}
