import { describe, it, expect } from 'vitest';
import {
  guideWindow,
  blockGeometry,
  guideChannels,
  GUIDE_CHANNEL_CAP,
} from '../../lib/guideLayout';
import type { Channel } from '../../types';

// Local times via the Date constructor so these pass in any timezone.
const local = (h: number, min: number, day = 24) => new Date(2026, 8, day, h, min).getTime();
const iso = (t: number) => new Date(t).toISOString();

describe('guideWindow', () => {
  it('starts at the half hour before now, floored, and spans three hours', () => {
    const { from, to } = guideWindow(local(20, 12), 0);
    expect(from).toBe(local(19, 30));
    expect(to).toBe(local(22, 30));
  });

  it('treats a time exactly on the hour the same way', () => {
    const { from, to } = guideWindow(local(20, 0), 0);
    expect(from).toBe(local(19, 30));
    expect(to).toBe(local(22, 30));
  });

  it('drops seconds when flooring', () => {
    const now = new Date(2026, 8, 24, 20, 45, 59, 999).getTime();
    expect(guideWindow(now, 0).from).toBe(local(20, 0));
  });

  it('shows 18:00-21:00 local on a later day', () => {
    const { from, to } = guideWindow(local(20, 12), 1);
    expect(from).toBe(local(18, 0, 25));
    expect(to).toBe(local(21, 0, 25));
  });

  it('crosses a month boundary for later days', () => {
    const now = new Date(2026, 8, 30, 9, 0).getTime();
    expect(guideWindow(now, 2).from).toBe(new Date(2026, 9, 2, 18, 0).getTime());
  });
});

describe('blockGeometry', () => {
  const from = local(19, 30);
  const to = local(22, 30);

  it('maps a 30-minute programme in a 3-hour window of 1080 px to 180 px', () => {
    expect(blockGeometry(iso(local(20, 0)), iso(local(20, 30)), from, to, 1080)).toEqual({
      left: 180,
      width: 180,
    });
  });

  it('clamps a programme that began before the window to left 0', () => {
    expect(blockGeometry(iso(local(19, 0)), iso(local(20, 0)), from, to, 1080)).toEqual({
      left: 0,
      width: 180,
    });
  });

  it('clamps a programme that runs past the window to its right edge', () => {
    expect(blockGeometry(iso(local(22, 0)), iso(local(23, 30)), from, to, 1080)).toEqual({
      left: 900,
      width: 180,
    });
  });

  it('returns null for a programme entirely before the window', () => {
    expect(blockGeometry(iso(local(18, 0)), iso(local(19, 30)), from, to, 1080)).toBeNull();
  });

  it('returns null for a programme entirely after the window', () => {
    expect(blockGeometry(iso(local(22, 30)), iso(local(23, 0)), from, to, 1080)).toBeNull();
  });

  it('returns null for unparsable or inverted times', () => {
    expect(blockGeometry('nope', iso(local(20, 0)), from, to, 1080)).toBeNull();
    expect(blockGeometry(iso(local(21, 0)), iso(local(20, 0)), from, to, 1080)).toBeNull();
  });
});

describe('guideChannels', () => {
  const ch = (id: number, epg_id: string | null | undefined): Channel =>
    ({ id, name: `C${id}`, url: 'http://x', content_type: 'live', epg_id }) as Channel;

  it('keeps only channels with a non-blank epg_id', () => {
    const list = [ch(1, 'a'), ch(2, null), ch(3, '  '), ch(4, undefined), ch(5, ' b ')];
    expect(guideChannels(list).map((c) => c.id)).toEqual([1, 5]);
  });

  it('caps the list at 100 channels', () => {
    const list = Array.from({ length: 150 }, (_, i) => ch(i + 1, `e${i}`));
    expect(GUIDE_CHANNEL_CAP).toBe(100);
    expect(guideChannels(list)).toHaveLength(100);
  });
});
