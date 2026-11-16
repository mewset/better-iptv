import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronLeft,
  Play,
  Star,
  Clapperboard,
  RefreshCw,
  Search,
  Check,
  RotateCcw,
} from 'lucide-react';
import { openUrl } from '@tauri-apps/plugin-opener';
import { usePlayerStore } from '../stores/player-store';
import {
  getTmdbDetails,
  getTmdbSeason,
  type TmdbDetails,
  type TmdbEpisode,
  type WatchProgress,
} from '../lib/tauri';
import type { Channel, Episode, SeriesInfo } from '../types';
import { ColorBars } from './ColorBars';
import { logger } from '../lib/logger';
import { errorText } from '../lib/errorText';
import { useProgressStore } from '../stores/progress-store';
import { queueFrom as seriesQueueFrom } from '../lib/seriesQueue';
import {
  finaleOf,
  formatPosition,
  nextUp,
  progressFraction,
  progressKey,
  resumeSecs,
} from '../lib/watchProgress';
import { cleanEpisodeTitle } from '../lib/episodeTitle';

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
    remainingEpisodes?: Array<{ id: string; title: string; extension: string }>,
    startSecs?: number
  ) => void;
  onToggleFavorite: (channelId: number, currentValue?: boolean) => void;
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
/** A thin amber bar of how far through a title is. */
function ProgressBar({ fraction, className = '' }: { fraction: number; className?: string }) {
  return (
    <span
      role="progressbar"
      aria-label="Watched"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(fraction * 100)}
      className={`block h-1 overflow-hidden rounded-full bg-text/20 ${className}`}
    >
      <span className="block h-full bg-accent" style={{ width: `${fraction * 100}%` }} />
    </span>
  );
}

/** On an episode's thumbnail: how far it got (the watched mark is the row's button). */
function EpisodeProgress({ progress }: { progress: WatchProgress | undefined }) {
  if (!progress || progress.watched) return null;
  const fraction = progressFraction(progress);
  if (fraction <= 0) return null;
  return <ProgressBar fraction={fraction} className="absolute inset-x-0 bottom-0 rounded-none" />;
}

function WatchedToggle({
  watched,
  title,
  onChange,
}: {
  watched: boolean;
  title: string;
  onChange: (watched: boolean) => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={watched}
      aria-label={watched ? `${title}: watched` : `Mark ${title} as watched`}
      title={watched ? 'Watched: click to unmark' : 'Mark as watched'}
      onClick={() => onChange(!watched)}
      className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border focus-visible:ring-2 focus-visible:ring-accent ${
        watched
          ? 'border-accent text-accent-text'
          : 'border-border-strong text-text-faint hover:text-text'
      }`}
    >
      <Check className="h-4 w-4" aria-hidden="true" />
    </button>
  );
}

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
  // A title not in the store yet (library still loading) may have a pending toggle.
  const isFavorite = usePlayerStore(
    (s) =>
      s.channels.find((c) => c.id === channel.id)?.is_favorite ??
      s.pendingFavorites.get(channel.id) ??
      channel.is_favorite
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
  // The URLs that failed to load, not flags: a changed URL gets a fresh try
  // without an effect. A failed backdrop falls back to the blurred poster; a
  // failed poster shows the ColorBars placeholder in the band and the frame.
  const [failedBackdrop, setFailedBackdrop] = useState<string | null>(null);
  const [failedPoster, setFailedPoster] = useState<string | null>(null);
  // Bumped by "Try again" after a failed load, like `attempt` for the details.
  const [seriesAttempt, setSeriesAttempt] = useState(0);
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
        useProgressStore.getState().setFinale(channel.id, finaleOf(info));
        // Open on the first season that has episodes: panels often list a
        // "Season 0" (specials) or upcoming seasons with nothing to play.
        const firstPlayable =
          info.seasons.find((s) => (info.episodes[s.season_number]?.length ?? 0) > 0) ??
          info.seasons[0];
        // Open on the season being watched, if any
        const up = nextUp(info, channel.id, useProgressStore.getState().index);
        if (up && up.kind !== 'start') setSelectedSeason(up.season);
        else if (firstPlayable) setSelectedSeason(firstPlayable.season_number);
      } catch (err) {
        if (cancelled) return;
        logger.error('Failed to load series info:', err);
        setSeriesError(errorText(err));
      } finally {
        if (!cancelled) setSeriesLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      setCurrentSeries(null);
      setSelectedSeason(null);
    };
    // channel.id only seeds the season; a new channel brings a new loadSeries
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSeries, loadSeries, seriesAttempt, setCurrentSeries, setSelectedSeason]);

  // The view takes the focus when it opens, and again when the failed screen
  // and the title swap places: the grid that held the focus is unmounted, and
  // without this Tab would start over from the top of the page. On the scroll
  // container, so the arrow keys scroll it and the next Tab is its first button.
  const viewRef = useRef<HTMLDivElement>(null);
  const seriesFailed = isSeries && seriesError !== '';
  useEffect(() => {
    viewRef.current?.focus({ preventScroll: true });
  }, [seriesFailed]);

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
  const backdropOk = backdrop !== null && backdrop !== failedBackdrop;
  const posterOk = poster !== null && poster !== failedPoster;
  const eyebrow = `${isSeries ? 'SERIES' : 'MOVIE'}${channel.group_name ? ` · ${channel.group_name}` : ''}`;
  const meta = metaRow(
    details,
    isSeries ? currentSeries?.info.releaseDate?.slice(0, 4) : undefined
  );
  const tmdbOn = details?.available ?? false;

  // The title an episode's row shows, which is also what the dock shows while
  // it plays: the provider's own title is often empty.
  // The episode's own name: providers often prefix it with the series and
  // its code ("Absentia - S01E01 - Comeback"), which this view already shows.
  const seriesNames = [channel.name, currentSeries?.info.name ?? '', title];
  const shownTitle = (episode: Episode): string =>
    cleanEpisodeTitle(episode.title, seriesNames) ||
    tmdbBySeasonEpisode.get(episode.episode_num)?.title ||
    `Episode ${episode.episode_num}`;
  // Playback keeps the provider's full title (the player shows it without the
  // series around it), as the rest of the queue does (`remainingFrom`).
  const playTitle = (episode: Episode): string => episode.title || shownTitle(episode);
  // Watch progress: episodes keyed by the series' channel, films by their own
  const progress = useProgressStore((s) => s.index);
  const setWatched = useProgressStore((s) => s.setWatched);
  const setEpisodesWatched = useProgressStore((s) => s.setEpisodesWatched);
  const episodeProgress = (episode: Episode) =>
    progress.byKey.get(progressKey(channel.id, episode.id));
  // An episode left part-way picks up there
  // The player gets this episode, then the rest of the series in viewing
  // order (into the next seasons), each titled "S2 E5 · Name" for its title
  // and episode list (lib/seriesQueue.ts)
  const queueFrom = (episode: Episode): RemainingEpisode[] =>
    currentSeries ? seriesQueueFrom(currentSeries, episode.id, shownTitle) : [];
  const playEpisodeIn = (episodes: Episode[], index: number) => {
    const episode = episodes[index];
    if (!episode) return;
    const queue = queueFrom(episode);
    onPlayEpisode(
      episode.id,
      episode.container_extension,
      playTitle(episode),
      queue.length > 0 ? queue : remainingFrom(episodes, index),
      resumeSecs(episodeProgress(episode))
    );
  };
  const playFrom = (index: number) => playEpisodeIn(seasonEpisodes, index);
  const seasonWatched =
    seasonEpisodes.length > 0 && seasonEpisodes.every((e) => episodeProgress(e)?.watched);
  // A series' Play carries on: the episode left part-way, the first unwatched
  // one after the last watched, or the first
  const up = isSeries && currentSeries ? nextUp(currentSeries, channel.id, progress) : null;
  const playUp = () => {
    if (!up || !currentSeries) return;
    const episodes = [...(currentSeries.episodes[up.season] ?? [])].sort(byEpisodeNumber);
    setSelectedSeason(up.season);
    playEpisodeIn(
      episodes,
      episodes.findIndex((e) => e.id === up.episode.id)
    );
  };
  const upLabel = up
    ? `${up.kind === 'resume' ? 'Resume' : 'Play'} S${up.season} E${up.episode.episode_num}`
    : 'Play';
  const filmProgress = isSeries ? undefined : progress.byKey.get(progressKey(channel.id));
  const filmResume = resumeSecs(filmProgress);
  const filmWatched = filmProgress?.watched ?? false;

  if (seriesFailed) {
    return (
      <div
        ref={viewRef}
        tabIndex={-1}
        className="flex h-full min-h-0 flex-1 items-center justify-center bg-bg outline-none"
      >
        <div className="text-center">
          <p className="mb-4 font-medium text-danger">{seriesError}</p>
          <div className="flex justify-center gap-2">
            <button
              type="button"
              onClick={() => setSeriesAttempt((n) => n + 1)}
              className="rounded-md bg-accent px-4 py-2 text-on-accent hover:bg-accent-hover focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
            >
              Try again
            </button>
            <button
              type="button"
              onClick={onBack}
              className="rounded-md border border-border-strong px-4 py-2 text-text hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-accent"
            >
              Go back
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={viewRef}
      tabIndex={-1}
      className="flex h-full min-h-0 flex-1 flex-col overflow-y-auto bg-bg pb-32 outline-none"
    >
      {/* Backdrop band */}
      <div className="relative h-[280px] shrink-0 overflow-hidden bg-surface-2">
        {backdrop && backdropOk ? (
          <img
            src={backdrop}
            alt=""
            aria-hidden="true"
            draggable={false}
            onError={() => setFailedBackdrop(backdrop)}
            className="h-full w-full object-cover"
          />
        ) : poster && posterOk ? (
          <img
            src={poster}
            alt=""
            aria-hidden="true"
            draggable={false}
            onError={() => setFailedPoster(poster)}
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
          {posterOk ? (
            <img
              src={poster}
              alt={title}
              draggable={false}
              onError={() => setFailedPoster(poster)}
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
          {filmResume !== undefined && filmProgress && (
            <div className="flex max-w-sm items-center gap-3 text-xs text-text-muted">
              <ProgressBar fraction={progressFraction(filmProgress)} className="flex-1" />
              {Math.max(1, Math.round((filmProgress.duration_secs - filmResume) / 60))} min left
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2 pt-1">
            {isSeries ? (
              <button
                type="button"
                onClick={playUp}
                disabled={!up}
                className="flex h-11 items-center gap-2 rounded-xl bg-accent px-5 font-bold text-on-accent focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50"
              >
                <Play className="h-4 w-4" aria-hidden="true" />
                {upLabel}
                {up?.resumeSecs !== undefined && (
                  <span className="font-medium opacity-80">· {formatPosition(up.resumeSecs)}</span>
                )}
              </button>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => onPlay(channel)}
                  disabled={isPlaying}
                  className="flex h-11 items-center gap-2 rounded-xl bg-accent px-5 font-bold text-on-accent focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-default"
                >
                  {!isPlaying && <Play className="h-4 w-4" aria-hidden="true" />}
                  {isPlaying
                    ? 'Playing'
                    : filmResume !== undefined
                      ? `Resume from ${formatPosition(filmResume)}`
                      : 'Play'}
                </button>
                {filmResume !== undefined && !isPlaying && (
                  // Forgets the position, so the film plays from the start
                  <button
                    type="button"
                    onClick={() =>
                      void setWatched(channel.id, null, false).then(() => onPlay(channel))
                    }
                    className="flex h-11 items-center gap-2 rounded-xl border border-border-strong px-4 font-semibold text-text hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-accent"
                  >
                    <RotateCcw className="h-4 w-4" aria-hidden="true" />
                    Start over
                  </button>
                )}
              </>
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
              onClick={() => onToggleFavorite(channel.id, isFavorite)}
              className="flex h-11 w-11 items-center justify-center rounded-xl border border-border-strong hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-accent"
            >
              <Star
                className={`h-5 w-5 ${isFavorite ? 'fill-current text-accent-text' : 'text-text-muted'}`}
                aria-hidden="true"
              />
            </button>
            {!isSeries && (
              <button
                type="button"
                aria-pressed={filmWatched}
                aria-label={filmWatched ? 'Watched' : 'Mark as watched'}
                title={filmWatched ? 'Watched: click to unmark' : 'Mark as watched'}
                onClick={() => void setWatched(channel.id, null, !filmWatched)}
                className={`flex h-11 w-11 items-center justify-center rounded-xl border hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-accent ${
                  filmWatched
                    ? 'border-accent text-accent-text'
                    : 'border-border-strong text-text-muted'
                }`}
              >
                <Check className="h-5 w-5" aria-hidden="true" />
              </button>
            )}
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
              <div className="mb-4 flex items-start gap-3">
                <div
                  role="tablist"
                  aria-label="Seasons"
                  className="flex min-w-0 flex-1 gap-1 overflow-x-auto rounded-xl bg-surface-2 p-1"
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
                {seasonEpisodes.length > 0 && (
                  // The whole season at once: marks every episode, or clears
                  // them all when every one is already watched
                  <button
                    type="button"
                    onClick={() =>
                      void setEpisodesWatched(
                        channel.id,
                        seasonEpisodes.map((e) => e.id),
                        !seasonWatched
                      )
                    }
                    className="flex h-11 shrink-0 items-center gap-2 rounded-xl px-3 text-sm font-medium text-text-muted hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                  >
                    <Check className="h-4 w-4" aria-hidden="true" />
                    {seasonWatched ? 'Mark season unwatched' : 'Mark season watched'}
                  </button>
                )}
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
                    const epTitle = shownTitle(episode);
                    const plot = episode.info.plot ?? tmdbEp?.overview ?? null;
                    const duration =
                      episode.info.duration ??
                      (tmdbEp?.runtime_minutes ? `${tmdbEp.runtime_minutes} min` : null);
                    return (
                      <li
                        key={episode.id}
                        className="flex items-center gap-4 rounded-xl border border-border bg-surface p-3"
                      >
                        <div className="relative h-[90px] w-[160px] shrink-0 overflow-hidden rounded-lg bg-surface-2">
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
                          <EpisodeProgress progress={episodeProgress(episode)} />
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
                        <WatchedToggle
                          watched={episodeProgress(episode)?.watched ?? false}
                          title={epTitle}
                          onChange={(watched) => void setWatched(channel.id, episode.id, watched)}
                        />
                        <button
                          type="button"
                          aria-label={`Play ${epTitle}`}
                          onClick={() => playFrom(index)}
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
