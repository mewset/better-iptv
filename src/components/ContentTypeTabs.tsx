import { memo } from 'react';
import { Tv, Film, Clapperboard, Star } from 'lucide-react';
import type { ContentTypeFilter } from '../hooks/useChannelFilter';

interface ContentTypeTabsProps {
  /** Currently active filter */
  activeFilter: ContentTypeFilter;
  /** Callback when filter changes */
  onFilterChange: (filter: ContentTypeFilter) => void;
}

interface TabConfig {
  value: ContentTypeFilter;
  label: string;
  icon?: React.ReactNode;
}

const TABS: TabConfig[] = [
  { value: 'live', label: 'Live TV', icon: <Tv className="h-4 w-4" aria-hidden="true" /> },
  { value: 'vod', label: 'Movies', icon: <Film className="h-4 w-4" aria-hidden="true" /> },
  {
    value: 'series',
    label: 'Series',
    icon: <Clapperboard className="h-4 w-4" aria-hidden="true" />,
  },
  {
    value: 'favorites',
    label: 'Favorites',
    icon: <Star className="h-4 w-4" aria-hidden="true" />,
  },
];

/**
 * Content type tabs component
 *
 * Provides tab-based navigation for filtering channels by content type:
 * - All: Show all channels
 * - Live TV: Show only live channels
 * - Movies: Show only VOD content
 * - Series: Show only series
 */
export const ContentTypeTabs = memo(function ContentTypeTabs({
  activeFilter,
  onFilterChange,
}: ContentTypeTabsProps) {
  return (
    <div className="border-b border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800">
      <div className="mx-auto px-6">
        <div className="flex gap-2 overflow-x-auto" role="tablist" aria-label="Content type filter">
          {TABS.map((tab) => (
            <button
              key={tab.value}
              role="tab"
              aria-selected={activeFilter === tab.value}
              aria-controls="channel-list"
              onClick={() => onFilterChange(tab.value)}
              className={`flex items-center gap-2 whitespace-nowrap border-b-2 px-4 py-3 font-medium transition-colors ${
                activeFilter === tab.value
                  ? 'border-blue-600 text-blue-600 dark:border-blue-400 dark:text-blue-400'
                  : 'border-transparent text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-200'
              }`}
            >
              {tab.icon}
              {tab.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
});

export default ContentTypeTabs;
