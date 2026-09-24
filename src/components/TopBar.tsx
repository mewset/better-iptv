import { useEffect, useRef } from 'react';
import { Check, ChevronDown, Search } from 'lucide-react';
import { usePlayerStore } from '../stores/player-store';
import { useProfileSwitch } from '../hooks/useProfileSwitch';
import ErrorModal from './modals/ErrorModal';
import type { Playlist, UpdateInfo } from '../types';

interface TopBarProps {
  title: string;
  subtitle: string;
  searchRef: React.RefObject<globalThis.HTMLInputElement | null>;
  query: string;
  onQuery: (q: string) => void;
  update: UpdateInfo | null;
  onOpenUpdate: () => void;
  showSearch: boolean;
  /** The profile menu is controlled so the rail's avatar can open it too. */
  profileMenuOpen: boolean;
  onProfileMenuOpenChange: (open: boolean) => void;
}

function initialOf(name: string | undefined): string {
  return name?.trim().charAt(0).toUpperCase() || '?';
}

/**
 * The glass top bar: section title and count, update pill, search, and the
 * profile switcher. The switcher lists the same profiles as Settings >
 * Profiles and switches with one click through `useProfileSwitch`.
 */
export function TopBar({
  title,
  subtitle,
  searchRef,
  query,
  onQuery,
  update,
  onOpenUpdate,
  showSearch,
  profileMenuOpen,
  onProfileMenuOpenChange,
}: TopBarProps) {
  const playlists = usePlayerStore((s) => s.playlists);
  const activeProfileId = usePlayerStore((s) => s.activeProfileId);
  const { switchTo, error, clearError } = useProfileSwitch();

  const active = playlists.find((p) => p.id === activeProfileId);
  const switcherRef = useRef<globalThis.HTMLDivElement>(null);
  const triggerRef = useRef<globalThis.HTMLButtonElement>(null);
  const menuRef = useRef<globalThis.HTMLDivElement>(null);

  const close = onProfileMenuOpenChange;

  // While the menu is open: an outside press closes it, and Escape closes it
  // without reaching the global shortcut handler (which would stop
  // playback). The Escape listener runs in the capture phase on window, so
  // it fires before useKeyboardShortcuts' bubble-phase window listener and
  // `stopPropagation` keeps that one from running at all.
  useEffect(() => {
    if (!profileMenuOpen) return;

    const onPointerDown = (e: globalThis.MouseEvent) => {
      if (!switcherRef.current?.contains(e.target as globalThis.Node)) close(false);
    };
    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      e.preventDefault();
      close(false);
      triggerRef.current?.focus();
    };

    document.addEventListener('mousedown', onPointerDown);
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, [profileMenuOpen, close]);

  // Move focus into the menu when it opens, onto the active profile.
  useEffect(() => {
    if (!profileMenuOpen) return;
    const items =
      menuRef.current?.querySelectorAll<globalThis.HTMLButtonElement>('[role="menuitemradio"]');
    if (!items?.length) return;
    const checked = Array.from(items).find((i) => i.getAttribute('aria-checked') === 'true');
    (checked ?? items[0]).focus();
  }, [profileMenuOpen]);

  const onMenuKeyDown = (e: React.KeyboardEvent<globalThis.HTMLDivElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') {
      return;
    }
    e.preventDefault();
    const items = Array.from(
      menuRef.current?.querySelectorAll<globalThis.HTMLButtonElement>('[role="menuitemradio"]') ??
        []
    );
    if (items.length === 0) return;
    const current = items.indexOf(document.activeElement as globalThis.HTMLButtonElement);
    let next = 0;
    if (e.key === 'ArrowDown') next = (current + 1) % items.length;
    if (e.key === 'ArrowUp') next = (current - 1 + items.length) % items.length;
    if (e.key === 'End') next = items.length - 1;
    items[next].focus();
  };

  const choose = (playlist: Playlist) => {
    close(false);
    triggerRef.current?.focus();
    if (playlist.id !== activeProfileId) void switchTo(playlist);
  };

  // The error modal sits outside <header>: the header's backdrop-filter makes
  // it the containing block for fixed descendants, which would clip the modal.
  return (
    <>
      <header className="relative z-10 flex h-16 shrink-0 items-center gap-6 border-b border-border bg-bg/70 px-10 backdrop-blur-xl supports-[not(backdrop-filter:blur(1px))]:bg-bg">
        <div className="flex min-w-0 flex-1 items-baseline gap-3">
          <h1 className="truncate font-display text-2xl font-semibold text-text">{title}</h1>
          <p className="truncate text-[13px] text-text-muted">{subtitle}</p>
        </div>

        {update && (
          <button
            type="button"
            onClick={onOpenUpdate}
            title={`Better IPTV ${update.version} is available`}
            className="h-8 shrink-0 rounded-full border border-accent px-3 text-xs font-semibold text-accent-text transition-colors hover:bg-text/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            {update.version} available
          </button>
        )}

        {showSearch && (
          <label className="flex h-10 w-[360px] shrink-0 items-center gap-2 rounded-xl border border-border bg-text/5 px-3 focus-within:ring-2 focus-within:ring-accent">
            <Search className="h-4 w-4 shrink-0 text-text-muted" aria-hidden="true" />
            <span className="sr-only">Search channels, movies and series</span>
            <input
              ref={searchRef}
              type="search"
              value={query}
              onChange={(e) => onQuery(e.target.value)}
              placeholder="Search channels, movies, series"
              className="min-w-0 flex-1 appearance-none bg-transparent text-sm text-text placeholder:text-text-muted focus:outline-none [&::-webkit-search-cancel-button]:appearance-none"
            />
            <kbd
              aria-hidden="true"
              className="rounded border border-border px-1.5 font-sans text-xs text-text-muted"
            >
              /
            </kbd>
          </label>
        )}

        <div ref={switcherRef} className="relative shrink-0">
          <button
            ref={triggerRef}
            type="button"
            aria-haspopup="menu"
            aria-expanded={profileMenuOpen}
            onClick={() => onProfileMenuOpenChange(!profileMenuOpen)}
            className="flex h-10 items-center gap-2 rounded-xl px-2 text-sm font-medium text-text transition-colors hover:bg-text/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            <span
              aria-hidden="true"
              className="flex h-7 w-7 items-center justify-center rounded-full border border-border-strong bg-surface-2 text-xs font-semibold"
            >
              {initialOf(active?.name)}
            </span>
            <span className="max-w-40 truncate">{active?.name ?? 'Profiles'}</span>
            <ChevronDown className="h-4 w-4 text-text-muted" aria-hidden="true" />
          </button>

          {profileMenuOpen && (
            <div
              ref={menuRef}
              role="menu"
              aria-label="Profiles"
              onKeyDown={onMenuKeyDown}
              className="absolute right-0 top-full z-20 mt-2 min-w-48 rounded-xl border border-border bg-surface-2 p-1 shadow-xl"
            >
              {playlists.map((playlist) => {
                const checked = playlist.id === activeProfileId;
                return (
                  <button
                    key={playlist.id}
                    type="button"
                    role="menuitemradio"
                    aria-checked={checked}
                    onClick={() => choose(playlist)}
                    className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-text hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                  >
                    <span className="flex-1 truncate">{playlist.name}</span>
                    {checked && <Check className="h-4 w-4 text-accent-text" aria-hidden="true" />}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </header>

      <ErrorModal
        isOpen={error !== null}
        onClose={clearError}
        title="Failed to switch profile"
        message={error ?? ''}
      />
    </>
  );
}

export default TopBar;
