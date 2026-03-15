use crate::db::{queries, models::Channel};
use crate::error::AppError;
use crate::playback;
use crate::playback::mpv::MpvPlaybackOptions;
use crate::state::AppState;
use log::info;
use tauri::State;

const MPV_SETTING_KEYS: &[&str] = &[
    "audio_language",
    "subtitle_language",
    "mpv_hardware_acceleration",
    "mpv_video_output",
    "mpv_deinterlace",
    "mpv_start_fullscreen",
    "mpv_cache_secs",
    "mpv_start_volume",
];

/// Build MpvPlaybackOptions from database settings
pub fn build_playback_options(
    db: &rusqlite::Connection,
    title: Option<&str>,
) -> Result<PlaybackSettings, AppError> {
    let settings = queries::get_multiple_settings(db, MPV_SETTING_KEYS)?;

    let audio_lang = settings.get("audio_language").filter(|s| !s.is_empty()).cloned();
    let subtitle_lang = settings.get("subtitle_language").filter(|s| !s.is_empty()).cloned();
    let hwdec = settings.get("mpv_hardware_acceleration").map(|s| s != "false").unwrap_or(true);
    let video_output = settings.get("mpv_video_output").cloned();
    let deinterlace = settings.get("mpv_deinterlace").cloned();
    let start_fullscreen = settings.get("mpv_start_fullscreen").map(|s| s == "true").unwrap_or(false);
    let cache_secs = settings.get("mpv_cache_secs").and_then(|s| s.parse::<u32>().ok());
    let start_volume = settings.get("mpv_start_volume").and_then(|s| s.parse::<u32>().ok());

    Ok(PlaybackSettings {
        title: title.map(|s| s.to_string()),
        audio_lang,
        subtitle_lang,
        hwdec,
        video_output,
        deinterlace,
        start_fullscreen,
        cache_secs,
        start_volume,
    })
}

/// Owned settings that can be converted to MpvPlaybackOptions references
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

#[tauri::command]
pub async fn check_mpv_installed() -> Result<bool, AppError> {
    Ok(playback::check_mpv_installed())
}

#[tauri::command]
pub async fn play_channel(state: State<'_, AppState>, channel: Channel) -> Result<(), AppError> {
    let settings = {
        let conn = state.pool.get()?;
        build_playback_options(&conn, Some(&channel.name))?
    };

    let mut player = state.mpv_player.lock().await;
    playback::play_channel(
        &mut player,
        &state.current_channel,
        &channel,
        &settings.as_options(),
    )
    .await?;

    info!("Playing channel: {} ({})", channel.name, channel.content_type);

    Ok(())
}

#[tauri::command]
pub async fn stop_playback(state: State<'_, AppState>) -> Result<(), AppError> {
    let mut player = state.mpv_player.lock().await;
    playback::stop(&mut player, &state.current_channel).await?;

    info!("Playback stopped");

    Ok(())
}

#[tauri::command]
pub async fn is_playing(state: State<'_, AppState>) -> Result<bool, AppError> {
    let mut player = state.mpv_player.lock().await;
    Ok(playback::is_playing(&mut player))
}
