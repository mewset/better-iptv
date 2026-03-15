import {
  LANGUAGE_OPTIONS,
  VIDEO_OUTPUT_OPTIONS,
  DEINTERLACE_OPTIONS,
  CACHE_SECONDS_OPTIONS,
  type LanguageCode,
  type VideoOutput,
  type DeinterlaceMode,
} from './constants';

interface PlaybackTabProps {
  // Video
  hardwareAcceleration: boolean;
  onHardwareAccelerationChange: (enabled: boolean) => void;
  videoOutput: VideoOutput;
  onVideoOutputChange: (vo: VideoOutput) => void;
  deinterlace: DeinterlaceMode;
  onDeinterlaceChange: (mode: DeinterlaceMode) => void;
  startFullscreen: boolean;
  onStartFullscreenChange: (enabled: boolean) => void;

  // Cache
  cacheSecs: number;
  onCacheSecsChange: (secs: number) => void;

  // Volume
  startVolume: number;
  onStartVolumeChange: (vol: number) => void;

  // Language
  audioLang: LanguageCode;
  onAudioLangChange: (lang: LanguageCode) => void;
  subtitleLang: LanguageCode;
  onSubtitleLangChange: (lang: LanguageCode) => void;
}

export default function PlaybackTab({
  hardwareAcceleration,
  onHardwareAccelerationChange,
  videoOutput,
  onVideoOutputChange,
  deinterlace,
  onDeinterlaceChange,
  startFullscreen,
  onStartFullscreenChange,
  cacheSecs,
  onCacheSecsChange,
  startVolume,
  onStartVolumeChange,
  audioLang,
  onAudioLangChange,
  subtitleLang,
  onSubtitleLangChange,
}: PlaybackTabProps) {
  return (
    <div className="space-y-6">
      {/* Video Settings */}
      <section>
        <h3 className="mb-4 text-lg font-semibold text-gray-900 dark:text-white">Video</h3>
        <div className="space-y-4">
          {/* Hardware Acceleration */}
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-gray-700 dark:text-gray-300">
                Hardware Acceleration
              </p>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                Use GPU for video decoding (recommended)
              </p>
            </div>
            <input
              type="checkbox"
              checked={hardwareAcceleration}
              onChange={(e) => onHardwareAccelerationChange(e.target.checked)}
              className="h-4 w-4 rounded text-blue-600 focus:ring-blue-500"
            />
          </div>

          {/* Video Output */}
          <div>
            <label className="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-300">
              Video Output
            </label>
            <select
              value={videoOutput}
              onChange={(e) => onVideoOutputChange(e.target.value as VideoOutput)}
              className="w-full rounded-lg border border-gray-300 px-4 py-2 focus:border-transparent focus:ring-2 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-700 dark:text-white dark:[color-scheme:dark]"
            >
              {VIDEO_OUTPUT_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              {VIDEO_OUTPUT_OPTIONS.find((o) => o.value === videoOutput)?.description}
            </p>
          </div>

          {/* Deinterlacing */}
          <div>
            <label className="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-300">
              Deinterlacing
            </label>
            <select
              value={deinterlace}
              onChange={(e) => onDeinterlaceChange(e.target.value as DeinterlaceMode)}
              className="w-full rounded-lg border border-gray-300 px-4 py-2 focus:border-transparent focus:ring-2 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-700 dark:text-white dark:[color-scheme:dark]"
            >
              {DEINTERLACE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              {DEINTERLACE_OPTIONS.find((o) => o.value === deinterlace)?.description}
            </p>
          </div>

          {/* Start Fullscreen */}
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-gray-700 dark:text-gray-300">
                Start in Fullscreen
              </p>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                Open video player in fullscreen mode
              </p>
            </div>
            <input
              type="checkbox"
              checked={startFullscreen}
              onChange={(e) => onStartFullscreenChange(e.target.checked)}
              className="h-4 w-4 rounded text-blue-600 focus:ring-blue-500"
            />
          </div>
        </div>
      </section>

      {/* Audio & Subtitles */}
      <section>
        <h3 className="mb-4 text-lg font-semibold text-gray-900 dark:text-white">
          Audio & Subtitles
        </h3>
        <div className="space-y-4">
          <div>
            <label className="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-300">
              Default Audio Language
            </label>
            <select
              value={audioLang}
              onChange={(e) => onAudioLangChange(e.target.value as LanguageCode)}
              className="w-full rounded-lg border border-gray-300 px-4 py-2 focus:border-transparent focus:ring-2 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-700 dark:text-white dark:[color-scheme:dark]"
            >
              {LANGUAGE_OPTIONS.map((lang) => (
                <option key={lang.code} value={lang.code}>
                  {lang.name}
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              Preferred audio track language (if available in stream)
            </p>
          </div>

          <div>
            <label className="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-300">
              Default Subtitles Language
            </label>
            <select
              value={subtitleLang}
              onChange={(e) => onSubtitleLangChange(e.target.value as LanguageCode)}
              className="w-full rounded-lg border border-gray-300 px-4 py-2 focus:border-transparent focus:ring-2 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-700 dark:text-white dark:[color-scheme:dark]"
            >
              {LANGUAGE_OPTIONS.map((lang) => (
                <option key={lang.code} value={lang.code}>
                  {lang.name}
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              Preferred subtitle language (if available in stream)
            </p>
          </div>

          {/* Start Volume */}
          <div>
            <label className="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-300">
              Start Volume: {startVolume}%
            </label>
            <input
              type="range"
              min={0}
              max={100}
              value={startVolume}
              onChange={(e) => onStartVolumeChange(Number(e.target.value))}
              className="w-full accent-blue-600"
            />
            <div className="mt-1 flex justify-between text-xs text-gray-500 dark:text-gray-400">
              <span>Muted</span>
              <span>100%</span>
            </div>
          </div>
        </div>
      </section>

      {/* Buffering */}
      <section>
        <h3 className="mb-4 text-lg font-semibold text-gray-900 dark:text-white">Buffering</h3>
        <div className="space-y-4">
          <div>
            <label className="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-300">
              Cache Duration
            </label>
            <select
              value={cacheSecs}
              onChange={(e) => onCacheSecsChange(Number(e.target.value))}
              className="w-full rounded-lg border border-gray-300 px-4 py-2 focus:border-transparent focus:ring-2 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-700 dark:text-white dark:[color-scheme:dark]"
            >
              {CACHE_SECONDS_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              How much stream data to buffer. Increase if you experience frequent buffering.
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}
