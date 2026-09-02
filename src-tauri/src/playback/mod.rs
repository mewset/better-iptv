pub mod mpv;

use crate::error::AppError;
use mpv::{MpvPlaybackOptions, MpvPlayer};
use std::sync::{Arc, Mutex, MutexGuard};

/// The MPV controller shared between commands.
pub type SharedPlayer = Arc<Mutex<MpvPlayer>>;

/// Owned MPV settings, read from the database and converted to borrowed
/// `MpvPlaybackOptions` right before spawning.
pub struct PlaybackSettings {
    pub title: Option<String>,
    pub audio_lang: Option<String>,
    pub subtitle_lang: Option<String>,
    pub hwdec: bool,
    pub video_output: Option<String>,
    pub deinterlace: Option<String>,
    pub start_fullscreen: bool,
    pub cache_secs: Option<u32>,
    pub start_volume: Option<u32>,
}

impl PlaybackSettings {
    pub fn as_options(&self) -> MpvPlaybackOptions<'_> {
        MpvPlaybackOptions {
            title: self.title.as_deref(),
            audio_lang: self.audio_lang.as_deref(),
            subtitle_lang: self.subtitle_lang.as_deref(),
            hwdec: self.hwdec,
            video_output: self.video_output.as_deref(),
            deinterlace: self.deinterlace.as_deref(),
            start_fullscreen: self.start_fullscreen,
            cache_secs: self.cache_secs,
            start_volume: self.start_volume,
        }
    }
}

fn lock_player(player: &SharedPlayer) -> Result<MutexGuard<'_, MpvPlayer>, AppError> {
    player
        .lock()
        .map_err(|_| AppError::Mpv("MPV player lock poisoned".to_string()))
}

/// Spawn MPV for a single stream. Stopping a previous instance can block for
/// up to five seconds, so the whole operation runs on the blocking pool.
pub async fn play_stream(
    player: SharedPlayer,
    url: String,
    settings: PlaybackSettings,
) -> Result<(), AppError> {
    tokio::task::spawn_blocking(move || {
        let mut mpv = lock_player(&player)?;
        mpv.play_stream(&url, &settings.as_options())
            .map_err(|e| AppError::Mpv(e.to_string()))
    })
    .await?
}

/// Spawn MPV with a queue of URLs (series episodes).
pub async fn play_playlist(
    player: SharedPlayer,
    urls: Vec<String>,
    settings: PlaybackSettings,
) -> Result<(), AppError> {
    tokio::task::spawn_blocking(move || {
        let mut mpv = lock_player(&player)?;
        mpv.play_playlist(&urls, &settings.as_options())
            .map_err(|e| AppError::Mpv(e.to_string()))
    })
    .await?
}

/// Kill the running MPV process, if any.
pub async fn stop(player: SharedPlayer) -> Result<(), AppError> {
    tokio::task::spawn_blocking(move || {
        let mut mpv = lock_player(&player)?;
        mpv.stop().map_err(|e| AppError::Mpv(e.to_string()))
    })
    .await?
}

/// Poll whether the MPV process is still alive.
pub async fn is_playing(player: SharedPlayer) -> Result<bool, AppError> {
    tokio::task::spawn_blocking(move || {
        let mut mpv = lock_player(&player)?;
        Ok(mpv.is_playing())
    })
    .await?
}

/// Check if MPV is installed on the system (runs `mpv --version`).
pub async fn check_mpv_installed() -> Result<bool, AppError> {
    Ok(tokio::task::spawn_blocking(MpvPlayer::check_installed).await?)
}
