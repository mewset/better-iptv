import { StrictMode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import RefreshModal from '../../components/modals/RefreshModal';

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

vi.mock('../../lib/tauri', () => ({
  refreshPlaylist: vi.fn(),
}));

import { refreshPlaylist } from '../../lib/tauri';

const props = { onClose: vi.fn(), playlistId: 1, playlistName: 'Home' };

describe('RefreshModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(refreshPlaylist).mockResolvedValue({ added: 1, updated: 0, removed: 0 } as never);
  });

  it('starts one refresh under StrictMode', async () => {
    render(
      <StrictMode>
        <RefreshModal {...props} isOpen={true} />
      </StrictMode>
    );
    await screen.findByText('Refresh complete');
    expect(refreshPlaylist).toHaveBeenCalledTimes(1);
  });

  it('names the outcome in its heading, and says it once', async () => {
    render(<RefreshModal {...props} isOpen={true} />);
    // The heading and the line under it both said "Refresh complete"
    expect(await screen.findByRole('dialog', { name: 'Refresh complete' })).toBeInTheDocument();
    expect(screen.getAllByText('Refresh complete')).toHaveLength(1);
    expect(screen.getByText('"Home" is up to date')).toBeInTheDocument();
  });

  it('says "Refresh failed" in the heading when the refresh failed', async () => {
    // It kept saying "Refreshing playlist" over the error
    vi.mocked(refreshPlaylist).mockRejectedValue({ code: 'Http', details: 'no answer' } as never);
    render(<RefreshModal {...props} isOpen={true} />);
    expect(await screen.findByRole('dialog', { name: 'Refresh failed' })).toBeInTheDocument();
    expect(screen.getByText(/Failed to refresh playlist: no answer/)).toBeInTheDocument();
    expect(screen.queryByText('Refreshing playlist')).not.toBeInTheDocument();
  });

  it('reopening refreshes again', async () => {
    const { rerender } = render(<RefreshModal {...props} isOpen={true} />);
    await screen.findByText('Refresh complete');
    expect(refreshPlaylist).toHaveBeenCalledTimes(1);

    rerender(<RefreshModal {...props} isOpen={false} />);
    rerender(<RefreshModal {...props} isOpen={true} />);

    await waitFor(() => expect(refreshPlaylist).toHaveBeenCalledTimes(2));
  });

  it('does not show the previous result while a reopened dialog refreshes again', async () => {
    const { rerender } = render(<RefreshModal {...props} isOpen={true} />);
    await screen.findByText('Refresh complete');

    // The second refresh stays pending, so only a stale result could be on screen
    vi.mocked(refreshPlaylist).mockReturnValueOnce(new Promise(() => {}) as never);

    rerender(<RefreshModal {...props} isOpen={false} />);
    rerender(<RefreshModal {...props} isOpen={true} />);

    await waitFor(() => expect(refreshPlaylist).toHaveBeenCalledTimes(2));
    expect(screen.getByText('Refreshing "Home"...')).toBeInTheDocument();
    expect(screen.queryByText('Refresh complete')).not.toBeInTheDocument();
    expect(screen.queryByText('New')).not.toBeInTheDocument();
  });

  it("shows the backend's sentence when the refresh is refused, not raw JSON", async () => {
    vi.mocked(refreshPlaylist).mockRejectedValue({
      code: 'Http',
      details: 'The provider did not answer. Check the address.',
    });
    render(<RefreshModal {...props} isOpen={true} />);
    expect(
      await screen.findByText(
        'Failed to refresh playlist: The provider did not answer. Check the address.'
      )
    ).toBeInTheDocument();
  });
});
