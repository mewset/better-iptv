/**
 * Ask the backend once per mount whether a newer release exists.
 *
 * The backend does the throttling and caching, so this hook stays a thin
 * fetch-once. A failure means no badge, never an error the user has to read.
 */
import { useEffect, useState } from 'react';
import { checkForUpdate } from '../lib/tauri';
import { logger } from '../lib/logger';
import type { UpdateInfo } from '../types';

export function useUpdateCheck(): UpdateInfo | null {
  const [update, setUpdate] = useState<UpdateInfo | null>(null);

  useEffect(() => {
    let cancelled = false;

    checkForUpdate()
      .then((result) => {
        if (!cancelled) setUpdate(result);
      })
      .catch((err) => logger.debug('Update check failed:', err));

    return () => {
      cancelled = true;
    };
  }, []);

  return update;
}
