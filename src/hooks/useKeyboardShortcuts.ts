import { useEffect, useCallback } from 'react';
import { usePlayerStore } from '../stores/player-store';
import { logger } from '../lib/logger';

/**
 * Global keyboard shortcuts for media control.
 *
 * | Key    | Action                                         |
 * |--------|------------------------------------------------|
 * | Space  | Stop playback                                  |
 * | Escape | Close the open view, else stop playback        |
 * | /      | Focus search bar (else `onSearchUnavailable`)  |
 * | G      | Toggle the TV guide (`onToggleGuide`)          |
 *
 * All shortcuts except Escape are suppressed when focus is inside an
 * input, textarea, select or contenteditable element. G is also ignored
 * with Ctrl/Meta/Alt held, so browser and Settings chords keep working.
 *
 * Space pressed on a button, link or tab belongs to that control: it is
 * how the keyboard presses it. The shortcut leaves the key alone there,
 * and stops playback only when the focus is on nothing that uses Space.
 * Space never starts anything: once stopped, nothing is current to resume.
 *
 * Escape: an owner that already handled it (Settings, TopBar's profile
 * menu, the guide's detail panel) marks it with `preventDefault` in the
 * capture phase and this handler does nothing. Otherwise `onEscapeView`
 * gets the first go; when it returns true (it closed something) playback
 * keeps going, and only when it returns false does Escape stop playback.
 *
 * No shortcut acts while any `aria-modal="true"` dialog is open (a PIN
 * prompt, a confirmation): the dialog owns the keyboard then.
 */
/** Controls the keyboard activates with Space; the stop shortcut never takes the key from them. */
const SPACE_CONTROLS =
  'button, a[href], summary, [role="button"], [role="tab"], [role="menuitem"], [role="option"], [role="checkbox"], [role="switch"]';

export interface KeyboardShortcutOptions {
  onToggleGuide?: () => void;
  /** Close the open view; true when something was closed. */
  onEscapeView?: () => boolean;
  /** "/" pressed while no search box is mounted (Home): the caller decides where to go. */
  onSearchUnavailable?: () => void;
}

export function useKeyboardShortcuts(
  searchInputRef?: React.RefObject<globalThis.HTMLInputElement | null>,
  options: KeyboardShortcutOptions = {}
) {
  const { onToggleGuide, onEscapeView, onSearchUnavailable } = options;
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const stopPlayback = usePlayerStore((s) => s.stopPlayback);

  const stopIfPlaying = useCallback(async () => {
    if (!isPlaying) return;
    try {
      await stopPlayback();
    } catch (err) {
      logger.error('Failed to stop playback via keyboard:', err);
    }
  }, [isPlaying, stopPlayback]);

  const handler = useCallback(
    async (e: globalThis.KeyboardEvent) => {
      // An open modal dialog owns the keyboard: no global shortcut acts behind it.
      if (document.querySelector('[aria-modal="true"]')) return;

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
        if (onEscapeView?.()) return;
        await stopIfPlaying();
        return;
      }

      // All other shortcuts are suppressed when inside form elements
      if (isInput) return;

      switch (e.key) {
        case ' ': {
          if (target.closest?.(SPACE_CONTROLS)) break;
          e.preventDefault();
          await stopIfPlaying();
          break;
        }

        case '/': {
          e.preventDefault();
          if (searchInputRef?.current) searchInputRef.current.focus();
          else onSearchUnavailable?.();
          break;
        }

        case 'g':
        case 'G': {
          if (e.ctrlKey || e.metaKey || e.altKey || !onToggleGuide) break;
          e.preventDefault();
          onToggleGuide();
          break;
        }
      }
    },
    [stopIfPlaying, searchInputRef, onToggleGuide, onSearchUnavailable, onEscapeView]
  );

  useEffect(() => {
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [handler]);
}
