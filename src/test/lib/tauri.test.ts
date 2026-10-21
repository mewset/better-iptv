import { describe, it, expect, vi, beforeEach } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import {
  getChannels,
  getLegacyEpgStatus,
  getPlaylistChannelCounts,
  reportDeadLogos,
} from '../../lib/tauri';
import { epgSource, epgStatus } from '../epgFixtures';

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

describe('getChannels', () => {
  beforeEach(() => {
    mockedInvoke.mockReset();
  });

  it('passes the content types to get_channels', async () => {
    mockedInvoke.mockResolvedValueOnce([]);

    await getChannels(3, ['live']);

    expect(mockedInvoke).toHaveBeenCalledWith('get_channels', {
      playlistId: 3,
      contentTypes: ['live'],
    });
  });

  it('leaves contentTypes undefined when no filter is given', async () => {
    mockedInvoke.mockResolvedValueOnce([]);

    await getChannels(3);

    expect(mockedInvoke).toHaveBeenCalledWith('get_channels', {
      playlistId: 3,
      contentTypes: undefined,
    });
  });
});

describe('reportDeadLogos', () => {
  beforeEach(() => {
    mockedInvoke.mockReset();
  });

  it('reportDeadLogos maps keys to numbers and sends channel_id', async () => {
    mockedInvoke.mockResolvedValueOnce({ '12': 'http://fb/12.png' });
    const result = await reportDeadLogos([{ channelId: 12, url: 'http://a' }]);
    expect(mockedInvoke).toHaveBeenCalledWith('report_dead_logos', {
      items: [{ channel_id: 12, url: 'http://a' }],
    });
    expect(result).toEqual({ 12: 'http://fb/12.png' });
  });
});

describe('getLegacyEpgStatus', () => {
  beforeEach(() => {
    mockedInvoke.mockReset();
  });

  it('summarises the enabled sources of the per-source status', async () => {
    mockedInvoke.mockResolvedValueOnce(
      epgStatus(true, {
        programme_count: 42,
        sources: [
          epgSource({ id: 1, last_success_at: '2026-10-21T08:00:00+00:00' }),
          epgSource({ id: 2, last_success_at: '2026-10-21T09:30:00+00:00' }),
          epgSource({ id: 3, enabled: false, last_success_at: '2026-10-21T11:00:00+00:00' }),
        ],
      })
    );

    expect(await getLegacyEpgStatus()).toEqual({
      has_url: true,
      last_fetched: '2026-10-21T09:30:00+00:00',
      program_count: 42,
    });
    expect(mockedInvoke).toHaveBeenCalledWith('get_epg_status');
  });

  it('has no URL when every source is disabled', async () => {
    mockedInvoke.mockResolvedValueOnce(
      epgStatus(true, { programme_count: 0, sources: [epgSource({ enabled: false })] })
    );

    expect(await getLegacyEpgStatus()).toEqual({
      has_url: false,
      last_fetched: null,
      program_count: 0,
    });
  });
});
