use crate::commands::with_db;
use crate::db::{mutations, queries};
use crate::error::AppError;
use crate::http;
use crate::playlist::get_xtream_epg_url;
use crate::playlist::XtreamCredentials;
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
        _ => value,
    };

    let key_for_log = key.clone();
    let value_for_log = normalized_value.clone();
    let background_turned_off = with_db(&state.pool, move |conn| {
        write_setting(conn, &key, normalized_value)
    })
    .await?;
    if key_for_log == TMDB_API_KEY_KEY || key_for_log == TMDB_ENABLED_KEY {
        state.tmdb.reset_shared();
    }
    if background_turned_off {
        state.tmdb.cancel_background();
    } else if key_for_log == TMDB_BACKGROUND_ENRICH_KEY && value_for_log == "1" {
        schedule_library_scan(app);
    }
    debug!("Setting '{}' updated", key_for_log);
    Ok(())
}

/// The database half of `set_setting`. Returns whether the write turned
/// background enrichment off: the flag itself set to "0", or the own key
/// cleared while the flag was on (the scan must not fall back to the shared
/// key, so the flag goes in the same write).
fn write_setting(conn: &Connection, key: &str, value: String) -> Result<bool, AppError> {
    let final_value = match key {
        "epg_url" if value.trim().is_empty() => get_default_xtream_epg_url(conn).unwrap_or(value),
        TMDB_BACKGROUND_ENRICH_KEY => validate_background_enrich_write(conn, &value)?,
        _ => value,
    };
    mutations::set_setting(conn, key, &final_value)?;
    let turned_off = match key {
        TMDB_BACKGROUND_ENRICH_KEY => final_value == "0",
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
    Ok(turned_off)
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

/// Get the default EPG URL from the active Xtream playlist (if any)
fn get_default_xtream_epg_url(db: &rusqlite::Connection) -> Option<String> {
    let active_id_str = queries::get_setting(db, "active_profile_id")
        .ok()
        .and_then(|x| x)?;
    let active_id: i64 = active_id_str.parse().ok()?;

    let playlist = queries::get_playlist_by_id(db, active_id)
        .ok()
        .and_then(|x| x)?;

    let server_url = playlist.url?;
    let username = playlist.xtream_username?;
    let password = playlist.xtream_password?;

    let creds = XtreamCredentials {
        server_url: server_url.clone(),
        username: username.clone(),
        password,
    };
    let epg_url = get_xtream_epg_url(&creds);

    debug!(
        "Defaulting to Xtream EPG URL: {}",
        crate::utils::mask_credentials(&epg_url)
    );

    Some(epg_url)
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
    fn clearing_the_key_turns_background_enrich_off_in_the_same_write() {
        let conn = crate::db::test_helpers::setup_test_db();
        mutations::set_setting(&conn, TMDB_API_KEY_KEY, "own-key").unwrap();
        mutations::set_setting(&conn, TMDB_BACKGROUND_ENRICH_KEY, "1").unwrap();
        assert!(
            !write_setting(&conn, TMDB_API_KEY_KEY, "own-key".into()).unwrap(),
            "a non-empty key turns nothing off"
        );
        assert_eq!(
            queries::get_setting(&conn, TMDB_BACKGROUND_ENRICH_KEY).unwrap(),
            Some("1".into()),
            "a non-empty key leaves the flag alone"
        );
        assert!(
            write_setting(&conn, TMDB_API_KEY_KEY, String::new()).unwrap(),
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
