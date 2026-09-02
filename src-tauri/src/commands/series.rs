use crate::commands::playback::build_playback_options;
use crate::commands::with_db;
use crate::db::queries;
use crate::error::AppError;
use crate::playback;
use crate::playlist::{fetch_series_info, SeriesInfo, XtreamCredentials};
use crate::series_domain::{self, PlaylistEpisode};
use crate::state::{AppState, CurrentChannel};
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
    let first_title = episodes[0].title.clone();
    let first_url = urls[0].clone();

    let title_for_settings = first_title.clone();
    let settings = with_db(&state.pool, move |conn| {
        build_playback_options(conn, Some(&title_for_settings))
    })
    .await?;

    playback::play_playlist(state.mpv_player.clone(), urls, settings).await?;

    *state.current_channel.write().await = Some(CurrentChannel {
        id: None,
        name: first_title.clone(),
        url: first_url,
        content_type: "series".to_string(),
    });

    info!("Playing series episode: {}", first_title);

    Ok(())
}

/// Seasons and episodes of an M3U series, read from `series_episodes`.
#[tauri::command]
pub async fn get_local_series_info(
    state: State<'_, AppState>,
    channel_id: i64,
) -> Result<SeriesInfo, AppError> {
    with_db(&state.pool, move |conn| {
        let channel = queries::get_channel_by_id(conn, channel_id)?
            .ok_or(AppError::ChannelNotFound(channel_id))?;
        if channel.content_type != "series" {
            return Err(AppError::InvalidInput(format!(
                "Channel {} is not a series",
                channel_id
            )));
        }
        let episodes = queries::get_series_episodes(conn, channel_id)?;
        Ok(series_domain::build_series_info(&channel, &episodes))
    })
    .await
}

/// Queue stored M3U episodes in MPV, in the order given. URLs come from the
/// database, never from the frontend.
#[tauri::command]
pub async fn play_series_episodes(
    state: State<'_, AppState>,
    episode_ids: Vec<i64>,
) -> Result<(), AppError> {
    if episode_ids.is_empty() {
        return Err(AppError::InvalidInput("No episodes provided".to_string()));
    }

    let ids = episode_ids.clone();
    let (episodes, settings) = with_db(&state.pool, move |conn| {
        let rows = queries::get_series_episodes_by_ids(conn, &ids)?;
        let ordered = series_domain::order_episodes_by_ids(rows, &ids)?;
        let settings = build_playback_options(conn, Some(&ordered[0].title))?;
        Ok((ordered, settings))
    })
    .await?;

    let urls: Vec<String> = episodes.iter().map(|e| e.url.clone()).collect();
    let first = &episodes[0];

    playback::play_playlist(state.mpv_player.clone(), urls, settings).await?;

    *state.current_channel.write().await = Some(CurrentChannel {
        id: None,
        name: first.title.clone(),
        url: first.url.clone(),
        content_type: "series".to_string(),
    });

    info!(
        "Playing M3U series episode: {} ({} queued)",
        first.title,
        episodes.len()
    );

    Ok(())
}
