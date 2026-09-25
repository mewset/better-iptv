import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import MetadataTab from '../../components/settings/MetadataTab';
import type { TmdbStatus } from '../../lib/tauri';

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
  ...extra,
});

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
    ...extra,
  };
  render(<MetadataTab {...props} />);
  return props;
}

describe('MetadataTab', () => {
  beforeEach(() => vi.mocked(checkTmdbKey).mockReset());

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
});
