import type { ReactNode } from 'react';
import type { Channel } from '../types';

interface FavoritesViewProps {
  /** The favourites to show (the section's list, search applied). */
  channels: Channel[];
  /** A movie's or series' card: a poster, as in Movies, Series and Home. */
  renderPoster: (channel: Channel) => ReactNode;
  /** A live channel's card, as in Live TV. */
  renderLive: (channel: Channel) => ReactNode;
}

const SECTIONS = [
  { type: 'live', title: 'Channels', kind: 'live' },
  { type: 'vod', title: 'Movies', kind: 'poster' },
  { type: 'series', title: 'Series', kind: 'poster' },
] as const;

/**
 * Favourites in three groups, each with the card its own section uses:
 * channel cards for live TV, posters for movies and series. One grid of
 * channel cards made a poster a thumbnail in a grey box. Favourites are few,
 * so the groups render whole, without the main grid's virtualiser.
 */
export function FavoritesView({ channels, renderPoster, renderLive }: FavoritesViewProps) {
  return (
    <div className="flex flex-col gap-9">
      {SECTIONS.map(({ type, title, kind }) => {
        const items = channels.filter((c) => c.content_type === type);
        if (items.length === 0) return null;
        return (
          <section key={type} aria-label={title} className="flex flex-col gap-3">
            <div className="flex items-baseline gap-3">
              <h2 className="font-display text-xl font-semibold text-text">{title}</h2>
              <span className="text-sm text-text-muted">{items.length}</span>
            </div>
            <ul
              className={`grid gap-4 ${
                kind === 'live'
                  ? 'grid-cols-[repeat(auto-fill,minmax(300px,1fr))]'
                  : 'grid-cols-[repeat(auto-fill,minmax(170px,1fr))] gap-y-6'
              }`}
            >
              {items.map((channel) => (
                <li key={channel.id} className="min-w-0">
                  {kind === 'live' ? renderLive(channel) : renderPoster(channel)}
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
