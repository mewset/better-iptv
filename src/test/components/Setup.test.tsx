import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import Setup from '../../components/Setup';
import { usePlayerStore } from '../../stores/player-store';
import { checkMpvInstalled } from '../../lib/tauri';
import { openUrl } from '@tauri-apps/plugin-opener';

vi.mock('../../lib/tauri', () => ({
  checkMpvInstalled: vi.fn(),
  importPlaylist: vi.fn(),
  importXtreamPlaylist: vi.fn(),
  getChannels: vi.fn(async () => []),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => {}),
}));

vi.mock('@tauri-apps/plugin-opener', () => ({
  openUrl: vi.fn(async () => {}),
}));

describe('Setup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    usePlayerStore.setState({ isLoading: false });
  });

  it('shows "MPV found" when checkMpvInstalled resolves true', async () => {
    vi.mocked(checkMpvInstalled).mockResolvedValue(true);

    render(<Setup />);

    expect(await screen.findByText('MPV found')).toBeInTheDocument();
    expect(screen.queryByText('MPV not found')).not.toBeInTheDocument();
  });

  it('shows "MPV not found" when checkMpvInstalled resolves false', async () => {
    vi.mocked(checkMpvInstalled).mockResolvedValue(false);

    render(<Setup />);

    expect(await screen.findByText('MPV not found')).toBeInTheDocument();
    expect(screen.queryByText('MPV found')).not.toBeInTheDocument();
  });

  it('treats a rejected MPV check as "not found" instead of crashing', async () => {
    vi.mocked(checkMpvInstalled).mockRejectedValue(new Error('no backend'));

    render(<Setup />);

    expect(await screen.findByText('MPV not found')).toBeInTheDocument();
  });

  it('calls openUrl with the MPV install page when the install link is clicked', async () => {
    vi.mocked(checkMpvInstalled).mockResolvedValue(false);

    render(<Setup />);

    const link = await screen.findByRole('button', { name: 'How to install MPV' });
    fireEvent.click(link);

    expect(openUrl).toHaveBeenCalledWith('https://mpv.io/installation/');
  });

  it('switches to the Xtream fields when the segmented control is switched', async () => {
    vi.mocked(checkMpvInstalled).mockResolvedValue(true);

    render(<Setup />);

    expect(screen.queryByLabelText('Server URL')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'Xtream Codes' }));

    expect(screen.getByLabelText('Server URL')).toBeInTheDocument();
    expect(screen.getByLabelText('Username')).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
  });

  it('names the submit button "Import playlist"', async () => {
    vi.mocked(checkMpvInstalled).mockResolvedValue(true);

    render(<Setup />);

    expect(await screen.findByRole('button', { name: 'Import playlist' })).toBeInTheDocument();
  });

  it('shows a validation error without importing when the playlist name is missing', async () => {
    vi.mocked(checkMpvInstalled).mockResolvedValue(true);

    render(<Setup />);

    fireEvent.submit(screen.getByRole('button', { name: 'Import playlist' }).closest('form')!);

    expect(await screen.findByText('Please enter a playlist name')).toBeInTheDocument();
  });

  it('shows profile-specific copy in the overlay (onCancel) mode, not the first-launch heading', async () => {
    vi.mocked(checkMpvInstalled).mockResolvedValue(true);

    render(<Setup onCancel={vi.fn()} />);

    expect(await screen.findByText('Add a profile')).toBeInTheDocument();
    expect(screen.queryByText('Add your first playlist')).not.toBeInTheDocument();
  });

  it('switches to the Xtream tab with ArrowRight from the M3U tab', async () => {
    vi.mocked(checkMpvInstalled).mockResolvedValue(true);

    render(<Setup />);

    const m3uTab = screen.getByRole('tab', { name: 'M3U URL' });
    const xtreamTab = screen.getByRole('tab', { name: 'Xtream Codes' });

    expect(m3uTab).toHaveAttribute('tabIndex', '0');
    expect(xtreamTab).toHaveAttribute('tabIndex', '-1');

    fireEvent.keyDown(m3uTab, { key: 'ArrowRight' });

    expect(xtreamTab).toHaveAttribute('aria-selected', 'true');
    expect(xtreamTab).toHaveAttribute('tabIndex', '0');
    expect(m3uTab).toHaveAttribute('tabIndex', '-1');
    expect(screen.getByLabelText('Server URL')).toBeInTheDocument();
  });
});
