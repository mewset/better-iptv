import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import AboutTab from '../../components/settings/AboutTab';
import { usePlayerStore } from '../../stores/player-store';

vi.mock('@tauri-apps/api/app', () => ({ getVersion: vi.fn(async () => '3.3.0') }));
vi.mock('@tauri-apps/api/path', () => ({ appLogDir: vi.fn(async () => '/data/app/logs') }));
vi.mock('@tauri-apps/plugin-opener', () => ({
  openPath: vi.fn(async () => {}),
  openUrl: vi.fn(async () => {}),
}));
import { openPath } from '@tauri-apps/plugin-opener';

describe('AboutTab, Open logs folder', () => {
  beforeEach(() => {
    vi.mocked(openPath).mockReset();
    vi.mocked(openPath).mockResolvedValue();
    usePlayerStore.setState({ toast: null });
  });

  it("opens the app's log folder", async () => {
    render(<AboutTab />);
    fireEvent.click(screen.getByRole('button', { name: 'Open logs folder' }));

    await waitFor(() => expect(openPath).toHaveBeenCalledWith('/data/app/logs'));
    expect(usePlayerStore.getState().toast).toBeNull();
  });

  it('says so when the folder cannot be opened', async () => {
    // What the opener plugin answers for a path outside the capability's scope
    vi.mocked(openPath).mockRejectedValue('Not allowed to open path /data/app/logs');
    render(<AboutTab />);
    fireEvent.click(screen.getByRole('button', { name: 'Open logs folder' }));

    await waitFor(() =>
      expect(usePlayerStore.getState().toast?.message).toBe("Couldn't open the logs folder.")
    );
  });
});
