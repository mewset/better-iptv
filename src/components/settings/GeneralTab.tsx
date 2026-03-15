import { RefreshCw } from 'lucide-react';
import {
  USER_AGENT_OPTIONS,
  type Theme,
  type UserAgentMode,
} from './constants';

const DEFAULT_USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Better-IPTV/2.1.1';
const MAX_CUSTOM_USER_AGENT_LENGTH = 512;
const PRESET_USER_AGENTS: Record<Exclude<UserAgentMode, 'custom'>, string> = {
  default: DEFAULT_USER_AGENT,
  tivimate: 'TiviMate/4.7.0 (Linux;Android 10) ExoPlayerLib/2.18.1',
  vlc: 'VLC/3.0.20 LibVLC/3.0.20',
};

function getUserAgentPreview(
  mode: UserAgentMode,
  customUserAgent: string
): { value: string; usingFallback: boolean } {
  if (mode !== 'custom') {
    return { value: PRESET_USER_AGENTS[mode], usingFallback: false };
  }

  const normalizedCustom = customUserAgent.trim();
  const invalidCustom =
    !normalizedCustom ||
    /\r|\n/.test(normalizedCustom) ||
    normalizedCustom.length > MAX_CUSTOM_USER_AGENT_LENGTH;

  if (invalidCustom) {
    return { value: DEFAULT_USER_AGENT, usingFallback: true };
  }

  return { value: normalizedCustom, usingFallback: false };
}

interface GeneralTabProps {
  // Theme state
  theme: Theme;
  onThemeChange: (theme: Theme) => void;

  // Playlist user-agent state
  playlistUserAgentMode: UserAgentMode;
  onPlaylistUserAgentModeChange: (mode: UserAgentMode) => void;
  playlistUserAgentCustom: string;
  onPlaylistUserAgentCustomChange: (value: string) => void;

  // Playlist refresh
  onRefreshPlaylist?: () => void;
  playlistName?: string;
}

export default function GeneralTab({
  theme,
  onThemeChange,
  playlistUserAgentMode,
  onPlaylistUserAgentModeChange,
  playlistUserAgentCustom,
  onPlaylistUserAgentCustomChange,
  onRefreshPlaylist,
  playlistName,
}: GeneralTabProps) {
  const userAgentPreview = getUserAgentPreview(playlistUserAgentMode, playlistUserAgentCustom);

  return (
    <div className="space-y-6">
      {/* Playlist Refresh */}
      {onRefreshPlaylist && playlistName && (
        <section>
          <h3 className="mb-4 text-lg font-semibold text-gray-900 dark:text-white">Playlist</h3>
          <div className="rounded-lg border border-gray-200 bg-gray-50 p-4 dark:border-gray-600 dark:bg-gray-700/50">
            <div className="flex items-center justify-between">
              <div>
                <p className="font-medium text-gray-900 dark:text-white">{playlistName}</p>
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  Refresh to sync with the latest channel list
                </p>
              </div>
              <button
                onClick={onRefreshPlaylist}
                className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm text-white transition-colors hover:bg-blue-700"
              >
                <RefreshCw className="h-4 w-4" />
                Refresh
              </button>
            </div>
          </div>
        </section>
      )}

      {/* Playlist Request Settings */}
      <section>
        <h3 className="mb-4 text-lg font-semibold text-gray-900 dark:text-white">
          Playlist Requests
        </h3>
        <div className="space-y-4">
          <div>
            <label className="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-300">
              User-Agent
            </label>
            <select
              value={playlistUserAgentMode}
              onChange={(e) => onPlaylistUserAgentModeChange(e.target.value as UserAgentMode)}
              className="w-full rounded-lg border border-gray-300 px-4 py-2 focus:border-transparent focus:ring-2 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-700 dark:text-white dark:[color-scheme:dark]"
            >
              {USER_AGENT_OPTIONS.map((option) => (
                <option key={option.mode} value={option.mode}>
                  {option.label}
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              Used when downloading playlists and Xtream-provided EPG data
            </p>
            <p className="mt-2 break-all text-xs text-gray-500 dark:text-gray-400">
              Current header: <span className="font-mono">{userAgentPreview.value}</span>
            </p>
            {userAgentPreview.usingFallback && (
              <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
                Custom value is currently invalid or empty, fallback to default will be used.
              </p>
            )}
          </div>

          {playlistUserAgentMode === 'custom' && (
            <div>
              <label className="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-300">
                Custom User-Agent
              </label>
              <input
                type="text"
                value={playlistUserAgentCustom}
                onChange={(e) => onPlaylistUserAgentCustomChange(e.target.value)}
                placeholder="Mozilla/5.0 ..."
                className="w-full rounded-lg border border-gray-300 px-4 py-2 focus:border-transparent focus:ring-2 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-700 dark:text-white"
              />
            </div>
          )}
        </div>
      </section>

      {/* Appearance Settings */}
      <section>
        <h3 className="mb-4 text-lg font-semibold text-gray-900 dark:text-white">Appearance</h3>
        <div className="space-y-4">
          <div>
            <label className="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-300">
              Theme
            </label>
            <div className="grid grid-cols-3 gap-3">
              {(['light', 'dark', 'system'] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => onThemeChange(t)}
                  className={`rounded-lg border px-4 py-2 capitalize ${
                    theme === t
                      ? 'border-blue-600 bg-blue-600 text-white'
                      : 'border-gray-300 bg-white text-gray-900 dark:border-gray-600 dark:bg-gray-700 dark:text-white'
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
