import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ChannelCard } from '../../components/ChannelCard';
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

describe('live ChannelCard', () => {
  it('shows now and next with times and a progress line', () => {
    const { container } = render(
      <ChannelCard
        channel={ch}
        isPlaying={false}
        onPlay={vi.fn()}
        epg={{
          current: 'Rapport',
          currentStart: iso(-15),
          currentEnd: iso(45),
          next: 'Sport',
          nextStart: iso(45),
        }}
      />
    );
    expect(screen.getByText('Rapport')).toBeInTheDocument();
    expect(screen.getByText('Sport')).toBeInTheDocument();
    expect(container.querySelector('[data-progress]')).not.toBeNull();
  });

  it('renders without EPG: no progress line, no NaN, a quiet placeholder line', () => {
    const { container } = render(<ChannelCard channel={ch} isPlaying={false} onPlay={vi.fn()} />);
    expect(container.querySelector('[data-progress]')).toBeNull();
    expect(container.textContent).not.toMatch(/NaN|undefined/);
    expect(screen.getByText('No guide data')).toBeInTheDocument();
  });

  it('shows the colour-bar placeholder when there is no logo', () => {
    const { container } = render(<ChannelCard channel={ch} isPlaying={false} onPlay={vi.fn()} />);
    expect(container.querySelectorAll('[data-bar]')).toHaveLength(7);
  });

  it('keeps a keyboard-reachable play button', () => {
    const onPlay = vi.fn();
    render(<ChannelCard channel={ch} isPlaying={false} onPlay={onPlay} />);
    fireEvent.click(screen.getByRole('button', { name: 'Play SVT1' }));
    expect(onPlay).toHaveBeenCalledTimes(1);
  });

  it('marks the playing card and offers stop', () => {
    render(<ChannelCard channel={ch} isPlaying onPlay={vi.fn()} />);
    expect(screen.getByText('PLAYING')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Stop SVT1' })).toBeInTheDocument();
  });

  it.each(['lock', 'blur'] as const)(
    'in %s mode asks for the PIN and hides the programme',
    (mode) => {
      const onPlay = vi.fn();
      render(
        <ChannelCard
          channel={ch}
          isPlaying={false}
          onPlay={onPlay}
          isBlocked
          parentalVisibility={mode}
          epg={{ current: 'Secret show' }}
        />
      );
      expect(screen.queryByText('Secret show')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Unlock SVT1 with PIN' }));
      expect(onPlay).toHaveBeenCalledWith(ch);
    }
  );

  it.each(['lock', 'blur'] as const)(
    'in %s mode exposes only the unlock control, not favourite or play',
    (mode) => {
      render(
        <ChannelCard
          channel={ch}
          isPlaying={false}
          onPlay={vi.fn()}
          isBlocked
          parentalVisibility={mode}
        />
      );
      expect(screen.queryByRole('button', { name: 'Play SVT1' })).toBeNull();
      expect(screen.queryByRole('button', { name: /favorites/i })).toBeNull();
      expect(screen.getAllByRole('button')).toHaveLength(1);
      expect(screen.getByRole('button', { name: 'Unlock SVT1 with PIN' })).toBeInTheDocument();
    }
  );
});
