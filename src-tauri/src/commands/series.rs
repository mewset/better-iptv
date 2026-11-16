use crate::commands::playback::build_playback_options;
use crate::commands::playlist::get_playlist_user_agent;
use crate::commands::{progress, with_db};
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
    state: State<'_, AppState>,
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

    // The same User-Agent as every other request to the provider: one that
    // only answers a known player would otherwise list its series and then
    // refuse to open any of them.
    let user_agent = with_db(&state.pool, get_playlist_user_agent).await?;

    fetch_series_info(&creds, series_id, Some(&user_agent))
        .await
        .map_err(|e| AppError::Http(e.to_string()))
}

/// The Xtream series id behind a series row, read from its stream URL so the
/// URL itself stays in the backend. None when the URL does not end in one.
#[tauri::command]
pub async fn get_xtream_series_id(
    state: State<'_, AppState>,
    channel_id: i64,
) -> Result<Option<i64>, AppError> {
    with_db(&state.pool, move |conn| {
        let channel = queries::get_channel_by_id(conn, channel_id)?
            .ok_or(AppError::ChannelNotFound(channel_id))?;
        Ok(series_domain::parse_xtream_series_id(&channel.url))
    })
    .await
}

#[tauri::command]
pub async fn play_episode_with_season(
    state: State<'_, AppState>,
    server_url: String,
    username: String,
    password: String,
    episodes: Vec<PlaylistEpisode>,
    // The series' channel, for watch progress (older callers leave it out)
    series_channel_id: Option<i64>,
    // Seconds into the first episode to start at (resuming)
    start_secs: Option<f64>,
) -> Result<(), AppError> {
    series_domain::validate_episodes(&episodes)?;
    series_domain::validate_server_url(&server_url)?;
    series_domain::validate_credentials(&username, &password)?;

    let urls = series_domain::build_episode_urls(&server_url, &username, &password, &episodes);
    let first_title = episodes[0].title.clone();
    let first_url = urls[0].clone();

    let title_for_settings = first_title.clone();
    let (mut settings, series_name) = with_db(&state.pool, move |conn| {
        let settings = build_playback_options(conn, Some(&title_for_settings))?;
        // The series' name heads the player's title ("Series  S2:E5  Name")
        let name = match series_channel_id {
            Some(id) => queries::get_channel_by_id(conn, id)?.map(|c| c.name),
            None => None,
        };
        Ok((settings, name))
    })
    .await?;
    settings.start_secs = start_secs;
    playback::add_controls(
        &mut settings,
        playback::player::PlayerKind {
            series: series_name.as_deref(),
            live: false,
        },
    );
    let episode_ids: Vec<String> = episodes.iter().map(|e| e.id.clone()).collect();
    // Each episode under its title ("S2 E5 · Name") in the player's list
    let entries = episodes.iter().map(|e| e.title.clone()).zip(urls).collect();

    progress::end_session(&state).await;
    playback::play_episodes(state.mpv_player.clone(), entries, settings).await?;
    if let Some(series) = series_channel_id {
        progress::begin_session(&state, series, episode_ids);
    }

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
    // Seconds into the first episode to start at (resuming)
    start_secs: Option<f64>,
) -> Result<(), AppError> {
    if episode_ids.is_empty() {
        return Err(AppError::InvalidInput("No episodes provided".to_string()));
    }

    let ids = episode_ids.clone();
    let (episodes, mut settings, series_name) = with_db(&state.pool, move |conn| {
        let rows = queries::get_series_episodes_by_ids(conn, &ids)?;
        let ordered = series_domain::order_episodes_by_ids(rows, &ids)?;
        let settings = build_playback_options(conn, Some(&ordered[0].title))?;
        let name = queries::get_channel_by_id(conn, ordered[0].series_channel_id)?.map(|c| c.name);
        Ok((ordered, settings, name))
    })
    .await?;

    let first = &episodes[0];
    settings.start_secs = start_secs;
    playback::add_controls(
        &mut settings,
        playback::player::PlayerKind {
            series: series_name.as_deref(),
            live: false,
        },
    );
    let entries = episodes
        .iter()
        .map(|e| {
            (
                format!("S{} E{} · {}", e.season, e.episode, e.title),
                e.url.clone(),
            )
        })
        .collect();

    progress::end_session(&state).await;
    playback::play_episodes(state.mpv_player.clone(), entries, settings).await?;
    // Every queued episode belongs to the first one's series (the frontend
    // queues one season), and progress keys them by their row id
    progress::begin_session(
        &state,
        first.series_channel_id,
        episodes.iter().map(|e| e.id.to_string()).collect(),
    );

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
