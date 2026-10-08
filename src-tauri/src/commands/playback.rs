use crate::commands::with_db;
use crate::db::queries;
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
    "playlist_user_agent_mode",
    "playlist_user_agent_custom",
];

/// Build playback settings from database settings
pub fn build_playback_options(
    db: &rusqlite::Connection,
    title: Option<&str>,
) -> Result<PlaybackSettings, AppError> {
    let settings = queries::get_multiple_settings(db, MPV_SETTING_KEYS)?;

    let audio_lang = settings
        .get("audio_language")
        .filter(|s| !s.is_empty())
        .cloned();
    let subtitle_lang = settings
        .get("subtitle_language")
        .filter(|s| !s.is_empty())
        .cloned();
    let hwdec = settings
        .get("mpv_hardware_acceleration")
        .map(|s| s != "false")
        .unwrap_or(true);
    let video_output = settings.get("mpv_video_output").cloned();
    let deinterlace = settings.get("mpv_deinterlace").cloned();
    let start_fullscreen = settings
        .get("mpv_start_fullscreen")
        .map(|s| s == "true")
        .unwrap_or(false);
    let cache_secs = settings
        .get("mpv_cache_secs")
        .and_then(|s| s.parse::<u32>().ok());
    let start_volume = settings
        .get("mpv_start_volume")
        .and_then(|s| s.parse::<u32>().ok());
    // The stream carries the same User-Agent as the playlist and EPG requests.
    let user_agent = crate::http::resolve_playlist_user_agent(
        settings.get("playlist_user_agent_mode").map(|s| s.as_str()),
        settings
            .get("playlist_user_agent_custom")
            .map(|s| s.as_str()),
    );

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
        user_agent: Some(user_agent),
    })
}

#[tauri::command]
pub async fn check_mpv_installed() -> Result<bool, AppError> {
    playback::check_mpv_installed().await
}

#[tauri::command]
/// Plays a channel from the database. The frontend sends only the id: the
/// stream URL never leaves the backend, so the webview cannot hand MPV an
/// address of its own.
pub async fn play_channel(state: State<'_, AppState>, channel_id: i64) -> Result<(), AppError> {
    let (channel, settings) = with_db(&state.pool, move |conn| {
        let channel = queries::get_channel_by_id(conn, channel_id)?
            .ok_or(AppError::ChannelNotFound(channel_id))?;
        let settings = build_playback_options(conn, Some(&channel.name))?;
        Ok((channel, settings))
    })
    .await?;

    playback::play_stream(state.mpv_player.clone(), channel.url.clone(), settings).await?;

    *state.current_channel.write().await = Some(CurrentChannel::from_channel(&channel));

    info!(
        "Playing channel: {} ({})",
        channel.name, channel.content_type
    );

    Ok(())
}

#[tauri::command]
pub async fn stop_playback(state: State<'_, AppState>) -> Result<(), AppError> {
    playback::stop(state.mpv_player.clone()).await?;

    *state.current_channel.write().await = None;

    info!("Playback stopped");

    Ok(())
}

/// Whether MPV is still playing, and whether it stopped because the stream failed.
#[tauri::command]
pub async fn playback_status(
    state: State<'_, AppState>,
) -> Result<playback::mpv::PlaybackStatus, AppError> {
    playback::status(state.mpv_player.clone()).await
}
