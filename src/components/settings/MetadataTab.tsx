import { useState } from 'react';
import { checkTmdbKey, type TmdbStatus } from '../../lib/tauri';
import { TMDB_LANGUAGE_OPTIONS, TMDB_ATTRIBUTION, type TmdbLanguage } from './constants';
import { logger } from '../../lib/logger';
import tmdbLogo from '../../assets/tmdb/tmdb-blue-short.svg';

interface MetadataTabProps {
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
  apiKey: string;
  onApiKeyChange: (key: string) => void;
  language: TmdbLanguage;
  onLanguageChange: (language: TmdbLanguage) => void;
  status: TmdbStatus | null;
  onClearCache: () => Promise<void>;
}

/** The one-line key status, spec §3. */
export function keyStatusLine(status: TmdbStatus | null, apiKey: string): string {
  if (!status) return '';
  if (apiKey.trim()) return status.user_key_rejected ? 'Key rejected by TMDB' : 'Using your key';
  if (status.shared_key_rejected)
    return 'Could not fetch TMDB data. Try generating your own key at themoviedb.org.';
  if (status.has_shared_key) return 'Using the shared key';
  return 'No key available: add your own';
}

export function TmdbAttribution() {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-border bg-surface-2/50 p-3">
      <img src={tmdbLogo} alt="TMDB" className="h-4 w-auto" />
      <p className="text-xs text-text-muted">{TMDB_ATTRIBUTION}</p>
    </div>
  );
}

export default function MetadataTab({
  enabled,
  onEnabledChange,
  apiKey,
  onApiKeyChange,
  language,
  onLanguageChange,
  status,
  onClearCache,
}: MetadataTabProps) {
  const [testResult, setTestResult] = useState<string>('');
  const [testing, setTesting] = useState(false);
  const [cleared, setCleared] = useState(false);

  const handleTest = async () => {
    setTesting(true);
    setTestResult('');
    try {
      await checkTmdbKey(apiKey);
      setTestResult('Key works');
    } catch (err) {
      setTestResult(
        typeof err === 'string' ? err : err instanceof Error ? err.message : String(err)
      );
    } finally {
      setTesting(false);
    }
  };

  const handleClear = async () => {
    try {
      await onClearCache();
      setCleared(true);
    } catch (err) {
      logger.error('Failed to clear the TMDB cache:', err);
    }
  };

  return (
    <div className="space-y-6">
      <section>
        <h3 className="mb-4 text-lg font-semibold text-text">Posters and details</h3>
        <div className="space-y-4">
          <label className="flex items-center gap-3">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => onEnabledChange(e.target.checked)}
              className="h-4 w-4 accent-accent"
            />
            <span className="text-sm font-medium text-text">
              Fetch posters and details from TMDB
            </span>
          </label>
          <p className="text-xs text-text-faint">
            Titles of your movies and series are sent to TMDB to look them up. Nothing else leaves
            the app.
          </p>

          <div>
            <label
              htmlFor="tmdb-api-key"
              className="mb-2 block text-sm font-medium text-text-muted"
            >
              TMDB API key
            </label>
            <div className="flex gap-2">
              <input
                id="tmdb-api-key"
                type="text"
                value={apiKey}
                onChange={(e) => onApiKeyChange(e.target.value)}
                placeholder="Optional. Uses Better IPTV's shared key when empty."
                autoComplete="off"
                spellCheck={false}
                className="flex-1 rounded-lg border border-border-strong bg-surface px-4 py-2 font-mono text-sm text-text focus:border-transparent focus:ring-2 focus:ring-accent"
              />
              <button
                type="button"
                onClick={handleTest}
                disabled={testing || !apiKey.trim()}
                className="rounded-lg bg-surface-2 px-4 py-2 text-sm font-semibold text-text hover:bg-surface-hover disabled:opacity-50"
              >
                Test
              </button>
            </div>
            {testResult && (
              <p className="mt-1 text-xs text-text-muted" role="status">
                {testResult}
              </p>
            )}
            <p className="mt-1 text-xs text-text-faint">{keyStatusLine(status, apiKey)}</p>
          </div>

          <div>
            <label
              htmlFor="tmdb-language"
              className="mb-2 block text-sm font-medium text-text-muted"
            >
              Metadata language
            </label>
            <select
              id="tmdb-language"
              value={language}
              onChange={(e) => onLanguageChange(e.target.value as TmdbLanguage)}
              className="w-full rounded-lg border border-border-strong bg-surface px-4 py-2 text-text focus:border-transparent focus:ring-2 focus:ring-accent dark:[color-scheme:dark]"
            >
              {TMDB_LANGUAGE_OPTIONS.map((l) => (
                <option key={l.tag} value={l.tag}>
                  {l.name}
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-text-faint">
              English is used when a translation is missing.
            </p>
          </div>

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={handleClear}
              className="rounded-lg bg-surface-2 px-4 py-2 text-sm font-semibold text-text hover:bg-surface-hover"
            >
              Clear cached metadata
            </button>
            {cleared && <span className="text-xs text-text-muted">Cache cleared</span>}
          </div>
        </div>
      </section>

      <TmdbAttribution />
    </div>
  );
}
