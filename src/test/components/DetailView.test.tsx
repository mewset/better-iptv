import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import DetailView from '../../components/DetailView';
import { usePlayerStore } from '../../stores/player-store';
import type { Channel, Episode, SeriesInfo } from '../../types';
import type { TmdbDetails } from '../../lib/tauri';

vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn(async () => {}) }));
vi.mock('../../lib/tauri', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/tauri')>()),
  getTmdbDetails: vi.fn(),
  getTmdbSeason: vi.fn(async () => []),
}));
import { getTmdbDetails, getTmdbSeason } from '../../lib/tauri';
import { openUrl } from '@tauri-apps/plugin-opener';

const movie: Channel = {
  id: 9,
  playlist_id: 1,
  name: 'Shutter Island (2010)',
  url: 'http://x/9.mkv',
  group_name: 'Thriller',
  logo: 'http://img/logo.jpg',
  content_type: 'vod',
  is_favorite: false,
  sort_order: 0,
};
const series: Channel = {
  ...movie,
  id: 10,
  name: 'Breaking Bad',
  content_type: 'series',
  url: 'http://x/series/10.mkv',
};

const matched: TmdbDetails = {
  available: true,
  matched: true,
  manual: false,
  tmdb_id: 11324,
  title: 'Shutter Island',
  original_title: 'Shutter Island',
  year: 2010,
  rating: 8.2,
  poster_url: 'https://image.tmdb.org/t/p/w780/p.jpg',
  backdrop_url: 'https://image.tmdb.org/t/p/w1280/b.jpg',
  overview: 'A marshal investigates.',
  runtime_minutes: 138,
  genres: ['Drama', 'Thriller'],
  cast: [{ name: 'Leonardo DiCaprio', character: 'Teddy Daniels', photo_url: null }],
  trailer_url: 'https://www.youtube.com/watch?v=qdPw9x9h5CY',
};
const unmatched: TmdbDetails = {
  ...matched,
  matched: false,
  tmdb_id: null,
  title: null,
  overview: null,
  cast: [],
  trailer_url: null,
  genres: [],
};
const off: TmdbDetails = { ...unmatched, available: false };

function episode(id: string, season: number, num: number, title: string): Episode {
  return { id, episode_num: num, title, container_extension: 'mp4', season, info: {} };
}
const info: SeriesInfo = {
  info: { name: 'Breaking Bad', plot: 'Chemistry teacher.' },
  seasons: [
    { id: '1', name: 'Season 1', season_number: '1', episode_count: 2 },
    { id: '2', name: 'Season 2', season_number: '2', episode_count: 1 },
  ],
  episodes: {
    '1': [episode('11', 1, 1, 'Pilot'), episode('12', 1, 2, "Cat's in the Bag")],
    '2': [episode('21', 2, 1, 'Seven Thirty-Seven')],
  },
};

function renderMovie(
  details: TmdbDetails,
  extra: Partial<React.ComponentProps<typeof DetailView>> = {}
) {
  vi.mocked(getTmdbDetails).mockResolvedValue(details);
  const props = {
    channel: movie,
    onBack: vi.fn(),
    onPlay: vi.fn(),
    onPlayEpisode: vi.fn(),
    onToggleFavorite: vi.fn(),
    isPlaying: false,
    ...extra,
  };
  render(<DetailView {...props} />);
  return props;
}

describe('DetailView for a movie', () => {
  beforeEach(() => {
    vi.mocked(getTmdbDetails).mockReset();
    vi.mocked(getTmdbSeason).mockClear();
    usePlayerStore.setState({ currentSeries: null, selectedSeason: null });
  });

  it('shows provider data at once and TMDB data when it arrives', async () => {
    renderMovie(matched);
    expect(
      screen.getByRole('heading', { level: 1, name: 'Shutter Island (2010)' })
    ).toBeInTheDocument();
    expect(await screen.findByText('A marshal investigates.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Shutter Island' })).toBeInTheDocument();
    expect(screen.getByText('2010 · Drama, Thriller · 138 min · ★ 8.2')).toBeInTheDocument();
    expect(screen.getByText('Leonardo DiCaprio')).toBeInTheDocument();
    expect(screen.getByText('Teddy Daniels')).toBeInTheDocument();
    expect(screen.getByText('MOVIE · Thriller')).toBeInTheDocument();
  });

  it('plays, opens the trailer in the browser and toggles the favourite', async () => {
    const props = renderMovie(matched);
    await screen.findByText('A marshal investigates.');
    fireEvent.click(screen.getByRole('button', { name: 'Play' }));
    expect(props.onPlay).toHaveBeenCalledWith(movie);
    fireEvent.click(screen.getByRole('button', { name: 'Trailer' }));
    expect(openUrl).toHaveBeenCalledWith(matched.trailer_url);
    fireEvent.click(screen.getByRole('button', { name: 'Add to favorites' }));
    expect(props.onToggleFavorite).toHaveBeenCalledWith(9);
  });

  it('offers "Wrong title?" only when a handler is given and TMDB is available', async () => {
    const onFixMatch = vi.fn();
    renderMovie(matched, { onFixMatch });
    await screen.findByText('A marshal investigates.');
    fireEvent.click(screen.getByRole('button', { name: 'Wrong title?' }));
    expect(onFixMatch).toHaveBeenCalledWith(movie, matched);
  });

  it('shows "Find on TMDB" for an unmatched title and nothing TMDB-related when off', async () => {
    const onFixMatch = vi.fn();
    renderMovie(unmatched, { onFixMatch });
    expect(await screen.findByRole('button', { name: 'Find on TMDB' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Trailer' })).not.toBeInTheDocument();
  });

  it('renders provider data only when TMDB is off', async () => {
    renderMovie(off, { onFixMatch: vi.fn() });
    await waitFor(() => expect(getTmdbDetails).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: /TMDB|Wrong title/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Play' })).toBeInTheDocument();
  });

  it('survives a failing TMDB lookup', async () => {
    vi.mocked(getTmdbDetails).mockRejectedValue(new Error('offline'));
    render(
      <DetailView
        channel={movie}
        onBack={vi.fn()}
        onPlay={vi.fn()}
        onPlayEpisode={vi.fn()}
        onToggleFavorite={vi.fn()}
        isPlaying={false}
      />
    );
    expect(await screen.findByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Play' })).toBeInTheDocument();
  });
});

describe('DetailView for a series', () => {
  beforeEach(() => {
    vi.mocked(getTmdbDetails).mockReset();
    vi.mocked(getTmdbSeason).mockReset();
    vi.mocked(getTmdbSeason).mockResolvedValue([]);
    usePlayerStore.setState({ currentSeries: null, selectedSeason: null });
  });

  function renderSeries(
    loadSeries = vi.fn().mockResolvedValue(info),
    details: TmdbDetails = unmatched
  ) {
    vi.mocked(getTmdbDetails).mockResolvedValue(details);
    const onPlayEpisode = vi.fn();
    const onBack = vi.fn();
    render(
      <DetailView
        channel={series}
        loadSeries={loadSeries}
        onBack={onBack}
        onPlay={vi.fn()}
        onPlayEpisode={onPlayEpisode}
        onToggleFavorite={vi.fn()}
        isPlaying={false}
      />
    );
    return { loadSeries, onPlayEpisode, onBack };
  }

  it('loads the series with the first season selected and lists its episodes', async () => {
    const { loadSeries } = renderSeries();
    expect(await screen.findByText('Pilot')).toBeInTheDocument();
    expect(loadSeries).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('tab', { name: 'Season 1' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByText('Seven Thirty-Seven')).not.toBeInTheDocument();
    expect(screen.getByText('Chemistry teacher.')).toBeInTheDocument();
  });

  it('Play S1 E1 and an episode row both pass the remaining episodes in order', async () => {
    const { onPlayEpisode } = renderSeries();
    await screen.findByText('Pilot');
    fireEvent.click(screen.getByRole('button', { name: 'Play S1 E1' }));
    expect(onPlayEpisode).toHaveBeenLastCalledWith('11', 'mp4', 'Pilot', [
      { id: '11', title: 'Pilot', extension: 'mp4' },
      { id: '12', title: "Cat's in the Bag", extension: 'mp4' },
    ]);
    fireEvent.click(screen.getByRole('button', { name: "Play Cat's in the Bag" }));
    expect(onPlayEpisode).toHaveBeenLastCalledWith('12', 'mp4', "Cat's in the Bag", [
      { id: '12', title: "Cat's in the Bag", extension: 'mp4' },
    ]);
  });

  it('switches seasons', async () => {
    renderSeries();
    await screen.findByText('Pilot');
    fireEvent.click(screen.getByRole('tab', { name: 'Season 2' }));
    expect(screen.getByText('Seven Thirty-Seven')).toBeInTheDocument();
    expect(screen.queryByText('Pilot')).not.toBeInTheDocument();
  });

  it('fills missing episode plot and thumbnail from TMDB for a matched series', async () => {
    vi.mocked(getTmdbSeason).mockResolvedValue([
      {
        season: 1,
        episode: 1,
        title: 'Pilot',
        overview: 'Walter starts cooking.',
        still_url: 'https://image.tmdb.org/t/p/w342/s.jpg',
        runtime_minutes: 58,
        air_date: '2008-01-20',
      },
    ]);
    renderSeries(vi.fn().mockResolvedValue(info), { ...matched, title: 'Breaking Bad' });
    expect(await screen.findByText('Walter starts cooking.')).toBeInTheDocument();
    expect(screen.getByText('58 min')).toBeInTheDocument();
    await waitFor(() => expect(getTmdbSeason).toHaveBeenCalledWith(10, 1));
  });

  it('shows the loader error and offers a way back', async () => {
    const { onBack } = renderSeries(vi.fn().mockRejectedValue(new Error('Series not found')));
    expect(await screen.findByText('Series not found')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Go back' }));
    expect(onBack).toHaveBeenCalled();
  });
});
