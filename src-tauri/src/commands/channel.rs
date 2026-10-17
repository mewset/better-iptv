use crate::channel_domain;
use crate::commands::with_db;
use crate::db::models::ChannelSummary;
use crate::db::{mutations, queries};
use crate::error::AppError;
use crate::state::AppState;
use log::debug;
use tauri::State;

#[tauri::command]
pub async fn get_channels(
    state: State<'_, AppState>,
    playlist_id: Option<i64>,
    content_types: Option<Vec<String>>,
) -> Result<Vec<ChannelSummary>, AppError> {
    if let Some(id) = playlist_id {
        channel_domain::validate_playlist_id(id)?;
    }
    if let Some(types) = &content_types {
        if types.is_empty() {
            return Err(AppError::InvalidInput(
                "content_types must not be empty".to_string(),
            ));
        }
        for ct in types {
            channel_domain::validate_content_type(ct)?;
        }
    }

    let types_for_log = content_types.clone();
    let channels = with_db(&state.pool, move |conn| {
        Ok(queries::get_channel_summaries(
            conn,
            playlist_id,
            content_types.as_deref(),
        )?)
    })
    .await?;
    debug!(
        "get_channels playlist_id={:?} content_types={:?} -> {} channels",
        playlist_id,
        types_for_log,
        channels.len()
    );
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
        Ok(queries::get_channel_groups(
            conn,
            playlist_id,
            content_type.as_deref(),
        )?)
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
pub async fn toggle_favorite(state: State<'_, AppState>, channel_id: i64) -> Result<(), AppError> {
    channel_domain::validate_channel_id(channel_id)?;

    with_db(&state.pool, move |conn| {
        Ok(mutations::toggle_favorite(conn, channel_id)?)
    })
    .await?;
    debug!("toggle_favorite channel_id={}", channel_id);
    Ok(())
}
