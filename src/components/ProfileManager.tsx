import { useState } from 'react';
import { usePlayerStore } from '../stores/player-store';
import { setActiveProfileId, deletePlaylist, renamePlaylist, getChannels } from '../lib/tauri';
import { logger } from '../lib/logger';
import Setup from './Setup';
import ErrorModal from './modals/ErrorModal';
import type { Playlist } from '../types';

interface ProfileManagerProps {
  onClose: () => void; // For closing Settings modal if needed
}

export default function ProfileManager({ onClose }: ProfileManagerProps) {
  const {
    playlists,
    activeProfileId,
    currentPlaylist,
    setActiveProfileId: setStoreActiveId,
    setCurrentPlaylist,
    setChannels,
    setIsSetupComplete,
  } = usePlayerStore();

  const [showSetupModal, setShowSetupModal] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState('');
  const [showDeleteWarning, setShowDeleteWarning] = useState<number | null>(null);

  // Error modal state
  const [showErrorModal, setShowErrorModal] = useState(false);
  const [errorTitle, setErrorTitle] = useState('');
  const [errorMessage, setErrorMessage] = useState('');

  // Switch to a different profile
  const handleActivateProfile = async (playlist: Playlist) => {
    try {
      logger.info(`Switching to profile: ${playlist.name}`);

      // Set active in backend
      await setActiveProfileId(playlist.id!);

      // Load channels for this playlist
      const channels = await getChannels(playlist.id!);

      // Update frontend state
      setStoreActiveId(playlist.id!);
      setCurrentPlaylist(playlist);
      setChannels(channels);

      logger.info(`Profile switched successfully: ${channels.length} channels loaded`);
    } catch (err) {
      logger.error('Failed to switch profile:', err);
      setErrorTitle('Failed to Switch Profile');
      setErrorMessage(`Failed to switch profile: ${err}`);
      setShowErrorModal(true);
    }
  };

  // Start rename process
  const handleStartRename = (playlist: Playlist) => {
    setEditingId(playlist.id!);
    setEditName(playlist.name);
  };

  // Save renamed profile
  const handleSaveRename = async (id: number) => {
    if (!editName.trim()) {
      setErrorTitle('Invalid Profile Name');
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
      onClose(); // Close Settings modal

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

  return (
    <>
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white">Profiles</h3>
          <button
            onClick={() => setShowSetupModal(true)}
            className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-white transition-colors hover:bg-blue-700"
          >
            <span className="text-xl">+</span>
            Create New Profile
          </button>
        </div>

        <div className="space-y-3">
          {playlists.map((playlist) => {
            const isActive = playlist.id === activeProfileId;
            const isEditing = editingId === playlist.id;
            const type = playlist.xtream_username ? 'Xtream Codes' : 'M3U URL';
            const icon = type === 'Xtream Codes' ? '📡' : '📺';

            return (
              <div
                key={playlist.id}
                className={`rounded-lg border-2 p-4 transition-all ${
                  isActive
                    ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20'
                    : 'border-gray-300 bg-white dark:border-gray-600 dark:bg-gray-800'
                }`}
              >
                <div className="flex items-center justify-between">
                  <div className="flex flex-1 items-center gap-3">
                    <div className="text-2xl">{icon}</div>
                    <div className="flex-1">
                      {isEditing ? (
                        <input
                          type="text"
                          value={editName}
                          onChange={(e) => setEditName(e.target.value)}
                          className="w-full rounded-md border border-gray-300 px-3 py-1 dark:border-gray-600 dark:bg-gray-700 dark:text-white"
                          autoFocus
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') handleSaveRename(playlist.id!);
                            if (e.key === 'Escape') handleCancelRename();
                          }}
                        />
                      ) : (
                        <h3 className="font-semibold text-gray-900 dark:text-white">
                          {playlist.name}
                        </h3>
                      )}
                      <p className="text-sm text-gray-600 dark:text-gray-400">Type: {type}</p>
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    {isActive ? (
                      <span className="rounded-full bg-blue-600 px-3 py-1 text-sm font-medium text-white">
                        Active
                      </span>
                    ) : (
                      <button
                        onClick={() => handleActivateProfile(playlist)}
                        className="rounded-md bg-green-600 px-3 py-1 text-sm font-medium text-white transition-colors hover:bg-green-700"
                      >
                        Activate
                      </button>
                    )}

                    {isEditing ? (
                      <>
                        <button
                          onClick={() => handleSaveRename(playlist.id!)}
                          className="rounded-md bg-blue-600 px-3 py-1 text-sm text-white hover:bg-blue-700"
                        >
                          Save
                        </button>
                        <button
                          onClick={handleCancelRename}
                          className="rounded-md bg-gray-500 px-3 py-1 text-sm text-white hover:bg-gray-600"
                        >
                          Cancel
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          onClick={() => handleStartRename(playlist)}
                          className="rounded-md bg-gray-600 px-3 py-1 text-sm text-white hover:bg-gray-700"
                        >
                          Rename
                        </button>
                        <button
                          onClick={() => handleDeleteProfile(playlist.id!)}
                          className="rounded-md bg-red-600 px-3 py-1 text-sm text-white hover:bg-red-700"
                        >
                          Delete
                        </button>
                      </>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Setup Modal for Creating New Profile */}
      {showSetupModal && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm">
          <Setup onComplete={handleProfileCreated} onCancel={() => setShowSetupModal(false)} />
        </div>
      )}

      {/* Delete Last Profile Warning Modal */}
      {showDeleteWarning !== null && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm">
          <div className="max-w-md rounded-lg bg-white p-6 dark:bg-gray-800">
            <h3 className="mb-4 text-xl font-bold text-gray-900 dark:text-white">
              Delete Last Profile?
            </h3>
            <p className="mb-6 text-gray-700 dark:text-gray-300">
              This is your only profile. If you delete it, the onboarding process will start again
              and you'll need to add a new playlist.
            </p>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setShowDeleteWarning(null)}
                className="rounded-lg bg-gray-500 px-4 py-2 text-white hover:bg-gray-600"
              >
                Cancel
              </button>
              <button
                onClick={handleConfirmDeleteLastProfile}
                className="rounded-lg bg-red-600 px-4 py-2 text-white hover:bg-red-700"
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
    </>
  );
}
