import { describe, it, expect } from 'vitest';
import { calculateGridConfig } from '../../hooks/useResponsiveGrid';

describe('calculateGridConfig', () => {
  it('uses one column below 560 px for both kinds', () => {
    expect(calculateGridConfig(500, 900, 'live').columns).toBe(1);
    expect(calculateGridConfig(500, 900, 'poster').columns).toBe(1);
  });
  it('uses seven poster columns at 1440 px', () => {
    expect(calculateGridConfig(1440, 900, 'poster').columns).toBe(7);
  });
  it('gives posters a 2:3 frame plus the meta line', () => {
    const c = calculateGridConfig(1440, 900, 'poster');
    const col = (1440 - 72 - 80 - 6 * 16) / 7;
    expect(c.cardHeight).toBe(Math.round(col * 1.5) + 28);
    expect(c.estimatedRowHeight).toBe(c.cardHeight + 16);
  });
  it('keeps live cards at a fixed height', () => {
    expect(calculateGridConfig(1440, 900, 'live').cardHeight).toBe(208);
    expect(calculateGridConfig(2560, 1440, 'live').cardHeight).toBe(208);
  });
});
