use crate::commands::with_db;
use crate::db::{mutations, queries};
use crate::epg::service::EpgService;
use crate::error::AppError;
use crate::http;
use crate::logo_domain::{is_enabled, LOGO_FALLBACK_ENABLED_KEY};
use crate::state::AppState;
use crate::tmdb::enrich::schedule_library_scan;
use crate::tmdb::keys::{TMDB_API_KEY_KEY, TMDB_BACKGROUND_ENRICH_KEY, TMDB_ENABLED_KEY};
use log::{debug, info, warn};
use rusqlite::Connection;
use tauri::{AppHandle, State};

#[tauri::command]
pub async fn get_setting(
    state: State<'_, AppState>,
    key: String,
) -> Result<Option<String>, AppError> {
    let key_for_log = key.clone();
    let result = with_db(&state.pool, move |conn| {
        Ok(queries::get_setting(conn, &key)?)
    })
    .await?;
    debug!(
        "get_setting '{}' -> {}",
        key_for_log,
        if result.is_some() { "found" } else { "not set" }
    );
    Ok(result)
}

#[tauri::command]
pub async fn set_setting(
    app: AppHandle,
    state: State<'_, AppState>,
    key: String,
    value: String,
) -> Result<(), AppError> {
    let normalized_value = match key.as_str() {
        "playlist_user_agent_mode" => validate_playlist_user_agent_mode(&value)?,
        "playlist_user_agent_custom" => validate_playlist_user_agent_custom(&value)?,
        TMDB_API_KEY_KEY => validate_tmdb_api_key(&value)?,
        "tmdb_language" => validate_tmdb_language(&value)?,
        TMDB_ENABLED_KEY => validate_tmdb_enabled(&value)?,
        TMDB_BACKGROUND_ENRICH_KEY => validate_tmdb_background_enrich(&value)?,
        LOGO_FALLBACK_ENABLED_KEY => validate_logo_fallback_enabled(&value)?,
        _ => value,
    };

    let key_for_log = key.clone();
    let value_for_log = normalized_value.clone();
    let SettingWrite {
        stops_scan,
        logo_fallback_changed,
    } = with_db(&state.pool, move |conn| {
        write_setting(conn, &key, normalized_value)
    })
    .await?;
    if key_for_log == TMDB_API_KEY_KEY || key_for_log == TMDB_ENABLED_KEY {
        state.tmdb.reset_shared();
    }
    if stops_scan {
        state.tmdb.cancel_background();
    } else if key_for_log == TMDB_BACKGROUND_ENRICH_KEY && value_for_log == "1" {
        schedule_library_scan(app);
    }
    if logo_fallback_changed && value_for_log == "1" {
        // Fetch the list only if it is due; a first enable has no stamp yet.
        tauri::async_runtime::spawn(crate::logo_fallback::run_maintenance(
            state.pool.clone(),
            state.logo_fallback_lock.clone(),
            false,
        ));
    }
    debug!("Setting '{}' updated", key_for_log);
    Ok(())
}

/// What a settings write means for the background work around it.
#[derive(Debug)]
struct SettingWrite {
    /// The write must stop a running library scan: the flag set to "0", the
    /// feature turned off (the stored flag is left alone), or the own key
    /// cleared while the flag was on (the scan must not fall back to the
    /// shared key, so the flag goes in the same write).
    stops_scan: bool,
    /// The logo fallback was switched on or off (absent counts as on), so
    /// the overrides were recomputed.
    logo_fallback_changed: bool,
}

/// The database half of `set_setting`.
fn write_setting(conn: &Connection, key: &str, value: String) -> Result<SettingWrite, AppError> {
    let final_value = match key {
        TMDB_BACKGROUND_ENRICH_KEY => validate_background_enrich_write(conn, &value)?,
        _ => value,
    };
    let logo_was_on = if key == LOGO_FALLBACK_ENABLED_KEY {
        Some(is_enabled(queries::get_setting(conn, key)?.as_deref()))
    } else {
        None
    };
    mutations::set_setting(conn, key, &final_value)?;
    // Settings Save writes the value every time; only a real switch costs a
    // recompute of every live row.
    let logo_fallback_changed =
        logo_was_on.is_some_and(|was| was != is_enabled(Some(&final_value)));
    if logo_fallback_changed {
        crate::db::logo_fallbacks::recompute_overrides(conn, None)?;
    }
    let stops_scan = match key {
        TMDB_BACKGROUND_ENRICH_KEY | TMDB_ENABLED_KEY => final_value == "0",
        TMDB_API_KEY_KEY if final_value.is_empty() => {
            let was_on =
                queries::get_setting(conn, TMDB_BACKGROUND_ENRICH_KEY)?.is_some_and(|v| v == "1");
            if was_on {
                mutations::set_setting(conn, TMDB_BACKGROUND_ENRICH_KEY, "0")?;
            }
            was_on
        }
        _ => false,
    };
    Ok(SettingWrite {
        stops_scan,
        logo_fallback_changed,
    })
}

/// Turning the scan on needs the user's own key; the shared key must never
/// carry a whole library. Read in the same connection as the write.
fn validate_background_enrich_write(conn: &Connection, value: &str) -> Result<String, AppError> {
    if value == "1" {
        let has_own_key =
            queries::get_setting(conn, TMDB_API_KEY_KEY)?.is_some_and(|k| !k.trim().is_empty());
        if !has_own_key {
            return Err(AppError::InvalidInput(
                "Background fetching needs your own TMDB API key".to_string(),
            ));
        }
    }
    Ok(value.to_string())
}

fn validate_tmdb_background_enrich(value: &str) -> Result<String, AppError> {
    match value.trim() {
        "0" => Ok("0".to_string()),
        "1" => Ok("1".to_string()),
        _ => Err(AppError::InvalidInput(
            "tmdb_background_enrich must be 0 or 1".to_string(),
        )),
    }
}

fn validate_tmdb_api_key(value: &str) -> Result<String, AppError> {
    let trimmed = value.trim();
    if trimmed.chars().any(char::is_whitespace) {
        return Err(AppError::InvalidInput(
            "The TMDB key cannot contain spaces".to_string(),
        ));
    }
    Ok(trimmed.to_string())
}

fn validate_tmdb_language(value: &str) -> Result<String, AppError> {
    let v = value.trim();
    let bytes = v.as_bytes();
    let ok = bytes.len() == 5
        && bytes[0..2].iter().all(|b| b.is_ascii_lowercase())
        && bytes[2] == b'-'
        && bytes[3..5].iter().all(|b| b.is_ascii_uppercase());
    if !ok {
        return Err(AppError::InvalidInput(
            "Language must look like en-US".to_string(),
        ));
    }
    Ok(v.to_string())
}

fn validate_logo_fallback_enabled(value: &str) -> Result<String, AppError> {
    match value.trim() {
        v @ ("0" | "1") => Ok(v.to_string()),
        _ => Err(AppError::InvalidInput(
            "logo_fallback_enabled must be 0 or 1".to_string(),
        )),
    }
}

fn validate_tmdb_enabled(value: &str) -> Result<String, AppError> {
    match value.trim() {
        "0" => Ok("0".to_string()),
        "1" => Ok("1".to_string()),
        _ => Err(AppError::InvalidInput(
            "tmdb_enabled must be 0 or 1".to_string(),
        )),
    }
}

fn validate_playlist_user_agent_mode(mode: &str) -> Result<String, AppError> {
    let normalized_mode = mode.trim().to_ascii_lowercase();

    if !http::is_valid_playlist_user_agent_mode(&normalized_mode) {
        return Err(AppError::InvalidInput(
            "User-Agent mode must be one of: default, tivimate, vlc, custom".to_string(),
        ));
    }

    Ok(normalized_mode)
}

fn validate_playlist_user_agent_custom(value: &str) -> Result<String, AppError> {
    let normalized = value.trim().to_string();

    if normalized.contains('\r') || normalized.contains('\n') {
        return Err(AppError::InvalidInput(
            "Custom User-Agent cannot contain line breaks".to_string(),
        ));
    }

    if normalized.len() > http::MAX_CUSTOM_USER_AGENT_LENGTH {
        return Err(AppError::InvalidInput(format!(
            "Custom User-Agent cannot be longer than {} characters",
            http::MAX_CUSTOM_USER_AGENT_LENGTH
        )));
    }

    Ok(normalized)
}

#[tauri::command]
pub async fn get_active_profile_id(state: State<'_, AppState>) -> Result<Option<i64>, AppError> {
    let active_id_str = with_db(&state.pool, |conn| {
        Ok(queries::get_setting(conn, "active_profile_id")?)
    })
    .await?;

    let active_id = active_id_str.and_then(|s| {
        s.parse::<i64>().ok().or_else(|| {
            warn!("Invalid profile ID in database: {}", s);
            None
        })
    });

    Ok(active_id)
}

#[tauri::command]
pub async fn set_active_profile_id(
    app: AppHandle,
    state: State<'_, AppState>,
    epg: State<'_, EpgService>,
    profile_id: i64,
) -> Result<(), AppError> {
    with_db(&state.pool, move |conn| {
        Ok(mutations::set_setting(
            conn,
            "active_profile_id",
            &profile_id.to_string(),
        )?)
    })
    .await?;

    info!("Active profile changed to ID: {}", profile_id);
    // The scan covers the active profile, so a switch (including the one
    // right after an import) is when a new library becomes eligible.
    schedule_library_scan(app);
    // Other guide sources apply now; one of them may be due. The switch
    // itself has succeeded either way.
    if let Err(e) = epg.profile_switched().await {
        warn!("EPG check after the profile switch failed: {e}");
    }

    Ok(())
}

#[cfg(test)]
mod tmdb_validation {
    use super::*;

    #[test]
    fn api_key_is_trimmed_and_rejects_inner_whitespace() {
        assert_eq!(validate_tmdb_api_key("  abc  ").unwrap(), "abc");
        assert_eq!(validate_tmdb_api_key("").unwrap(), "");
        assert!(validate_tmdb_api_key("a b").is_err());
        assert!(validate_tmdb_api_key("a\nb").is_err());
    }

    #[test]
    fn language_must_be_a_tmdb_locale_tag() {
        assert_eq!(validate_tmdb_language("sv-SE").unwrap(), "sv-SE");
        assert!(validate_tmdb_language("sv").is_err());
        assert!(validate_tmdb_language("SV-se").is_err());
        assert!(validate_tmdb_language("en-US; DROP").is_err());
    }

    #[test]
    fn enabled_is_zero_or_one() {
        assert_eq!(validate_tmdb_enabled("1").unwrap(), "1");
        assert_eq!(validate_tmdb_enabled("0").unwrap(), "0");
        assert!(validate_tmdb_enabled("true").is_err());
    }

    #[test]
    fn background_enrich_is_zero_or_one() {
        assert_eq!(validate_tmdb_background_enrich(" 1 ").unwrap(), "1");
        assert_eq!(validate_tmdb_background_enrich("0").unwrap(), "0");
        assert!(validate_tmdb_background_enrich("yes").is_err());
    }

    #[test]
    fn background_enrich_cannot_turn_on_without_an_own_key() {
        let conn = crate::db::test_helpers::setup_test_db();
        // No key at all, then a blank key: both refused with the user's message.
        for blank in [None, Some("")] {
            if let Some(v) = blank {
                mutations::set_setting(&conn, TMDB_API_KEY_KEY, v).unwrap();
            }
            match validate_background_enrich_write(&conn, "1") {
                Err(AppError::InvalidInput(msg)) => {
                    assert_eq!(msg, "Background fetching needs your own TMDB API key")
                }
                other => panic!("expected the refusal, got {other:?}"),
            }
            assert_eq!(
                queries::get_setting(&conn, TMDB_BACKGROUND_ENRICH_KEY).unwrap(),
                None,
                "a refused write must not touch the setting"
            );
        }
        // Off is always fine.
        assert_eq!(validate_background_enrich_write(&conn, "0").unwrap(), "0");
        mutations::set_setting(&conn, TMDB_API_KEY_KEY, "own-key").unwrap();
        assert_eq!(validate_background_enrich_write(&conn, "1").unwrap(), "1");
    }

    #[test]
    fn turning_the_feature_off_stops_the_scan_but_keeps_the_flag_stored() {
        let conn = crate::db::test_helpers::setup_test_db();
        mutations::set_setting(&conn, TMDB_API_KEY_KEY, "own-key").unwrap();
        mutations::set_setting(&conn, TMDB_BACKGROUND_ENRICH_KEY, "1").unwrap();
        assert!(
            !write_setting(&conn, TMDB_ENABLED_KEY, "1".into())
                .unwrap()
                .stops_scan
        );
        assert!(
            write_setting(&conn, TMDB_ENABLED_KEY, "0".into())
                .unwrap()
                .stops_scan
        );
        assert_eq!(
            queries::get_setting(&conn, TMDB_BACKGROUND_ENRICH_KEY).unwrap(),
            Some("1".into()),
            "the flag itself is not rewritten"
        );
    }

    #[test]
    fn clearing_the_key_turns_background_enrich_off_in_the_same_write() {
        let conn = crate::db::test_helpers::setup_test_db();
        mutations::set_setting(&conn, TMDB_API_KEY_KEY, "own-key").unwrap();
        mutations::set_setting(&conn, TMDB_BACKGROUND_ENRICH_KEY, "1").unwrap();
        assert!(
            !write_setting(&conn, TMDB_API_KEY_KEY, "own-key".into())
                .unwrap()
                .stops_scan,
            "a non-empty key turns nothing off"
        );
        assert_eq!(
            queries::get_setting(&conn, TMDB_BACKGROUND_ENRICH_KEY).unwrap(),
            Some("1".into()),
            "a non-empty key leaves the flag alone"
        );
        assert!(
            write_setting(&conn, TMDB_API_KEY_KEY, String::new())
                .unwrap()
                .stops_scan,
            "an emptied key reports the flag turned off"
        );
        assert_eq!(
            queries::get_setting(&conn, TMDB_API_KEY_KEY).unwrap(),
            Some(String::new())
        );
        assert_eq!(
            queries::get_setting(&conn, TMDB_BACKGROUND_ENRICH_KEY).unwrap(),
            Some("0".into())
        );
    }
}

#[cfg(test)]
mod logo_fallback_setting {
    use super::*;
    use crate::db::logo_fallbacks::replace_fallbacks;
    use crate::db::test_helpers::{create_test_channel, create_test_playlist, setup_test_db};
    use std::collections::HashMap;

    fn override_of(conn: &Connection, id: i64) -> Option<String> {
        conn.query_row(
            "SELECT logo_override FROM channels WHERE id = ?1",
            [id],
            |r| r.get(0),
        )
        .unwrap()
    }

    fn setup() -> (Connection, i64) {
        let conn = setup_test_db();
        let pid = create_test_playlist(&conn, "P");
        let id = create_test_channel(&conn, pid, "TV3");
        conn.execute("UPDATE channels SET epg_id = 'tv3.se' WHERE id = ?1", [id])
            .unwrap();
        let fb = HashMap::from([("tv3.se".to_string(), "http://fb/tv3.png".to_string())]);
        replace_fallbacks(&conn, &fb).unwrap();
        write_setting(&conn, LOGO_FALLBACK_ENABLED_KEY, "1".into()).unwrap();
        crate::db::logo_fallbacks::recompute_overrides(&conn, None).unwrap();
        (conn, id)
    }

    #[test]
    fn logo_fallback_enabled_accepts_only_0_and_1() {
        assert_eq!(validate_logo_fallback_enabled("1").unwrap(), "1");
        assert_eq!(validate_logo_fallback_enabled(" 0 ").unwrap(), "0");
        assert!(validate_logo_fallback_enabled("true").is_err());
        assert!(validate_logo_fallback_enabled("").is_err());
    }

    #[test]
    fn turning_off_clears_all_overrides() {
        let (conn, id) = setup();
        assert_eq!(override_of(&conn, id).as_deref(), Some("http://fb/tv3.png"));
        let w = write_setting(&conn, LOGO_FALLBACK_ENABLED_KEY, "0".into()).unwrap();
        assert!(!w.stops_scan);
        assert!(w.logo_fallback_changed);
        assert_eq!(override_of(&conn, id), None);
    }

    #[test]
    fn saving_an_unchanged_value_does_no_work() {
        let (conn, id) = setup();
        // Wipe the override by hand: only a recompute would bring it back.
        conn.execute("UPDATE channels SET logo_override = NULL", [])
            .unwrap();
        let w = write_setting(&conn, LOGO_FALLBACK_ENABLED_KEY, "1".into()).unwrap();
        assert!(!w.logo_fallback_changed, "1 over 1 is no change");
        assert_eq!(override_of(&conn, id), None, "no recompute ran");

        // Absent counts as on, so a first "1" is no change either.
        let conn = setup_test_db();
        let w = write_setting(&conn, LOGO_FALLBACK_ENABLED_KEY, "1".into()).unwrap();
        assert!(!w.logo_fallback_changed);
        let w = write_setting(&conn, LOGO_FALLBACK_ENABLED_KEY, "0".into()).unwrap();
        assert!(w.logo_fallback_changed);
        let w = write_setting(&conn, LOGO_FALLBACK_ENABLED_KEY, "0".into()).unwrap();
        assert!(!w.logo_fallback_changed);
    }

    #[test]
    fn other_keys_never_report_a_logo_change() {
        let conn = setup_test_db();
        let w = write_setting(&conn, "tmdb_language", "sv-SE".into()).unwrap();
        assert!(!w.logo_fallback_changed);
    }

    #[test]
    fn turning_on_restores_them() {
        let (conn, id) = setup();
        write_setting(&conn, LOGO_FALLBACK_ENABLED_KEY, "0".into()).unwrap();
        write_setting(&conn, LOGO_FALLBACK_ENABLED_KEY, "1".into()).unwrap();
        assert_eq!(override_of(&conn, id).as_deref(), Some("http://fb/tv3.png"));
    }
}
