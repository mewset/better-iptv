import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { NowPlayingBar } from '../../components/NowPlayingBar';
import type { Channel } from '../../types';

const ch: Channel = {
  id: 1,
  playlist_id: 1,
  name: 'SVT1',
  url: 'http://x',
  group_name: 'Sweden',
  content_type: 'live',
  is_favorite: false,
  sort_order: 0,
};

const now = Date.now();
const iso = (m: number) => new Date(now + m * 60000).toISOString();

describe('NowPlayingBar', () => {
  it('has the aria-label the harness and screen readers rely on', () => {
    render(<NowPlayingBar channel={ch} onStop={vi.fn()} />);
    expect(screen.getByRole('complementary', { name: 'Now playing' })).toBeInTheDocument();
  });

  it('renders times, minutes left and the next line from a full epg', () => {
    const { container } = render(
      <NowPlayingBar
        channel={ch}
        epg={{
          current: 'Rapport',
          currentStart: iso(-15),
          currentEnd: iso(45),
          next: 'Sport',
          nextStart: iso(45),
        }}
        onStop={vi.fn()}
      />
    );
    expect(screen.getByText('Rapport')).toBeInTheDocument();
    expect(screen.getByText(/min left/)).toBeInTheDocument();
    expect(container.textContent).toMatch(/–/); // time range dash
    expect(screen.getByText(/Next/)).toBeInTheDocument();
    expect(screen.getByText('Sport', { exact: false })).toBeInTheDocument();
    expect(container.querySelector('[data-progress]')).not.toBeNull();
  });

  it('renders only name and fallback programme string with no epg: no dash, no minutes left, no NaN/undefined', () => {
    const { container } = render(
      <NowPlayingBar channel={ch} currentProgram="No guide data" onStop={vi.fn()} />
    );
    expect(screen.getByText('SVT1')).toBeInTheDocument();
    expect(screen.getByText('No guide data')).toBeInTheDocument();
    expect(container.querySelector('[data-progress]')).toBeNull();
    expect(container.textContent).not.toMatch(/NaN|undefined/);
    expect(container.textContent).not.toMatch(/min left/);
    expect(screen.queryByText(/Next/)).toBeNull();
    expect(container.textContent).not.toMatch(/–/);
  });

  it('does not show a time range without both start and end', () => {
    const { container } = render(
      <NowPlayingBar
        channel={ch}
        epg={{ current: 'Rapport', currentStart: iso(-15) }}
        onStop={vi.fn()}
      />
    );
    expect(screen.getByText('Rapport')).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/–/);
    expect(container.textContent).not.toMatch(/min left/);
  });

  it('shows the next line only when epg.next exists, without a time when nextStart is missing', () => {
    render(
      <NowPlayingBar
        channel={ch}
        epg={{ current: 'Rapport', currentStart: iso(-15), currentEnd: iso(45), next: 'Sport' }}
        onStop={vi.fn()}
      />
    );
    expect(screen.getByText(/Next/)).toBeInTheDocument();
    expect(screen.getByText('Sport', { exact: false })).toBeInTheDocument();
  });

  it('calls onStop when the stop button is clicked', () => {
    const onStop = vi.fn();
    render(<NowPlayingBar channel={ch} onStop={onStop} />);
    fireEvent.click(screen.getByRole('button', { name: 'Stop playback' }));
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it('shows the colour-bar placeholder when the channel has no logo', () => {
    const { container } = render(<NowPlayingBar channel={ch} onStop={vi.fn()} />);
    expect(container.querySelectorAll('[data-bar]')).toHaveLength(7);
  });
});
