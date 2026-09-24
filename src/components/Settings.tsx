import { useState, useEffect, useRef } from 'react';
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
import { applyTheme } from '../lib/theme';
import { cn } from '../lib/utils';
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

/** The left nav's sections, in display order. Ctrl+1-6 below maps to these by index. */
const SECTIONS: Array<{ value: string; name: string; description: string }> = [
  { value: 'general', name: 'General', description: 'Playlist, appearance, updates' },
  { value: 'playback', name: 'Playback', description: 'MPV, video, audio, subtitles' },
  { value: 'epg', name: 'EPG', description: 'Guide sources and refresh' },
  { value: 'parental', name: 'Parental', description: 'PIN and blocked content' },
  { value: 'profiles', name: 'Profiles', description: 'Playlists and providers' },
  { value: 'about', name: 'About', description: 'Version and licenses' },
];

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
  const [updateCheckEnabled, setUpdateCheckEnabled] = useState(true);

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
  const [showDisablePinModal, setShowDisablePinModal] = useState(false);
  const [showResetPinConfirmation, setShowResetPinConfirmation] = useState(false);
  const [showChannelBlockingModal, setShowChannelBlockingModal] = useState(false);
  const [showErrorModal, setShowErrorModal] = useState(false);
  const [errorTitle, setErrorTitle] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [showRefreshModal, setShowRefreshModal] = useState(false);

  // Reserves room at the bottom of the scrolling content for the sticky
  // footer below, so its own natural flow height never sits under it -
  // sticky keeps the footer glued to the viewport bottom instead of
  // pushing content up, so without this the last ~footer-height of a long
  // section (e.g. Playback) renders behind it. Measured rather than
  // hardcoded since the footer's height depends on its own padding/button
  // sizing, not a value this component should have to know.
  const footerRef = useRef<globalThis.HTMLDivElement>(null);
  const [footerHeight, setFooterHeight] = useState(0);

  useEffect(() => {
    const measure = () => {
      if (footerRef.current) setFooterHeight(footerRef.current.getBoundingClientRect().height);
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);

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
        const savedUpdateCheck = await getSetting('update_check_enabled');

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
        // Absent means never saved, which is the default: on.
        if (savedUpdateCheck !== null) {
          setUpdateCheckEnabled(savedUpdateCheck !== 'false');
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

  // Escape closes the view - but only when nothing "inner" wants the key
  // first. Unlike TopBar's profile menu (a self-contained popup), Settings
  // hosts arbitrary descendants - an inline profile rename input, PIN/
  // blocking/confirmation/refresh/error modals, ProfileManager's own Setup
  // and delete-last-profile overlays - that must get to handle Escape
  // themselves (cancel the rename, do nothing and let the open dialog's own
  // Cancel button be used, etc). So this listener does NOT stopPropagation:
  // it only marks the event via `preventDefault` (capture phase, ahead of
  // useKeyboardShortcuts' bubble-phase handler, which treats a
  // defaultPrevented Escape as already spoken for and never stops
  // playback), then closes the view unless the target is a form field, one
  // of Settings' own modal flags is set, or any `aria-modal="true"` dialog
  // is open anywhere in the document (Settings' modals and ProfileManager's
  // two inline overlays all carry that attribute on their panel).
  useEffect(() => {
    const modalOpen =
      showSetPinModal ||
      showChangePinModal ||
      showResetPinModal ||
      showDisablePinModal ||
      showResetPinConfirmation ||
      showChannelBlockingModal ||
      showErrorModal ||
      showRefreshModal;

    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();

      const target = e.target as globalThis.HTMLElement | null;
      const isFormField =
        target instanceof globalThis.HTMLInputElement ||
        target instanceof globalThis.HTMLTextAreaElement ||
        target instanceof globalThis.HTMLSelectElement ||
        target?.isContentEditable;
      if (isFormField) return;

      if (modalOpen) return;
      if (document.querySelector('[aria-modal="true"]')) return;

      onClose();
    };

    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [
    onClose,
    showSetPinModal,
    showChangePinModal,
    showResetPinModal,
    showDisablePinModal,
    showResetPinConfirmation,
    showChannelBlockingModal,
    showErrorModal,
    showRefreshModal,
  ]);

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
      await setSetting('update_check_enabled', updateCheckEnabled.toString());

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

  const activeSection = SECTIONS.find((s) => s.value === activeTab) ?? SECTIONS[0];

  return (
    <div id="settings-view" className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <Tabs value={activeTab} onValueChange={setActiveTab} orientation="vertical">
        <div className="flex gap-10 px-10 pt-7" style={{ paddingBottom: footerHeight }}>
          <nav aria-label="Settings sections" className="w-[240px] shrink-0">
            <TabsList className="flex h-auto w-full flex-col items-stretch justify-start gap-1 border-b-0">
              {SECTIONS.map(({ value, name, description }) => {
                const active = activeTab === value;
                const descriptionId = `settings-section-${value}-description`;
                return (
                  <TabsTrigger
                    key={value}
                    value={value}
                    aria-label={name}
                    aria-describedby={descriptionId}
                    className={cn(
                      'flex w-full flex-col items-start gap-0.5 rounded-lg border border-transparent px-4 py-3 text-left text-text-muted transition-colors hover:text-text',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
                      'data-[state=active]:border-border-strong data-[state=active]:bg-text/5 data-[state=active]:text-text'
                    )}
                  >
                    <span className="text-sm font-semibold">{name}</span>
                    <span
                      id={descriptionId}
                      className={cn('text-xs', active ? 'text-text-muted' : 'text-text-faint')}
                    >
                      {description}
                    </span>
                  </TabsTrigger>
                );
              })}
            </TabsList>
          </nav>

          <div className="min-w-0 flex-1 pb-10">
            <h1 className="mb-6 font-display text-3xl font-semibold text-text">
              {activeSection.name}
            </h1>

            <TabsContent value="general" className="mt-0 min-h-0">
              <GeneralTab
                theme={theme}
                onThemeChange={(t) => {
                  setTheme(t);
                  applyTheme(t);
                }}
                playlistUserAgentMode={playlistUserAgentMode}
                onPlaylistUserAgentModeChange={setPlaylistUserAgentMode}
                playlistUserAgentCustom={playlistUserAgentCustom}
                onPlaylistUserAgentCustomChange={setPlaylistUserAgentCustom}
                onRefreshPlaylist={
                  currentPlaylist?.id ? () => setShowRefreshModal(true) : undefined
                }
                playlistName={currentPlaylist?.name}
                updateCheckEnabled={updateCheckEnabled}
                onUpdateCheckEnabledChange={setUpdateCheckEnabled}
              />
            </TabsContent>

            <TabsContent value="playback" className="mt-0 min-h-0">
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

            <TabsContent value="epg" className="mt-0 min-h-0">
              <EpgTab
                epgUrl={epgUrl}
                onEpgUrlChange={setEpgUrl}
                epgStatus={epgStatus}
                isUpdatingEpg={isUpdatingEpg}
                onForceEpgUpdate={handleForceEpgUpdate}
              />
            </TabsContent>

            <TabsContent value="parental" className="mt-0 min-h-0">
              <ParentalTab
                enabled={parentalEnabled}
                onEnabledChange={setParentalEnabled}
                onDisableRequest={() => setShowDisablePinModal(true)}
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

            <TabsContent value="profiles" className="mt-0 min-h-0">
              <ProfileManager onClose={onClose} />
            </TabsContent>

            <TabsContent value="about" className="mt-0 min-h-0">
              <AboutTab />
            </TabsContent>
          </div>
        </div>
      </Tabs>

      {/* Footer */}
      <div
        ref={footerRef}
        className="sticky bottom-0 flex items-center justify-end gap-3 border-t border-border bg-bg/90 px-10 py-6 backdrop-blur"
      >
        <button
          onClick={onClose}
          className="rounded-lg px-4 py-2 text-text-muted transition-colors hover:bg-surface-hover"
        >
          Cancel
        </button>
        <button
          onClick={handleSave}
          disabled={isSaving || isLoading}
          className="rounded-lg bg-accent px-4 py-2 text-on-accent transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isSaving ? 'Saving...' : 'Save Changes'}
        </button>
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

      <PinEntryModal
        isOpen={showDisablePinModal}
        onClose={() => setShowDisablePinModal(false)}
        onSuccess={() => {
          setShowDisablePinModal(false);
          setParentalEnabled(false);
          logger.info('Parental controls disabled after PIN verification');
        }}
        mode="verify"
        title="Enter PIN to disable parental controls"
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
