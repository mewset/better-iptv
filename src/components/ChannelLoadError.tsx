import { TriangleAlert } from 'lucide-react';

interface ChannelLoadErrorProps {
  onRetry: () => void;
}

/** Shown in place of a channel list that failed to load. Only render it in the 'error' state. */
export function ChannelLoadError({ onRetry }: ChannelLoadErrorProps) {
  return (
    <div
      data-testid="channel-load-error"
      role="alert"
      className="flex flex-col items-center gap-4 py-16 text-center text-text-muted"
    >
      <TriangleAlert className="h-6 w-6" aria-hidden="true" />
      <p>Couldn&apos;t load your channels.</p>
      <button
        type="button"
        onClick={onRetry}
        className="h-10 rounded-xl bg-accent px-4 text-sm font-semibold text-on-accent transition-colors hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
      >
        Try again
      </button>
    </div>
  );
}
