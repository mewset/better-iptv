/**
 * The keyboard and focus behaviour every dialog in `components/modals`
 * shares, in one place:
 *
 * - opening moves the focus into the dialog (to the dialog itself, unless a
 *   field inside asked for it with `autoFocus`);
 * - Tab and Shift+Tab stay inside it;
 * - Escape is the dialog's Cancel, except while the dialog is working;
 * - closing hands the focus back to where it was;
 * - the dialog is named by its title (`aria-labelledby`).
 *
 * Escape is marked with `preventDefault` in the capture phase, which is how
 * the views behind (Settings, the global shortcuts) know the key is taken.
 */
import { useEffect, useId, useRef } from 'react';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** The open dialogs, oldest first. Only the last one owns the keyboard. */
const openDialogs: symbol[] = [];

interface ModalDialogOptions {
  isOpen: boolean;
  /** What Escape does: the same as the dialog's Cancel, or its only button. */
  onCancel: () => void;
  /** True while the dialog is working and cannot be cancelled. */
  busy?: boolean;
}

export function useModalDialog({ isOpen, onCancel, busy = false }: ModalDialogOptions) {
  const titleId = useId();
  const dialogRef = useRef<globalThis.HTMLDivElement>(null);
  const returnFocusRef = useRef<globalThis.Element | null>(null);
  const wasOpenRef = useRef(false);

  // Read by the key listener, which is subscribed once per opening.
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;
  const busyRef = useRef(busy);
  busyRef.current = busy;

  // Where the focus was, read while rendering the opening: an `autoFocus`
  // field takes the focus in the commit, before any effect can look.
  if (isOpen && !wasOpenRef.current) returnFocusRef.current = document.activeElement;
  wasOpenRef.current = isOpen;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!isOpen || !dialog) return;

    const token = Symbol('dialog');
    openDialogs.push(token);

    if (!dialog.contains(document.activeElement)) {
      // A dialog that closed in the same step has handed the focus back by
      // now, so this is the better place to return to.
      returnFocusRef.current = document.activeElement;
      dialog.focus();
    }

    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      if (openDialogs[openDialogs.length - 1] !== token) return;

      if (e.key === 'Escape') {
        e.preventDefault();
        if (!busyRef.current) onCancelRef.current();
        return;
      }
      if (e.key !== 'Tab') return;

      const focusable = Array.from(dialog.querySelectorAll<globalThis.HTMLElement>(FOCUSABLE));
      const first = focusable[0] ?? dialog;
      const last = focusable[focusable.length - 1] ?? dialog;
      const active = document.activeElement;
      const leaving =
        !dialog.contains(active) ||
        (e.shiftKey ? active === first || active === dialog : active === last);
      if (!leaving) return;
      e.preventDefault();
      (e.shiftKey ? last : first).focus();
    };

    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      openDialogs.splice(openDialogs.indexOf(token), 1);
      // Only once the dialog is gone: StrictMode re-runs this effect on a
      // dialog that stays, and its focused field must keep the focus.
      const back = returnFocusRef.current;
      if (!dialog.isConnected && back instanceof globalThis.HTMLElement && back.isConnected) {
        back.focus();
      }
    };
  }, [isOpen]);

  return {
    /** Spread on the dialog's panel. */
    dialogProps: {
      ref: dialogRef,
      role: 'dialog',
      'aria-modal': true,
      'aria-labelledby': titleId,
      tabIndex: -1,
    } as const,
    /** The `id` of the dialog's heading. */
    titleId,
  };
}
