use crate::commands::with_db;
use crate::error::AppError;
use crate::epg_domain;
use crate::playlist::{get_xtream_epg_url, XtreamCredentials};
use crate::state::AppState;
use crate::db::queries;
use log::{debug, info, warn};
use serde::Serialize;
use tauri::State;

fn resolve_xtream_epg_user_agent(
    db: &rusqlite::Connection,
    target_epg_url: &str,
) -> Result<Option<String>, AppError> {
    let active_profile_id = queries::get_setting(db, "active_profile_id")?
        .and_then(|id| id.parse::<i64>().ok());

    let Some(profile_id) = active_profile_id else {
        return Ok(None);
    };

    let Some(playlist) = queries::get_playlist_by_id(db, profile_id)? else {
        return Ok(None);
    };

    let Some(server_url) = playlist.url else {
        return Ok(None);
    };
    let Some(username) = playlist.xtream_username else {
        return Ok(None);
    };
    let Some(password) = playlist.xtream_password else {
        return Ok(None);
    };

    let xtream_epg_url = get_xtream_epg_url(&XtreamCredentials {
        server_url,
        username,
        password,
    });

    if xtream_epg_url != target_epg_url {
        return Ok(None);
    }

    let settings = queries::get_multiple_settings(
        db,
        &["playlist_user_agent_mode", "playlist_user_agent_custom"],
    )?;
    let mode = settings.get("playlist_user_agent_mode").map(|s| s.as_str());
    let custom = settings.get("playlist_user_agent_custom").map(|s| s.as_str());

    Ok(Some(crate::http::resolve_playlist_user_agent(mode, custom)))
}

#[derive(Debug, Serialize)]
pub struct EpgStatus {
    pub has_url: bool,
    pub last_fetched: Option<String>,
    pub program_count: usize,
}

#[derive(Debug, Serialize)]
pub struct EpgRefreshResult {
    pub success: bool,
    pub programs_loaded: usize,
    pub timestamp: String,
    pub error: Option<String>,
}

#[tauri::command]
pub async fn fetch_epg_data(state: State<'_, AppState>, epg_url: String) -> Result<usize, AppError> {
    let normalized_url = epg_domain::normalize_epg_url(&epg_url);
    epg_domain::validate_epg_url(&normalized_url)?;

    let url_for_ua = normalized_url.clone();
    let playlist_user_agent = with_db(&state.pool, move |conn| {
        resolve_xtream_epg_user_agent(conn, &url_for_ua)
    })
    .await?;

    let programs = crate::epg::fetch_and_parse_epg(&normalized_url, playlist_user_agent.as_deref())
        .await
        .map_err(|e| AppError::Epg(e.to_string()))?;

    with_db(&state.pool, move |conn| {
        let updated = crate::db::mutations::update_channel_epg_ids(conn)?;
        if updated > 0 {
            debug!("Updated EPG IDs for {} channels", updated);
        }
        Ok(crate::epg::store_epg_programs(conn, &programs)?)
    })
    .await
}

#[tauri::command]
pub async fn get_channel_epg(
    state: State<'_, AppState>,
    channel_epg_id: String,
) -> Result<(Option<String>, Option<String>), AppError> {
    epg_domain::validate_channel_epg_id(&channel_epg_id)?;

    with_db(&state.pool, move |conn| {
        let current = crate::epg::get_current_program(conn, &channel_epg_id)?;
        let next = crate::epg::get_next_program(conn, &channel_epg_id)?;
        Ok((current, next))
    })
    .await
}

#[tauri::command]
pub async fn get_epg_status(state: State<'_, AppState>) -> Result<EpgStatus, AppError> {
    with_db(&state.pool, |conn| {
        let epg_url = queries::get_setting(conn, "epg_url")?;
        let has_url = epg_url.map(|u| !u.trim().is_empty()).unwrap_or(false);

        let last_fetched = queries::get_setting(conn, "epg_last_fetched")?;
        let program_count = queries::get_epg_program_count(conn)?;

        Ok(EpgStatus {
            has_url,
            last_fetched,
            program_count,
        })
    })
    .await
}

#[tauri::command]
pub async fn force_refresh_epg(state: State<'_, AppState>) -> Result<EpgRefreshResult, AppError> {
    let epg_url = with_db(&state.pool, |conn| Ok(queries::get_setting(conn, "epg_url")?)).await?;

    let epg_url = match epg_url {
        Some(url) if !url.trim().is_empty() => url,
        _ => {
            return Ok(EpgRefreshResult {
                success: false,
                programs_loaded: 0,
                timestamp: chrono::Utc::now().to_rfc3339(),
                error: Some("No EPG URL configured".to_string()),
            });
        }
    };

    info!("Force refreshing EPG from: {}", crate::utils::mask_credentials(&epg_url));

    let normalized_url = epg_domain::normalize_epg_url(&epg_url);
    if let Err(e) = epg_domain::validate_epg_url(&normalized_url) {
        warn!("Invalid EPG URL: {}", e);
        return Ok(EpgRefreshResult {
            success: false,
            programs_loaded: 0,
            timestamp: chrono::Utc::now().to_rfc3339(),
            error: Some(format!("Invalid EPG URL: {}", e)),
        });
    }

    let url_for_ua = normalized_url.clone();
    let playlist_user_agent = with_db(&state.pool, move |conn| {
        resolve_xtream_epg_user_agent(conn, &url_for_ua)
    })
    .await?;

    let programs = match crate::epg::fetch_and_parse_epg(
        &normalized_url,
        playlist_user_agent.as_deref(),
    )
    .await
    {
        Ok(p) => p,
        Err(e) => {
            warn!("Failed to fetch EPG: {}", e);
            return Ok(EpgRefreshResult {
                success: false,
                programs_loaded: 0,
                timestamp: chrono::Utc::now().to_rfc3339(),
                error: Some(format!("Failed to fetch EPG: {}", e)),
            });
        }
    };

    let (count, timestamp) = with_db(&state.pool, move |conn| {
        let updated = crate::db::mutations::update_channel_epg_ids(conn)?;
        if updated > 0 {
            debug!("Updated EPG IDs for {} channels", updated);
        }

        let count = crate::epg::store_epg_programs(conn, &programs)?;

        let timestamp = chrono::Utc::now().to_rfc3339();
        crate::db::mutations::set_setting(conn, "epg_last_fetched", &timestamp)?;
        Ok((count, timestamp))
    })
    .await?;

    info!("EPG refresh completed: {} programs loaded", count);

    Ok(EpgRefreshResult {
        success: true,
        programs_loaded: count,
        timestamp,
        error: None,
    })
}
