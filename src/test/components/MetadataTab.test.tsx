import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import MetadataTab from '../../components/settings/MetadataTab';
import type { TmdbStatus } from '../../lib/tauri';
import { TMDB_BACKGROUND_PROGRESS_EVENT, type TmdbBackgroundProgress } from '../../lib/tmdb';

type Handler = (event: { payload: TmdbBackgroundProgress }) => void;
const handlers = new Map<string, Handler>();
const unlisten = vi.fn();
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (name: string, handler: Handler) => {
    handlers.set(name, handler);
    return unlisten;
  }),
}));

vi.mock('../../lib/tauri', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/tauri')>()),
  checkTmdbKey: vi.fn(),
}));
import { checkTmdbKey } from '../../lib/tauri';

const status = (extra: Partial<TmdbStatus> = {}): TmdbStatus => ({
  enabled: true,
  has_user_key: false,
  has_shared_key: true,
  user_key_rejected: false,
  shared_key_rejected: false,
  language: 'en-US',
  background_enrich: false,
  background_progress: null,
  ...extra,
});

const BACKGROUND_LABEL = 'Fetch details for the whole library in the background';

function renderTab(extra: Partial<React.ComponentProps<typeof MetadataTab>> = {}) {
  const props = {
    enabled: true,
    onEnabledChange: vi.fn(),
    apiKey: '',
    onApiKeyChange: vi.fn(),
    language: 'en-US' as const,
    onLanguageChange: vi.fn(),
    status: status(),
    onClearCache: vi.fn(async () => {}),
    backgroundEnrich: false,
    onBackgroundEnrichChange: vi.fn(),
    ...extra,
  };
  const view = render(<MetadataTab {...props} />);
  return { ...props, unmount: view.unmount };
}

describe('MetadataTab', () => {
  beforeEach(() => {
    vi.mocked(checkTmdbKey).mockReset();
    handlers.clear();
    unlisten.mockClear();
  });

  it('shows the toggle, the privacy line, the attribution and the shared-key status', () => {
    renderTab();
    expect(
      screen.getByRole('checkbox', { name: 'Fetch posters and details from TMDB' })
    ).toBeChecked();
    expect(
      screen.getByText(/Titles of your movies and series are sent to TMDB/)
    ).toBeInTheDocument();
    expect(
      screen.getByText('This product uses the TMDB API but is not endorsed or certified by TMDB.')
    ).toBeInTheDocument();
    expect(screen.getByAltText('TMDB')).toBeInTheDocument();
    expect(screen.getByText('Using the shared key')).toBeInTheDocument();
  });

  it('reports the generic line when the shared key was rejected', () => {
    renderTab({ status: status({ shared_key_rejected: true, has_shared_key: false }) });
    expect(
      screen.getByText('Could not fetch TMDB data. Try generating your own key at themoviedb.org.')
    ).toBeInTheDocument();
  });

  it('reports a rejected user key and "Using your key" otherwise', () => {
    renderTab({ apiKey: 'abc', status: status({ has_user_key: true, user_key_rejected: true }) });
    expect(screen.getByText('Key rejected by TMDB')).toBeInTheDocument();
  });

  it('says when no key is available', () => {
    renderTab({ status: status({ has_shared_key: false }) });
    expect(screen.getByText('No key available: add your own')).toBeInTheDocument();
  });

  it('Test validates the typed key and shows the result', async () => {
    vi.mocked(checkTmdbKey).mockResolvedValueOnce(undefined);
    renderTab({ apiKey: 'abc' });
    fireEvent.click(screen.getByRole('button', { name: 'Test' }));
    await waitFor(() => expect(checkTmdbKey).toHaveBeenCalledWith('abc'));
    expect(await screen.findByText('Key works')).toBeInTheDocument();
    vi.mocked(checkTmdbKey).mockRejectedValueOnce(
      'Invalid API key: You must be granted a valid key.'
    );
    fireEvent.click(screen.getByRole('button', { name: 'Test' }));
    expect(await screen.findByText(/Invalid API key/)).toBeInTheDocument();
  });

  it('propagates edits and clears the cache on request', async () => {
    const props = renderTab();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Fetch posters and details from TMDB' }));
    expect(props.onEnabledChange).toHaveBeenCalledWith(false);
    fireEvent.change(screen.getByLabelText('TMDB API key'), { target: { value: 'k' } });
    expect(props.onApiKeyChange).toHaveBeenCalledWith('k');
    fireEvent.change(screen.getByLabelText('Metadata language'), { target: { value: 'sv-SE' } });
    expect(props.onLanguageChange).toHaveBeenCalledWith('sv-SE');
    fireEvent.click(screen.getByRole('button', { name: 'Clear cached metadata' }));
    await waitFor(() => expect(props.onClearCache).toHaveBeenCalled());
    expect(await screen.findByText('Cache cleared')).toBeInTheDocument();
  });

  it('the background toggle is disabled without an own key and says why', () => {
    renderTab();
    const box = screen.getByRole('checkbox', { name: BACKGROUND_LABEL });
    expect(box).toBeDisabled();
    expect(box).not.toBeChecked();
    expect(screen.getByText('Needs your own TMDB API key')).toBeInTheDocument();
    expect(
      screen.queryByText(/Searches TMDB for every movie and series once/)
    ).not.toBeInTheDocument();
  });

  it('the background toggle is enabled with an own key and reports changes', () => {
    const props = renderTab({ apiKey: 'abc', status: status({ has_user_key: true }) });
    const box = screen.getByRole('checkbox', { name: BACKGROUND_LABEL });
    expect(box).toBeEnabled();
    expect(
      screen.getByText(/Searches TMDB for every movie and series once, at a gentle pace/)
    ).toBeInTheDocument();
    expect(screen.queryByText('Needs your own TMDB API key')).not.toBeInTheDocument();
    fireEvent.click(box);
    expect(props.onBackgroundEnrichChange).toHaveBeenCalledWith(true);
  });

  it('shows the progress from the status on open, and nothing before the first scan', () => {
    const { unmount } = renderTab({ apiKey: 'abc', backgroundEnrich: true });
    expect(screen.queryByText(/Fetched \d+ of \d+ titles/)).not.toBeInTheDocument();
    expect(screen.queryByText('Library up to date')).not.toBeInTheDocument();
    unmount();
    renderTab({
      apiKey: 'abc',
      backgroundEnrich: true,
      status: status({
        background_enrich: true,
        background_progress: { done: 12, total: 340, running: true },
      }),
    });
    expect(screen.getByText('Fetched 12 of 340 titles')).toBeInTheDocument();
  });

  it('follows the progress event and unlistens on unmount', async () => {
    const { unmount } = renderTab({
      apiKey: 'abc',
      backgroundEnrich: true,
      status: status({
        background_enrich: true,
        background_progress: { done: 0, total: 3, running: true },
      }),
    });
    await waitFor(() => expect(handlers.has(TMDB_BACKGROUND_PROGRESS_EVENT)).toBe(true));
    act(() => {
      handlers.get(TMDB_BACKGROUND_PROGRESS_EVENT)!({
        payload: { done: 2, total: 3, running: true },
      });
    });
    expect(screen.getByText('Fetched 2 of 3 titles')).toBeInTheDocument();
    act(() => {
      handlers.get(TMDB_BACKGROUND_PROGRESS_EVENT)!({
        payload: { done: 3, total: 3, running: false },
      });
    });
    expect(screen.getByText('Library up to date')).toBeInTheDocument();
    expect(screen.queryByText(/Fetched/)).not.toBeInTheDocument();
    unmount();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });
});
