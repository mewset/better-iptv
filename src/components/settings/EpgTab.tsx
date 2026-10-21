import { useId, useState, type FormEvent } from 'react';
import { Plus, RefreshCw } from 'lucide-react';
import { addEpgSource, refreshEpg } from '../../lib/epgIpc';
import { errorText, nextUpdateText } from '../../lib/epgSourceView';
import { isAppError } from '../../types/errors';
import { useEpgStatus } from '../../hooks/useEpgStatus';
import { useNow } from '../../hooks/useNow';
import { usePlayerStore } from '../../stores/player-store';
import { logger } from '../../lib/logger';
import { cn } from '../../lib/utils';
import EpgSourceRow from './EpgSourceRow';

/**
 * Settings → EPG: the guide sources of the active profile with their
 * status and time correction, adding a guide URL, and the automatic
 * updates. Every action takes effect at once, like Profiles; nothing here
 * waits for Save.
 */
export default function EpgTab() {
  const { status, failed } = useEpgStatus();
  const profileName = usePlayerStore((s) => s.currentPlaylist?.name);
  const now = useNow();

  const sources = status
    ? [...status.sources].sort((a, b) => a.priority - b.priority || a.id - b.id)
    : [];
  const anyRefreshing = sources.some((s) => s.refreshing);
  const anyEnabled = sources.some((s) => s.enabled);

  const [updateError, setUpdateError] = useState<string | null>(null);
  const [updating, setUpdating] = useState(false);
  const updateAll = async () => {
    setUpdating(true);
    setUpdateError(null);
    try {
      await refreshEpg(null);
    } catch (err) {
      logger.error('Failed to update the guide:', err);
      setUpdateError(`Could not start the update: ${errorText(err)}`);
    } finally {
      setUpdating(false);
    }
  };

  return (
    <div className="space-y-8">
      <section>
        <h3 className="text-lg font-semibold text-text">Guide sources</h3>
        {profileName && <p className="mt-1 text-sm text-text-muted">Used by {profileName}</p>}

        <div className="mt-4 space-y-3">
          {status === null ? (
            <p className="text-sm text-text-muted">
              {failed
                ? 'The guide sources could not be read. Reopening Settings tries again.'
                : 'Loading guide sources…'}
            </p>
          ) : sources.length === 0 ? (
            <p className="rounded-2xl border border-dashed border-border-strong p-5 text-sm text-text-muted">
              No guide source for this profile yet. Add a guide URL below.
            </p>
          ) : (
            sources.map((source) => <EpgSourceRow key={source.id} source={source} now={now} />)
          )}
        </div>

        <AddSource />
      </section>

      <section>
        <h3 className="mb-4 text-lg font-semibold text-text">Automatic updates</h3>
        <div className="space-y-3">
          {status && <p className="text-sm text-text">{nextUpdateText(status, now)}</p>}
          <p className="text-xs text-text-faint">
            Each enabled source is downloaded every 6 hours; a failed download is tried again after
            an hour.
          </p>
          <button
            type="button"
            onClick={updateAll}
            disabled={status === null || updating || anyRefreshing || !anyEnabled}
            className="flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm text-on-accent transition-colors hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-50"
          >
            <RefreshCw
              className={cn('h-4 w-4', anyRefreshing && 'animate-spin')}
              aria-hidden="true"
            />
            Update all now
          </button>
          {updateError && (
            <p role="alert" className="text-xs text-danger">
              {updateError}
            </p>
          )}
        </div>
      </section>
    </div>
  );
}

/**
 * The "Add a source" field. The backend validates the URL and refuses a
 * duplicate; its reason is shown under the field.
 */
function AddSource() {
  const id = useId();
  const [url, setUrl] = useState('');
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = url.trim();
    if (!trimmed || adding) return;
    setAdding(true);
    setError(null);
    try {
      await addEpgSource(trimmed);
      setUrl('');
    } catch (err) {
      logger.warn('Failed to add a guide source:', err);
      setError(
        isAppError(err) && err.code === 'InvalidInput'
          ? err.details
          : `Could not add the source: ${errorText(err)}`
      );
    } finally {
      setAdding(false);
    }
  };

  const inputId = `${id}-url`;
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;
  return (
    <form onSubmit={submit} noValidate className="mt-6">
      <label htmlFor={inputId} className="mb-2 block text-sm font-medium text-text-muted">
        Add a source
      </label>
      <div className="flex gap-2">
        <input
          id={inputId}
          type="url"
          value={url}
          onChange={(e) => {
            setUrl(e.target.value);
            if (error) setError(null);
          }}
          placeholder="https://example.com/guide.xml.gz"
          autoComplete="off"
          spellCheck={false}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${errorId} ${hintId}` : hintId}
          className="min-w-0 flex-1 rounded-lg border border-border-strong bg-surface px-4 py-2 text-text focus:border-transparent focus:ring-2 focus:ring-accent"
        />
        <button
          type="submit"
          disabled={!url.trim() || adding}
          className="flex shrink-0 items-center gap-2 rounded-lg bg-surface-2 px-4 py-2 text-sm font-semibold text-text transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
          {adding ? 'Adding…' : 'Add'}
        </button>
      </div>
      {error && (
        <p id={errorId} role="alert" className="mt-1 text-xs text-danger">
          {error}
        </p>
      )}
      <p id={hintId} className="mt-1 text-xs text-text-faint">
        An XMLTV guide address, plain or gzipped, used by every profile. If your provider has no
        guide, we recommend{' '}
        <a
          href="https://iptv-epg.org/"
          target="_blank"
          rel="noopener noreferrer"
          className="text-accent-text hover:underline"
        >
          https://iptv-epg.org/
        </a>
        .
      </p>
    </form>
  );
}
