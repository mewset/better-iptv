//! IPC command for the channel-logo fallback: the frontend reports provider
//! logos that failed to load.

use crate::commands::with_db;
use crate::db::logo_fallbacks::{record_failures, DeadLogoReport};
use crate::db::queries;
use crate::error::AppError;
use crate::logo_domain::{is_enabled, LOGO_FALLBACK_ENABLED_KEY};
use crate::state::AppState;
use chrono::{DateTime, Utc};
use rusqlite::Connection;
use std::collections::HashMap;
use tauri::State;

const MAX_REPORT_ITEMS: usize = 200;
const MAX_URL_BYTES: usize = 2048;

/// Reject oversized or blank reports before touching the database.
fn validate_reports(items: &[DeadLogoReport]) -> Result<(), AppError> {
    if items.len() > MAX_REPORT_ITEMS {
        return Err(AppError::InvalidInput(format!(
            "At most {MAX_REPORT_ITEMS} logo reports per call"
        )));
    }
    for item in items {
        if item.url.trim().is_empty() {
            return Err(AppError::InvalidInput(
                "A logo report needs a URL".to_string(),
            ));
        }
        if item.url.len() > MAX_URL_BYTES {
            return Err(AppError::InvalidInput(format!(
                "A logo URL is longer than {MAX_URL_BYTES} bytes"
            )));
        }
    }
    Ok(())
}

/// The database half of `report_dead_logos`: an empty map, without recording
/// anything, while the fallback is switched off.
pub(crate) fn report_dead_logos_db(
    conn: &Connection,
    items: &[DeadLogoReport],
    launch_id: i64,
    now: DateTime<Utc>,
) -> Result<HashMap<i64, String>, AppError> {
    let setting = queries::get_setting(conn, LOGO_FALLBACK_ENABLED_KEY)?;
    if !is_enabled(setting.as_deref()) {
        return Ok(HashMap::new());
    }
    Ok(record_failures(conn, items, launch_id, now)?)
}

/// Record provider logos that failed to load. Returns `channel_id -> fallback
/// url` for every accepted report so the UI can swap them in at once.
#[tauri::command]
pub async fn report_dead_logos(
    state: State<'_, AppState>,
    items: Vec<DeadLogoReport>,
) -> Result<HashMap<i64, String>, AppError> {
    validate_reports(&items)?;
    let launch_id = state.launch_id;
    with_db(&state.pool, move |conn| {
        report_dead_logos_db(conn, &items, launch_id, Utc::now())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::logo_fallbacks::replace_fallbacks;
    use crate::db::mutations;
    use crate::db::test_helpers::{create_test_channel, create_test_playlist, setup_test_db};

    fn setup() -> (Connection, i64) {
        let conn = setup_test_db();
        let pid = create_test_playlist(&conn, "P");
        let id = create_test_channel(&conn, pid, "TV3");
        conn.execute(
            "UPDATE channels SET logo = 'http://p/a.png', epg_id = 'tv3.se' WHERE id = ?1",
            [id],
        )
        .unwrap();
        let fb = HashMap::from([("tv3.se".to_string(), "http://fb/tv3.png".to_string())]);
        replace_fallbacks(&conn, &fb).unwrap();
        (conn, id)
    }

    fn report(id: i64, url: &str) -> DeadLogoReport {
        DeadLogoReport {
            channel_id: id,
            url: url.to_string(),
        }
    }

    #[test]
    fn report_returns_fallbacks_for_accepted_items() {
        let (conn, id) = setup();
        let got =
            report_dead_logos_db(&conn, &[report(id, "http://p/a.png")], 1, Utc::now()).unwrap();
        assert_eq!(got.get(&id).map(String::as_str), Some("http://fb/tv3.png"));
    }

    #[test]
    fn report_is_empty_when_disabled() {
        let (conn, id) = setup();
        mutations::set_setting(&conn, LOGO_FALLBACK_ENABLED_KEY, "0").unwrap();
        let got =
            report_dead_logos_db(&conn, &[report(id, "http://p/a.png")], 1, Utc::now()).unwrap();
        assert!(got.is_empty());
        let marks: i64 = conn
            .query_row("SELECT COUNT(*) FROM dead_logo_urls", [], |r| r.get(0))
            .unwrap();
        assert_eq!(marks, 0);
    }

    #[test]
    fn report_rejects_more_than_200_items() {
        let items: Vec<_> = (0..201).map(|i| report(i, "http://p/a.png")).collect();
        assert!(matches!(
            validate_reports(&items),
            Err(AppError::InvalidInput(_))
        ));
        assert!(validate_reports(&items[..200]).is_ok());
    }

    #[test]
    fn report_rejects_overlong_url() {
        let long = format!("http://p/{}", "a".repeat(2048));
        assert!(matches!(
            validate_reports(&[report(1, &long)]),
            Err(AppError::InvalidInput(_))
        ));
        let ok = "a".repeat(2048);
        assert!(validate_reports(&[report(1, &ok)]).is_ok());
    }

    #[test]
    fn report_rejects_blank_url() {
        assert!(matches!(
            validate_reports(&[report(1, "  ")]),
            Err(AppError::InvalidInput(_))
        ));
    }
}
