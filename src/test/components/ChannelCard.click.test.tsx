import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ChannelCard } from '../../components/ChannelCard';
import type { Channel } from '../../types';

/**
 * The card body is the click target users reach for.
 *
 * Every other IPTV player plays a channel when you click the channel, so a card
 * whose only live pixel is the Play button reads as broken (issue #55: "no
 * reaction when clicking on channel" — keyboard worked, because Tab lands on
 * the button). Playing must therefore work from anywhere on the card, while the
 * controls layered on top of it keep doing their own job.
 */

const channel: Channel = {
  id: 1,
  playlist_id: 1,
  name: 'SVT1',
  url: 'http://example.test/svt1',
  content_type: 'live',
  is_favorite: false,
  sort_order: 0,
};

function renderCard(props: Partial<React.ComponentProps<typeof ChannelCard>> = {}) {
  const onPlay = vi.fn();
  const onToggleFavorite = vi.fn();
  render(
    <ChannelCard
      channel={channel}
      isPlaying={false}
      onPlay={onPlay}
      cardHeight={280}
      onToggleFavorite={onToggleFavorite}
      {...props}
    />
  );
  return { onPlay, onToggleFavorite };
}

describe('ChannelCard click targets', () => {
  it('plays the channel when the card body is clicked', () => {
    const { onPlay } = renderCard();

    fireEvent.click(screen.getByText('SVT1'));

    expect(onPlay).toHaveBeenCalledWith(channel);
  });

  it('plays the channel exactly once when the Play button is clicked', () => {
    const { onPlay } = renderCard();

    fireEvent.click(screen.getByRole('button', { name: /play/i }));

    // The button sits inside the clickable card: without stopPropagation the
    // click would fire onPlay twice, and the second call would toggle playback
    // straight back off.
    expect(onPlay).toHaveBeenCalledTimes(1);
  });

  it('does not play the channel when the favorite star is clicked', () => {
    const { onPlay, onToggleFavorite } = renderCard();

    fireEvent.click(screen.getByRole('button', { name: /add to favorites/i }));

    expect(onToggleFavorite).toHaveBeenCalledWith(1);
    expect(onPlay).not.toHaveBeenCalled();
  });

  it('keeps the Play button as the only focusable way to play', () => {
    renderCard();

    // The card body is a mouse shortcut, not a second control: giving it its
    // own role/tabIndex would nest buttons inside a button and add a third tab
    // stop to every card in a 10,000-channel list.
    const buttons = screen.getAllByRole('button');
    expect(buttons.map((b) => b.getAttribute('aria-label') ?? b.textContent)).toEqual([
      'Add to favorites',
      'Play',
    ]);
  });
});
