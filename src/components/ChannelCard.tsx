import { memo, useState } from 'react';
import { Play, Square, Star, Lock } from 'lucide-react';
import type { Channel } from '../types';
import type { EpgEntry } from '../stores/player-store';
import { formatClock, progressPercent } from '../lib/epgTime';
import { ColorBars } from './ColorBars';

interface ChannelCardProps {
  channel: Channel;
  /** Whether this channel is currently playing */
  isPlaying: boolean;
  /** Callback when play/stop button is clicked */
  onPlay: (channel: Channel) => void;
  /** Current/next EPG program for this channel, if any */
  epg?: EpgEntry;
  /** Whether this channel is blocked by parental controls */
  isBlocked?: boolean;
  /** Visibility mode for blocked channels */
  parentalVisibility?: 'hide' | 'lock' | 'blur';
  /** Callback when favorite star is toggled */
  onToggleFavorite?: (channelId: number) => void;
}

/**
 * Live-shaped channel card.
 *
 * A fixed 208px shape: a 124px logo/artwork area (logo image, ColorBars
 * placeholder, playing pill, favourite star, centred play button and a
 * progress line) above an info block (name, group, now/next EPG or a quiet
 * "No guide data" line). Series and VOD items shown in a live-shaped grid
 * (Favorites) reuse this same card with their artwork.
 */
export const ChannelCard = memo(function ChannelCard({
  channel,
  isPlaying,
  onPlay,
  epg,
  isBlocked = false,
  parentalVisibility = 'hide',
  onToggleFavorite,
}: ChannelCardProps) {
  const [logoFailed, setLogoFailed] = useState(false);
  const showLogo = Boolean(channel.logo) && !logoFailed;
  const blocked = isBlocked && parentalVisibility !== 'hide';

  const pct =
    epg?.currentStart && epg?.currentEnd ? progressPercent(epg.currentStart, epg.currentEnd) : null;
  const nowTime = epg?.currentStart ? formatClock(epg.currentStart) : '';
  const nextTime = epg?.nextStart ? formatClock(epg.nextStart) : '';

  return (
    // The whole card plays the channel, because that is what every other IPTV
    // player does and what users reach for (issue #55). The card is a mouse
    // shortcut rather than a control of its own: no role or tabIndex, so it
    // neither nests a button inside a button nor adds a third tab stop to every
    // card in a 10,000-channel list. The centred Play button is the keyboard
    // and screen-reader path, and the controls layered on top stop propagation.
    <article
      onClick={() => onPlay(channel)}
      className={`group relative flex h-[208px] cursor-pointer flex-col overflow-hidden rounded-[14px] bg-surface ${
        isPlaying ? 'border-[1.5px] border-accent' : 'border border-border'
      }`}
    >
      {/* Logo/artwork area */}
      <div className="relative flex h-[124px] items-center justify-center bg-surface-2">
        {showLogo ? (
          <img
            src={channel.logo!}
            alt={channel.name}
            loading="lazy"
            decoding="async"
            // Images are draggable by default, and a click that starts with a
            // few pixels of drag becomes a drag gesture that never fires a
            // click - on the logo, the largest target on the card.
            draggable={false}
            onError={() => setLogoFailed(true)}
            className="max-h-full max-w-full object-contain p-3"
          />
        ) : (
          <ColorBars label={channel.name} />
        )}

        {isPlaying && (
          <span className="absolute left-2 top-2 rounded-full bg-accent px-2 py-0.5 text-[11px] font-bold text-on-accent">
            PLAYING
          </span>
        )}

        <button
          type="button"
          aria-label={channel.is_favorite ? 'Remove from favorites' : 'Add to favorites'}
          onClick={(e) => {
            e.stopPropagation();
            onToggleFavorite?.(channel.id);
          }}
          className={`absolute right-2 top-2 flex h-[30px] w-[30px] items-center justify-center rounded-full bg-black/35 transition-opacity focus-visible:ring-2 focus-visible:ring-accent ${
            channel.is_favorite
              ? 'opacity-100'
              : 'opacity-0 focus-visible:opacity-100 group-hover:opacity-100'
          }`}
        >
          <Star
            className={`h-4 w-4 ${
              channel.is_favorite ? 'fill-current text-accent-text' : 'text-[#F2F2F0]/55'
            }`}
            aria-hidden="true"
          />
        </button>

        <button
          type="button"
          aria-label={isPlaying ? `Stop ${channel.name}` : `Play ${channel.name}`}
          onClick={(e) => {
            e.stopPropagation();
            onPlay(channel);
          }}
          className="absolute left-1/2 top-1/2 flex h-11 w-11 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-accent text-on-accent opacity-0 transition-opacity focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-accent group-hover:opacity-100"
        >
          {isPlaying ? (
            <Square className="h-4 w-4" aria-hidden="true" />
          ) : (
            <Play className="h-4 w-4" aria-hidden="true" />
          )}
        </button>

        {pct !== null && (
          <div data-progress className="absolute inset-x-0 bottom-0 h-[3px] bg-text/10">
            <div className="h-full bg-accent" style={{ width: `${pct}%` }} />
          </div>
        )}
      </div>

      {/* Info block */}
      <div className="flex flex-col gap-[5px] px-3.5 pb-3.5 pt-3">
        <div className="flex items-baseline justify-between gap-2">
          <span className="min-w-0 flex-1 truncate text-sm font-semibold text-text">
            {channel.name}
          </span>
          {channel.group_name && (
            <span className="shrink-0 truncate text-[11px] text-text-faint">
              {channel.group_name}
            </span>
          )}
        </div>

        {blocked ? (
          <p className="truncate text-xs text-text-faint">
            {channel.group_name ? `${channel.group_name} · Locked` : 'Locked'}
          </p>
        ) : epg?.current ? (
          <>
            <div className="flex items-baseline gap-1.5">
              {nowTime && (
                <span className="font-semibold tabular-nums text-accent-text">{nowTime}</span>
              )}
              <span className="truncate text-[13px] text-text">{epg.current}</span>
            </div>
            {epg.next && (
              <div className="flex items-baseline gap-1.5">
                {nextTime && <span className="text-text-faint">{nextTime}</span>}
                <span className="truncate text-xs text-text-faint">{epg.next}</span>
              </div>
            )}
          </>
        ) : (
          <p className="text-xs text-text-faint">No guide data</p>
        )}
      </div>

      {blocked && (
        <button
          type="button"
          aria-label={`Unlock ${channel.name} with PIN`}
          onClick={(e) => {
            e.stopPropagation();
            onPlay(channel);
          }}
          className={`absolute inset-0 flex flex-col items-center justify-center gap-2 text-text focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent ${
            parentalVisibility === 'blur' ? 'bg-bg/55 backdrop-blur-md' : 'bg-bg/80'
          }`}
        >
          <Lock className="h-7 w-7" aria-hidden="true" />
          <span className="text-xs font-semibold text-text">Enter PIN to watch</span>
        </button>
      )}
    </article>
  );
});

export default ChannelCard;
