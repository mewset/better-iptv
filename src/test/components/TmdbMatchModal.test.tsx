import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import TmdbMatchModal from '../../components/modals/TmdbMatchModal';
import type { Channel } from '../../types';
import type { TmdbDetails } from '../../lib/tauri';

vi.mock('../../lib/tauri', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/tauri')>()),
  searchTmdb: vi.fn(),
  setTmdbMatch: vi.fn(),
}));
import { searchTmdb, setTmdbMatch } from '../../lib/tauri';

const movie: Channel = {
  id: 9,
  name: 'Shuter Island',
  content_type: 'vod',
  is_favorite: false,
};
const details = { available: true, matched: true, manual: true, tmdb_id: 11324 } as TmdbDetails;

describe('TmdbMatchModal', () => {
  beforeEach(() => {
    vi.mocked(searchTmdb).mockReset();
    vi.mocked(setTmdbMatch).mockReset();
    vi.mocked(searchTmdb).mockResolvedValue([
      {
        tmdb_id: 11324,
        title: 'Shutter Island',
        original_title: 'Shutter Island',
        year: 2010,
        poster_url: null,
        overview: 'A marshal.',
      },
      {
        tmdb_id: 4313,
        title: 'Huset fullt',
        original_title: 'Full House',
        year: 1987,
        poster_url: null,
        overview: null,
      },
    ]);
    vi.mocked(setTmdbMatch).mockResolvedValue(details);
  });

  it('searches the initial query on open and lists the candidates', async () => {
    render(
      <TmdbMatchModal
        isOpen
        channel={movie}
        initialQuery="Shuter Island"
        onClose={vi.fn()}
        onMatched={vi.fn()}
      />
    );
    await waitFor(() => expect(searchTmdb).toHaveBeenCalledWith('Shuter Island', 'vod'));
    expect(await screen.findByText('Shutter Island')).toBeInTheDocument();
    expect(screen.getByText('Huset fullt (Full House)')).toBeInTheDocument();
    expect(screen.getByText('2010')).toBeInTheDocument();
  });

  it('re-runs the search from the field', async () => {
    render(
      <TmdbMatchModal
        isOpen
        channel={movie}
        initialQuery="Shuter Island"
        onClose={vi.fn()}
        onMatched={vi.fn()}
      />
    );
    await screen.findByText('Shutter Island');
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'Dune' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() => expect(searchTmdb).toHaveBeenLastCalledWith('Dune', 'vod'));
  });

  it('Use this stores the pick and reports the details', async () => {
    const onMatched = vi.fn();
    const onClose = vi.fn();
    render(
      <TmdbMatchModal
        isOpen
        channel={movie}
        initialQuery="Shuter Island"
        onClose={onClose}
        onMatched={onMatched}
      />
    );
    fireEvent.click((await screen.findAllByRole('button', { name: /^Use this/ }))[0]);
    await waitFor(() => expect(setTmdbMatch).toHaveBeenCalledWith(9, 11324));
    expect(onMatched).toHaveBeenCalledWith(details);
    expect(onClose).toHaveBeenCalled();
  });

  it('Not on TMDB stores a manual no-match', async () => {
    const onMatched = vi.fn();
    render(
      <TmdbMatchModal
        isOpen
        channel={movie}
        initialQuery="Shuter Island"
        onClose={vi.fn()}
        onMatched={onMatched}
      />
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Not on TMDB' }));
    await waitFor(() => expect(setTmdbMatch).toHaveBeenCalledWith(9, null));
    expect(onMatched).toHaveBeenCalled();
  });

  it('shows an empty state and the error from a failed search', async () => {
    vi.mocked(searchTmdb).mockResolvedValueOnce([]);
    const { rerender } = render(
      <TmdbMatchModal
        isOpen
        channel={movie}
        initialQuery="zzz"
        onClose={vi.fn()}
        onMatched={vi.fn()}
      />
    );
    expect(await screen.findByText('No titles found')).toBeInTheDocument();
    vi.mocked(searchTmdb).mockRejectedValueOnce(new Error('offline'));
    rerender(
      <TmdbMatchModal
        isOpen
        channel={movie}
        initialQuery="zzz"
        onClose={vi.fn()}
        onMatched={vi.fn()}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByText(/offline/)).toBeInTheDocument();
  });

  it('renders nothing while closed', () => {
    const { container } = render(
      <TmdbMatchModal
        isOpen={false}
        channel={movie}
        initialQuery="x"
        onClose={vi.fn()}
        onMatched={vi.fn()}
      />
    );
    expect(container).toBeEmptyDOMElement();
    expect(searchTmdb).not.toHaveBeenCalled();
  });
});
