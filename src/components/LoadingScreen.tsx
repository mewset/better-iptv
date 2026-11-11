import { memo } from 'react';
import logoImage from '../assets/logo/logo-256.webp';

interface LoadingScreenProps {
  message?: string;
  progress?: number;
  total?: number;
  details?: {
    live_count?: number;
    vod_count?: number;
    series_count?: number;
  };
}

/**
 * Loading screen with Better-IPTV logo
 * Shown during initial setup and channel loading
 */
export const LoadingScreen = memo(function LoadingScreen({
  message = 'Loading...',
  progress,
  total: _total,
  details,
}: LoadingScreenProps) {
  const showProgress = progress !== undefined && progress > 0;
  const showDetails =
    details &&
    (details.live_count || 0) + (details.vod_count || 0) + (details.series_count || 0) > 0;

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-gradient-to-br from-gray-900 via-gray-800 to-gray-900">
      {/* Logo with pulse animation */}
      <div className="mb-8 animate-pulse">
        <img src={logoImage} alt="Better-IPTV Logo" className="h-64 w-64 drop-shadow-2xl" />
      </div>

      {/* Loading message */}
      <div className="text-center">
        <p className="mb-4 text-xl font-medium text-white">{message}</p>

        {/* Detailed progress */}
        {showDetails && (
          <div className="space-y-2 text-gray-300">
            {details!.live_count! > 0 && (
              <p className="text-lg">
                <span className="font-semibold text-cyan-400">
                  {details!.live_count!.toLocaleString()}
                </span>{' '}
                live streams
              </p>
            )}
            {details!.vod_count! > 0 && (
              <p className="text-lg">
                <span className="font-semibold text-purple-400">
                  {details!.vod_count!.toLocaleString()}
                </span>{' '}
                VOD streams
              </p>
            )}
            {details!.series_count! > 0 && (
              <p className="text-lg">
                <span className="font-semibold text-blue-400">
                  {details!.series_count!.toLocaleString()}
                </span>{' '}
                series
              </p>
            )}
            {showProgress && (
              <p className="mt-4 text-xl font-bold text-white">
                Total: {progress!.toLocaleString()} channels
              </p>
            )}
          </div>
        )}

        {/* Animated loading dots */}
        {!showDetails && (
          <div className="flex justify-center space-x-2">
            <div className="h-2 w-2 animate-bounce rounded-full bg-cyan-500" />
            <div className="h-2 w-2 animate-bounce rounded-full bg-blue-500 [animation-delay:0.1s]" />
            <div className="h-2 w-2 animate-bounce rounded-full bg-purple-500 [animation-delay:0.2s]" />
          </div>
        )}
      </div>
    </div>
  );
});
