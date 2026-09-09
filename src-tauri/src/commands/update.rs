//! Update check: is there a newer GitHub release than the running app?

use crate::commands::with_db;
use crate::db::{mutations, queries};
use crate::error::AppError;
use crate::http;
use crate::state::AppState;
use crate::update_domain::{is_newer_version, update_check_due, UPDATE_CHECK_INTERVAL_HOURS};
use chrono::Utc;
use log::{debug, info};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

/// GitHub's public endpoint for the newest non-prerelease release.
const LATEST_RELEASE_API: &str = "https://api.github.com/repos/mewset/better-iptv/releases/latest";
/// Release pages are `.../releases/tag/<tag>`, which is what `html_url` holds.
const RELEASE_TAG_URL_PREFIX: &str = "https://github.com/mewset/better-iptv/releases/tag/";

pub const UPDATE_CHECK_ENABLED_KEY: &str = "update_check_enabled";
pub const UPDATE_LAST_CHECKED_KEY: &str = "update_last_checked";
pub const UPDATE_LATEST_VERSION_KEY: &str = "update_latest_version";

/// A release newer than the one running, ready for the frontend badge.
#[derive(Debug, Clone, Serialize)]
pub struct UpdateInfo {
    pub version: String,
    pub url: String,
}

#[derive(Deserialize)]
struct GithubRelease {
    tag_name: String,
}

/// Report a newer release, or `None`.
///
/// The network call runs at most once per day; in between, the newest tag seen
/// is read back from settings so the badge survives a restart. Every failure
/// path - disabled by the user, offline, rate limited, unreadable response -
/// returns `None` rather than an error: an update check is not worth an error
/// dialog, and it must never keep the app from starting.
#[tauri::command]
pub async fn check_for_update(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<UpdateInfo>, AppError> {
    let current = app.package_info().version.to_string();

    let (enabled, last_checked, cached_latest) = with_db(&state.pool, |conn| {
        Ok((
            queries::get_setting(conn, UPDATE_CHECK_ENABLED_KEY)?,
            queries::get_setting(conn, UPDATE_LAST_CHECKED_KEY)?,
            queries::get_setting(conn, UPDATE_LATEST_VERSION_KEY)?,
        ))
    })
    .await?;

    if enabled.as_deref() == Some("false") {
        debug!("update check disabled in settings");
        return Ok(None);
    }

    let latest = if update_check_due(
        last_checked.as_deref(),
        Utc::now(),
        UPDATE_CHECK_INTERVAL_HOURS,
    ) {
        match fetch_latest_tag().await {
            Some(tag) => {
                let tag_to_store = tag.clone();
                with_db(&state.pool, move |conn| {
                    mutations::set_setting(conn, UPDATE_LATEST_VERSION_KEY, &tag_to_store)?;
                    mutations::set_setting(
                        conn,
                        UPDATE_LAST_CHECKED_KEY,
                        &Utc::now().to_rfc3339(),
                    )?;
                    Ok(())
                })
                .await?;
                Some(tag)
            }
            // Not stamping the timestamp on failure means the next start tries
            // again instead of going quiet for a day.
            None => cached_latest,
        }
    } else {
        debug!("update check not due yet, using the last tag seen");
        cached_latest
    };

    let latest = match latest {
        Some(tag) => tag,
        None => return Ok(None),
    };

    if !is_newer_version(&current, &latest) {
        debug!("running {current}, latest release is {latest}, nothing to offer");
        return Ok(None);
    }

    info!("update available: running {current}, latest release is {latest}");
    Ok(Some(UpdateInfo {
        url: format!("{RELEASE_TAG_URL_PREFIX}{latest}"),
        version: latest,
    }))
}

/// Fetch the newest release tag, or `None` on any failure.
async fn fetch_latest_tag() -> Option<String> {
    let response = http::get_http_client()
        .get(LATEST_RELEASE_API)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| debug!("update check request failed: {e}"))
        .ok()?;

    if !response.status().is_success() {
        debug!("update check got HTTP {}", response.status());
        return None;
    }

    let release = response
        .json::<GithubRelease>()
        .await
        .map_err(|e| debug!("update check response was unreadable: {e}"))
        .ok()?;

    Some(release.tag_name)
}
