import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { NowPlayingBar } from '../../components/NowPlayingBar';
import { resetLogoFallbackSession, useLogoFallbackStore } from '../../lib/logoFallback';
import type { Channel } from '../../types';
import { nowNext, programme } from '../epgFixtures';

const ch: Channel = {
  id: 1,
  name: 'SVT1',
  group_name: 'Sweden',
  content_type: 'live',
  is_favorite: false,
};

const now = Date.now();
const iso = (m: number) => new Date(now + m * 60000).toISOString();

describe('NowPlayingBar', () => {
  it('has the aria-label the harness and screen readers rely on', () => {
    render(<NowPlayingBar now={now} channel={ch} onStop={vi.fn()} />);
    expect(screen.getByRole('complementary', { name: 'Now playing' })).toBeInTheDocument();
  });

  it('renders times, minutes left and the next line from a full epg', () => {
    const { container } = render(
      <NowPlayingBar
        now={now}
        channel={ch}
        epg={nowNext(programme('Rapport', iso(-15), iso(45)), programme('Sport', iso(45), iso(75)))}
        onStop={vi.fn()}
      />
    );
    expect(screen.getByText('Rapport')).toBeInTheDocument();
    expect(screen.getByText(/45 min left/)).toBeInTheDocument();
    expect(screen.getByText(/min left/)).toBeInTheDocument();
    expect(container.textContent).toMatch(/–/); // time range dash
    expect(screen.getByText(/Next/)).toBeInTheDocument();
    expect(screen.getByText('Sport', { exact: false })).toBeInTheDocument();
    expect(container.querySelector('[data-progress]')).not.toBeNull();
  });

  it('renders only the name with no epg: no dash, no minutes left, no NaN/undefined', () => {
    const { container } = render(<NowPlayingBar now={now} channel={ch} onStop={vi.fn()} />);
    expect(screen.getByText('SVT1')).toBeInTheDocument();
    expect(screen.queryByText('Off air')).toBeNull();
    expect(container.querySelector('[data-progress]')).toBeNull();
    expect(container.textContent).not.toMatch(/NaN|undefined/);
    expect(container.textContent).not.toMatch(/min left/);
    expect(screen.queryByText(/Next/)).toBeNull();
    expect(container.textContent).not.toMatch(/–/);
  });

  it('shows "Off air" with the next programme when the channel is between broadcasts', () => {
    render(
      <NowPlayingBar
        now={now}
        channel={ch}
        epg={nowNext(null, programme('Spårlöst försvunnen', iso(240), iso(300)))}
        onStop={vi.fn()}
      />
    );
    expect(screen.getByText('Off air')).toBeInTheDocument();
    expect(screen.getByText(/Spårlöst försvunnen/)).toBeInTheDocument();
  });

  it('hides an off-air entry whose next programme has started until the refetch lands', () => {
    render(
      <NowPlayingBar
        now={now}
        channel={ch}
        epg={nowNext(null, programme('Old next', iso(-5), iso(25)))}
        onStop={vi.fn()}
      />
    );
    expect(screen.queryByText('Off air')).toBeNull();
    expect(screen.queryByText(/Old next/)).toBeNull();
  });

  it('does not show a time range when a time cannot be read', () => {
    const { container } = render(
      <NowPlayingBar
        now={now}
        channel={ch}
        epg={nowNext(programme('Rapport', iso(-15), 'not a time'))}
        onStop={vi.fn()}
      />
    );
    expect(screen.getByText('Rapport')).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/–/);
    expect(container.textContent).not.toMatch(/min left|NaN/);
  });

  it('shows the next line only when the entry has a next programme', () => {
    const { rerender } = render(
      <NowPlayingBar
        now={now}
        channel={ch}
        epg={nowNext(programme('Rapport', iso(-15), iso(45)), programme('Sport', iso(45), iso(75)))}
        onStop={vi.fn()}
      />
    );
    expect(screen.getByText(/Next/)).toBeInTheDocument();
    expect(screen.getByText('Sport', { exact: false })).toBeInTheDocument();
    rerender(
      <NowPlayingBar
        channel={ch}
        now={now}
        epg={nowNext(programme('Rapport', iso(-15), iso(45)))}
        onStop={vi.fn()}
      />
    );
    expect(screen.queryByText(/Next/)).toBeNull();
  });

  it('hides an entry whose programme has ended at the time it is given', () => {
    const entry = nowNext(
      programme('Old show', iso(-90), iso(-30)),
      programme('Old next', iso(-30), iso(30))
    );
    const { container } = render(
      <NowPlayingBar now={now} channel={ch} epg={entry} onStop={vi.fn()} />
    );
    expect(screen.queryByText('Old show')).toBeNull();
    expect(screen.queryByText(/Old next/)).toBeNull();
    expect(container.querySelector('[data-progress]')).toBeNull();
    expect(container.textContent).not.toMatch(/min left/);
  });

  it('reads progress and minutes left at the time it is given', () => {
    const entry = nowNext(programme('Rapport', iso(-15), iso(45)));
    const { container, rerender } = render(
      <NowPlayingBar channel={ch} now={now} epg={entry} onStop={vi.fn()} />
    );
    expect(screen.getByText(/45 min left/)).toBeInTheDocument();
    rerender(<NowPlayingBar channel={ch} now={now + 30 * 60000} epg={entry} onStop={vi.fn()} />);
    expect(screen.getByText(/15 min left/)).toBeInTheDocument();
    const bar = container.querySelector('[data-progress] > div') as HTMLElement;
    expect(bar.style.width).toBe('75%');
  });

  it('calls onStop when the stop button is clicked', () => {
    const onStop = vi.fn();
    render(<NowPlayingBar now={now} channel={ch} onStop={onStop} />);
    fireEvent.click(screen.getByRole('button', { name: 'Stop playback' }));
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it('shows the colour-bar placeholder when the channel has no logo', () => {
    const { container } = render(<NowPlayingBar now={now} channel={ch} onStop={vi.fn()} />);
    expect(container.querySelectorAll('[data-bars]')).toHaveLength(1);
  });

  it('resets the failed-logo state when the playing channel changes', () => {
    const chB: Channel = { ...ch, id: 2, name: 'BBC One', logo: 'http://x/bbc.png' };
    const { container, rerender } = render(
      <NowPlayingBar now={now} channel={{ ...ch, logo: 'http://x/svt1.png' }} onStop={vi.fn()} />
    );
    const img = container.querySelector('img');
    expect(img).not.toBeNull();
    fireEvent.error(img!);
    // Channel A's logo failed: falls back to ColorBars.
    expect(container.querySelectorAll('[data-bars]')).toHaveLength(1);

    rerender(<NowPlayingBar now={now} channel={chB} onStop={vi.fn()} />);

    // Channel B has its own logo and never errored: it must render its <img>,
    // not stay stuck on channel A's failed-logo fallback.
    const imgB = container.querySelector('img');
    expect(imgB).not.toBeNull();
    expect(imgB).toHaveAttribute('src', 'http://x/bbc.png');
    expect(container.querySelectorAll('[data-bars]')).toHaveLength(0);
  });

  it('truncates the name, programme and time-range instead of overflowing', () => {
    const { container } = render(
      <NowPlayingBar
        now={now}
        channel={{
          ...ch,
          name: 'An Extremely Long Channel Name That Must Not Blow Out The Dock Layout',
        }}
        epg={nowNext(
          programme(
            'An Equally Long Programme Title That Must Also Not Overflow The Fixed-Height Dock',
            iso(-15),
            iso(45)
          )
        )}
        onStop={vi.fn()}
      />
    );
    const name = screen.getByText(/An Extremely Long Channel Name/);
    const title = screen.getByText(/An Equally Long Programme Title/);
    expect(name.className).toMatch(/truncate/);
    expect(name.className).toMatch(/shrink-0/);
    expect(name.className).toMatch(/max-w-\[40%\]/);
    expect(title.className).toMatch(/truncate/);
    expect(title.className).toMatch(/min-w-0/);
    expect(title.className).toMatch(/flex-1/);
    const timeRange = container.querySelector('[data-time-range]');
    expect(timeRange).not.toBeNull();
    expect(timeRange!.className).toMatch(/shrink-0/);
    // Proportional figures: tabular ones widen the colons to a digit's width.
    expect(timeRange!.textContent).toMatch(/\d:\d/);
    expect(timeRange!.closest('.tabular-nums')).toBeNull();
  });

  it('gives the Stop button a visible-only focus ring', () => {
    render(<NowPlayingBar now={now} channel={ch} onStop={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Stop playback' }).className).toMatch(
      /focus-visible:outline-none/
    );
  });
});

describe('NowPlayingBar logo fallback', () => {
  beforeEach(() => resetLogoFallbackSession());

  it('shows the placeholder after the logo and fallback fail', () => {
    useLogoFallbackStore.getState().merge({ 1: 'https://f/x.png' });
    const { container } = render(
      <NowPlayingBar now={now} channel={{ ...ch, logo: 'https://p/dead.png' }} onStop={vi.fn()} />
    );
    fireEvent.error(container.querySelector('img')!);
    expect(container.querySelector('img')?.getAttribute('src')).toBe('https://f/x.png');
    fireEvent.error(container.querySelector('img')!);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelectorAll('[data-bars]')).toHaveLength(1);
  });
});
