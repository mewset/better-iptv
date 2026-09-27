import { describe, it, expect, vi, beforeEach } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { getPlaylistChannelCounts } from '../../lib/tauri';

const mockedInvoke = vi.mocked(invoke);

describe('getPlaylistChannelCounts', () => {
  beforeEach(() => {
    mockedInvoke.mockReset();
  });

  it('converts the string keys serde sends over IPC back to numbers', async () => {
    // serde_json turns a Rust HashMap<i64, i64>'s keys into JSON object keys,
    // which are always strings, so the wire payload looks like this rather
    // than like a JS object literal with numeric keys.
    mockedInvoke.mockResolvedValueOnce({ '1': 42, '2': 7 });

    const counts = await getPlaylistChannelCounts();

    expect(counts).toEqual({ 1: 42, 2: 7 });
    expect(Object.keys(counts)).toEqual(['1', '2']); // JS object keys stringify regardless
    expect(counts[1]).toBe(42);
    expect(counts[2]).toBe(7);
  });

  it('returns an empty object when no playlist has channels', async () => {
    mockedInvoke.mockResolvedValueOnce({});

    const counts = await getPlaylistChannelCounts();

    expect(counts).toEqual({});
  });
});
