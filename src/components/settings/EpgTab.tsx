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
        <h3 className="mb-4 text-lg font-semibold text-gray-900 dark:text-white">
          Electronic Program Guide (EPG)
        </h3>
        <div className="space-y-4">
          <div>
            <label className="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-300">
              EPG URL (XMLTV format)
            </label>
            <input
              type="url"
              value={epgUrl}
              onChange={(e) => onEpgUrlChange(e.target.value)}
              placeholder="http://example.com/epg.xml"
              className="w-full rounded-lg border border-gray-300 px-4 py-2 focus:border-transparent focus:ring-2 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-700 dark:text-white"
            />
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              If EPG data is not provided with Xtream, we recommend using:{' '}
              <a
                href="https://iptv-epg.org/"
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-600 hover:underline dark:text-blue-400"
              >
                https://iptv-epg.org/
              </a>
            </p>
          </div>

          {/* EPG Status Card */}
          <div className="rounded-lg border border-gray-200 bg-gray-50 p-4 dark:border-gray-600 dark:bg-gray-700/50">
            <div className="mb-3 flex items-center justify-between">
              <span className="text-sm font-medium text-gray-700 dark:text-gray-300">Status</span>
              {epgStatus?.has_url && (
                <span className="text-xs text-gray-500 dark:text-gray-400">
                  {epgStatus.program_count.toLocaleString()} programs
                </span>
              )}
            </div>

            {epgStatus ? (
              <div className="space-y-2">
                {epgStatus.last_fetched ? (
                  <p className="text-sm text-gray-600 dark:text-gray-400">
                    Last updated: {new Date(epgStatus.last_fetched).toLocaleString()}
                  </p>
                ) : (
                  <p className="text-sm text-gray-500 dark:text-gray-400">
                    {epgStatus.has_url ? 'Never updated' : 'No EPG URL configured'}
                  </p>
                )}

                <button
                  onClick={onForceEpgUpdate}
                  disabled={!epgStatus.has_url || isUpdatingEpg}
                  className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <RefreshCw className={`h-4 w-4 ${isUpdatingEpg ? 'animate-spin' : ''}`} />
                  {isUpdatingEpg ? 'Updating...' : 'Update Now'}
                </button>
              </div>
            ) : (
              <p className="text-sm text-gray-500 dark:text-gray-400">Loading status...</p>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
