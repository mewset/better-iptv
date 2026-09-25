import { useEffect } from 'react';
import { X } from 'lucide-react';
import { usePlayerStore } from '../stores/player-store';

const AUTO_DISMISS_MS = 6000;

/**
 * The one transient notice the app shows, such as a stream the provider
 * refused. Glass like the dock, and placed above it when the dock is visible.
 */
export function Toast({ aboveDock = false }: { aboveDock?: boolean }) {
  const toast = usePlayerStore((s) => s.toast);
  const dismissToast = usePlayerStore((s) => s.dismissToast);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(dismissToast, AUTO_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [toast, dismissToast]);

  if (!toast) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className={`absolute left-1/2 z-20 flex w-[min(560px,calc(100%-80px))] -translate-x-1/2 items-center gap-3 rounded-2xl border border-border-strong bg-surface/90 py-3 pl-4 pr-2 shadow-[0_20px_50px_rgba(0,0,0,.5)] backdrop-blur-2xl supports-[not(backdrop-filter:blur(1px))]:bg-surface ${
        aboveDock ? 'bottom-[112px]' : 'bottom-6'
      }`}
    >
      <p className="min-w-0 flex-1 text-sm text-text">{toast.message}</p>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={dismissToast}
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-text-muted hover:bg-text/10 hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        <X className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  );
}
