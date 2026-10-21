import { memo } from 'react';
import { Square } from 'lucide-react';
import { useChannelLogo } from '../hooks/useChannelLogo';
import type { Channel } from '../types';
import type { NowNext } from '../lib/epgIpc';
import { formatClock, progressPercent, minutesLeft, shownNowNext } from '../lib/epgTime';
import { ColorBars } from './ColorBars';

interface NowPlayingBarProps {
  /** Currently playing channel */
  channel: Channel;
  /** Now and next on this channel, the same entry its card shows */
  epg?: NowNext;
  /** The current time (epoch ms); `useNow` */
  now: number;
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
  now,
  onStop,
}: NowPlayingBarProps) {
  // The dock stays mounted while any channel plays; the hook resets its
  // failure state when the channel or its logo changes.
  const { src: logoSrc, onError: onLogoError } = useChannelLogo(channel);

  // An entry that no longer describes the present (its programme ended, or
  // an off-air entry's next programme began) is not shown while the
  // refetch, asked for just after that boundary, is on its way.
  const epg = shownNowNext(cachedEpg, now);

  const current = epg?.now ?? null;
  const programme = current?.title ?? null;
  // Between broadcasts: nothing on now, but the guide knows what comes next.
  const offAir = !current && Boolean(epg?.next);
  const next = epg?.next?.title ?? null;

  const startTime = current ? formatClock(current.start) : '';
  const endTime = current ? formatClock(current.stop) : '';
  const hasRange = Boolean(startTime && endTime);
  const pct = current ? progressPercent(current.start, current.stop, now) : null;
  const minsLeft = current ? minutesLeft(current.stop, now) : null;
  const nextTime = epg?.next ? formatClock(epg.next.start) : '';

  return (
    <aside
      aria-label="Now playing"
      className="absolute bottom-6 left-1/2 flex h-[76px] w-[min(880px,calc(100%-80px))] -translate-x-1/2 items-center gap-4 rounded-[18px] border border-border-strong bg-surface/85 px-3 shadow-[0_20px_50px_rgba(0,0,0,.5)] backdrop-blur-2xl supports-[not(backdrop-filter:blur(1px))]:bg-surface"
    >
      <div className="relative h-[52px] w-[52px] shrink-0 overflow-hidden rounded-xl bg-surface-2">
        {logoSrc ? (
          <img
            src={logoSrc}
            alt={channel.name}
            loading="lazy"
            decoding="async"
            draggable={false}
            onError={onLogoError}
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
