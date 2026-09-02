import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import SeriesView from '../../components/SeriesView';
import type { Episode, SeriesInfo } from '../../types';

/**
 * SeriesView no longer knows where series data comes from. Xtream profiles
 * hand it a loader that calls the provider API; M3U profiles hand it one
 * that reads the locally grouped episodes. The view must render whatever
 * SeriesInfo comes back and report episode ids untouched.
 */

function episode(id: string, season: number, num: number, title: string): Episode {
  return {
    id,
    episode_num: num,
    title,
    container_extension: 'mp4',
    season,
    info: {},
  };
}

const info: SeriesInfo = {
  info: { name: 'Breaking Bad' },
  seasons: [
    { id: '1', name: 'Season 1', season_number: '1', episode_count: 2 },
    { id: '2', name: 'Season 2', season_number: '2', episode_count: 1 },
  ],
  episodes: {
    '1': [episode('11', 1, 1, 'Pilot'), episode('12', 1, 2, "Cat's in the Bag")],
    '2': [episode('21', 2, 1, 'Seven Thirty-Seven')],
  },
};

function renderView(loadSeries = vi.fn().mockResolvedValue(info)) {
  const onPlayEpisode = vi.fn();
  const onBack = vi.fn();
  render(<SeriesView loadSeries={loadSeries} onBack={onBack} onPlayEpisode={onPlayEpisode} />);
  return { loadSeries, onPlayEpisode, onBack };
}

describe('SeriesView', () => {
  it('renders the series returned by the loader with the first season selected', async () => {
    const { loadSeries } = renderView();

    expect(await screen.findByRole('heading', { name: 'Breaking Bad' })).toBeInTheDocument();
    expect(loadSeries).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Season 1 (2)' })).toBeInTheDocument();
    expect(screen.getByText('Pilot')).toBeInTheDocument();
    expect(screen.queryByText('Seven Thirty-Seven')).not.toBeInTheDocument();
  });

  it('plays the clicked episode and the rest of its season, in order', async () => {
    const { onPlayEpisode } = renderView();
    await screen.findByText('Pilot');

    fireEvent.click(screen.getAllByRole('button', { name: /^play$/i })[0]);

    expect(onPlayEpisode).toHaveBeenCalledWith('11', 'mp4', 'Pilot', [
      { id: '11', title: 'Pilot', extension: 'mp4' },
      { id: '12', title: "Cat's in the Bag", extension: 'mp4' },
    ]);
  });

  it('switches seasons', async () => {
    renderView();
    await screen.findByText('Pilot');

    fireEvent.click(screen.getByRole('button', { name: 'Season 2 (1)' }));

    expect(screen.getByText('Seven Thirty-Seven')).toBeInTheDocument();
    expect(screen.queryByText('Pilot')).not.toBeInTheDocument();
  });

  it('shows the loader error and offers a way back', async () => {
    const { onBack } = renderView(vi.fn().mockRejectedValue(new Error('Series not found')));

    expect(await screen.findByText('Series not found')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /go back/i }));
    expect(onBack).toHaveBeenCalled();
  });
});
