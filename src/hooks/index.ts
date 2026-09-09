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

// EPG data
export { useEpgData, useChannelEpg } from './useEpgData';

// Keyboard shortcuts
export { useKeyboardShortcuts } from './useKeyboardShortcuts';

// Update check
export { useUpdateCheck } from './useUpdateCheck';
