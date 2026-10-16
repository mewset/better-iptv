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

  it('reopening refreshes again', async () => {
    const { rerender } = render(<RefreshModal {...props} isOpen={true} />);
    await screen.findByText('Refresh complete');
    expect(refreshPlaylist).toHaveBeenCalledTimes(1);

    rerender(<RefreshModal {...props} isOpen={false} />);
    rerender(<RefreshModal {...props} isOpen={true} />);

    await waitFor(() => expect(refreshPlaylist).toHaveBeenCalledTimes(2));
  });
});
