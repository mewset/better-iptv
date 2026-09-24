import { RefreshCw } from 'lucide-react';
import type { EpgStatus } from '../../lib/tauri';

interface EpgTabProps {
  epgUrl: string;
  onEpgUrlChange: (url: string) => void;
  epgStatus: EpgStatus | null;
  isUpdatingEpg: boolean;
  onForceEpgUpdate: () => void;
}

export default function EpgTab({
  epgUrl,
  onEpgUrlChange,
  epgStatus,
  isUpdatingEpg,
  onForceEpgUpdate,
}: EpgTabProps) {
  return (
    <div className="space-y-6">
      <section>
        <h3 className="mb-4 text-lg font-semibold text-text">Electronic Program Guide (EPG)</h3>
        <div className="space-y-4">
          <div>
            <label className="mb-2 block text-sm font-medium text-text-muted">
              EPG URL (XMLTV format)
            </label>
            <input
              type="url"
              value={epgUrl}
              onChange={(e) => onEpgUrlChange(e.target.value)}
              placeholder="http://example.com/epg.xml"
              className="w-full rounded-lg border border-border-strong bg-surface px-4 py-2 text-text focus:border-transparent focus:ring-2 focus:ring-accent"
            />
            <p className="mt-1 text-xs text-text-faint">
              If EPG data is not provided with Xtream, we recommend using:{' '}
              <a
                href="https://iptv-epg.org/"
                target="_blank"
                rel="noopener noreferrer"
                className="text-accent-text hover:underline"
              >
                https://iptv-epg.org/
              </a>
            </p>
          </div>

          {/* EPG Status Card */}
          <div className="rounded-lg border border-border bg-surface-2/50 p-4">
            <div className="mb-3 flex items-center justify-between">
              <span className="text-sm font-medium text-text-muted">Status</span>
              {epgStatus?.has_url && (
                <span className="text-xs text-text-muted">
                  {epgStatus.program_count.toLocaleString()} programs
                </span>
              )}
            </div>

            {epgStatus ? (
              <div className="space-y-2">
                {epgStatus.last_fetched ? (
                  <p className="text-sm text-text-muted">
                    Last updated: {new Date(epgStatus.last_fetched).toLocaleString()}
                  </p>
                ) : (
                  <p className="text-sm text-text-muted">
                    {epgStatus.has_url ? 'Never updated' : 'No EPG URL configured'}
                  </p>
                )}

                <button
                  onClick={onForceEpgUpdate}
                  disabled={!epgStatus.has_url || isUpdatingEpg}
                  className="flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm text-on-accent transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <RefreshCw
                    className={`h-4 w-4 ${isUpdatingEpg ? 'animate-spin' : ''}`}
                    aria-hidden="true"
                  />
                  {isUpdatingEpg ? 'Updating...' : 'Update Now'}
                </button>
              </div>
            ) : (
              <p className="text-sm text-text-muted">Loading status...</p>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
