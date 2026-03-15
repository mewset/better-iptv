import { useState, useEffect } from 'react';
import { X } from 'lucide-react';
import {
  getSetting,
  setSetting,
  fetchEpgData,
  resetParentalPin,
  getEpgStatus,
  forceRefreshEpg,
  getChannels,
} from '../lib/tauri';
import type { EpgStatus } from '../lib/tauri';
import { usePlayerStore } from '../stores/player-store';
import { logger } from '../lib/logger';
import ProfileManager from './ProfileManager';
import PinEntryModal from './modals/PinEntryModal';
import ChannelBlockingModal from './modals/ChannelBlockingModal';
import ConfirmationModal from './modals/ConfirmationModal';
import ErrorModal from './modals/ErrorModal';
import RefreshModal from './modals/RefreshModal';
import { Tabs, TabsList, TabsTrigger, TabsContent } from './ui/tabs';
import {
  GeneralTab,
  PlaybackTab,
  EpgTab,
  ParentalTab,
  AboutTab,
  LANGUAGE_OPTIONS,
  USER_AGENT_OPTIONS,
  type Theme,
  type LanguageCode,
  type UserAgentMode,
  type VideoOutput,
  type DeinterlaceMode,
  type ParentalVisibility,
} from './settings/index';

interface SettingsProps {
  onClose: () => void;
}

export default function Settings({ onClose }: SettingsProps) {
  const { triggerEpgRefresh, channels, loadParentalSettings, currentPlaylist, setChannels } =
    usePlayerStore();

  // UI state
  const [activeTab, setActiveTab] = useState('general');
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);

  // General tab state
  const [theme, setTheme] = useState<Theme>('system');
  const [playlistUserAgentMode, setPlaylistUserAgentMode] = useState<UserAgentMode>('default');
  const [playlistUserAgentCustom, setPlaylistUserAgentCustom] = useState('');

  // EPG tab state
  const [epgUrl, setEpgUrl] = useState('');
  const [originalEpgUrl, setOriginalEpgUrl] = useState('');
  const [epgStatus, setEpgStatus] = useState<EpgStatus | null>(null);
  const [isUpdatingEpg, setIsUpdatingEpg] = useState(false);

  // Playback tab state
  const [hardwareAcceleration, setHardwareAcceleration] = useState(true);
  const [videoOutput, setVideoOutput] = useState<VideoOutput>('gpu-next');
  const [deinterlace, setDeinterlace] = useState<DeinterlaceMode>('auto');
  const [startFullscreen, setStartFullscreen] = useState(false);
  const [cacheSecs, setCacheSecs] = useState(30);
  const [startVolume, setStartVolume] = useState(100);
  const [audioLang, setAudioLang] = useState<LanguageCode>('none');
  const [subtitleLang, setSubtitleLang] = useState<LanguageCode>('none');

  // Parental tab state
  const [parentalEnabled, setParentalEnabled] = useState(false);
  const [hasPin, setHasPin] = useState(false);
  const [blockedChannelIds, setBlockedChannelIds] = useState<Set<number>>(new Set());
  const [blockedCategories, setBlockedCategories] = useState<string[]>([]);
  const [parentalAutoDetect, setParentalAutoDetect] = useState(false);
  const [parentalVisibility, setParentalVisibility] = useState<ParentalVisibility>('hide');

  // Modal state
  const [showSetPinModal, setShowSetPinModal] = useState(false);
  const [showChangePinModal, setShowChangePinModal] = useState(false);
  const [showResetPinModal, setShowResetPinModal] = useState(false);
  const [showResetPinConfirmation, setShowResetPinConfirmation] = useState(false);
  const [showChannelBlockingModal, setShowChannelBlockingModal] = useState(false);
  const [showErrorModal, setShowErrorModal] = useState(false);
  const [errorTitle, setErrorTitle] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [showRefreshModal, setShowRefreshModal] = useState(false);

  // Load settings on mount
  useEffect(() => {
    async function loadSettings() {
      try {
        const savedEpgUrl = await getSetting('epg_url');
        const savedTheme = await getSetting('theme');
        const savedAudioIso = await getSetting('audio_language');
        const savedSubtitleIso = await getSetting('subtitle_language');
        const savedPlaylistUserAgentMode = await getSetting('playlist_user_agent_mode');
        const savedPlaylistUserAgentCustom = await getSetting('playlist_user_agent_custom');
        const savedVideoOutput = await getSetting('mpv_video_output');
        const savedDeinterlace = await getSetting('mpv_deinterlace');
        const savedStartFullscreen = await getSetting('mpv_start_fullscreen');
        const savedCacheSecs = await getSetting('mpv_cache_secs');
        const savedStartVolume = await getSetting('mpv_start_volume');
        const savedHwAccel = await getSetting('mpv_hardware_acceleration');

        if (savedEpgUrl) {
          setEpgUrl(savedEpgUrl);
          setOriginalEpgUrl(savedEpgUrl);
        }
        if (savedTheme) setTheme(savedTheme as Theme);

        if (
          savedPlaylistUserAgentMode &&
          USER_AGENT_OPTIONS.some((option) => option.mode === savedPlaylistUserAgentMode)
        ) {
          setPlaylistUserAgentMode(savedPlaylistUserAgentMode as UserAgentMode);
        }
        if (savedPlaylistUserAgentCustom) {
          setPlaylistUserAgentCustom(savedPlaylistUserAgentCustom);
        }

        // Convert ISO codes back to language codes for UI
        if (savedAudioIso) {
          const audioLang = LANGUAGE_OPTIONS.find((l) => l.iso === savedAudioIso);
          if (audioLang) setAudioLang(audioLang.code);
        }
        if (savedSubtitleIso) {
          const subtitleLang = LANGUAGE_OPTIONS.find((l) => l.iso === savedSubtitleIso);
          if (subtitleLang) setSubtitleLang(subtitleLang.code);
        }

        // MPV settings
        if (savedVideoOutput) setVideoOutput(savedVideoOutput as VideoOutput);
        if (savedDeinterlace) setDeinterlace(savedDeinterlace as DeinterlaceMode);
        if (savedStartFullscreen) setStartFullscreen(savedStartFullscreen === 'true');
        if (savedCacheSecs) setCacheSecs(Number(savedCacheSecs) || 30);
        if (savedStartVolume) setStartVolume(Number(savedStartVolume));
        if (savedHwAccel !== null && savedHwAccel !== undefined) {
          setHardwareAcceleration(savedHwAccel !== 'false');
        }

        // Load EPG status
        const status = await getEpgStatus();
        setEpgStatus(status);

        // Load parental controls settings
        const { getParentalSettings, getBlockedChannels } = await import('../lib/tauri');
        const parentalSettings = await getParentalSettings();
        const blockedIds = await getBlockedChannels();

        setParentalEnabled(parentalSettings.enabled);
        setHasPin(parentalSettings.has_pin);
        setBlockedChannelIds(new Set(blockedIds));
        setBlockedCategories(parentalSettings.blocked_categories);
        setParentalAutoDetect(parentalSettings.auto_detect);
        setParentalVisibility(parentalSettings.visibility);
      } catch (err) {
        logger.error('Failed to load settings:', err);
      } finally {
        setIsLoading(false);
      }
    }

    loadSettings();
  }, []);

  // Keyboard navigation (Ctrl+1-6 for tab switching)
  useEffect(() => {
    const handleKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey) {
        const tabMap: Record<string, string> = {
          '1': 'general',
          '2': 'playback',
          '3': 'epg',
          '4': 'parental',
          '5': 'profiles',
          '6': 'about',
        };
        if (tabMap[e.key]) {
          e.preventDefault();
          setActiveTab(tabMap[e.key]);
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Error helper
  const showError = (title: string, message: string) => {
    setErrorTitle(title);
    setErrorMessage(message);
    setShowErrorModal(true);
  };

  // EPG handlers
  const handleForceEpgUpdate = async () => {
    if (isUpdatingEpg) return;

    setIsUpdatingEpg(true);
    try {
      logger.info('Force refreshing EPG data...');
      const result = await forceRefreshEpg();

      if (result.success) {
        logger.info(`EPG refresh successful: ${result.programs_loaded} programs loaded`);
        const newStatus = await getEpgStatus();
        setEpgStatus(newStatus);
        triggerEpgRefresh();
      } else {
        logger.error('EPG refresh failed:', result.error);
        showError('EPG Update Failed', result.error || 'Unknown error occurred');
      }
    } catch (err) {
      logger.error('Failed to refresh EPG:', err);
      showError('EPG Update Failed', `Failed to refresh EPG: ${err}`);
    } finally {
      setIsUpdatingEpg(false);
    }
  };

  // Parental control handlers
  const handleResetPin = () => setShowResetPinModal(true);

  const handleResetPinSuccess = () => {
    setShowResetPinModal(false);
    setShowResetPinConfirmation(true);
  };

  const handleConfirmReset = async () => {
    try {
      await resetParentalPin();
      setHasPin(false);
      setParentalEnabled(false);
      logger.info('Parental PIN reset successfully');
    } catch (err) {
      logger.error('Failed to reset PIN:', err);
      showError('Failed to Reset PIN', `Failed to reset PIN: ${err}`);
    }
  };

  const handlePinSet = async () => {
    setHasPin(true);
    await loadParentalSettings();
    logger.info('Parental PIN set successfully');
  };

  const handleBlockedChannelsUpdate = (ids: Set<number>) => {
    setBlockedChannelIds(ids);
  };

  // Save handler
  const handleSave = async () => {
    try {
      setIsSaving(true);
      await setSetting('epg_url', epgUrl);
      await setSetting('theme', theme);

      // Save language settings (store ISO codes for MPV)
      const audioIso = LANGUAGE_OPTIONS.find((l) => l.code === audioLang)?.iso || '';
      const subtitleIso = LANGUAGE_OPTIONS.find((l) => l.code === subtitleLang)?.iso || '';
      await setSetting('audio_language', audioIso);
      await setSetting('subtitle_language', subtitleIso);

      const sanitizedCustomUserAgent = playlistUserAgentCustom.trim();
      if (playlistUserAgentMode === 'custom' && !sanitizedCustomUserAgent) {
        showError(
          'Invalid User-Agent',
          'Custom User-Agent cannot be empty when Custom is selected.'
        );
        return;
      }
      if (/\r|\n/.test(sanitizedCustomUserAgent)) {
        showError('Invalid User-Agent', 'Custom User-Agent cannot contain line breaks.');
        return;
      }
      if (sanitizedCustomUserAgent.length > 512) {
        showError('Invalid User-Agent', 'Custom User-Agent cannot be longer than 512 characters.');
        return;
      }

      await setSetting('playlist_user_agent_mode', playlistUserAgentMode);
      await setSetting('playlist_user_agent_custom', sanitizedCustomUserAgent);

      // Save MPV playback settings
      await setSetting('mpv_hardware_acceleration', hardwareAcceleration.toString());
      await setSetting('mpv_video_output', videoOutput);
      await setSetting('mpv_deinterlace', deinterlace);
      await setSetting('mpv_start_fullscreen', startFullscreen.toString());
      await setSetting('mpv_cache_secs', cacheSecs.toString());
      await setSetting('mpv_start_volume', startVolume.toString());

      // Save parental controls settings
      await setSetting('parental_enabled', parentalEnabled.toString());
      await setSetting('parental_auto_detect', parentalAutoDetect.toString());
      await setSetting('parental_visibility', parentalVisibility);

      // If auto-detect is enabled, scan all channels and add adult content to blocked list
      let updatedBlockedIds = new Set(blockedChannelIds);
      if (parentalAutoDetect) {
        const { isAdultContent } = await import('../lib/parentalControls');
        channels.forEach((channel) => {
          if (channel.id && isAdultContent(channel.name, channel.group_name)) {
            updatedBlockedIds.add(channel.id);
          }
        });
        logger.info(
          `Auto-detect found ${updatedBlockedIds.size - blockedChannelIds.size} additional adult channels`
        );
      }

      const { setBlockedChannels } = await import('../lib/tauri');
      await setBlockedChannels(Array.from(updatedBlockedIds));
      await setSetting('parental_blocked_categories', JSON.stringify(blockedCategories));

      setBlockedChannelIds(updatedBlockedIds);
      await loadParentalSettings();

      // Only fetch EPG data if URL has actually changed
      const epgUrlChanged = epgUrl.trim() !== originalEpgUrl.trim();
      if (epgUrlChanged && epgUrl.trim()) {
        logger.info('EPG URL changed, fetching new data from:', epgUrl);
        const count = await fetchEpgData(epgUrl);
        logger.info(`EPG fetched successfully: ${count} programs`);

        const newStatus = await getEpgStatus();
        setEpgStatus(newStatus);
        triggerEpgRefresh();
      } else if (epgUrlChanged) {
        logger.debug('EPG URL cleared, skipping fetch');
      } else {
        logger.debug('EPG URL unchanged, skipping fetch');
      }

      logger.info('Settings saved successfully');
      onClose();
    } catch (err) {
      logger.error('Failed to save settings:', err);
      showError(
        'Failed to Save Settings',
        `Failed to save settings: ${err}. Please check the EPG URL and try again.`
      );
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm">
      <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-lg bg-white shadow-xl dark:bg-gray-800">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-gray-200 p-6 dark:border-gray-700">
          <h2 className="text-2xl font-bold text-gray-900 dark:text-white">Settings</h2>
          <button
            onClick={onClose}
            className="rounded-lg p-2 transition-colors hover:bg-gray-100 dark:hover:bg-gray-700"
          >
            <X className="h-5 w-5 text-gray-600 dark:text-gray-400" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6">
          <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
            <TabsList>
              <TabsTrigger value="general">General</TabsTrigger>
              <TabsTrigger value="playback">Playback</TabsTrigger>
              <TabsTrigger value="epg">EPG</TabsTrigger>
              <TabsTrigger value="parental">Parental</TabsTrigger>
              <TabsTrigger value="profiles">Profiles</TabsTrigger>
              <TabsTrigger value="about">About</TabsTrigger>
            </TabsList>

            <TabsContent value="general">
              <GeneralTab
                theme={theme}
                onThemeChange={setTheme}
                playlistUserAgentMode={playlistUserAgentMode}
                onPlaylistUserAgentModeChange={setPlaylistUserAgentMode}
                playlistUserAgentCustom={playlistUserAgentCustom}
                onPlaylistUserAgentCustomChange={setPlaylistUserAgentCustom}
                onRefreshPlaylist={
                  currentPlaylist?.id ? () => setShowRefreshModal(true) : undefined
                }
                playlistName={currentPlaylist?.name}
              />
            </TabsContent>

            <TabsContent value="playback">
              <PlaybackTab
                hardwareAcceleration={hardwareAcceleration}
                onHardwareAccelerationChange={setHardwareAcceleration}
                videoOutput={videoOutput}
                onVideoOutputChange={setVideoOutput}
                deinterlace={deinterlace}
                onDeinterlaceChange={setDeinterlace}
                startFullscreen={startFullscreen}
                onStartFullscreenChange={setStartFullscreen}
                cacheSecs={cacheSecs}
                onCacheSecsChange={setCacheSecs}
                startVolume={startVolume}
                onStartVolumeChange={setStartVolume}
                audioLang={audioLang}
                onAudioLangChange={setAudioLang}
                subtitleLang={subtitleLang}
                onSubtitleLangChange={setSubtitleLang}
              />
            </TabsContent>

            <TabsContent value="epg">
              <EpgTab
                epgUrl={epgUrl}
                onEpgUrlChange={setEpgUrl}
                epgStatus={epgStatus}
                isUpdatingEpg={isUpdatingEpg}
                onForceEpgUpdate={handleForceEpgUpdate}
              />
            </TabsContent>

            <TabsContent value="parental">
              <ParentalTab
                enabled={parentalEnabled}
                onEnabledChange={setParentalEnabled}
                hasPin={hasPin}
                onSetPin={() => setShowSetPinModal(true)}
                onChangePin={() => setShowChangePinModal(true)}
                onResetPin={handleResetPin}
                blockedCount={blockedChannelIds.size}
                onOpenChannelBlocking={() => setShowChannelBlockingModal(true)}
                autoDetect={parentalAutoDetect}
                onAutoDetectChange={setParentalAutoDetect}
                visibility={parentalVisibility}
                onVisibilityChange={setParentalVisibility}
              />
            </TabsContent>

            <TabsContent value="profiles">
              <ProfileManager onClose={onClose} />
            </TabsContent>

            <TabsContent value="about">
              <AboutTab />
            </TabsContent>
          </Tabs>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 border-t border-gray-200 p-6 dark:border-gray-700">
          <button
            onClick={onClose}
            className="rounded-lg px-4 py-2 text-gray-700 transition-colors hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={isSaving || isLoading}
            className="rounded-lg bg-blue-600 px-4 py-2 text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isSaving ? 'Saving...' : 'Save Changes'}
          </button>
        </div>
      </div>

      {/* Modals */}
      <PinEntryModal
        isOpen={showSetPinModal}
        onClose={() => setShowSetPinModal(false)}
        onSuccess={handlePinSet}
        mode="set"
      />

      <PinEntryModal
        isOpen={showChangePinModal}
        onClose={() => setShowChangePinModal(false)}
        onSuccess={handlePinSet}
        mode="change"
      />

      <PinEntryModal
        isOpen={showResetPinModal}
        onClose={() => setShowResetPinModal(false)}
        onSuccess={handleResetPinSuccess}
        mode="verify"
        title="Enter PIN to reset parental controls"
      />

      <ConfirmationModal
        isOpen={showResetPinConfirmation}
        onClose={() => setShowResetPinConfirmation(false)}
        onConfirm={handleConfirmReset}
        title="Reset PIN?"
        message="Are you sure you want to reset the PIN? This will also disable parental controls."
        confirmText="Reset PIN"
        cancelText="Cancel"
        confirmVariant="danger"
      />

      <ChannelBlockingModal
        isOpen={showChannelBlockingModal}
        onClose={() => setShowChannelBlockingModal(false)}
        channels={channels}
        initialBlockedIds={blockedChannelIds}
        onUpdate={handleBlockedChannelsUpdate}
      />

      <ErrorModal
        isOpen={showErrorModal}
        onClose={() => setShowErrorModal(false)}
        title={errorTitle}
        message={errorMessage}
      />

      {currentPlaylist?.id && (
        <RefreshModal
          isOpen={showRefreshModal}
          onClose={() => setShowRefreshModal(false)}
          playlistId={currentPlaylist.id}
          playlistName={currentPlaylist.name}
          onRefreshComplete={async () => {
            // Reload channels after refresh
            if (currentPlaylist.id) {
              try {
                const freshChannels = await getChannels(currentPlaylist.id);
                setChannels(freshChannels);
              } catch (err) {
                logger.error('Failed to reload channels after refresh:', err);
              }
            }
          }}
        />
      )}
    </div>
  );
}
