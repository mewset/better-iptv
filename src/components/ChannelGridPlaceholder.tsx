import { getGridClasses } from '../hooks/useResponsiveGrid';

interface ChannelGridPlaceholderProps {
  kind: 'live' | 'poster';
  columns: number;
  /** Rows to draw: as many as cover the window, so no visible row starts out empty */
  rows: number;
}

/**
 * Pulsing stand-ins for the channel grid while the list loads. Same grid
 * classes, gaps and card heights as the real rows, so cards replace them
 * without a layout jump. The pulse matches HomeView's skeleton; it runs on
 * the grid, one animation for every stand-in, which pulse in step anyway.
 */
export function ChannelGridPlaceholder({ kind, columns, rows }: ChannelGridPlaceholderProps) {
  return (
    <div
      data-testid="channel-grid-placeholder"
      aria-busy="true"
      className={`grid ${getGridClasses(columns)} animate-pulse gap-4`}
    >
      {Array.from({ length: columns * rows }, (_, i) =>
        kind === 'poster' ? (
          // 2:3 poster frame plus the 28px meta line PosterCard carries under it
          <div key={i} className="flex flex-col gap-2">
            <div className="aspect-[2/3] rounded-xl bg-surface-2" />
            <div className="h-5" />
          </div>
        ) : (
          <div key={i} className="h-[208px] rounded-[14px] bg-surface-2" />
        )
      )}
    </div>
  );
}
