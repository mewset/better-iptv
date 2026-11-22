import { memo, useState } from 'react';
import { Pause, Play, X } from 'lucide-react';
import { useChannelLogo } from '../hooks/useChannelLogo';
import type { Channel } from '../types';
import type { NowNext } from '../lib/epgIpc';
import { formatClock, progressPercent, minutesLeft, shownNowNext } from '../lib/epgTime';
import { ColorBars } from './ColorBars';
import { usePlayerStore } from '../stores/player-store';
import { useProgressStore } from '../stores/progress-store';
import { useNowPlayingStore } from '../stores/now-playing-store';
import { progressFraction, progressKey } from '../lib/watchProgress';
import { playerSetPaused, showPlayer } from '../lib/tauri';
import { logger } from '../lib/logger';

interface NowPlayingBarProps {
  /** What the player plays (for episodes, a stand-in with the episode's title) */
  channel: Channel;
  /** Now and next on a live channel, the same entry its card shows */
  epg?: NowNext;
  /** The current time (epoch ms); `useNow` */
  now: number;
  /** Ends playback and closes the player (the ✕) */
  onStop: () => void;
}

/** "S1 E2 · Name" (how episodes are queued) → ["S1 E2", "Name"] */
function splitEpisode(title: string): [string | null, string] {
  const m = /^(S\d+ E\d+) · (.*)$/.exec(title);
  return m ? [m[1], m[2]] : [null, title];
}

/**
 * The now-playing dock: artwork, what plays, a progress bar and play/pause.
 * The same structure for every kind, so play/pause and the bar never move:
 *
 *   [poster]  The Chosen · S1 E1                              [⏯]  ✕
 *             I Have Called You by Name
 *             ━━━━━━━━━━━━━━━━━━━━━━━──────────── 46 min left
 *
 * A live channel has a wider logo tile, "LIVE · Channel", the programme on
 * now with "Next · 19:30 Title" at the line's end, its description on one
 * line when the guide has one (the dock is 20 px taller then), and its progress through
 * the programme; without guide data, a quiet line instead of the bar. The
 * whole dock brings the player window to the front; the ✕ ends playback.
 * No transitions (see ChannelCard), and no backdrop blur: blurring the
 * scrolling grid behind it on every frame is costly in WebKitGTK.
 */
export const NowPlayingBar = memo(function NowPlayingBar({
  channel,
  epg: cachedEpg,
  now,
  onStop,
}: NowPlayingBarProps) {
  const info = useNowPlayingStore((s) => s.info);
  const paused = useNowPlayingStore((s) => s.paused);
  const setPaused = useNowPlayingStore((s) => s.setPaused);
  const progress = useProgressStore((s) => s.index);
  const tmdbCards = usePlayerStore((s) => s.tmdbCards);

  const kind = info?.kind ?? (channel.content_type === 'live' ? 'live' : 'film');
  const owner = info?.channel ?? channel;
  const live = kind === 'live';
  const card = tmdbCards.get(owner.id);
  const { src: logoSrc, onError: onLogoError } = useChannelLogo(owner);
  const [posterFailed, setPosterFailed] = useState<string | null>(null);
  const poster = card?.poster_url && card.poster_url !== posterFailed ? card.poster_url : null;
  const art = live ? logoSrc : (poster ?? logoSrc);

  // What the lines say, and how far it is
  let eyebrow: string;
  let title: string;
  let detail: string | null = null;
  let description: string | null = null;
  let fraction: number | null = null;
  let left: string | null = null;
  let next: { time: string; title: string } | null = null;
  let noGuide = false;

  if (live) {
    const epg = shownNowNext(cachedEpg, now);
    const current = epg?.now ?? null;
    eyebrow = owner.name;
    title = current?.title ?? (epg?.next ? 'Off air' : owner.name);
    description = current?.description?.trim() || null;
    if (current) {
      const pct = progressPercent(current.start, current.stop, now);
      fraction = pct === null ? null : pct / 100;
      const mins = minutesLeft(current.stop, now);
      left = mins === null ? null : `${mins} min left`;
    }
    if (epg?.next) next = { time: formatClock(epg.next.start), title: epg.next.title };
    noGuide = !current && !epg?.next;
  } else if (kind === 'episode' && info?.queue) {
    // The episode playing is the series' latest progress entry, once the
    // player has saved one; before that, the first in the queue
    const latest = progress.latestByChannel.get(owner.id);
    const playing = info.queue.find((q) => q.id === latest?.episode_id) ?? info.queue[0] ?? null;
    const [se, name] = splitEpisode(playing?.title ?? channel.name);
    eyebrow = se ? `${owner.name} · ${se}` : owner.name;
    title = name;
    const entry = playing ? progress.byKey.get(progressKey(owner.id, playing.id)) : undefined;
    if (entry && entry.duration_secs > 0) {
      fraction = progressFraction(entry);
      left = `${Math.max(1, Math.round((entry.duration_secs - entry.position_secs) / 60))} min left`;
    }
  } else {
    eyebrow = 'Film';
    title = card?.title || owner.name;
    detail = [card?.year, card?.genres?.[0]].filter(Boolean).join(' · ') || null;
    const entry = progress.byKey.get(progressKey(owner.id));
    if (entry && entry.duration_secs > 0) {
      fraction = progressFraction(entry);
      left = `${Math.max(1, Math.round((entry.duration_secs - entry.position_secs) / 60))} min left`;
    }
  }

  const togglePause = () => {
    const want = !paused;
    setPaused(want);
    playerSetPaused(want).catch((err) => {
      logger.warn('Could not pause the player:', err);
      setPaused(!want);
    });
  };
  const bringPlayer = () => {
    showPlayer().catch((err) => logger.warn('Could not show the player:', err));
  };

  return (
    <aside
      aria-label="Now playing"
      className="absolute bottom-6 left-1/2 w-[min(880px,calc(100%-80px))] -translate-x-1/2"
    >
      <div
        role="button"
        tabIndex={0}
        title="Show player"
        aria-label={`Show player: ${title}`}
        onClick={bringPlayer}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            bringPlayer();
          }
        }}
        className={`relative flex ${description ? 'h-[112px]' : 'h-[92px]'} cursor-pointer items-center gap-4 rounded-[18px] border border-border-strong bg-surface py-0 pl-3 pr-11 shadow-[0_20px_50px_rgba(0,0,0,.5)] hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent`}
      >
        {/* Artwork: a 2:3 poster, or a wider tile for a channel's logo */}
        <div
          className={`relative shrink-0 overflow-hidden rounded-md bg-surface-2 ${
            live ? 'h-[66px] w-[100px] border border-border-strong' : 'h-[66px] w-[44px]'
          }`}
        >
          {art ? (
            <img
              src={art}
              alt=""
              draggable={false}
              onError={() => (art === poster ? setPosterFailed(poster) : onLogoError())}
              className={`h-full w-full ${live ? 'object-contain p-2' : 'object-cover'}`}
            />
          ) : (
            <ColorBars label={owner.name} />
          )}
        </div>

        <div className="grid min-w-0 flex-1 gap-0.5">
          <div className="flex min-w-0 items-center gap-1.5 whitespace-nowrap text-[12.5px] text-text-muted">
            {paused && <Tag>PAUSED</Tag>}
            {live && <Tag>LIVE</Tag>}
            <span className="min-w-0 truncate">{eyebrow}</span>
            {detail && <span className="min-w-0 truncate text-text-faint">· {detail}</span>}
          </div>
          {/* The title; for live, what is next at the line's end, over the bar's end */}
          <div className="flex min-w-0 items-baseline gap-4 pr-[100px]">
            <span className="min-w-0 truncate font-display text-[17px] font-semibold leading-snug text-text">
              {title}
            </span>
            {next && (
              <span className="ml-auto min-w-0 shrink truncate text-[12.5px] text-text-muted">
                Next · <b className="font-semibold text-text">{next.time}</b> {next.title}
              </span>
            )}
          </div>
          {description && (
            <p className="min-w-0 truncate text-[12.5px] text-text-muted">{description}</p>
          )}
          {noGuide ? (
            <p className="mt-0.5 min-h-[18px] text-[12.5px] text-text-faint">
              No guide for this channel
            </p>
          ) : (
            <div className="mt-1 flex items-center gap-3">
              <div
                role="progressbar"
                aria-label="Progress"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={fraction === null ? undefined : Math.round(fraction * 100)}
                className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-text/10"
              >
                {fraction !== null && (
                  <div
                    className="h-full rounded-full bg-accent"
                    style={{ width: `${fraction * 100}%` }}
                  />
                )}
              </div>
              <span className="w-[88px] shrink-0 text-xs text-text-muted">{left ?? ''}</span>
            </div>
          )}
        </div>

        <button
          type="button"
          aria-label={paused ? 'Play' : 'Pause'}
          onClick={(e) => {
            e.stopPropagation();
            togglePause();
          }}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent text-on-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
        >
          {paused ? (
            <Play className="h-[19px] w-[19px] fill-current" aria-hidden="true" />
          ) : (
            <Pause className="h-[19px] w-[19px] fill-current" aria-hidden="true" />
          )}
        </button>

        <button
          type="button"
          aria-label="Stop playback"
          title="Close the player"
          onClick={(e) => {
            e.stopPropagation();
            onStop();
          }}
          className="absolute right-3 top-3 flex h-6 w-6 items-center justify-center rounded-md text-text-faint hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
    </aside>
  );
});

function Tag({ children }: { children: string }) {
  return (
    <span className="shrink-0 rounded border border-border-strong bg-text/5 px-1.5 text-[10px] font-bold leading-4 tracking-[0.08em] text-text">
      {children}
    </span>
  );
}
