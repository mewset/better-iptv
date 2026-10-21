import type { Channel } from '../types';

/**
 * Sets the guide keys `get_channel_epg_keys` returned on a channel list:
 * a live channel listed in `pairs` gets its key as `epg_id`, a live channel
 * not listed loses its `epg_id` (the backend lists every matched live
 * channel of the playlist), vod and series rows are left as they are.
 *
 * One pass. Only a channel whose key changes is copied; when none does,
 * `channels` itself is returned, so nothing that reads the list re-renders.
 */
export function applyEpgKeys(
  channels: Channel[],
  pairs: ReadonlyArray<readonly [number, string]>
): Channel[] {
  const keys = new Map(pairs);
  let out: Channel[] | null = null;
  for (let i = 0; i < channels.length; i++) {
    const channel = channels[i];
    if (channel.content_type !== 'live') continue;
    const key = keys.get(channel.id);
    if ((channel.epg_id ?? undefined) === key) continue;
    out ??= channels.slice();
    out[i] = { ...channel, epg_id: key };
  }
  return out ?? channels;
}
