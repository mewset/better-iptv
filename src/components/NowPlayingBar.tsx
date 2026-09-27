import { memo, useEffect, useState } from 'react';
import { Square } from 'lucide-react';
import type { Channel } from '../types';
import type { EpgEntry } from '../stores/player-store';
import { formatClock, progressPercent, minutesLeft, isEpgEntryStale } from '../lib/epgTime';
import { ColorBars } from './ColorBars';

interface NowPlayingBarProps {
  /** Currently playing channel */
  channel: Channel;
  /** Current/next EPG entry for this channel, if any */
  epg?: EpgEntry;
  /** Fallback current-programme string, used only when `epg` is absent */
  currentProgram?: string | null;
  /** Fallback next-programme string, used only when `epg` is absent */
  nextProgram?: string | null;
  /** Callback when stop button is clicked */
  onStop: () => void;
}

/**
 * Floating now-playing dock.
 *
 * A pill fixed to the bottom of the viewport: a 52px logo tile, a middle
 * column with the channel name, the current programme, a time range with
 * minutes-left and a progress bar (only for the parts EPG data actually
 * supplies), and a stop button on the right.
 */
export const NowPlayingBar = memo(function NowPlayingBar({
  channel,
  epg: cachedEpg,
  currentProgram,
  nextProgram,
  onStop,
}: NowPlayingBarProps) {
  const [logoFailed, setLogoFailed] = useState(false);
  // The dock stays mounted for as long as any channel plays, so a failed
  // logo load for one channel must not stick around once playback moves to
  // a different channel with its own (possibly working) logo.
  useEffect(() => {
    setLogoFailed(false);
  }, [channel.id, channel.logo]);
  const showLogo = Boolean(channel.logo) && !logoFailed;

  // A cached entry that no longer describes the present (its programme ended,
  // or an off-air entry's next programme began) is stale until the refetch
  // lands: drop it and use the playback strings instead.
  const epg = cachedEpg && isEpgEntryStale(cachedEpg) ? undefined : cachedEpg;

  const programme = epg?.current ?? currentProgram ?? null;
  // Between broadcasts: nothing on now, but the guide knows what comes next.
  const offAir = !programme && Boolean(epg?.next);
  const next = epg?.next ?? nextProgram ?? null;

  const hasRange = Boolean(epg?.currentStart && epg?.currentEnd);
  const startTime = epg?.currentStart ? formatClock(epg.currentStart) : '';
  const endTime = epg?.currentEnd ? formatClock(epg.currentEnd) : '';
  const pct =
    epg?.currentStart && epg?.currentEnd ? progressPercent(epg.currentStart, epg.currentEnd) : null;
  const minsLeft = epg?.currentEnd ? minutesLeft(epg.currentEnd) : null;
  const nextTime = epg?.nextStart ? formatClock(epg.nextStart) : '';

  return (
    <aside
      aria-label="Now playing"
      className="absolute bottom-6 left-1/2 flex h-[76px] w-[min(880px,calc(100%-80px))] -translate-x-1/2 items-center gap-4 rounded-[18px] border border-border-strong bg-surface/85 px-3 shadow-[0_20px_50px_rgba(0,0,0,.5)] backdrop-blur-2xl supports-[not(backdrop-filter:blur(1px))]:bg-surface"
    >
      <div className="relative h-[52px] w-[52px] shrink-0 overflow-hidden rounded-xl bg-surface-2">
        {showLogo ? (
          <img
            src={channel.logo!}
            alt={channel.name}
            loading="lazy"
            decoding="async"
            draggable={false}
            onError={() => setLogoFailed(true)}
            className="h-full w-full object-contain p-1"
          />
        ) : (
          <ColorBars label={channel.name} />
        )}
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-1.5">
          <span className="max-w-[40%] shrink-0 truncate text-sm font-semibold text-text">
            {channel.name}
          </span>
          {offAir && (
            <span className="min-w-0 flex-1 truncate text-sm text-text-muted">Off air</span>
          )}
          {programme && (
            <span className="min-w-0 flex-1 truncate text-sm text-text-muted">{programme}</span>
          )}
          {(hasRange || minsLeft !== null) && (
            <span
              data-time-range
              className="shrink-0 whitespace-nowrap text-xs tabular-nums text-text-muted"
            >
              {hasRange && `${startTime}–${endTime}`}
              {minsLeft !== null && ` · ${minsLeft} min left`}
            </span>
          )}
        </div>
        {(pct !== null || next) && (
          <div className="mt-1.5 flex items-center gap-3">
            {pct !== null && (
              <div data-progress className="h-1 w-[360px] max-w-full rounded-full bg-text/10">
                <div className="h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
              </div>
            )}
            {next && (
              <p className="truncate text-xs text-text-muted">
                Next{nextTime && ` · ${nextTime}`} {next}
              </p>
            )}
          </div>
        )}
      </div>

      <button
        type="button"
        aria-label="Stop playback"
        onClick={onStop}
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent text-on-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        <Square className="h-4 w-4 fill-current" aria-hidden="true" />
      </button>
    </aside>
  );
});

export default NowPlayingBar;
