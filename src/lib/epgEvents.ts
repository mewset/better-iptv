import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { useEpgStore } from '../stores/epg-store';
import { EPG_REFRESHED_EVENT, EPG_STATUS_EVENT, type EpgRefreshed, type EpgStatus } from './epgIpc';
import { logger } from './logger';

/**
 * One listener per guide event for the whole app, feeding the epg store:
 * `epg-refreshed` invalidates the cached now/next and guide data,
 * `epg-status` replaces the status. Hooks read the store instead of
 * listening themselves.
 *
 * `startEpgEvents` is called on MainScreen mount and returns its stop; the
 * listeners stay while any caller has not stopped.
 */
let users = 0;
let unlisteners: Array<Promise<UnlistenFn | null>> = [];

function register<T>(event: string, handler: (payload: T) => void): Promise<UnlistenFn | null> {
  return Promise.resolve()
    .then(() => listen<T>(event, (e) => handler(e.payload)))
    .catch((err) => {
      logger.warn(`Failed to listen for ${event}:`, err);
      return null;
    });
}

export function startEpgEvents(): () => void {
  users++;
  if (users === 1) {
    unlisteners = [
      register<EpgRefreshed>(EPG_REFRESHED_EVENT, (refreshed) =>
        useEpgStore.getState().invalidate(refreshed)
      ),
      register<EpgStatus>(EPG_STATUS_EVENT, (status) => useEpgStore.getState().setStatus(status)),
    ];
  }
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    users--;
    if (users === 0) {
      for (const pending of unlisteners) pending.then((unlisten) => unlisten?.());
      unlisteners = [];
    }
  };
}
