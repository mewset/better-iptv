//! Channel domain - Business logic for channel operations
//!
//! This module contains pure business logic functions for channel-related operations.
//! Functions here are synchronous and do NOT perform database operations.

use crate::error::AppError;

/// Valid content types for channels
const VALID_CONTENT_TYPES: &[&str] = &["live", "vod", "series"];

// ========== EPG ids ==========

/// The EPG id a channel row is stored with: exactly what the provider sent,
/// or `None` when it sent nothing or only whitespace. Nothing is made up from
/// the channel name; matching to the guide happens on read
/// (`epg_domain::key::channel_key`).
pub fn provider_epg_id(epg_id: Option<&str>) -> Option<String> {
    epg_id
        .filter(|id| !id.trim().is_empty())
        .map(str::to_string)
}

// ========== Validation Functions ==========

/// Validate content type
///
/// Ensures the content type is one of the valid types: "live", "vod", or "series".
///
/// # Arguments
/// * `content_type` - The content type to validate
///
/// # Errors
/// Returns `AppError::InvalidInput` if content type is not valid
///
/// # Examples
/// ```ignore
/// use better_ip_tv::channel_domain::validate_content_type;
///
/// assert!(validate_content_type("live").is_ok());
/// assert!(validate_content_type("invalid").is_err());
/// ```ignore
pub fn validate_content_type(content_type: &str) -> Result<(), AppError> {
    if !VALID_CONTENT_TYPES.contains(&content_type) {
        return Err(AppError::InvalidInput(format!(
            "Invalid content type '{}'. Must be one of: {}",
            content_type,
            VALID_CONTENT_TYPES.join(", ")
        )));
    }
    Ok(())
}

/// Validate channel ID
///
/// Ensures the channel ID is positive.
///
/// # Arguments
/// * `channel_id` - The channel ID to validate
///
/// # Errors
/// Returns `AppError::InvalidInput` if channel ID is not positive
pub fn validate_channel_id(channel_id: i64) -> Result<(), AppError> {
    if channel_id <= 0 {
        return Err(AppError::InvalidInput(
            "Channel ID must be positive".to_string(),
        ));
    }
    Ok(())
}

/// Longest category name accepted when pinning (bytes). Provider names are far
/// shorter; this only stops a runaway string from reaching the database.
const MAX_CATEGORY_NAME_LEN: usize = 1024;

/// Validate a category name sent to pin or unpin
///
/// The name is matched exactly as the provider sent it, so it is not trimmed or
/// changed, only refused when it is blank or longer than 1024 bytes.
///
/// # Errors
/// Returns `AppError::InvalidInput` for a blank or overlong name
pub fn validate_category_name(name: &str) -> Result<(), AppError> {
    if name.trim().is_empty() {
        return Err(AppError::InvalidInput(
            "Category name must not be empty".to_string(),
        ));
    }
    if name.len() > MAX_CATEGORY_NAME_LEN {
        return Err(AppError::InvalidInput(format!(
            "Category name must be at most {MAX_CATEGORY_NAME_LEN} bytes"
        )));
    }
    Ok(())
}

/// Validate playlist ID
///
/// Ensures the playlist ID is positive.
///
/// # Arguments
/// * `playlist_id` - The playlist ID to validate
///
/// # Errors
/// Returns `AppError::InvalidInput` if playlist ID is not positive
pub fn validate_playlist_id(playlist_id: i64) -> Result<(), AppError> {
    if playlist_id <= 0 {
        return Err(AppError::InvalidInput(
            "Playlist ID must be positive".to_string(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_category_name_accepts_provider_names() {
        assert!(validate_category_name("SE: Sweden").is_ok());
        assert!(validate_category_name("SE: Sverige | ÅÄÖ 4K").is_ok());
    }

    #[test]
    fn validate_category_name_rejects_empty() {
        assert!(matches!(
            validate_category_name(""),
            Err(AppError::InvalidInput(_))
        ));
        assert!(matches!(
            validate_category_name("   "),
            Err(AppError::InvalidInput(_))
        ));
    }

    #[test]
    fn validate_category_name_rejects_overlong() {
        assert!(validate_category_name(&"a".repeat(1024)).is_ok());
        assert!(matches!(
            validate_category_name(&"a".repeat(1025)),
            Err(AppError::InvalidInput(_))
        ));
    }

    #[test]
    fn the_provider_epg_id_is_stored_as_sent() {
        assert_eq!(
            provider_epg_id(Some("SVT1.se")),
            Some("SVT1.se".to_string())
        );
        assert_eq!(
            provider_epg_id(Some(" svt1.se ")),
            Some(" svt1.se ".to_string())
        );
    }

    #[test]
    fn a_missing_or_blank_provider_epg_id_is_none() {
        assert_eq!(provider_epg_id(None), None);
        assert_eq!(provider_epg_id(Some("")), None);
        assert_eq!(provider_epg_id(Some("  ")), None);
    }

    #[test]
    fn test_validate_content_type() {
        assert!(validate_content_type("live").is_ok());
        assert!(validate_content_type("vod").is_ok());
        assert!(validate_content_type("series").is_ok());
        assert!(validate_content_type("invalid").is_err());
        assert!(validate_content_type("LIVE").is_err());
    }

    #[test]
    fn test_validate_channel_id() {
        assert!(validate_channel_id(1).is_ok());
        assert!(validate_channel_id(999).is_ok());
        assert!(validate_channel_id(0).is_err());
        assert!(validate_channel_id(-1).is_err());
    }
}
