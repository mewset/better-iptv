import { useEffect, useCallback } from 'react';
import { usePlayerStore } from '../stores/player-store';
import { stopPlayback, playChannel } from '../lib/tauri';
import { logger } from '../lib/logger';

/**
 * Global keyboard shortcuts for media control.
 *
 * | Key    | Action                                         |
 * |--------|------------------------------------------------|
 * | Space  | Toggle play/stop                               |
 * | F      | Toggle fullscreen (MPV)                        |
 * | Escape | Close the open view, else stop playback        |
 * | /      | Focus search bar                               |
 * | G      | Toggle the TV guide (`onToggleGuide`)          |
 * | M      | Mute toggle (future)                           |
 *
 * All shortcuts except Escape are suppressed when focus is inside an
 * input, textarea, select or contenteditable element. G is also ignored
 * with Ctrl/Meta/Alt held, so browser and Settings chords keep working.
 *
 * Escape: an owner that already handled it (Settings, TopBar's profile
 * menu, the guide's detail panel) marks it with `preventDefault` in the
 * capture phase and this handler does nothing. Otherwise `onEscapeView`
 * gets the first go; when it returns true (it closed something) playback
 * keeps going, and only when it returns false does Escape stop playback.
 *
 * Escape and G are both left alone while any `aria-modal="true"` dialog is
 * open (a PIN prompt, a confirmation): the dialog owns the keyboard then.
 */
export interface KeyboardShortcutOptions {
  onToggleGuide?: () => void;
  /** Close the open view; true when something was closed. */
  onEscapeView?: () => boolean;
}

export function useKeyboardShortcuts(
  searchInputRef?: React.RefObject<globalThis.HTMLInputElement | null>,
  options: KeyboardShortcutOptions = {}
) {
  const { onToggleGuide, onEscapeView } = options;
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

      const isGuideKey = e.key === 'g' || e.key === 'G';
      if ((e.key === 'Escape' || isGuideKey) && document.querySelector('[aria-modal="true"]')) {
        return;
      }

      // Escape always works, unless something already claimed it (Settings,
      // TopBar's profile menu) via preventDefault - it owns the key instead.
      if (e.key === 'Escape') {
        if (e.defaultPrevented) return;
        if (onEscapeView?.()) return;
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

        case 'g':
        case 'G': {
          if (e.ctrlKey || e.metaKey || e.altKey || !onToggleGuide) break;
          e.preventDefault();
          onToggleGuide();
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
      onToggleGuide,
      onEscapeView,
    ]
  );

  useEffect(() => {
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [handler]);
}
