import { useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { refreshEpg, removeEpgSource, updateEpgSource, type EpgSource } from '../../lib/epgIpc';
import { errorText, sourceTitle, statusDetails, statusLine } from '../../lib/epgSourceView';
import { logger } from '../../lib/logger';
import { cn } from '../../lib/utils';
import ConfirmationModal from '../modals/ConfirmationModal';
import TimeCorrection from './TimeCorrection';

interface EpgSourceRowProps {
  source: EpgSource;
  /** Epoch ms, from the shared ticker. */
  now: number;
}

const textButton =
  'rounded px-2 py-1 text-sm text-text-muted transition-colors hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:text-text-muted';

/**
 * One guide source: its name, one status line, and its actions. Every
 * action is sent at once; the row follows the `epg-status` events the
 * backend answers with rather than guessing the result.
 */
export default function EpgSourceRow({ source, now }: EpgSourceRowProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [removing, setRemoving] = useState(false);

  const title = sourceTitle(source);
  const line = statusLine(source, now);
  const details = statusDetails(source);

  /** Runs one action; false when it failed (its error is shown). */
  const run = async (what: string, action: () => Promise<void>): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      await action();
      return true;
    } catch (err) {
      logger.error(`Failed to ${what}:`, err);
      setError(`Could not ${what}: ${errorText(err)}`);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    // Drops a time correction still waiting to be sent for this source.
    setRemoving(true);
    if (!(await run('remove the source', () => removeEpgSource(source.id)))) {
      setRemoving(false);
    }
  };

  return (
    <article aria-label={title} className="rounded-2xl border border-border p-5 transition-colors">
      <div className="flex flex-wrap items-start gap-x-5 gap-y-3">
        <div className="min-w-0 flex-1 basis-64">
          <h4
            className={cn(
              'truncate text-base font-semibold',
              source.enabled ? 'text-text' : 'text-text-muted'
            )}
            title={title}
          >
            {title}
          </h4>
          <p
            className={cn(
              'mt-1 text-[13px]',
              source.last_result === 'error' && !source.refreshing
                ? 'text-danger'
                : 'text-text-muted'
            )}
            title={details ?? undefined}
          >
            {line}
            {details && <span className="sr-only">. {details}</span>}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <label className="mr-1 flex items-center gap-2 text-sm text-text">
            <input
              type="checkbox"
              checked={source.enabled}
              disabled={busy}
              aria-label={`Enable ${title}`}
              onChange={(e) => {
                const enabled = e.target.checked;
                run(enabled ? 'enable the source' : 'disable the source', () =>
                  updateEpgSource(source.id, { enabled })
                );
              }}
              className="h-4 w-4 accent-accent disabled:opacity-50"
            />
            Enabled
          </label>
          <button
            type="button"
            disabled={busy || source.refreshing || !source.enabled}
            aria-label={`Update ${title}`}
            onClick={() => run('update the source', () => refreshEpg(source.id))}
            className="flex items-center gap-2 rounded-lg border border-border-strong bg-text/5 px-3 py-1.5 text-sm font-medium text-text transition-colors hover:bg-text/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-text/5"
          >
            <RefreshCw
              className={cn('h-4 w-4', source.refreshing && 'animate-spin')}
              aria-hidden="true"
            />
            Update
          </button>
          {source.origin === 'manual' && (
            <button
              type="button"
              disabled={busy}
              aria-label={`Remove ${title}`}
              onClick={() => setConfirmRemove(true)}
              className={cn(textButton, 'hover:text-danger')}
            >
              Remove
            </button>
          )}
        </div>
      </div>

      <TimeCorrection source={source} now={now} removing={removing} />

      {error && (
        <p role="alert" className="mt-2 text-xs text-danger">
          {error}
        </p>
      )}

      <ConfirmationModal
        isOpen={confirmRemove}
        onClose={() => setConfirmRemove(false)}
        onConfirm={remove}
        title="Remove this guide source?"
        message={`${title} and its programmes are removed from every profile. Channels it covered show no guide until another source has them.`}
        confirmText="Remove"
        cancelText="Cancel"
        confirmVariant="danger"
      />
    </article>
  );
}
