import { RefreshCw } from 'lucide-react';
import { USER_AGENT_OPTIONS, type Theme, type UserAgentMode } from './constants';
import { DEFAULT_USER_AGENT } from '../../lib/userAgent';

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

  // Update check
  updateCheckEnabled: boolean;
  onUpdateCheckEnabledChange: (enabled: boolean) => void;
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
  updateCheckEnabled,
  onUpdateCheckEnabledChange,
}: GeneralTabProps) {
  const userAgentPreview = getUserAgentPreview(playlistUserAgentMode, playlistUserAgentCustom);

  return (
    <div className="space-y-6">
      {/* Playlist Refresh */}
      {onRefreshPlaylist && playlistName && (
        <section>
          <h3 className="mb-4 text-lg font-semibold text-text">Playlist</h3>
          <div className="rounded-lg border border-border bg-surface-2/50 p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="font-medium text-text">{playlistName}</p>
                <p className="text-sm text-text-muted">
                  Refresh to sync with the latest channel list
                </p>
              </div>
              <button
                onClick={onRefreshPlaylist}
                className="flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm text-on-accent transition-colors hover:bg-accent-hover"
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
        <h3 className="mb-4 text-lg font-semibold text-text">Playlist Requests</h3>
        <div className="space-y-4">
          <div>
            <label className="mb-2 block text-sm font-medium text-text-muted">User-Agent</label>
            <select
              value={playlistUserAgentMode}
              onChange={(e) => onPlaylistUserAgentModeChange(e.target.value as UserAgentMode)}
              className="w-full rounded-lg border border-border-strong bg-surface px-4 py-2 text-text focus:border-transparent focus:ring-2 focus:ring-accent dark:[color-scheme:dark]"
            >
              {USER_AGENT_OPTIONS.map((option) => (
                <option key={option.mode} value={option.mode}>
                  {option.label}
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-text-faint">
              Used when downloading playlists and Xtream-provided EPG data
            </p>
            <p className="mt-2 break-all text-xs text-text-faint">
              Current header: <span className="font-mono">{userAgentPreview.value}</span>
            </p>
            {userAgentPreview.usingFallback && (
              <p className="mt-1 text-xs text-accent-text">
                Custom value is currently invalid or empty, fallback to default will be used.
              </p>
            )}
          </div>

          {playlistUserAgentMode === 'custom' && (
            <div>
              <label className="mb-2 block text-sm font-medium text-text-muted">
                Custom User-Agent
              </label>
              <input
                type="text"
                value={playlistUserAgentCustom}
                onChange={(e) => onPlaylistUserAgentCustomChange(e.target.value)}
                placeholder="Mozilla/5.0 ..."
                className="w-full rounded-lg border border-border-strong bg-surface px-4 py-2 text-text focus:border-transparent focus:ring-2 focus:ring-accent"
              />
            </div>
          )}
        </div>
      </section>

      {/* Appearance Settings */}
      <section>
        <h3 className="mb-4 text-lg font-semibold text-text">Appearance</h3>
        <div className="space-y-4">
          <div>
            <label className="mb-2 block text-sm font-medium text-text-muted">Theme</label>
            <div className="grid grid-cols-3 gap-3">
              {(['light', 'dark', 'system'] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => onThemeChange(t)}
                  className={`rounded-lg border px-4 py-2 capitalize ${
                    theme === t
                      ? 'border-accent bg-accent text-on-accent'
                      : 'border-border-strong bg-surface text-text'
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section>
        <h3 className="mb-4 text-lg font-semibold text-text">Updates</h3>
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-text-muted">Check for new versions</p>
            <p className="text-xs text-text-faint">
              Asks GitHub once a day whether a newer release exists, and shows a link next to the
              title when there is one. Nothing is downloaded or installed automatically.
            </p>
          </div>
          <input
            type="checkbox"
            checked={updateCheckEnabled}
            onChange={(e) => onUpdateCheckEnabledChange(e.target.checked)}
            className="h-4 w-4 rounded text-accent-text focus:ring-accent"
          />
        </div>
      </section>
    </div>
  );
}
