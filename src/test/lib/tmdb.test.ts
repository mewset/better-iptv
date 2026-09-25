import { describe, it, expect } from 'vitest';
import { metaLine, heroMetaLine, cardFromDetails } from '../../lib/tmdb';
import type { TmdbDetails } from '../../lib/tauri';

describe('metaLine', () => {
  it('shows year and rating when both are known', () => {
    expect(metaLine({ year: 2010, rating: 8.197 }, 'Drama')).toBe('2010 · ★ 8.2');
  });
  it('shows whichever part is known', () => {
    expect(metaLine({ year: 2010, rating: null }, 'Drama')).toBe('2010');
    expect(metaLine({ year: null, rating: 7 }, 'Drama')).toBe('★ 7.0');
  });
  it('falls back to the group when nothing is known', () => {
    expect(metaLine({ year: null, rating: null }, 'Drama')).toBe('Drama');
    expect(metaLine(undefined, 'Drama')).toBe('Drama');
  });
});

describe('heroMetaLine', () => {
  it('adds up to three genres between year and rating', () => {
    const card = {
      channel_id: 1,
      tmdb_id: 1,
      title: 'X',
      year: 2023,
      rating: 7.4,
      poster_url: null,
      backdrop_url: null,
      genres: ['Action', 'Thriller', 'Drama', 'Crime'],
    };
    expect(heroMetaLine(card, 'Movies')).toBe('2023 · Action, Thriller, Drama · ★ 7.4');
  });
  it('falls back to the group without a card', () => {
    expect(heroMetaLine(undefined, 'Movies')).toBe('Movies');
  });
});

describe('cardFromDetails', () => {
  const details: TmdbDetails = {
    available: true,
    matched: true,
    manual: false,
    tmdb_id: 11324,
    title: 'Shutter Island',
    original_title: 'Shutter Island',
    year: 2010,
    rating: 8.2,
    poster_url: 'https://image.tmdb.org/t/p/w780/p.jpg',
    backdrop_url: 'https://image.tmdb.org/t/p/w1280/b.jpg',
    overview: 'x',
    runtime_minutes: 138,
    genres: ['Drama'],
    cast: [],
    trailer_url: null,
  };
  it('builds a card with the w342 poster from the w780 detail poster', () => {
    const card = cardFromDetails(9, details)!;
    expect(card.channel_id).toBe(9);
    expect(card.poster_url).toBe('https://image.tmdb.org/t/p/w342/p.jpg');
    expect(card.genres).toEqual(['Drama']);
  });
  it('is null for an unmatched title', () => {
    expect(cardFromDetails(9, { ...details, matched: false, tmdb_id: null })).toBeNull();
  });
});
