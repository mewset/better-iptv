use crate::commands::with_db;
use crate::db::{models::Channel, queries};
use crate::error::AppError;
use crate::playback::{self, PlaybackSettings};
use crate::state::{AppState, CurrentChannel};
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

/// Build playback settings from database settings
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

#[tauri::command]
pub async fn check_mpv_installed() -> Result<bool, AppError> {
    playback::check_mpv_installed().await
}

#[tauri::command]
pub async fn play_channel(state: State<'_, AppState>, channel: Channel) -> Result<(), AppError> {
    let title = channel.name.clone();
    let settings = with_db(&state.pool, move |conn| {
        build_playback_options(conn, Some(&title))
    })
    .await?;

    playback::play_stream(state.mpv_player.clone(), channel.url.clone(), settings).await?;

    *state.current_channel.write().await = Some(CurrentChannel::from_channel(&channel));

    info!("Playing channel: {} ({})", channel.name, channel.content_type);

    Ok(())
}

#[tauri::command]
pub async fn stop_playback(state: State<'_, AppState>) -> Result<(), AppError> {
    playback::stop(state.mpv_player.clone()).await?;

    *state.current_channel.write().await = None;

    info!("Playback stopped");

    Ok(())
}

#[tauri::command]
pub async fn is_playing(state: State<'_, AppState>) -> Result<bool, AppError> {
    playback::is_playing(state.mpv_player.clone()).await
}
