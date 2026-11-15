import { describe, expect, it } from 'vitest';
import { isFourK } from '../../lib/fourK';

describe('isFourK', () => {
  it('finds 4K, UHD or 2160p as a word in the name or category', () => {
    expect(isFourK({ name: '28 Years Later (2025) 4K' })).toBe(true);
    expect(isFourK({ name: 'Dune [UHD]' })).toBe(true);
    expect(isFourK({ name: 'Heat 2160p' })).toBe(true);
    expect(isFourK({ name: 'Absolution (2024)', group_name: '2024 4K Movies' })).toBe(true);
  });

  it('does not match 4K inside another word or number', () => {
    expect(isFourK({ name: 'Bruno Mars: 24K Magic Live at the Apollo (2017)' })).toBe(false);
    expect(isFourK({ name: 'K4K Rescue' })).toBe(false);
    expect(isFourK({ name: 'Rocky (1976)', group_name: 'Drama 1970s' })).toBe(false);
  });
});
