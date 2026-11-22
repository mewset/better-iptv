import { useCallback, useEffect, useState } from 'react';

/** The category sidebar's width, padding included: what a grid beside it loses. */
export const CATEGORY_SIDEBAR_WIDTH = 272;

function read(key: string): boolean {
  try {
    return globalThis.localStorage.getItem(key) !== 'hidden';
  } catch {
    return true;
  }
}

function write(key: string, open: boolean): void {
  try {
    globalThis.localStorage.setItem(key, open ? 'shown' : 'hidden');
  } catch {
    // Not stored (private storage): the default holds next time
  }
}

/**
 * Whether a section's category sidebar is shown, remembered per section on
 * this device (`key`), and the toggle. While `active` (the section is on
 * screen), "[" toggles it, as anywhere outside a text field.
 */
export function useCategorySidebar(key: string, active: boolean): [boolean, () => void] {
  const [open, setOpen] = useState(() => read(key));
  const toggle = useCallback(() => {
    setOpen((was) => {
      write(key, !was);
      return !was;
    });
  }, [key]);

  useEffect(() => {
    if (!active) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== '[' || e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target as globalThis.HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      e.preventDefault();
      toggle();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [active, toggle]);

  return [open, toggle];
}
