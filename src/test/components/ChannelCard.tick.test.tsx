import { describe, it, expect, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { ChannelCard } from '../../components/ChannelCard';
import { cardEpg } from '../../lib/epgTime';
import type { NowNext } from '../../lib/epgIpc';
import type { Channel } from '../../types';
import { nowNext, programme } from '../epgFixtures';

// Every render of a card calls its logo hook once: count them per channel.
const renders = vi.hoisted(() => new Map<number, number>());
vi.mock('../../hooks/useChannelLogo', () => ({
  useChannelLogo: (channel: Channel) => {
    renders.set(channel.id, (renders.get(channel.id) ?? 0) + 1);
    return { src: null, onError: () => {} };
  },
}));

const T = Date.parse('2026-10-21T18:00:00Z');
const at = (m: number) => new Date(T + m * 60_000).toISOString();
const ch = (id: number, name: string): Channel => ({
  id,
  name,
  content_type: 'live',
  is_favorite: false,
});

const cards: Array<[Channel, NowNext | undefined]> = [
  [ch(1, 'No guide'), undefined],
  [ch(2, 'Off air'), nowNext(null, programme('Later', at(120), at(180)))],
  // Ten hours long: a 30 s tick moves its progress by 0.08 %.
  [ch(3, 'Long'), nowNext(programme('Marathon', at(-60), at(540)))],
  // One hour long: a 30 s tick moves its progress by 0.8 %.
  [ch(4, 'Short'), nowNext(programme('News', at(-30), at(30)))],
];

// Stable like MainScreen's handlers, so only the guide props can differ.
const onPlay = () => {};
let tick: (now: number) => void = () => {};
function Grid() {
  const [now, setNow] = useState(T);
  tick = setNow;
  return (
    <>
      {cards.map(([channel, entry]) => (
        <ChannelCard
          key={channel.id}
          channel={channel}
          isPlaying={false}
          onPlay={onPlay}
          {...cardEpg(entry, now)}
        />
      ))}
    </>
  );
}

describe('ChannelCard and the 30 s clock', () => {
  it('re-renders only the cards whose output changes', () => {
    render(<Grid />);
    renders.clear();

    act(() => tick(T + 30_000));
    // News went from 50 % to 51 %; nothing else visible moved.
    expect([...renders.keys()]).toEqual([4]);

    renders.clear();
    act(() => tick(T + 31 * 60_000));
    // News has ended and leaves the card, Marathon moved to 15 %.
    expect([...renders.keys()].sort()).toEqual([3, 4]);
    expect(screen.queryByText('News')).toBeNull();
    expect(screen.getByText('Marathon')).toBeInTheDocument();
  });
});
