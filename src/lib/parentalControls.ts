import type { Channel } from '../types';

// Adult-content markers: +18, 18+ (bare or inside (), [] or {}), xxx, adult,
// porn, erotic. One pattern, tested on the name and the group separately:
// it runs over every title of a library on each parental or hero pass.
const ADULT_PATTERN = /\+18|18\+|xxx|adult|porn|erotic/i;

/**
 * Detect if a channel contains adult content based on name and category
 */
export function isAdultContent(channelName: string, groupName?: string): boolean {
  return ADULT_PATTERN.test(channelName) || (groupName ? ADULT_PATTERN.test(groupName) : false);
}

/**
 * Settings interface for channel blocking logic
 */
export interface ParentalBlockSettings {
  enabled: boolean;
  autoDetect: boolean;
  blockedIds: Set<number>;
  blockedCategories: string[];
  unlocked: boolean;
}

/**
 * Determine if a channel should be blocked based on parental control settings
 */
export function shouldBlockChannel(channel: Channel, settings: ParentalBlockSettings): boolean {
  // If parental controls are disabled or unlocked, don't block anything
  if (!settings.enabled || settings.unlocked) {
    return false;
  }

  // Manual channel block
  if (channel.id && settings.blockedIds.has(channel.id)) {
    return true;
  }

  // Category block
  if (channel.group_name && settings.blockedCategories.includes(channel.group_name)) {
    return true;
  }

  // Auto-detection of adult content
  if (settings.autoDetect && isAdultContent(channel.name, channel.group_name)) {
    return true;
  }

  return false;
}

/**
 * Filter an array of channels based on parental control settings
 */
export function filterChannels(channels: Channel[], settings: ParentalBlockSettings): Channel[] {
  if (!settings.enabled || settings.unlocked) {
    return channels;
  }

  return channels.filter((channel) => !shouldBlockChannel(channel, settings));
}

/**
 * Validate PIN format (4-6 digits, only numbers)
 */
export function validatePin(pin: string): { valid: boolean; error?: string } {
  if (pin.length < 4 || pin.length > 6) {
    return { valid: false, error: 'PIN must be 4-6 digits' };
  }

  if (!/^\d+$/.test(pin)) {
    return { valid: false, error: 'PIN must contain only numbers' };
  }

  return { valid: true };
}

/**
 * Calculate unlock expiry timestamp based on duration
 */
export function calculateUnlockExpiry(
  duration: 'session' | '30min' | '1hour' | 'always'
): number | null {
  switch (duration) {
    case '30min':
      return Date.now() + 30 * 60 * 1000;
    case '1hour':
      return Date.now() + 60 * 60 * 1000;
    case 'always':
    case 'session':
    default:
      return null; // Session-based or always unlocked (handled by session state)
  }
}

/**
 * Check if unlock has expired
 */
export function isUnlockExpired(expiryTimestamp: number | null): boolean {
  if (expiryTimestamp === null) {
    return false; // No expiry set (session-based)
  }
  return Date.now() >= expiryTimestamp;
}
