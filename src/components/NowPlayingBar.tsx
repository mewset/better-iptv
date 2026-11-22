import { memo, useState } from 'react';
import { Pause, Play } from 'lucide-react';
import { DockCard, DOCK_ACTION } from './DockCard';
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
      <DockCard
        wide={live}
        art={
          art ? (
            <img
              src={art}
              alt=""
              draggable={false}
              onError={() => (art === poster ? setPosterFailed(poster) : onLogoError())}
              className={`h-full w-full ${live ? 'object-contain p-2' : 'object-cover'}`}
            />
          ) : (
            <ColorBars label={owner.name} />
          )
        }
        tags={[...(paused ? ['PAUSED'] : []), ...(live ? ['LIVE'] : [])]}
        eyebrow={eyebrow}
        detail={detail}
        title={title}
        next={next}
        description={description}
        fraction={fraction}
        left={left}
        quiet={noGuide ? 'No guide for this channel' : null}
        surface={{ label: `Show player: ${title}`, title: 'Show player', onActivate: bringPlayer }}
        action={
          <button
            type="button"
            aria-label={paused ? 'Play' : 'Pause'}
            onClick={(e) => {
              e.stopPropagation();
              togglePause();
            }}
            className={DOCK_ACTION}
          >
            {paused ? (
              <Play className="h-[19px] w-[19px] fill-current" aria-hidden="true" />
            ) : (
              <Pause className="h-[19px] w-[19px] fill-current" aria-hidden="true" />
            )}
          </button>
        }
        closeLabel="Stop playback"
        closeTitle="Close the player"
        onClose={onStop}
      />
    </aside>
  );
});
