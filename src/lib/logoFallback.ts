import { create } from 'zustand';
import { reportDeadLogos } from './tauri';
import { logger } from './logger';
import type { Channel } from '../types';

/** Failures inside this window go out as one backend call. */
export const REPORT_BATCH_MS = 300;

/** The backend rejects more items than this per call. */
const MAX_ITEMS_PER_CALL = 200;

interface LogoFallbackState {
  fallbacks: Record<number, string>;
  merge: (map: Record<number, string>) => void;
  clear: () => void;
}

export const useLogoFallbackStore = create<LogoFallbackState>((set) => ({
  fallbacks: {},
  merge: (map) => {
    if (Object.keys(map).length === 0) return;
    set((state) => ({ fallbacks: { ...state.fallbacks, ...map } }));
  },
  clear: () => set({ fallbacks: {} }),
}));

let queue: Array<{ channelId: number; url: string }> = [];
let timer: ReturnType<typeof setTimeout> | null = null;
const reportedUrls = new Set<string>();

async function flush(): Promise<void> {
  timer = null;
  const items = queue;
  queue = [];
  for (let i = 0; i < items.length; i += MAX_ITEMS_PER_CALL) {
    try {
      const result = await reportDeadLogos(items.slice(i, i + MAX_ITEMS_PER_CALL));
      useLogoFallbackStore.getState().merge(result);
    } catch (e) {
      logger.warn('Failed to report dead logos', e);
    }
  }
}

export function reportLogoFailure(channel: Channel, url: string): void {
  if (channel.content_type !== 'live') return;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
  if (reportedUrls.has(url)) return;
  reportedUrls.add(url);
  queue.push({ channelId: channel.id, url });
  if (timer === null) timer = setTimeout(() => void flush(), REPORT_BATCH_MS);
}

export function resetLogoFallbackSession(): void {
  if (timer !== null) clearTimeout(timer);
  timer = null;
  queue = [];
  reportedUrls.clear();
  useLogoFallbackStore.getState().clear();
}
