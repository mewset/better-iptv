use crate::commands::with_db;
use crate::db::{mutations, queries};
use crate::error::AppError;
use crate::http;
use crate::playlist::get_xtream_epg_url;
use crate::playlist::XtreamCredentials;
use crate::state::AppState;
use log::{debug, info, warn};
use tauri::State;

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
    state: State<'_, AppState>,
    key: String,
    value: String,
) -> Result<(), AppError> {
    let normalized_value = match key.as_str() {
        "playlist_user_agent_mode" => validate_playlist_user_agent_mode(&value)?,
        "playlist_user_agent_custom" => validate_playlist_user_agent_custom(&value)?,
        "tmdb_api_key" => validate_tmdb_api_key(&value)?,
        "tmdb_language" => validate_tmdb_language(&value)?,
        "tmdb_enabled" => validate_tmdb_enabled(&value)?,
        _ => value,
    };

    let key_for_log = key.clone();
    with_db(&state.pool, move |conn| {
        let final_value = if key == "epg_url" && normalized_value.trim().is_empty() {
            get_default_xtream_epg_url(conn).unwrap_or(normalized_value)
        } else {
            normalized_value
        };
        Ok(mutations::set_setting(conn, &key, &final_value)?)
    })
    .await?;
    if key_for_log == "tmdb_api_key" || key_for_log == "tmdb_enabled" {
        state.tmdb.reset_shared();
    }
    debug!("Setting '{}' updated", key_for_log);
    Ok(())
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
}
