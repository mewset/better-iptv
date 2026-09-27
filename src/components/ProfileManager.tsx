import { useEffect, useState } from 'react';
import { Check, Info, KeyRound, Link, Plus, RefreshCw } from 'lucide-react';
import { usePlayerStore } from '../stores/player-store';
import {
  deletePlaylist,
  getChannels,
  getPlaylistChannelCounts,
  getPlaylists,
  renamePlaylist,
} from '../lib/tauri';
import { logger } from '../lib/logger';
import { useSubscriptionExpiries } from '../hooks/useSubscriptionExpiries';
import { useProfileSwitch } from '../hooks/useProfileSwitch';
import { formatSubscriptionExpiry } from '../lib/subscriptionExpiry';
import { daysSince, refreshedAgo } from '../lib/relativeDays';
import { cn } from '../lib/utils';
import Setup from './Setup';
import ErrorModal from './modals/ErrorModal';
import RefreshModal from './modals/RefreshModal';
import type { Playlist } from '../types';

interface ProfileManagerProps {
  onClose: () => void; // Closes the Settings view, e.g. after the last profile is deleted
}

/** A subscription within this many days of ending (or already ended) reads as urgent. */
const EXPIRY_SOON_DAYS = 60;
const STALE_REFRESH_DAYS = 7;

export default function ProfileManager({ onClose }: ProfileManagerProps) {
  const {
    playlists,
    activeProfileId,
    currentPlaylist,
    setCurrentPlaylist,
    setIsSetupComplete,
    setChannels,
    setPlaylists,
  } = usePlayerStore();

  // Only Xtream profiles have a subscription; an M3U profile is a plain file
  // or address and the backend has nothing to ask about.
  const expiries = useSubscriptionExpiries(
    playlists.filter((p) => p.xtream_username && p.id).map((p) => p.id!)
  );

  const [channelCounts, setChannelCounts] = useState<Record<number, number>>({});

  // A joined key keeps the effect from re-running on every render (a freshly
  // built playlists array would otherwise cause that), while still refetching
  // when a profile is added or removed - otherwise a newly created profile
  // never gets a count for the rest of the session, and a deleted one's count
  // lingers in state.
  const playlistIdsKey = playlists.map((p) => p.id).join(',');

  useEffect(() => {
    let cancelled = false;
    getPlaylistChannelCounts()
      .then((counts) => {
        if (!cancelled) setChannelCounts(counts);
      })
      .catch((err) => logger.debug('Failed to load playlist channel counts:', err));
    return () => {
      cancelled = true;
    };
  }, [playlistIdsKey]);

  const [showSetupModal, setShowSetupModal] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState('');
  const [showDeleteWarning, setShowDeleteWarning] = useState<number | null>(null);
  const [refreshingId, setRefreshingId] = useState<number | null>(null);

  // Error modal state
  const [showErrorModal, setShowErrorModal] = useState(false);
  const [errorTitle, setErrorTitle] = useState('');
  const [errorMessage, setErrorMessage] = useState('');

  // Switch to a different profile (shared with the top bar's switcher)
  const { switchTo: handleActivateProfile, error: switchError, clearError } = useProfileSwitch();

  // Start rename process
  const handleStartRename = (playlist: Playlist) => {
    setEditingId(playlist.id!);
    setEditName(playlist.name);
  };

  // Save renamed profile
  const handleSaveRename = async (id: number) => {
    if (!editName.trim()) {
      setErrorTitle('Invalid profile name');
      setErrorMessage('Profile name cannot be empty');
      setShowErrorModal(true);
      return;
    }

    try {
      await renamePlaylist(id, editName.trim());

      // Update playlists in store
      const updatedPlaylists = playlists.map((p) =>
        p.id === id ? { ...p, name: editName.trim() } : p
      );
      usePlayerStore.setState({ playlists: updatedPlaylists });

      // `currentPlaylist` is its own copy in the store rather than a lookup
      // into `playlists`, so renaming the active profile leaves every consumer
      // of it showing the old name until the next profile switch or restart —
      // Settings > General, the refresh modal, and the stale-playlist prompt.
      if (currentPlaylist?.id === id) {
        setCurrentPlaylist({ ...currentPlaylist, name: editName.trim() });
      }

      setEditingId(null);
      logger.info(`Profile ID ${id} renamed to: ${editName.trim()}`);
    } catch (err) {
      logger.error('Failed to rename profile:', err);
      setErrorTitle('Failed to Rename Profile');
      setErrorMessage(`Failed to rename profile: ${err}`);
      setShowErrorModal(true);
    }
  };

  // Cancel rename
  const handleCancelRename = () => {
    setEditingId(null);
    setEditName('');
  };

  // Delete profile with special logic
  const handleDeleteProfile = async (id: number) => {
    const isActive = id === activeProfileId;
    const isLastProfile = playlists.length === 1;

    if (isLastProfile) {
      // Show warning modal for last profile
      setShowDeleteWarning(id);
      return;
    }

    if (isActive) {
      // Deleting active profile, need to switch first
      const remainingPlaylists = playlists.filter((p) => p.id !== id);
      const nextProfile = remainingPlaylists[0];

      // Switch to next profile first
      await handleActivateProfile(nextProfile);
    }

    // Now delete the profile
    try {
      await deletePlaylist(id);

      // Update store
      const updatedPlaylists = playlists.filter((p) => p.id !== id);
      usePlayerStore.setState({ playlists: updatedPlaylists });

      logger.info(`Profile ID ${id} deleted`);
    } catch (err) {
      logger.error('Failed to delete profile:', err);
      setErrorTitle('Failed to Delete Profile');
      setErrorMessage(`Failed to delete profile: ${err}`);
      setShowErrorModal(true);
    }
  };

  // Confirm delete last profile
  const handleConfirmDeleteLastProfile = async () => {
    const id = showDeleteWarning!;

    try {
      await deletePlaylist(id);

      // Reset to setup screen
      setIsSetupComplete(false);
      setShowDeleteWarning(null);
      onClose(); // Back to browse - Settings has nothing left to manage

      logger.info('Last profile deleted, returning to setup');
    } catch (err) {
      logger.error('Failed to delete last profile:', err);
      setErrorTitle('Failed to Delete Profile');
      setErrorMessage(`Failed to delete profile: ${err}`);
      setShowErrorModal(true);
    }
  };

  // Handle new profile creation
  const handleProfileCreated = async (newPlaylist: Playlist) => {
    setShowSetupModal(false);

    // Add to playlists
    const updatedPlaylists = [...playlists, newPlaylist];
    usePlayerStore.setState({ playlists: updatedPlaylists });

    // Auto-activate new profile
    await handleActivateProfile(newPlaylist);
  };

  // Refresh one profile's playlist, reloading its channels if it is the
  // active one and refreshing every card's channel count and refresh date
  // afterwards.
  const refreshTarget = playlists.find((p) => p.id === refreshingId) ?? null;

  const handleRefreshComplete = async () => {
    try {
      setChannelCounts(await getPlaylistChannelCounts());
    } catch (err) {
      logger.debug('Failed to reload playlist channel counts after refresh:', err);
    }

    try {
      setPlaylists(await getPlaylists());
    } catch (err) {
      logger.debug('Failed to reload playlists after refresh:', err);
    }

    if (refreshTarget?.id && refreshTarget.id === currentPlaylist?.id) {
      try {
        const freshChannels = await getChannels(refreshTarget.id);
        setChannels(freshChannels);
      } catch (err) {
        logger.error('Failed to reload channels after refresh:', err);
      }
    }
  };

  return (
    <>
      <div className="space-y-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="font-display text-2xl font-semibold text-text">Profiles</h2>
            <p className="mt-1 text-sm text-text-muted">
              Each profile is one playlist or provider. Switching profiles swaps the whole channel
              list, favorites and guide.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setShowSetupModal(true)}
            className="flex shrink-0 items-center gap-2 rounded-lg bg-accent px-4 py-2 text-on-accent transition-colors hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
            Add profile
          </button>
        </div>

        <div className="space-y-3">
          {playlists.map((playlist) => {
            const isActive = playlist.id === activeProfileId;
            const isEditing = editingId === playlist.id;
            const isXtream = Boolean(playlist.xtream_username);
            const kind = isXtream ? 'Xtream Codes' : 'M3U';

            const count = playlist.id !== undefined ? channelCounts[playlist.id] : undefined;
            const countKnown = count !== undefined;

            const refreshedLine = refreshedAgo(playlist.last_updated);
            const refreshAgeDays = daysSince(playlist.last_updated);
            const olderThanWeek = refreshAgeDays !== null && refreshAgeDays > STALE_REFRESH_DAYS;

            const rawExpiry = playlist.id ? expiries[playlist.id] : null;
            const expiryLine = formatSubscriptionExpiry(rawExpiry);
            const expiryDate = rawExpiry ? new Date(rawExpiry) : null;
            const daysUntilExpiry =
              expiryDate && !Number.isNaN(expiryDate.getTime())
                ? Math.floor((expiryDate.getTime() - Date.now()) / 86_400_000)
                : null;
            const expirySoon = daysUntilExpiry !== null && daysUntilExpiry <= EXPIRY_SOON_DAYS;

            return (
              <article
                key={playlist.id}
                className={cn(
                  'flex items-center gap-5 rounded-2xl border p-5 transition-colors',
                  isActive ? 'border-accent bg-text/5' : 'border-border'
                )}
              >
                <div className="flex h-[52px] w-[52px] shrink-0 items-center justify-center rounded-[14px] border border-border bg-surface-2">
                  {isXtream ? (
                    <KeyRound
                      className={cn('h-6 w-6', isActive ? 'text-accent-text' : 'text-text-muted')}
                      aria-hidden="true"
                    />
                  ) : (
                    <Link
                      className={cn('h-6 w-6', isActive ? 'text-accent-text' : 'text-text-muted')}
                      aria-hidden="true"
                    />
                  )}
                </div>

                <div className="min-w-0 flex-1">
                  {isEditing ? (
                    <input
                      type="text"
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      className="w-full max-w-sm rounded-md border border-border-strong bg-surface px-3 py-1 text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                      autoFocus
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') handleSaveRename(playlist.id!);
                        if (e.key === 'Escape') handleCancelRename();
                      }}
                    />
                  ) : (
                    <div className="flex min-w-0 items-center gap-2">
                      <h3 className="truncate font-display text-xl font-semibold text-text">
                        {playlist.name}
                      </h3>
                      <span className="shrink-0 rounded-md border border-border px-2 text-xs text-text-muted">
                        {kind}
                      </span>
                    </div>
                  )}

                  <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] tabular-nums text-text-muted">
                    {countKnown && <span>{count === 1 ? '1 channel' : `${count} channels`}</span>}
                    {refreshedLine && <span>{refreshedLine}</span>}
                    {expiryLine && (
                      <span
                        className={cn(
                          'flex items-center gap-1',
                          expirySoon ? 'font-semibold text-accent-text' : 'text-text-muted'
                        )}
                      >
                        {expirySoon && <Info className="h-3.5 w-3.5" aria-hidden="true" />}
                        {expiryLine}
                      </span>
                    )}
                    {olderThanWeek && (
                      <span className="flex items-center gap-1 text-text-muted">
                        <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
                        Older than a week
                      </span>
                    )}
                  </div>
                </div>

                <div className="flex shrink-0 items-center gap-2">
                  {isEditing ? (
                    <>
                      <button
                        type="button"
                        onClick={() => handleSaveRename(playlist.id!)}
                        className="rounded-md bg-accent px-3 py-1.5 text-sm text-on-accent transition-colors hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                      >
                        Save
                      </button>
                      <button
                        type="button"
                        onClick={handleCancelRename}
                        className="rounded-md border border-border-strong bg-text/5 px-3 py-1.5 text-sm text-text transition-colors hover:bg-text/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                      >
                        Cancel
                      </button>
                    </>
                  ) : (
                    <>
                      {isActive ? (
                        <span className="flex items-center gap-1.5 rounded-full bg-accent px-3 py-1.5 text-sm font-medium text-on-accent">
                          <Check className="h-4 w-4" aria-hidden="true" />
                          Active
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => handleActivateProfile(playlist)}
                          aria-label={`Switch to ${playlist.name}`}
                          className="rounded-full border border-border-strong bg-text/5 px-3 py-1.5 text-sm font-medium text-text transition-colors hover:bg-text/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                        >
                          Switch to
                        </button>
                      )}

                      <button
                        type="button"
                        onClick={() => handleStartRename(playlist)}
                        className="rounded px-2 py-1 text-sm text-text-muted transition-colors hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                      >
                        Rename
                      </button>
                      <button
                        type="button"
                        onClick={() => setRefreshingId(playlist.id!)}
                        className="rounded px-2 py-1 text-sm text-text-muted transition-colors hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                      >
                        Refresh
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDeleteProfile(playlist.id!)}
                        className="rounded px-2 py-1 text-sm text-text-muted transition-colors hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                      >
                        Delete
                      </button>
                    </>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      </div>

      {/* Setup Modal for Creating New Profile */}
      {showSetupModal && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-[60] flex items-center justify-center bg-bg/70 p-4 backdrop-blur-sm"
        >
          <Setup onComplete={handleProfileCreated} onCancel={() => setShowSetupModal(false)} />
        </div>
      )}

      {/* Delete Last Profile Warning Modal */}
      {showDeleteWarning !== null && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-bg/70 p-4 backdrop-blur-sm">
          <div role="dialog" aria-modal="true" className="max-w-md rounded-lg bg-surface p-6">
            <h3 className="mb-4 text-xl font-bold text-text">Delete Last Profile?</h3>
            <p className="mb-6 text-text-muted">
              This is your only profile. If you delete it, the onboarding process will start again
              and you'll need to add a new playlist.
            </p>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setShowDeleteWarning(null)}
                className="rounded-lg bg-surface-2 px-4 py-2 text-text hover:bg-surface-hover"
              >
                Cancel
              </button>
              <button
                onClick={handleConfirmDeleteLastProfile}
                className="rounded-lg bg-danger px-4 py-2 text-on-danger hover:bg-danger/90"
              >
                Delete and Restart
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Error Modal */}
      <ErrorModal
        isOpen={showErrorModal}
        onClose={() => setShowErrorModal(false)}
        title={errorTitle}
        message={errorMessage}
      />

      {/* Profile switch failure, kept by useProfileSwitch */}
      <ErrorModal
        isOpen={switchError !== null}
        onClose={clearError}
        title="Failed to switch profile"
        message={switchError ?? ''}
      />

      {/* Per-profile refresh, triggered by a card's Refresh button */}
      {refreshTarget?.id && (
        <RefreshModal
          isOpen={true}
          onClose={() => setRefreshingId(null)}
          playlistId={refreshTarget.id}
          playlistName={refreshTarget.name}
          onRefreshComplete={handleRefreshComplete}
        />
      )}
    </>
  );
}
