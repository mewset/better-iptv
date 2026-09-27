import { useEffect, useRef, useState } from 'react';
import { Search, X } from 'lucide-react';
import { searchTmdb, setTmdbMatch, type TmdbCandidate, type TmdbDetails } from '../../lib/tauri';
import type { Channel } from '../../types';
import { logger } from '../../lib/logger';

interface TmdbMatchModalProps {
  isOpen: boolean;
  channel: Channel | null;
  /** Prefilled search: the normalised title (or the provider name). */
  initialQuery: string;
  onClose: () => void;
  onMatched: (details: TmdbDetails) => void;
}

/**
 * Manual TMDB match for one title: search, pick a candidate, or declare the
 * title absent from TMDB. Both outcomes are stored as `manual` so automatic
 * re-matching never overrides them.
 */
export default function TmdbMatchModal({
  isOpen,
  channel,
  initialQuery,
  onClose,
  onMatched,
}: TmdbMatchModalProps) {
  const [query, setQuery] = useState(initialQuery);
  const [results, setResults] = useState<TmdbCandidate[]>([]);
  const [state, setState] = useState<'idle' | 'searching' | 'done'>('idle');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<globalThis.HTMLInputElement>(null);
  const contentType = channel?.content_type === 'series' ? 'series' : 'vod';

  const runSearch = async (q: string) => {
    const trimmed = q.trim();
    if (!trimmed) return;
    setState('searching');
    setError('');
    try {
      setResults(await searchTmdb(trimmed, contentType));
    } catch (err) {
      logger.debug('TMDB manual search failed:', err);
      setResults([]);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setState('done');
    }
  };

  // Open: reset to the initial query and search it once.
  useEffect(() => {
    if (!isOpen) return;
    setQuery(initialQuery);
    setResults([]);
    setError('');
    runSearch(initialQuery);
    inputRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, initialQuery, channel?.id]);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [isOpen, onClose]);

  if (!isOpen || !channel) return null;

  const choose = async (tmdbId: number | null) => {
    setSaving(true);
    try {
      const details = await setTmdbMatch(channel.id, tmdbId);
      onMatched(details);
      onClose();
    } catch (err) {
      logger.error('Failed to store the TMDB match:', err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-bg/70 backdrop-blur-sm">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Find the right title"
        className="flex max-h-[80vh] w-full max-w-2xl flex-col rounded-lg bg-surface p-6 shadow-xl"
      >
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-xl font-bold text-text">Find the right title</h3>
          <button
            onClick={onClose}
            aria-label="Close"
            className="rounded-lg p-1 hover:bg-surface-hover"
          >
            <X className="h-5 w-5 text-text-muted" aria-hidden="true" />
          </button>
        </div>

        <form
          className="mb-4 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            runSearch(query);
          }}
        >
          <input
            ref={inputRef}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search TMDB"
            className="flex-1 rounded-lg border border-border-strong bg-bg px-4 py-2 text-text focus:border-transparent focus:ring-2 focus:ring-accent"
          />
          <button
            type="submit"
            className="flex items-center gap-2 rounded-lg bg-accent px-4 py-2 font-semibold text-on-accent hover:bg-accent-hover"
          >
            <Search className="h-4 w-4" aria-hidden="true" />
            Search
          </button>
        </form>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {error && <p className="mb-3 text-sm text-danger">{error}</p>}
          {state === 'searching' && <p className="text-text-muted">Searching…</p>}
          {state === 'done' && !error && results.length === 0 && (
            <p className="text-text-muted">No titles found</p>
          )}
          <ul className="flex flex-col gap-2">
            {results.map((c) => {
              const name =
                c.original_title && c.original_title !== c.title
                  ? `${c.title} (${c.original_title})`
                  : c.title;
              return (
                <li
                  key={c.tmdb_id}
                  className="flex items-center gap-3 rounded-lg border border-border p-2"
                >
                  <div className="h-[72px] w-[48px] shrink-0 overflow-hidden rounded bg-surface-2">
                    {c.poster_url && (
                      <img
                        src={c.poster_url}
                        alt=""
                        draggable={false}
                        className="h-full w-full object-cover"
                      />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-semibold text-text">{name}</p>
                    {c.year && <p className="text-xs text-text-muted">{c.year}</p>}
                    {c.overview && (
                      <p className="line-clamp-2 text-xs text-text-muted">{c.overview}</p>
                    )}
                  </div>
                  <button
                    type="button"
                    disabled={saving}
                    aria-label={`Use this: ${name}`}
                    onClick={() => choose(c.tmdb_id)}
                    className="shrink-0 rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-on-accent hover:bg-accent-hover disabled:opacity-50"
                  >
                    Use this
                  </button>
                </li>
              );
            })}
          </ul>
        </div>

        <div className="mt-4 flex justify-between border-t border-border pt-4">
          <button
            type="button"
            disabled={saving}
            onClick={() => choose(null)}
            className="rounded-lg px-4 py-2 text-text-muted hover:bg-surface-hover disabled:opacity-50"
          >
            Not on TMDB
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg bg-surface-2 px-4 py-2 text-text hover:bg-surface-hover"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
