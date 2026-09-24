import { useState, useMemo, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { X, Search, Lock, Unlock } from 'lucide-react';
import type { Channel } from '../../types';
import { setBlockedChannels } from '../../lib/tauri';
import ErrorModal from './ErrorModal';

interface ChannelBlockingModalProps {
  isOpen: boolean;
  onClose: () => void;
  channels: Channel[];
  initialBlockedIds: Set<number>;
  onUpdate: (blockedIds: Set<number>) => void;
}

export default function ChannelBlockingModal({
  isOpen,
  onClose,
  channels,
  initialBlockedIds,
  onUpdate,
}: ChannelBlockingModalProps) {
  const [blockedIds, setBlockedIds] = useState<Set<number>>(new Set(initialBlockedIds));
  const [searchQuery, setSearchQuery] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const parentRef = useRef<HTMLDivElement>(null);

  // Error modal state
  const [showErrorModal, setShowErrorModal] = useState(false);
  const [errorTitle, setErrorTitle] = useState('');
  const [errorMessage, setErrorMessage] = useState('');

  // Filter channels by search query
  const filteredChannels = useMemo(() => {
    if (!searchQuery.trim()) {
      return channels;
    }

    const query = searchQuery.toLowerCase();
    return channels.filter(
      (channel) =>
        channel.name.toLowerCase().includes(query) ||
        channel.group_name?.toLowerCase().includes(query)
    );
  }, [channels, searchQuery]);

  // Virtual scrolling for performance with large channel lists
  const virtualizer = useVirtualizer({
    count: filteredChannels.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 68, // Approximate height of each channel item
    overscan: 5,
  });

  // Toggle channel block status
  const toggleChannel = (channelId: number | undefined) => {
    if (!channelId) return;

    setBlockedIds((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(channelId)) {
        newSet.delete(channelId);
      } else {
        newSet.add(channelId);
      }
      return newSet;
    });
  };

  // Select/deselect all filtered channels
  const toggleAll = () => {
    const filteredIds = filteredChannels
      .map((c) => c.id)
      .filter((id): id is number => id !== undefined);
    const allBlocked = filteredIds.every((id) => blockedIds.has(id));

    setBlockedIds((prev) => {
      const newSet = new Set(prev);
      if (allBlocked) {
        // Unblock all filtered
        filteredIds.forEach((id) => newSet.delete(id));
      } else {
        // Block all filtered
        filteredIds.forEach((id) => newSet.add(id));
      }
      return newSet;
    });
  };

  // Save changes
  const handleSave = async () => {
    setIsSaving(true);
    try {
      const idsArray = Array.from(blockedIds);
      await setBlockedChannels(idsArray);
      onUpdate(blockedIds);
      onClose();
    } catch (error) {
      console.error('Failed to save blocked channels:', error);
      setErrorTitle('Failed to Save');
      setErrorMessage(`Failed to save: ${error}`);
      setShowErrorModal(true);
    } finally {
      setIsSaving(false);
    }
  };

  // Cancel and revert
  const handleCancel = () => {
    setBlockedIds(new Set(initialBlockedIds));
    setSearchQuery('');
    onClose();
  };

  if (!isOpen) return null;

  const allFilteredBlocked = filteredChannels.every((c) => c.id && blockedIds.has(c.id));

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-bg/70 backdrop-blur-sm">
      <div
        role="dialog"
        aria-modal="true"
        className="flex h-[80vh] w-full max-w-3xl flex-col rounded-lg bg-surface shadow-xl"
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border p-6">
          <div>
            <h3 className="text-xl font-bold text-text">Block Channels</h3>
            <p className="mt-1 text-sm text-text-faint">
              {blockedIds.size} of {channels.length} channels blocked
            </p>
          </div>
          <button
            onClick={handleCancel}
            aria-label="Close"
            className="rounded-lg p-1 hover:bg-surface-hover"
          >
            <X className="h-5 w-5 text-text-muted" aria-hidden="true" />
          </button>
        </div>

        {/* Search and controls */}
        <div className="border-b border-border p-4">
          <div className="flex gap-3">
            <div className="relative flex-1">
              <Search
                className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-faint"
                aria-hidden="true"
              />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search channels..."
                className="w-full rounded-lg border border-border-strong bg-surface py-2 pl-10 pr-4 text-text focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent"
              />
            </div>
            <button
              onClick={toggleAll}
              className="flex items-center gap-2 rounded-lg border border-border-strong px-4 py-2 hover:bg-surface-hover"
            >
              {allFilteredBlocked ? (
                <>
                  <Unlock className="h-4 w-4" aria-hidden="true" />
                  <span className="text-sm">Unblock All</span>
                </>
              ) : (
                <>
                  <Lock className="h-4 w-4" aria-hidden="true" />
                  <span className="text-sm">Block All</span>
                </>
              )}
            </button>
          </div>
        </div>

        {/* Channel list - Virtualized for performance */}
        <div ref={parentRef} className="flex-1 overflow-y-auto p-4">
          {filteredChannels.length === 0 ? (
            <div className="py-12 text-center text-text-faint">No channels found</div>
          ) : (
            <div
              style={{
                height: `${virtualizer.getTotalSize()}px`,
                width: '100%',
                position: 'relative',
              }}
            >
              {virtualizer.getVirtualItems().map((virtualItem) => {
                const channel = filteredChannels[virtualItem.index];
                return (
                  <div
                    key={virtualItem.key}
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      width: '100%',
                      height: `${virtualItem.size}px`,
                      transform: `translateY(${virtualItem.start}px)`,
                      paddingBottom: '8px',
                    }}
                  >
                    <label className="flex h-full cursor-pointer items-center gap-3 rounded-lg border border-border p-3 hover:bg-surface-hover">
                      <input
                        type="checkbox"
                        checked={channel.id ? blockedIds.has(channel.id) : false}
                        onChange={() => toggleChannel(channel.id)}
                        className="h-4 w-4 rounded border-border-strong accent-accent focus:ring-2 focus:ring-accent"
                      />
                      <div className="flex-1">
                        <div className="font-medium text-text">{channel.name}</div>
                        {channel.group_name && (
                          <div className="text-sm text-text-muted">{channel.group_name}</div>
                        )}
                      </div>
                      {channel.id && blockedIds.has(channel.id) && (
                        <Lock className="h-4 w-4 text-danger" aria-hidden="true" />
                      )}
                    </label>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-border p-6">
          <div className="text-sm text-text-faint">{filteredChannels.length} channels shown</div>
          <div className="flex gap-3">
            <button
              onClick={handleCancel}
              className="rounded-lg bg-surface-2 px-4 py-2 text-text hover:bg-surface-hover disabled:opacity-50"
              disabled={isSaving}
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              className="rounded-lg bg-accent px-4 py-2 text-on-accent hover:bg-accent-hover disabled:opacity-50"
              disabled={isSaving}
            >
              {isSaving ? 'Saving...' : 'Save'}
            </button>
          </div>
        </div>
      </div>

      {/* Error Modal */}
      <ErrorModal
        isOpen={showErrorModal}
        onClose={() => setShowErrorModal(false)}
        title={errorTitle}
        message={errorMessage}
      />
    </div>
  );
}
