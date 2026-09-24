import { useEffect, useCallback } from 'react';
import { usePlayerStore } from '../stores/player-store';
import { stopPlayback, playChannel } from '../lib/tauri';
import { logger } from '../lib/logger';

/**
 * Global keyboard shortcuts for media control.
 *
 * | Key    | Action                        |
 * |--------|-------------------------------|
 * | Space  | Toggle play/stop              |
 * | F      | Toggle fullscreen (MPV)       |
 * | Escape | Close modals / stop playback  |
 * | /      | Focus search bar              |
 * | M      | Mute toggle (future)          |
 *
 * All shortcuts except Escape are suppressed when focus is inside an
 * input, textarea or select element.
 */
export function useKeyboardShortcuts(
  searchInputRef?: React.RefObject<globalThis.HTMLInputElement | null>
) {
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const currentChannel = usePlayerStore((s) => s.currentChannel);
  const setIsPlaying = usePlayerStore((s) => s.setIsPlaying);
  const setCurrentChannel = usePlayerStore((s) => s.setCurrentChannel);
  const setCurrentProgram = usePlayerStore((s) => s.setCurrentProgram);
  const setNextProgram = usePlayerStore((s) => s.setNextProgram);

  const handler = useCallback(
    async (e: globalThis.KeyboardEvent) => {
      const target = e.target as globalThis.HTMLElement;
      const isInput =
        target instanceof globalThis.HTMLInputElement ||
        target instanceof globalThis.HTMLTextAreaElement ||
        target instanceof globalThis.HTMLSelectElement ||
        target.isContentEditable;

      // Escape always works, unless something already claimed it (Settings,
      // TopBar's profile menu) via preventDefault - it owns the key instead.
      if (e.key === 'Escape') {
        if (e.defaultPrevented) return;
        if (isPlaying) {
          try {
            await stopPlayback();
            setIsPlaying(false);
            setCurrentChannel(null);
            setCurrentProgram(null);
            setNextProgram(null);
          } catch (err) {
            logger.error('Failed to stop playback via keyboard:', err);
          }
        }
        return;
      }

      // All other shortcuts are suppressed when inside form elements
      if (isInput) return;

      switch (e.key) {
        case ' ': {
          e.preventDefault();
          if (isPlaying && currentChannel) {
            try {
              await stopPlayback();
              setIsPlaying(false);
              setCurrentChannel(null);
              setCurrentProgram(null);
              setNextProgram(null);
            } catch (err) {
              logger.error('Failed to stop playback via keyboard:', err);
            }
          } else if (currentChannel) {
            try {
              await playChannel(currentChannel);
              setIsPlaying(true);
            } catch (err) {
              logger.error('Failed to resume playback via keyboard:', err);
            }
          }
          break;
        }

        case '/': {
          e.preventDefault();
          searchInputRef?.current?.focus();
          break;
        }

        // F and M are reserved for future fullscreen / mute toggle via MPV IPC
      }
    },
    [
      isPlaying,
      currentChannel,
      setIsPlaying,
      setCurrentChannel,
      setCurrentProgram,
      setNextProgram,
      searchInputRef,
    ]
  );

  useEffect(() => {
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [handler]);
}
