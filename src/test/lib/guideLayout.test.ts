import { describe, it, expect } from 'vitest';
import {
  blockGeometry,
  guideChannels,
  guideDataRange,
  guideWindow,
  normalizeEpgId,
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

describe('normalizeEpgId', () => {
  it('trims and lower-cases ASCII only, like the backend', () => {
    expect(normalizeEpgId('  SVT1.se ')).toBe('svt1.se');
    expect(normalizeEpgId('KANAL5.SE')).toBe('kanal5.se');
    // Non-ASCII letters keep their case, as Rust's to_ascii_lowercase does.
    expect(normalizeEpgId('ÖRESUND.dk')).toBe('Öresund.dk');
  });
});

describe('guideDataRange', () => {
  it('runs from today 00:00 local to the same time five days later', () => {
    const now = new Date(2026, 9, 8, 20, 12).getTime();
    const { from, to } = guideDataRange(now);
    expect(from).toBe(new Date(2026, 9, 8).getTime());
    expect(to).toBe(new Date(2026, 9, 13).getTime());
  });

  it('crosses a month boundary', () => {
    const { to } = guideDataRange(new Date(2026, 9, 29, 9).getTime());
    expect(to).toBe(new Date(2026, 10, 3).getTime());
  });
});

describe('guideChannels', () => {
  const ch = (id: number, epg_id: string | null | undefined): Channel =>
    ({ id, name: `C${id}`, content_type: 'live', epg_id }) as Channel;

  it('keeps channels whose normalized id has data, in list order', () => {
    const list = [ch(1, 'b.se'), ch(2, ' SVT1.se '), ch(3, 'none.se'), ch(4, 'a.se')];
    const rows = guideChannels(list, new Set(['a.se', 'b.se', 'svt1.se']));
    expect(rows.map((c) => c.id)).toEqual([1, 2, 4]);
  });

  it('keeps every channel sharing an id with data', () => {
    const rows = guideChannels([ch(1, 'svt1.se'), ch(2, 'SVT1.se')], new Set(['svt1.se']));
    expect(rows.map((c) => c.id)).toEqual([1, 2]);
  });

  it('drops channels without an id or with a blank one', () => {
    const list = [ch(1, null), ch(2, undefined), ch(3, '   '), ch(4, 'a.se')];
    expect(guideChannels(list, new Set(['a.se', ''])).map((c) => c.id)).toEqual([4]);
  });

  it('has no cap', () => {
    const list = Array.from({ length: 1500 }, (_, i) => ch(i + 1, `e${i}`));
    const ids = new Set(list.map((c) => c.epg_id!));
    expect(guideChannels(list, ids)).toHaveLength(1500);
  });

  it('without a set keeps every channel with a non-blank id', () => {
    const list = [ch(1, 'a'), ch(2, null), ch(3, '  '), ch(4, 'b')];
    expect(guideChannels(list, null).map((c) => c.id)).toEqual([1, 4]);
  });
});
