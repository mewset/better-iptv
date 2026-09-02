use crate::commands::with_db;
use crate::error::AppError;
use crate::epg::ChannelEpg;
use crate::epg_domain;
use crate::epg_domain::{
    epg_refresh_due, epg_retry_allowed, EPG_AUTO_REFRESH_INTERVAL_HOURS,
    EPG_AUTO_REFRESH_RETRY_MINUTES,
};
use crate::playlist::{get_xtream_epg_url, XtreamCredentials};
use crate::state::AppState;
use crate::db::queries;
use log::{debug, info, warn};
use serde::Serialize;
use std::collections::HashMap;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};

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

#[derive(Debug, Clone, Serialize)]
pub struct EpgRefreshResult {
    pub success: bool,
    pub programs_loaded: usize,
    pub timestamp: String,
    pub error: Option<String>,
}

#[tauri::command]
pub async fn fetch_epg_data(state: State<'_, AppState>, epg_url: String) -> Result<usize, AppError> {
    let _guard = state.epg_refresh_lock.lock().await;

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
        let count = crate::epg::store_epg_programs(conn, &programs)?;
        crate::db::mutations::set_setting(conn, "epg_last_fetched", &chrono::Utc::now().to_rfc3339())?;
        Ok(count)
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

/// Upper bound on ids per call; the channel grid asks for at most 100.
const MAX_EPG_BATCH: usize = 500;

#[tauri::command]
pub async fn get_channels_epg(
    state: State<'_, AppState>,
    epg_ids: Vec<String>,
) -> Result<HashMap<String, ChannelEpg>, AppError> {
    if epg_ids.len() > MAX_EPG_BATCH {
        return Err(AppError::InvalidInput(format!(
            "At most {} EPG ids per request",
            MAX_EPG_BATCH
        )));
    }

    let ids: Vec<String> = epg_ids
        .into_iter()
        .filter(|id| !id.trim().is_empty())
        .collect();
    if ids.is_empty() {
        return Ok(HashMap::new());
    }

    let result = with_db(&state.pool, move |conn| {
        Ok(crate::epg::get_programs_for_channels(conn, &ids)?)
    })
    .await?;
    debug!("get_channels_epg -> {} channels with data", result.len());
    Ok(result)
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

/// Fetch, parse and store EPG from the configured `epg_url`.
///
/// Returns `Ok(EpgRefreshResult { success: false, .. })` for user-facing
/// problems (no URL, invalid URL, download failure) and `Err` only for
/// database failures. Shared by the Settings button and the background task.
pub async fn run_epg_refresh(state: &AppState) -> Result<EpgRefreshResult, AppError> {
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

#[tauri::command]
pub async fn force_refresh_epg(state: State<'_, AppState>) -> Result<EpgRefreshResult, AppError> {
    let _guard = state.epg_refresh_lock.lock().await;
    run_epg_refresh(&state).await
}

/// First automatic check after startup; leaves the UI's own startup traffic alone.
pub const EPG_AUTO_REFRESH_INITIAL_DELAY: Duration = Duration::from_secs(30);
/// How often the background task re-checks whether a refresh is due.
pub const EPG_AUTO_REFRESH_POLL_INTERVAL: Duration = Duration::from_secs(15 * 60);

/// Background entry point: refresh EPG when an `epg_url` is set and the last
/// fetch is older than `EPG_AUTO_REFRESH_INTERVAL_HOURS`. Never fails; every
/// problem is logged. Attempts are spaced at least
/// `EPG_AUTO_REFRESH_RETRY_MINUTES` apart via the `epg_last_attempt` setting,
/// so a broken URL is not re-downloaded at every poll.
pub async fn maybe_auto_refresh_epg(app: &AppHandle) {
    let state = app.state::<AppState>();

    let _guard = match state.epg_refresh_lock.try_lock() {
        Ok(g) => g,
        Err(_) => {
            debug!("EPG auto-refresh: a refresh is already running, skipping");
            return;
        }
    };

    let settings = with_db(&state.pool, |conn| {
        Ok(queries::get_multiple_settings(
            conn,
            &["epg_url", "epg_last_fetched", "epg_last_attempt"],
        )?)
    })
    .await;

    let settings = match settings {
        Ok(s) => s,
        Err(e) => {
            warn!("EPG auto-refresh: could not read settings: {}", e);
            return;
        }
    };

    let has_url = settings
        .get("epg_url")
        .map(|u| !u.trim().is_empty())
        .unwrap_or(false);
    if !has_url {
        return;
    }

    let now = chrono::Utc::now();
    let last_fetched = settings.get("epg_last_fetched").map(|s| s.as_str());
    if !epg_refresh_due(last_fetched, now, EPG_AUTO_REFRESH_INTERVAL_HOURS) {
        return;
    }

    // A broken URL must not be re-downloaded at every poll: space attempts out
    // whether or not the previous one succeeded.
    let last_attempt = settings.get("epg_last_attempt").map(|s| s.as_str());
    if !epg_retry_allowed(last_attempt, now, EPG_AUTO_REFRESH_RETRY_MINUTES) {
        debug!(
            "EPG auto-refresh: last attempt {:?} is too recent, waiting",
            last_attempt
        );
        return;
    }

    let stamp = now.to_rfc3339();
    let stamped = with_db(&state.pool, move |conn| {
        Ok(crate::db::mutations::set_setting(conn, "epg_last_attempt", &stamp)?)
    })
    .await;
    if let Err(e) = stamped {
        warn!("EPG auto-refresh: could not record attempt time: {}", e);
        return;
    }

    info!("EPG auto-refresh: last fetch {:?}, refreshing", last_fetched);
    match run_epg_refresh(&state).await {
        Ok(result) if result.success => {
            if let Err(e) = app.emit("epg-refreshed", result) {
                warn!("EPG auto-refresh: failed to emit event: {}", e);
            }
        }
        Ok(result) => warn!("EPG auto-refresh failed: {:?}", result.error),
        Err(e) => warn!("EPG auto-refresh failed: {}", e),
    }
}
