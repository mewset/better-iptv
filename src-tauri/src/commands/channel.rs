use crate::channel_domain;
use crate::commands::with_db;
use crate::db::models::Channel;
use crate::db::{mutations, queries};
use crate::error::AppError;
use crate::state::AppState;
use log::debug;
use tauri::State;

#[tauri::command]
pub async fn get_channels(
    state: State<'_, AppState>,
    playlist_id: Option<i64>,
) -> Result<Vec<Channel>, AppError> {
    if let Some(id) = playlist_id {
        channel_domain::validate_playlist_id(id)?;
    }

    let channels = with_db(&state.pool, move |conn| {
        Ok(queries::get_channels(conn, playlist_id)?)
    })
    .await?;
    debug!("get_channels playlist_id={:?} -> {} channels", playlist_id, channels.len());
    Ok(channels)
}

#[tauri::command]
pub async fn get_channel_groups(
    state: State<'_, AppState>,
    playlist_id: i64,
    content_type: Option<String>,
) -> Result<Vec<String>, AppError> {
    channel_domain::validate_playlist_id(playlist_id)?;

    if let Some(ref ct) = content_type {
        channel_domain::validate_content_type(ct)?;
    }

    let ct_for_log = content_type.clone();
    let groups = with_db(&state.pool, move |conn| {
        Ok(queries::get_channel_groups(conn, playlist_id, content_type.as_deref())?)
    })
    .await?;
    debug!(
        "get_channel_groups playlist_id={} type={:?} -> {} groups",
        playlist_id,
        ct_for_log,
        groups.len()
    );
    Ok(groups)
}

#[tauri::command]
pub async fn search_channels(
    state: State<'_, AppState>,
    query: String,
) -> Result<Vec<Channel>, AppError> {
    channel_domain::validate_search_query(&query)?;

    let query_for_log = query.clone();
    let channels = with_db(&state.pool, move |conn| {
        Ok(queries::search_channels(conn, &query)?)
    })
    .await?;
    debug!("search_channels query='{}' -> {} results", query_for_log, channels.len());
    Ok(channels)
}

#[tauri::command]
pub async fn toggle_favorite(state: State<'_, AppState>, channel_id: i64) -> Result<(), AppError> {
    channel_domain::validate_channel_id(channel_id)?;

    with_db(&state.pool, move |conn| {
        Ok(mutations::toggle_favorite(conn, channel_id)?)
    })
    .await?;
    debug!("toggle_favorite channel_id={}", channel_id);
    Ok(())
}

#[tauri::command]
pub async fn get_favorites(state: State<'_, AppState>) -> Result<Vec<Channel>, AppError> {
    let channels = with_db(&state.pool, |conn| Ok(queries::get_favorites(conn)?)).await?;
    debug!("get_favorites -> {} channels", channels.len());
    Ok(channels)
}
