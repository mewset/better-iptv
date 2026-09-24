import { useState, useEffect } from 'react';
import { usePlayerStore } from '../stores/player-store';
import { ChevronLeft, Play } from 'lucide-react';
import type { Episode, SeriesInfo } from '../types';
import { logger } from '../lib/logger';

interface SeriesViewProps {
  /** Fetches the series. Must be memoised by the caller: it is an effect dependency. */
  loadSeries: () => Promise<SeriesInfo>;
  onBack: () => void;
  onPlayEpisode: (
    episodeId: string,
    extension: string,
    title: string,
    remainingEpisodes?: Array<{ id: string; title: string; extension: string }>
  ) => void;
}

export default function SeriesView({ loadSeries, onBack, onPlayEpisode }: SeriesViewProps) {
  const { currentSeries, selectedSeason, setCurrentSeries, setSelectedSeason } = usePlayerStore();
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;

    async function loadSeriesInfo() {
      try {
        setIsLoading(true);
        setError('');
        const info = await loadSeries();
        if (cancelled) return;
        setCurrentSeries(info);
        // Auto-select first season
        if (info.seasons.length > 0) {
          setSelectedSeason(info.seasons[0].season_number);
        }
      } catch (err) {
        if (cancelled) return;
        logger.error('Failed to load series info:', err);
        setError(err instanceof Error ? err.message : 'Failed to load series');
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }

    loadSeriesInfo();

    return () => {
      cancelled = true;
      setCurrentSeries(null);
      setSelectedSeason(null);
    };
  }, [loadSeries, setCurrentSeries, setSelectedSeason]);

  if (isLoading) {
    return (
      <div className="flex h-screen flex-col bg-bg">
        <div className="flex flex-1 items-center justify-center">
          <div className="text-center">
            <div className="mx-auto mb-4 h-16 w-16 animate-spin rounded-full border-4 border-accent border-t-transparent"></div>
            <p className="font-medium text-text-muted">Loading series...</p>
          </div>
        </div>
      </div>
    );
  }

  if (error || !currentSeries) {
    return (
      <div className="flex h-screen flex-col bg-bg">
        <div className="flex flex-1 items-center justify-center">
          <div className="text-center">
            <p className="mb-4 font-medium text-danger">{error || 'Failed to load series'}</p>
            <button
              onClick={onBack}
              className="rounded-md bg-accent px-4 py-2 text-on-accent hover:bg-accent-hover"
            >
              Go Back
            </button>
          </div>
        </div>
      </div>
    );
  }

  const selectedSeasonEpisodes = selectedSeason ? currentSeries.episodes[selectedSeason] || [] : [];

  return (
    <div className="flex h-screen flex-col bg-bg">
      {/* Header */}
      <div className="border-b border-border bg-surface p-4">
        <div className="mx-auto max-w-7xl">
          <button
            onClick={onBack}
            className="mb-4 flex items-center gap-2 text-accent-text hover:text-accent-hover"
          >
            <ChevronLeft className="h-5 w-5" aria-hidden="true" />
            Back to Series List
          </button>
          <div className="flex gap-6">
            {currentSeries.info.cover && (
              <img
                src={currentSeries.info.cover}
                alt={currentSeries.info.name}
                className="h-48 w-32 rounded-lg object-cover"
              />
            )}
            <div className="flex-1">
              <h1 className="mb-2 text-3xl font-bold text-text">{currentSeries.info.name}</h1>
              {currentSeries.info.genre && (
                <p className="mb-2 text-sm text-text-muted">{currentSeries.info.genre}</p>
              )}
              {currentSeries.info.plot && (
                <p className="line-clamp-3 text-text-muted">{currentSeries.info.plot}</p>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Season Selector */}
      <div className="border-b border-border bg-surface">
        <div className="mx-auto max-w-7xl px-4">
          <div className="flex gap-2 overflow-x-auto py-4">
            {currentSeries.seasons.map((season) => (
              <button
                key={season.id}
                onClick={() => setSelectedSeason(season.season_number)}
                className={`whitespace-nowrap rounded-md px-4 py-2 font-medium transition-colors ${
                  selectedSeason === season.season_number
                    ? 'bg-accent text-on-accent'
                    : 'bg-surface-2 text-text hover:bg-surface-hover'
                }`}
              >
                {season.name} ({season.episode_count})
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Episode List */}
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-7xl p-4">
          {selectedSeasonEpisodes.length === 0 ? (
            <div className="py-12 text-center">
              <p className="text-text-muted">No episodes available for this season</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {selectedSeasonEpisodes.map((episode, index) => {
                // Get all episodes from current to end of season (for playlist playback)
                const remainingEpisodes = selectedSeasonEpisodes
                  .slice(index) // Start from current episode
                  .sort((a, b) => a.episode_num - b.episode_num) // Sort by episode number
                  .map((ep) => ({
                    id: ep.id,
                    title: ep.title,
                    extension: ep.container_extension,
                  }));

                return (
                  <EpisodeCard
                    key={episode.id}
                    episode={episode}
                    onPlay={() =>
                      onPlayEpisode(
                        episode.id,
                        episode.container_extension,
                        episode.title,
                        remainingEpisodes
                      )
                    }
                  />
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

interface EpisodeCardProps {
  episode: Episode;
  onPlay: () => void;
}

function EpisodeCard({ episode, onPlay }: EpisodeCardProps) {
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-surface shadow-sm transition-shadow hover:shadow-md">
      <div className="relative bg-surface-2">
        {episode.info.movie_image ? (
          <img
            src={episode.info.movie_image}
            alt={episode.title}
            className="h-48 w-full object-cover"
          />
        ) : (
          <div className="flex h-48 w-full items-center justify-center bg-surface-2">
            <span className="text-4xl font-bold text-text-muted">E{episode.episode_num}</span>
          </div>
        )}
      </div>
      <div className="p-3">
        <h3 className="mb-1 line-clamp-2 font-medium text-text">Episode {episode.episode_num}</h3>
        <p className="mb-2 line-clamp-1 text-sm text-text-muted">{episode.title}</p>
        {episode.info.plot && (
          <p className="mb-3 line-clamp-2 text-xs text-text-muted">{episode.info.plot}</p>
        )}
        <button
          onClick={onPlay}
          className="flex w-full items-center justify-center gap-2 rounded-md bg-accent px-4 py-2 font-medium text-on-accent transition-colors hover:bg-accent-hover"
        >
          <Play className="h-4 w-4" aria-hidden="true" />
          Play
        </button>
      </div>
    </div>
  );
}
