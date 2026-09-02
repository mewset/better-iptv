use crate::commands::with_db;
use crate::db::{mutations, queries};
use crate::error::AppError;
use crate::parental_domain;
use crate::state::AppState;
use log::{info, warn};
use tauri::State;

#[tauri::command]
pub async fn set_parental_pin(state: State<'_, AppState>, pin: String) -> Result<(), AppError> {
    parental_domain::validate_pin(&pin)?;

    let password_hash = parental_domain::hash_pin(&pin)?;

    with_db(&state.pool, move |conn| {
        Ok(mutations::set_setting(conn, "parental_pin_hash", &password_hash)?)
    })
    .await?;

    info!("Parental control PIN set successfully");
    Ok(())
}

#[tauri::command]
pub async fn verify_parental_pin(state: State<'_, AppState>, pin: String) -> Result<bool, AppError> {
    let hash = with_db(&state.pool, |conn| {
        Ok(queries::get_setting(conn, "parental_pin_hash")?)
    })
    .await?;

    let hash = match hash {
        Some(h) => h,
        None => return Ok(false),
    };

    // Argon2 verification is CPU-bound by design; keep it off the async worker too.
    let is_valid = tokio::task::spawn_blocking(move || parental_domain::verify_pin_hash(&pin, &hash))
        .await??;

    if is_valid {
        info!("Parental control PIN verified successfully");
    } else {
        warn!("Failed parental control PIN verification attempt");
    }

    Ok(is_valid)
}

#[tauri::command]
pub async fn reset_parental_pin(state: State<'_, AppState>) -> Result<(), AppError> {
    with_db(&state.pool, |conn| {
        mutations::delete_setting(conn, "parental_pin_hash")?;
        mutations::set_setting(conn, "parental_enabled", "false")?;
        Ok(())
    })
    .await?;

    info!("Parental control PIN reset");
    Ok(())
}

#[tauri::command]
pub async fn get_blocked_channels(state: State<'_, AppState>) -> Result<Vec<i64>, AppError> {
    let json_str = with_db(&state.pool, |conn| {
        Ok(queries::get_setting(conn, "parental_blocked_channels")?)
    })
    .await?;

    let json_str = match json_str {
        Some(s) => s,
        None => return Ok(Vec::new()),
    };

    let channel_ids: Vec<i64> = serde_json::from_str(&json_str)
        .map_err(|e| AppError::Parse(format!("Failed to parse blocked channels: {}", e)))?;

    Ok(channel_ids)
}

#[tauri::command]
pub async fn set_blocked_channels(state: State<'_, AppState>, channel_ids: Vec<i64>) -> Result<(), AppError> {
    let json_str = serde_json::to_string(&channel_ids)
        .map_err(|e| AppError::Parse(format!("Failed to serialize blocked channels: {}", e)))?;
    let count = channel_ids.len();

    with_db(&state.pool, move |conn| {
        Ok(mutations::set_setting(conn, "parental_blocked_channels", &json_str)?)
    })
    .await?;

    info!("Updated blocked channels list ({} channels)", count);
    Ok(())
}

#[tauri::command]
pub async fn get_parental_settings(state: State<'_, AppState>) -> Result<serde_json::Value, AppError> {
    let settings = with_db(&state.pool, |conn| {
        Ok(queries::get_multiple_settings(
            conn,
            &[
                "parental_enabled",
                "parental_pin_hash",
                "parental_auto_detect",
                "parental_blocked_channels",
                "parental_blocked_categories",
                "parental_unlock_duration",
                "parental_visibility",
            ],
        )?)
    })
    .await?;

    let blocked_channels: Vec<i64> = settings
        .get("parental_blocked_channels")
        .and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or_default();

    let blocked_categories: Vec<String> = settings
        .get("parental_blocked_categories")
        .and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or_default();

    let result = serde_json::json!({
        "enabled": settings.get("parental_enabled").map(|s| s == "true").unwrap_or(false),
        "has_pin": settings.contains_key("parental_pin_hash"),
        "auto_detect": settings.get("parental_auto_detect").map(|s| s == "true").unwrap_or(false),
        "blocked_channels": blocked_channels,
        "blocked_categories": blocked_categories,
        "unlock_duration": settings.get("parental_unlock_duration").unwrap_or(&"session".to_string()),
        "visibility": settings.get("parental_visibility").unwrap_or(&"hide".to_string()),
    });

    Ok(result)
}
