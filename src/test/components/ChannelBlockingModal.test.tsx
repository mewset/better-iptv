import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ChannelBlockingModal from '../../components/modals/ChannelBlockingModal';
import { setBlockedChannels } from '../../lib/tauri';
import type { Channel } from '../../types';

vi.mock('../../lib/tauri', () => ({
  setBlockedChannels: vi.fn(async () => {}),
}));

// jsdom has no layout, so the real virtualizer would render no rows.
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        index,
        key: index,
        start: index * 68,
        size: 68,
      })),
    getTotalSize: () => count * 68,
  }),
}));

const channels = [1, 2, 3].map(
  (id) =>
    ({
      id,
      playlist_id: 1,
      name: `Channel ${id}`,
      url: `http://home.example/${id}.ts`,
      content_type: 'live',
      is_favorite: false,
      sort_order: id,
    }) as Channel
);

function modal(
  isOpen: boolean,
  blocked: number[],
  extra: { onUpdate?: (ids: Set<number>) => void } = {}
) {
  return (
    <ChannelBlockingModal
      isOpen={isOpen}
      onClose={vi.fn()}
      channels={channels}
      initialBlockedIds={new Set(blocked)}
      onUpdate={extra.onUpdate ?? vi.fn()}
    />
  );
}

describe('ChannelBlockingModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('opens with the blocks that were loaded after it was first rendered', () => {
    // Settings renders the dialog closed before the saved blocks have loaded.
    const { rerender } = render(modal(false, []));
    rerender(modal(false, [1, 2]));
    rerender(modal(true, [1, 2]));

    expect(screen.getByText('2 of 3 channels blocked')).toBeInTheDocument();
  });

  it('starts over from the saved blocks on every opening', () => {
    const { rerender } = render(modal(true, [1]));
    fireEvent.click(screen.getByRole('button', { name: 'Block All' }));
    expect(screen.getByText('3 of 3 channels blocked')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    rerender(modal(false, [1]));
    rerender(modal(true, [1]));

    expect(screen.getByText('1 of 3 channels blocked')).toBeInTheDocument();
  });

  it('Done hands the edited list to its host and writes nothing itself', () => {
    const onUpdate = vi.fn();
    render(modal(true, [1], { onUpdate }));

    fireEvent.click(screen.getByRole('checkbox', { name: /Channel 2/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));

    expect(onUpdate).toHaveBeenCalledWith(new Set([1, 2]));
    expect(setBlockedChannels).not.toHaveBeenCalled();
  });
});
