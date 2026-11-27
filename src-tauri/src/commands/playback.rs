use crate::commands::{progress, with_db};
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
        start_secs: None,
        extra_args: Vec::new(),
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
///
/// `start_secs` starts a film part-way (resuming); a film's progress is
/// recorded while it plays (`commands::progress`).
pub async fn play_channel(
    state: State<'_, AppState>,
    channel_id: i64,
    start_secs: Option<f64>,
) -> Result<(), AppError> {
    let (channel, mut settings) = with_db(&state.pool, move |conn| {
        let channel = queries::get_channel_by_id(conn, channel_id)?
            .ok_or(AppError::ChannelNotFound(channel_id))?;
        let mut settings = build_playback_options(conn, Some(&channel.name))?;
        // The controls show MPV's media title, else the stream's file name
        // ("916783.m3u8"); a film or channel is one file, so its name is it.
        settings
            .extra_args
            .push(format!("--force-media-title={}", channel.name));
        if channel.content_type == "vod" {
            settings.start_secs = start_secs;
        }
        Ok((channel, settings))
    })
    .await?;
    playback::add_controls(
        &mut settings,
        playback::player::PlayerKind {
            series: None,
            live: channel.content_type == "live",
        },
    );

    progress::end_session(&state).await;
    playback::play_stream(state.mpv_player.clone(), channel.url.clone(), settings).await?;
    if channel.content_type == "vod" {
        progress::begin_session(&state, channel_id, Vec::new());
    }

    *state.current_channel.write().await = Some(CurrentChannel::from_channel(&channel));

    info!(
        "Playing channel: {} ({})",
        channel.name, channel.content_type
    );

    Ok(())
}

#[tauri::command]
pub async fn stop_playback(state: State<'_, AppState>) -> Result<(), AppError> {
    progress::end_session(&state).await;
    playback::stop(state.mpv_player.clone()).await?;

    *state.current_channel.write().await = None;

    info!("Playback stopped");

    Ok(())
}

/// Whether the player is paused (None without one), for the now-playing bar.
#[tauri::command]
pub async fn player_paused() -> Result<Option<bool>, AppError> {
    playback::paused().await
}

/// Pause or resume the player from the now-playing bar.
#[tauri::command]
pub async fn player_set_paused(paused: bool) -> Result<bool, AppError> {
    playback::set_paused(paused).await
}

/// Bring the player window to the front (a click on the now-playing bar).
#[tauri::command]
pub async fn show_player(state: State<'_, AppState>) -> Result<(), AppError> {
    playback::show(state.mpv_player.clone()).await
}

/// What a live channel shows now, for the player's controls.
#[tauri::command]
pub async fn player_set_programme(title: String) -> Result<bool, AppError> {
    playback::set_programme(title).await
}

/// Whether MPV is still playing, and if it stopped on a failure, whether the
/// player or the stream was at fault.
#[tauri::command]
pub async fn playback_status(
    state: State<'_, AppState>,
) -> Result<playback::mpv::PlaybackStatus, AppError> {
    playback::status(state.mpv_player.clone()).await
}
