import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ChannelGridPlaceholder } from '../../components/ChannelGridPlaceholder';

describe('ChannelGridPlaceholder', () => {
  it.each(['live', 'poster'] as const)('draws a %s stand-in for every cell of the rows', (kind) => {
    render(<ChannelGridPlaceholder kind={kind} columns={6} rows={5} />);
    expect(screen.getByTestId('channel-grid-placeholder').children).toHaveLength(30);
  });

  it('pulses the grid as a whole, not each stand-in', () => {
    const { container } = render(<ChannelGridPlaceholder kind="live" columns={3} rows={4} />);
    const animated = container.querySelectorAll('.animate-pulse');
    expect(animated).toHaveLength(1);
    expect(animated[0]).toBe(screen.getByTestId('channel-grid-placeholder'));
  });
});
