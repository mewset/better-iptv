import { useEffect, useMemo, useState } from 'react';
import { ChevronLeft, Play, Star, Clapperboard, RefreshCw, Search } from 'lucide-react';
import { openUrl } from '@tauri-apps/plugin-opener';
import { usePlayerStore } from '../stores/player-store';
import { getTmdbDetails, getTmdbSeason, type TmdbDetails, type TmdbEpisode } from '../lib/tauri';
import type { Channel, Episode, SeriesInfo } from '../types';
import { ColorBars } from './ColorBars';
import { logger } from '../lib/logger';

interface DetailViewProps {
  channel: Channel;
  /** Series only. Must be memoised by the caller: it is an effect dependency. */
  loadSeries?: () => Promise<SeriesInfo>;
  onBack: () => void;
  onPlay: (channel: Channel) => void;
  onPlayEpisode: (
    episodeId: string,
    extension: string,
    title: string,
    remainingEpisodes?: Array<{ id: string; title: string; extension: string }>
  ) => void;
  onToggleFavorite: (channelId: number) => void;
  isPlaying: boolean;
  /** Opens the manual re-match flow. Absent: the button is not shown. */
  onFixMatch?: (channel: Channel, details: TmdbDetails) => void;
  /** Called whenever details are (re)loaded, so the grid card can follow. */
  onDetails?: (details: TmdbDetails) => void;
  /** Details chosen in the re-match modal (Task 12); applied whenever it changes. */
  detailsOverride?: TmdbDetails | null;
}

type RemainingEpisode = { id: string; title: string; extension: string };

function byEpisodeNumber(a: Episode, b: Episode): number {
  return a.episode_num - b.episode_num;
}

function remainingFrom(episodes: Episode[], index: number): RemainingEpisode[] {
  return episodes
    .slice(index)
    .sort(byEpisodeNumber)
    .map((ep) => ({ id: ep.id, title: ep.title, extension: ep.container_extension }));
}

/** "2010 · Drama, Thriller · 138 min · ★ 8.2" from whatever is known. */
function metaRow(d: TmdbDetails | null, fallbackYear?: string): string {
  const parts = [
    d?.year ? String(d.year) : (fallbackYear ?? null),
    d && d.genres.length > 0 ? d.genres.slice(0, 3).join(', ') : null,
    d?.runtime_minutes ? `${d.runtime_minutes} min` : null,
    d?.rating != null ? `★ ${d.rating.toFixed(1)}` : null,
  ].filter(Boolean);
  return parts.join(' · ');
}

/**
 * Full-screen title view for movies and series (canvas board 3). Provider
 * data renders at once; TMDB details layer on top when they arrive. Series
 * keep the season/episode flow of the old series view, with TMDB filling gaps in
 * the episode rows.
 */
export default function DetailView({
  channel,
  loadSeries,
  onBack,
  onPlay,
  onPlayEpisode,
  onToggleFavorite,
  isPlaying,
  onFixMatch,
  onDetails,
  detailsOverride = null,
}: DetailViewProps) {
  const isSeries = channel.content_type === 'series';
  // The channel prop is a snapshot; favourite state lives in the store.
  const isFavorite = usePlayerStore(
    (s) => s.channels.find((c) => c.id === channel.id)?.is_favorite ?? channel.is_favorite
  );

  // ----- TMDB details -----
  const [details, setDetails] = useState<TmdbDetails | null>(null);
  const [tmdbEpisodes, setTmdbEpisodes] = useState<Map<string, TmdbEpisode[]>>(new Map());
  const [detailsState, setDetailsState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setDetailsState('loading');
    getTmdbDetails(channel.id)
      .then((d) => {
        if (cancelled) return;
        setDetails(d);
        setDetailsState('ready');
        onDetails?.(d);
      })
      .catch((err) => {
        if (cancelled) return;
        logger.debug('TMDB details failed:', err);
        setDetailsState('error');
      });
    return () => {
      cancelled = true;
    };
    // onDetails is intentionally not a dependency: the parent passes a new
    // closure each render, and re-fetching on that would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel.id, attempt]);

  // A manual re-match (Task 12) arrives through this prop.
  useEffect(() => {
    if (!detailsOverride) return;
    setDetails(detailsOverride);
    setDetailsState('ready');
    setTmdbEpisodes(new Map());
    onDetails?.(detailsOverride);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detailsOverride]);

  // ----- series data (provider seasons and episodes) -----
  const { currentSeries, selectedSeason, setCurrentSeries, setSelectedSeason } = usePlayerStore();
  const [seriesLoading, setSeriesLoading] = useState(isSeries);
  const [seriesError, setSeriesError] = useState('');
  useEffect(() => {
    if (!isSeries || !loadSeries) return;
    let cancelled = false;
    (async () => {
      try {
        setSeriesLoading(true);
        setSeriesError('');
        const info = await loadSeries();
        if (cancelled) return;
        setCurrentSeries(info);
        if (info.seasons.length > 0) setSelectedSeason(info.seasons[0].season_number);
      } catch (err) {
        if (cancelled) return;
        logger.error('Failed to load series info:', err);
        setSeriesError(err instanceof Error ? err.message : 'Failed to load series');
      } finally {
        if (!cancelled) setSeriesLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      setCurrentSeries(null);
      setSelectedSeason(null);
    };
  }, [isSeries, loadSeries, setCurrentSeries, setSelectedSeason]);

  // TMDB episodes for the selected season of a matched series.
  useEffect(() => {
    if (!isSeries || !details?.matched || !selectedSeason || tmdbEpisodes.has(selectedSeason)) {
      return;
    }
    let cancelled = false;
    const season = selectedSeason;
    getTmdbSeason(channel.id, Number(season))
      .then((eps) => {
        if (cancelled) return;
        setTmdbEpisodes((prev) => new Map(prev).set(season, eps));
      })
      .catch((err) => logger.debug('TMDB season failed:', err));
    return () => {
      cancelled = true;
    };
  }, [isSeries, details?.matched, selectedSeason, channel.id, tmdbEpisodes]);

  // Episodes of the selected season in episode order.
  const seasonEpisodes = useMemo(
    () =>
      selectedSeason && currentSeries
        ? [...(currentSeries.episodes[selectedSeason] ?? [])].sort(byEpisodeNumber)
        : [],
    [selectedSeason, currentSeries]
  );
  const tmdbBySeasonEpisode = useMemo(() => {
    const map = new Map<number, TmdbEpisode>();
    for (const e of tmdbEpisodes.get(selectedSeason ?? '') ?? []) map.set(e.episode, e);
    return map;
  }, [tmdbEpisodes, selectedSeason]);

  const providerPlot = isSeries ? currentSeries?.info.plot : undefined;
  const providerCover = isSeries ? (currentSeries?.info.cover ?? channel.logo) : channel.logo;
  // `matched && !title` means a manual pick whose detail fetch failed: keep
  // the provider title but leave the TMDB affordances in place.
  const title = details?.matched && details.title ? details.title : channel.name;
  const overview = details?.overview ?? providerPlot ?? '';
  const poster = details?.poster_url ?? providerCover ?? null;
  const backdrop = details?.backdrop_url ?? null;
  const eyebrow = `${isSeries ? 'SERIES' : 'MOVIE'}${channel.group_name ? ` · ${channel.group_name}` : ''}`;
  const meta = metaRow(
    details,
    isSeries ? currentSeries?.info.releaseDate?.slice(0, 4) : undefined
  );
  const tmdbOn = details?.available ?? false;
  const firstEpisode = seasonEpisodes[0];

  const playFirst = () => {
    if (!firstEpisode) return;
    onPlayEpisode(
      firstEpisode.id,
      firstEpisode.container_extension,
      firstEpisode.title,
      remainingFrom(seasonEpisodes, 0)
    );
  };

  if (isSeries && seriesError) {
    return (
      <div className="flex h-full min-h-0 flex-1 items-center justify-center bg-bg">
        <div className="text-center">
          <p className="mb-4 font-medium text-danger">{seriesError}</p>
          <button
            onClick={onBack}
            className="rounded-md bg-accent px-4 py-2 text-on-accent hover:bg-accent-hover"
          >
            Go back
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-y-auto bg-bg pb-32">
      {/* Backdrop band */}
      <div className="relative h-[280px] shrink-0 overflow-hidden bg-surface-2">
        {backdrop ? (
          <img
            src={backdrop}
            alt=""
            aria-hidden="true"
            draggable={false}
            className="h-full w-full object-cover"
          />
        ) : poster ? (
          <img
            src={poster}
            alt=""
            aria-hidden="true"
            draggable={false}
            className="h-full w-full scale-110 object-cover opacity-30 blur-2xl"
          />
        ) : (
          <ColorBars label={channel.name} />
        )}
        {/* The one allowed gradient: a bottom scrim so the header reads over the art. */}
        <div
          aria-hidden="true"
          className="absolute inset-0 bg-gradient-to-t from-bg via-bg/40 to-transparent"
        />
        <button
          type="button"
          onClick={onBack}
          aria-label="Back"
          className="absolute left-10 top-6 flex items-center gap-1 rounded-lg bg-bg/60 px-3 py-2 text-sm text-text hover:bg-bg/80 focus-visible:ring-2 focus-visible:ring-accent"
        >
          <ChevronLeft className="h-4 w-4" aria-hidden="true" />
          Back
        </button>
      </div>

      {/* Header */}
      <div className="relative -mt-24 flex gap-8 px-10">
        <div className="relative h-[300px] w-[200px] shrink-0 overflow-hidden rounded-xl border border-border bg-surface-2">
          {poster ? (
            <img
              src={poster}
              alt={title}
              draggable={false}
              className="h-full w-full object-cover"
            />
          ) : (
            <ColorBars label={channel.name} />
          )}
        </div>
        <div className="flex min-w-0 flex-1 flex-col justify-end gap-3 pb-2">
          <span className="text-xs font-bold tracking-[0.12em] text-accent-text">{eyebrow}</span>
          <h1 className="font-display text-[40px] font-bold leading-none text-text">{title}</h1>
          {meta && <p className="text-[13px] text-text-muted">{meta}</p>}
          <div className="flex flex-wrap items-center gap-2 pt-1">
            {isSeries ? (
              <button
                type="button"
                onClick={playFirst}
                disabled={!firstEpisode}
                className="flex h-11 items-center gap-2 rounded-xl bg-accent px-5 font-bold text-on-accent focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50"
              >
                <Play className="h-4 w-4" aria-hidden="true" />
                {selectedSeason
                  ? `Play S${selectedSeason} E${firstEpisode?.episode_num ?? 1}`
                  : 'Play'}
              </button>
            ) : (
              <button
                type="button"
                onClick={() => onPlay(channel)}
                disabled={isPlaying}
                className="flex h-11 items-center gap-2 rounded-xl bg-accent px-5 font-bold text-on-accent focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-default"
              >
                {!isPlaying && <Play className="h-4 w-4" aria-hidden="true" />}
                {isPlaying ? 'Playing' : 'Play'}
              </button>
            )}
            {details?.trailer_url && (
              <button
                type="button"
                onClick={() =>
                  openUrl(details.trailer_url!).catch((err) =>
                    logger.warn('Failed to open trailer:', err)
                  )
                }
                className="flex h-11 items-center gap-2 rounded-xl border border-border-strong px-4 font-semibold text-text hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-accent"
              >
                <Clapperboard className="h-4 w-4" aria-hidden="true" />
                Trailer
              </button>
            )}
            <button
              type="button"
              aria-label={isFavorite ? 'Remove from favorites' : 'Add to favorites'}
              onClick={() => onToggleFavorite(channel.id)}
              className="flex h-11 w-11 items-center justify-center rounded-xl border border-border-strong hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-accent"
            >
              <Star
                className={`h-5 w-5 ${isFavorite ? 'fill-current text-accent-text' : 'text-text-muted'}`}
                aria-hidden="true"
              />
            </button>
            {onFixMatch && tmdbOn && details && (
              <button
                type="button"
                onClick={() => onFixMatch(channel, details)}
                className="flex h-11 items-center gap-2 rounded-xl px-3 text-sm text-text-muted hover:text-text focus-visible:ring-2 focus-visible:ring-accent"
              >
                <Search className="h-4 w-4" aria-hidden="true" />
                {details.matched ? 'Wrong title?' : 'Find on TMDB'}
              </button>
            )}
            {detailsState === 'error' && (
              <button
                type="button"
                onClick={() => setAttempt((n) => n + 1)}
                className="flex h-11 items-center gap-2 rounded-xl px-3 text-sm text-text-muted hover:text-text focus-visible:ring-2 focus-visible:ring-accent"
              >
                <RefreshCw className="h-4 w-4" aria-hidden="true" />
                Retry
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Overview */}
      {detailsState === 'loading' && !overview ? (
        <div
          className="mx-10 mt-8 h-16 max-w-[720px] animate-pulse rounded-lg bg-surface-2"
          aria-label="Loading details"
        />
      ) : (
        overview && (
          <p className="mx-10 mt-8 max-w-[720px] text-pretty leading-relaxed text-text-muted">
            {overview}
          </p>
        )
      )}

      {/* Cast */}
      {details && details.cast.length > 0 && (
        <section aria-label="Cast" className="mt-8 px-10">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-text-faint">
            Cast
          </h2>
          <ul className="flex gap-4 overflow-x-auto pb-2">
            {details.cast.map((member) => (
              <li key={`${member.name}-${member.character ?? ''}`} className="w-[110px] shrink-0">
                <div className="mb-2 h-[110px] w-[110px] overflow-hidden rounded-full bg-surface-2">
                  {member.photo_url && (
                    <img
                      src={member.photo_url}
                      alt=""
                      draggable={false}
                      className="h-full w-full object-cover"
                    />
                  )}
                </div>
                <p className="truncate text-sm font-semibold text-text">{member.name}</p>
                {member.character && (
                  <p className="truncate text-xs text-text-muted">{member.character}</p>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Seasons and episodes */}
      {isSeries && (
        <section aria-label="Episodes" className="mt-8 px-10">
          {seriesLoading ? (
            <p className="text-text-muted">Loading episodes…</p>
          ) : (
            <>
              <div
                role="tablist"
                aria-label="Seasons"
                className="mb-4 flex gap-1 overflow-x-auto rounded-xl bg-surface-2 p-1"
              >
                {currentSeries?.seasons.map((season) => {
                  const active = selectedSeason === season.season_number;
                  return (
                    <button
                      key={season.id}
                      type="button"
                      role="tab"
                      aria-selected={active}
                      onClick={() => setSelectedSeason(season.season_number)}
                      className={`whitespace-nowrap rounded-lg px-4 py-2 text-sm font-semibold transition-colors ${
                        active ? 'bg-accent text-on-accent' : 'text-text-muted hover:text-text'
                      }`}
                    >
                      {season.name}
                    </button>
                  );
                })}
              </div>
              {seasonEpisodes.length === 0 ? (
                <p className="py-8 text-center text-text-muted">
                  No episodes available for this season
                </p>
              ) : (
                <ul className="flex flex-col gap-2">
                  {seasonEpisodes.map((episode, index) => {
                    const tmdbEp = tmdbBySeasonEpisode.get(episode.episode_num);
                    const thumb = episode.info.movie_image ?? tmdbEp?.still_url ?? null;
                    const epTitle =
                      episode.title || tmdbEp?.title || `Episode ${episode.episode_num}`;
                    const plot = episode.info.plot ?? tmdbEp?.overview ?? null;
                    const duration =
                      episode.info.duration ??
                      (tmdbEp?.runtime_minutes ? `${tmdbEp.runtime_minutes} min` : null);
                    return (
                      <li
                        key={episode.id}
                        className="flex items-center gap-4 rounded-xl border border-border bg-surface p-3"
                      >
                        <div className="h-[90px] w-[160px] shrink-0 overflow-hidden rounded-lg bg-surface-2">
                          {thumb ? (
                            <img
                              src={thumb}
                              alt=""
                              draggable={false}
                              className="h-full w-full object-cover"
                            />
                          ) : (
                            <div className="flex h-full items-center justify-center text-lg font-bold text-text-faint">
                              E{episode.episode_num}
                            </div>
                          )}
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="truncate font-semibold text-text">
                            <span className="text-text-faint">{episode.episode_num}.</span>{' '}
                            {epTitle}
                          </p>
                          {duration && <p className="text-xs text-text-muted">{duration}</p>}
                          {plot && (
                            <p className="mt-1 line-clamp-2 text-sm text-text-muted">{plot}</p>
                          )}
                        </div>
                        <button
                          type="button"
                          aria-label={`Play ${epTitle}`}
                          onClick={() =>
                            onPlayEpisode(
                              episode.id,
                              episode.container_extension,
                              episode.title,
                              remainingFrom(seasonEpisodes, index)
                            )
                          }
                          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-accent text-on-accent focus-visible:ring-2 focus-visible:ring-accent"
                        >
                          <Play className="h-4 w-4" aria-hidden="true" />
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </>
          )}
        </section>
      )}
    </div>
  );
}
