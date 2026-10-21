import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { useEpgStore } from '../stores/epg-store';
import { usePlayerStore } from '../stores/player-store';
import {
  EPG_REFRESHED_EVENT,
  EPG_STATUS_EVENT,
  getChannelEpgKeys,
  type EpgRefreshed,
  type EpgStatus,
} from './epgIpc';
import { logger } from './logger';

/**
 * One listener per guide event for the whole app, feeding the stores:
 * `epg-refreshed` invalidates the cached now/next and guide data, after
 * setting the channels' new guide keys when a match changed them;
 * `epg-status` replaces the status. Hooks read the stores instead of
 * listening themselves.
 *
 * `startEpgEvents` is called on MainScreen mount and returns its stop; the
 * listeners stay while any caller has not stopped.
 */
let users = 0;
/** Counts keys requests; only the latest one's answer is used. */
let keysRequest = 0;
let unlisteners: Array<Promise<UnlistenFn | null>> = [];

function register<T>(event: string, handler: (payload: T) => void): Promise<UnlistenFn | null> {
  return Promise.resolve()
    .then(() => listen<T>(event, (e) => handler(e.payload)))
    .catch((err) => {
      logger.warn(`Failed to listen for ${event}:`, err);
      return null;
    });
}

/**
 * `epg-refreshed`. When the match before it changed channels, their keys
 * are read for the current playlist and set on the channels held, then
 * the cache is invalidated, so the cards ask once, for the new keys. An
 * answer that arrives after the playlist changed (a profile switch) or
 * after a newer request is dropped; a failed request still invalidates.
 */
async function onRefreshed(event: EpgRefreshed): Promise<void> {
  const playlistId = usePlayerStore.getState().currentPlaylist?.id;
  if (event.matches_changed <= 0 || playlistId === undefined) {
    useEpgStore.getState().invalidate();
    return;
  }
  const request = ++keysRequest;
  try {
    const pairs = await getChannelEpgKeys(playlistId);
    if (request !== keysRequest) return;
    usePlayerStore.getState().setEpgKeys({ playlistId, pairs });
  } catch (err) {
    if (request !== keysRequest) return;
    logger.warn('Failed to read the guide keys of the channels:', err);
  }
  useEpgStore.getState().invalidate();
}

export function startEpgEvents(): () => void {
  users++;
  if (users === 1) {
    unlisteners = [
      register<EpgRefreshed>(EPG_REFRESHED_EVENT, (event) => void onRefreshed(event)),
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
