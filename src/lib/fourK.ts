import type { Channel } from '../types';

// "4K", "UHD" or "2160p" as a word of its own, so "24K Magic" is not 4K.
const FOUR_K = /(^|[^0-9a-z])(4k|uhd|2160p?)(?![0-9a-z])/i;

/** Whether the provider marks a title as 4K, in its name or its category. */
export function isFourK(channel: Pick<Channel, 'name' | 'group_name'>): boolean {
  return FOUR_K.test(channel.name) || FOUR_K.test(channel.group_name ?? '');
}
