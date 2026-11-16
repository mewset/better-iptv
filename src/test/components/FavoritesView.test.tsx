import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { FavoritesView } from '../../components/FavoritesView';
import type { Channel } from '../../types';

const c = (id: number, name: string, content_type: Channel['content_type']): Channel => ({
  id,
  name,
  content_type,
  is_favorite: true,
});

describe('FavoritesView', () => {
  it('groups channels, movies and series, each with its own card, skipping empty groups', () => {
    render(
      <FavoritesView
        channels={[
          c(1, 'BBC One', 'live'),
          c(2, 'MobLand', 'series'),
          c(3, 'The Chosen', 'series'),
        ]}
        renderPoster={(ch) => <span>poster {ch.name}</span>}
        renderLive={(ch) => <span>live {ch.name}</span>}
      />
    );
    const groups = screen.getAllByRole('region').map((r) => r.getAttribute('aria-label'));
    expect(groups).toEqual(['Channels', 'Series']);
    expect(within(screen.getByRole('region', { name: 'Channels' })).getByText('live BBC One'));
    const series = screen.getByRole('region', { name: 'Series' });
    expect(within(series).getByText('poster MobLand')).toBeInTheDocument();
    expect(within(series).getByText('2')).toBeInTheDocument();
  });
});
