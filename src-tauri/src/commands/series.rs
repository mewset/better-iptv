use crate::commands::playback::build_playback_options;
use crate::error::AppError;
use crate::playlist::{fetch_series_info, SeriesInfo, XtreamCredentials};
use crate::series_domain::{self, PlaylistEpisode};
use crate::state::AppState;
use log::info;
use tauri::State;

#[tauri::command]
pub async fn get_series_info(
    server_url: String,
    username: String,
    password: String,
    series_id: i64,
) -> Result<SeriesInfo, AppError> {
    series_domain::validate_server_url(&server_url)?;
    series_domain::validate_credentials(&username, &password)?;

    let creds = XtreamCredentials {
        server_url,
        username,
        password,
    };

    fetch_series_info(&creds, series_id)
        .await
        .map_err(|e| AppError::Http(e.to_string()))
}

#[tauri::command]
pub async fn play_episode_with_season(
    state: State<'_, AppState>,
    server_url: String,
    username: String,
    password: String,
    episodes: Vec<PlaylistEpisode>,
) -> Result<(), AppError> {
    series_domain::validate_episodes(&episodes)?;
    series_domain::validate_server_url(&server_url)?;
    series_domain::validate_credentials(&username, &password)?;

    let urls = series_domain::build_episode_urls(&server_url, &username, &password, &episodes);

    let first_title = &episodes[0].title;

    {
        let mut current = state.current_channel.write().await;
        *current = Some(crate::state::CurrentChannel {
            id: None,
            name: first_title.clone(),
            url: urls[0].clone(),
            content_type: "series".to_string(),
        });
    }

    let settings = {
        let conn = state.pool.get()?;
        build_playback_options(&conn, Some(first_title))?
    };

    let mut player = state.mpv_player.lock().await;
    player
        .play_playlist(&urls, &settings.as_options())
        .map_err(|e| AppError::Mpv(e.to_string()))?;

    info!("Playing series episode: {}", first_title);

    Ok(())
}
