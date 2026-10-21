import { useEffect } from 'react';
import { useEpgStore } from '../stores/epg-store';
import type { EpgStatus } from '../lib/epgIpc';

export interface EpgStatusView {
  /** The status for the active profile; null until it is known. */
  status: EpgStatus | null;
  /** Asking for it failed and no `epg-status` event has brought one since. */
  failed: boolean;
}

/**
 * The guide's status from the epg store. The first user asks the backend
 * once; after that `epg-status` events keep it current (`epgEvents`), so
 * nothing polls and nothing on the boot path asks.
 */
export function useEpgStatus(): EpgStatusView {
  const status = useEpgStore((s) => s.status);
  const failed = useEpgStore((s) => s.statusFailed);
  const loadStatus = useEpgStore((s) => s.loadStatus);
  useEffect(() => {
    loadStatus();
  }, [loadStatus]);
  return { status, failed };
}

/**
 * Whether the guide has nothing to show from: the status is known and no
 * source is enabled for the active profile. Unknown is not empty.
 */
export function hasNoEnabledSource(status: EpgStatus | null): boolean {
  return status !== null && !status.sources.some((s) => s.enabled);
}
