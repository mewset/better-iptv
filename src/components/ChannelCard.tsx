import { memo, useState } from 'react';
import { Play, Square, Star, Clapperboard, Lock } from 'lucide-react';
import type { Channel } from '../types';

interface ChannelCardProps {
  channel: Channel;
  /** Whether this channel is currently playing */
  isPlaying: boolean;
  /** Callback when play/stop button is clicked */
  onPlay: (channel: Channel) => void;
  /** Current EPG program title */
  currentProgram?: string;
  /** Next EPG program title */
  nextProgram?: string;
  /** Height of the card in pixels */
  cardHeight: number;
  /** Whether this channel is blocked by parental controls */
  isBlocked?: boolean;
  /** Visibility mode for blocked channels */
  parentalVisibility?: 'hide' | 'lock' | 'blur';
  /** Callback when favorite star is toggled */
  onToggleFavorite?: (channelId: number) => void;
}

/**
 * Channel card component
 *
 * Displays a single channel in the grid with:
 * - Channel logo or initial letter
 * - Favorite indicator
 * - Channel name and group
 * - Current EPG program (for live channels)
 * - Play/Stop/Browse button based on content type
 */
export const ChannelCard = memo(function ChannelCard({
  channel,
  isPlaying,
  onPlay,
  currentProgram,
  nextProgram,
  cardHeight,
  isBlocked = false,
  parentalVisibility = 'hide',
  onToggleFavorite,
}: ChannelCardProps) {
  const [logoFailed, setLogoFailed] = useState(false);

  // Calculate dynamic image height (approximately 45% of card height)
  const imageHeight = Math.max(80, Math.round(cardHeight * 0.45));
  const showLogo = channel.logo && !logoFailed;

  // Scale text and padding based on card height
  const isLarge = cardHeight > 280;
  const isSmall = cardHeight < 220;

  return (
    <div
      className="relative flex flex-col overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm hover:shadow-md dark:border-gray-700 dark:bg-gray-800"
      style={{ height: `${cardHeight}px` }}
    >
      {/* Logo/Image section */}
      <div className="group relative flex-shrink-0 bg-gray-900">
        {showLogo ? (
          <div
            className="flex w-full items-center justify-center bg-gray-900 p-2"
            style={{ height: `${imageHeight}px` }}
          >
            <img
              src={channel.logo!}
              alt={channel.name}
              loading="lazy"
              onError={() => setLogoFailed(true)}
              className="max-h-full max-w-full object-contain"
            />
          </div>
        ) : (
          <div
            className="flex w-full items-center justify-center bg-gradient-to-br from-blue-500 to-purple-600"
            style={{ height: `${imageHeight}px` }}
          >
            <span
              className={`font-bold text-white ${isLarge ? 'text-4xl' : isSmall ? 'text-2xl' : 'text-3xl'}`}
            >
              {channel.name.charAt(0).toUpperCase()}
            </span>
          </div>
        )}
        <button
          type="button"
          aria-label={channel.is_favorite ? 'Remove from favorites' : 'Add to favorites'}
          onClick={(e) => {
            e.stopPropagation();
            onToggleFavorite?.(channel.id);
          }}
          className={`absolute right-2 top-2 rounded-full p-1 transition-opacity ${
            channel.is_favorite
              ? 'bg-yellow-400 opacity-100'
              : 'bg-black/40 opacity-0 hover:bg-black/60 group-hover:opacity-100'
          }`}
        >
          <Star
            className={`${isSmall ? 'h-3 w-3' : 'h-4 w-4'} ${
              channel.is_favorite ? 'fill-white text-white' : 'text-white'
            }`}
          />
        </button>
      </div>

      {/* Content section */}
      <div className={`${isLarge ? 'p-4' : isSmall ? 'p-2' : 'p-3'} flex min-h-0 flex-1 flex-col`}>
        <h3
          className={`truncate font-medium text-gray-900 dark:text-white ${isLarge ? 'text-base' : 'text-sm'}`}
        >
          {channel.name}
        </h3>
        {channel.group_name && (
          <p
            className={`mt-0.5 truncate text-gray-500 dark:text-gray-400 ${isSmall ? 'text-[10px]' : 'text-xs'}`}
          >
            {channel.group_name}
          </p>
        )}
        {currentProgram && channel.content_type === 'live' && (
          <p
            className={`mt-0.5 truncate text-blue-600 dark:text-blue-400 ${isSmall ? 'text-[10px]' : 'text-xs'}`}
            title={currentProgram}
          >
            📺 {currentProgram}
          </p>
        )}
        {nextProgram && channel.content_type === 'live' && (
          <p
            className={`mt-0.5 truncate text-gray-500 dark:text-gray-400 ${isSmall ? 'text-[10px]' : 'text-xs'}`}
            title={nextProgram}
          >
            ⏭ {nextProgram}
          </p>
        )}
        <div className="flex-1" />

        {/* Action button */}
        <button
          onClick={() => onPlay(channel)}
          className={`flex w-full items-center justify-center gap-2 rounded-md font-medium transition-colors ${
            isLarge ? 'mt-3 px-4 py-2.5' : isSmall ? 'mt-2 px-3 py-1.5 text-sm' : 'mt-2 px-4 py-2'
          } ${
            isPlaying
              ? 'bg-red-600 text-white hover:bg-red-700'
              : channel.content_type === 'series'
                ? 'bg-purple-600 text-white hover:bg-purple-700'
                : 'bg-blue-600 text-white hover:bg-blue-700'
          }`}
        >
          {isPlaying ? (
            <>
              <Square className={`${isSmall ? 'h-3 w-3' : 'h-4 w-4'}`} />
              Stop
            </>
          ) : channel.content_type === 'series' ? (
            <>
              <Clapperboard className={`${isSmall ? 'h-3 w-3' : 'h-4 w-4'}`} />
              Browse
            </>
          ) : (
            <>
              <Play className={`${isSmall ? 'h-3 w-3' : 'h-4 w-4'}`} />
              Play
            </>
          )}
        </button>
      </div>

      {/* Parental Controls Overlay */}
      {isBlocked && parentalVisibility !== 'hide' && (
        <div
          onClick={(e) => {
            e.stopPropagation(); // Prevent card click
            onPlay(channel); // Trigger PIN verification
          }}
          className={`absolute inset-0 flex cursor-pointer items-center justify-center transition-opacity hover:opacity-90 ${
            parentalVisibility === 'blur' ? 'bg-black/30 backdrop-blur-md' : 'bg-black/70'
          }`}
          title="Click to unlock with PIN"
        >
          <Lock className="h-12 w-12 text-white drop-shadow-lg" />
        </div>
      )}
    </div>
  );
});

export default ChannelCard;
