/**
 * Custom hooks barrel export
 */

// Grid and layout
export { useResponsiveGrid, getGridClasses } from './useResponsiveGrid';

// Error handling
export { useErrorHandler, withErrorHandling, type Toast } from './useErrorHandler';

// Channel filtering and search
export {
  useChannelFilter,
  useContentTypeFilter,
  useSearchQuery,
  type ContentTypeFilter,
} from './useChannelFilter';

// Channel playback
export { useChannelPlayback, type PlaylistEpisode } from './useChannelPlayback';

// Guide data
export { useNowNext, nowNextFor, epgKey } from './useNowNext';
export { useEpgStatus } from './useEpgStatus';
export { useNow } from './useNow';

// Keyboard shortcuts
export { useKeyboardShortcuts } from './useKeyboardShortcuts';

// Update check
export { useUpdateCheck } from './useUpdateCheck';

// Xtream subscription expiry
export { useSubscriptionExpiries } from './useSubscriptionExpiries';

// Profile switching
export { useProfileSwitch, type ProfileSwitch } from './useProfileSwitch';

// Channel logo with iptv-org fallback
export { useChannelLogo } from './useChannelLogo';
