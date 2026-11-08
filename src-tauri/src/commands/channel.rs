use crate::channel_domain;
use crate::commands::with_db;
use crate::db::models::{CategoryGroups, ChannelSummary};
use crate::db::{mutations, pinned_categories, queries};
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

/// The section's categories for the category bar: pinned ones first (in pin
/// order), then the rest in provider order. One answer, so the bar paints once.
#[tauri::command]
pub async fn get_channel_groups(
    state: State<'_, AppState>,
    playlist_id: i64,
    content_type: String,
) -> Result<CategoryGroups, AppError> {
    channel_domain::validate_playlist_id(playlist_id)?;
    channel_domain::validate_content_type(&content_type)?;

    let ct_for_log = content_type.clone();
    let groups = with_db(&state.pool, move |conn| {
        Ok(pinned_categories::get_category_groups(
            conn,
            playlist_id,
            &content_type,
        )?)
    })
    .await?;
    debug!(
        "get_channel_groups playlist_id={} type={} -> {} pinned, {} others",
        playlist_id,
        ct_for_log,
        groups.pinned.len(),
        groups.others.len()
    );
    Ok(groups)
}

/// Pin or unpin a category in one section of a profile, and answer with the
/// section's categories as they now stand.
#[tauri::command]
pub async fn set_category_pinned(
    state: State<'_, AppState>,
    playlist_id: i64,
    content_type: String,
    group_name: String,
    pinned: bool,
) -> Result<CategoryGroups, AppError> {
    channel_domain::validate_playlist_id(playlist_id)?;
    channel_domain::validate_content_type(&content_type)?;
    channel_domain::validate_category_name(&group_name)?;

    let ct_for_log = content_type.clone();
    let groups = with_db(&state.pool, move |conn| {
        pinned_categories::set_category_pinned(
            conn,
            playlist_id,
            &content_type,
            &group_name,
            pinned,
        )?;
        Ok(pinned_categories::get_category_groups(
            conn,
            playlist_id,
            &content_type,
        )?)
    })
    .await?;
    debug!(
        "set_category_pinned playlist_id={} type={} pinned={} -> {} pinned",
        playlist_id,
        ct_for_log,
        pinned,
        groups.pinned.len()
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
