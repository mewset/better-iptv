//! EPG domain logic module
//!
//! This module contains business logic for EPG operations, separated from
//! database and command layers for better testability and maintainability.

use crate::error::AppError;
use chrono::{DateTime, Utc};

/// Validate EPG URL format
///
/// Ensures the URL is not empty and uses HTTP/HTTPS protocol.
///
/// # Arguments
/// * `url` - The EPG URL to validate
///
/// # Returns
/// * `Ok(())` if the URL is valid
/// * `Err(AppError::InvalidInput)` if the URL is invalid
///
/// # Examples
/// ```ignore
/// use better_ip_tv::epg_domain::validate_epg_url;
///
/// assert!(validate_epg_url("https://example.com/epg.xml").is_ok());
/// assert!(validate_epg_url("").is_err());
/// assert!(validate_epg_url("ftp://example.com/epg.xml").is_err());
/// ```ignore
pub fn validate_epg_url(url: &str) -> Result<(), AppError> {
    // Check if URL is empty or whitespace-only
    if url.trim().is_empty() {
        return Err(AppError::InvalidInput("EPG URL cannot be empty".to_string()));
    }

    // Ensure URL uses HTTP or HTTPS protocol
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err(AppError::InvalidInput(
            "EPG URL must start with http:// or https://".to_string(),
        ));
    }

    Ok(())
}

/// Normalize EPG URL by trimming whitespace
///
/// This is a helper function to clean up user input before processing.
///
/// # Arguments
/// * `url` - The EPG URL to normalize
///
/// # Returns
/// * The normalized URL with leading/trailing whitespace removed
pub fn normalize_epg_url(url: &str) -> String {
    url.trim().to_string()
}

/// Check if URL points to a gzipped file based on extension
///
/// This is used to determine if we need to decompress the EPG data.
///
/// # Arguments
/// * `url` - The EPG URL to check
///
/// # Returns
/// * `true` if the URL ends with `.gz`, `false` otherwise
#[allow(dead_code)]
pub fn is_gzipped_url(url: &str) -> bool {
    url.ends_with(".gz")
}

/// Validate channel EPG ID format
///
/// Ensures the EPG ID is not empty and contains valid characters.
///
/// # Arguments
/// * `epg_id` - The channel EPG ID to validate
///
/// # Returns
/// * `Ok(())` if the EPG ID is valid
/// * `Err(AppError::InvalidInput)` if the EPG ID is invalid
pub fn validate_channel_epg_id(epg_id: &str) -> Result<(), AppError> {
    if epg_id.trim().is_empty() {
        return Err(AppError::InvalidInput(
            "Channel EPG ID cannot be empty".to_string(),
        ));
    }

    Ok(())
}

/// How old `epg_last_fetched` may be before the background task refreshes.
pub const EPG_AUTO_REFRESH_INTERVAL_HOURS: i64 = 6;

/// Decide whether an automatic EPG refresh should run now.
///
/// `last_fetched` is the RFC 3339 string stored in the `epg_last_fetched`
/// setting. A missing or unreadable value counts as "never fetched".
pub fn epg_refresh_due(last_fetched: Option<&str>, now: DateTime<Utc>, interval_hours: i64) -> bool {
    match last_fetched.and_then(|s| DateTime::parse_from_rfc3339(s).ok()) {
        Some(last) => now - last.with_timezone(&Utc) >= chrono::Duration::hours(interval_hours),
        None => true,
    }
}

/// Minimum spacing between automatic refresh attempts, so a broken EPG URL is
/// not re-downloaded at every poll.
pub const EPG_AUTO_REFRESH_RETRY_MINUTES: i64 = 60;

/// Decide whether the background task may attempt a refresh now, given the
/// time of its previous attempt (the `epg_last_attempt` setting, stamped
/// whether or not that attempt succeeded). A missing or unreadable value
/// counts as "never attempted".
pub fn epg_retry_allowed(last_attempt: Option<&str>, now: DateTime<Utc>, retry_minutes: i64) -> bool {
    match last_attempt.and_then(|s| DateTime::parse_from_rfc3339(s).ok()) {
        Some(last) => now - last.with_timezone(&Utc) >= chrono::Duration::minutes(retry_minutes),
        None => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_validate_epg_url_valid_https() {
        assert!(validate_epg_url("https://example.com/epg.xml").is_ok());
    }

    #[test]
    fn test_validate_epg_url_valid_http() {
        assert!(validate_epg_url("http://example.com/epg.xml.gz").is_ok());
    }

    #[test]
    fn test_validate_epg_url_empty() {
        assert!(validate_epg_url("").is_err());
    }

    #[test]
    fn test_validate_epg_url_whitespace() {
        assert!(validate_epg_url("   ").is_err());
    }

    #[test]
    fn test_validate_epg_url_invalid_protocol() {
        assert!(validate_epg_url("ftp://example.com/epg.xml").is_err());
    }

    #[test]
    fn test_validate_epg_url_no_protocol() {
        assert!(validate_epg_url("example.com/epg.xml").is_err());
    }

    #[test]
    fn test_normalize_epg_url() {
        assert_eq!(
            normalize_epg_url("  https://example.com/epg.xml  "),
            "https://example.com/epg.xml"
        );
    }

    #[test]
    fn test_normalize_epg_url_no_whitespace() {
        assert_eq!(
            normalize_epg_url("https://example.com/epg.xml"),
            "https://example.com/epg.xml"
        );
    }

    #[test]
    fn test_is_gzipped_url_true() {
        assert!(is_gzipped_url("https://example.com/epg.xml.gz"));
    }

    #[test]
    fn test_is_gzipped_url_false() {
        assert!(!is_gzipped_url("https://example.com/epg.xml"));
    }

    #[test]
    fn test_validate_channel_epg_id_valid() {
        assert!(validate_channel_epg_id("channel123").is_ok());
    }

    #[test]
    fn test_validate_channel_epg_id_empty() {
        assert!(validate_channel_epg_id("").is_err());
    }

    #[test]
    fn test_validate_channel_epg_id_whitespace() {
        assert!(validate_channel_epg_id("   ").is_err());
    }

    mod refresh_due {
        use super::super::{epg_refresh_due, EPG_AUTO_REFRESH_INTERVAL_HOURS};
        use chrono::{Duration, Utc};

        #[test]
        fn never_fetched_is_due() {
            assert!(epg_refresh_due(None, Utc::now(), EPG_AUTO_REFRESH_INTERVAL_HOURS));
        }

        #[test]
        fn unparsable_timestamp_is_due() {
            assert!(epg_refresh_due(Some("yesterday"), Utc::now(), EPG_AUTO_REFRESH_INTERVAL_HOURS));
        }

        #[test]
        fn recent_fetch_is_not_due() {
            let now = Utc::now();
            let last = (now - Duration::hours(1)).to_rfc3339();
            assert!(!epg_refresh_due(Some(&last), now, 6));
        }

        #[test]
        fn fetch_older_than_interval_is_due() {
            let now = Utc::now();
            let last = (now - Duration::hours(6) - Duration::minutes(1)).to_rfc3339();
            assert!(epg_refresh_due(Some(&last), now, 6));
        }

        #[test]
        fn accepts_the_timestamp_format_written_by_force_refresh() {
            // chrono's to_rfc3339 with nanoseconds, as stored in epg_last_fetched.
            let now = Utc::now();
            assert!(!epg_refresh_due(Some("2026-03-15T15:03:20.435045575+00:00"), now, 24 * 365 * 10));
            assert!(epg_refresh_due(Some("2026-03-15T15:03:20.435045575+00:00"), now, 6));
        }
    }

    mod retry_allowed {
        use super::super::{epg_retry_allowed, EPG_AUTO_REFRESH_RETRY_MINUTES};
        use chrono::{Duration, Utc};

        #[test]
        fn never_attempted_is_allowed() {
            assert!(epg_retry_allowed(None, Utc::now(), EPG_AUTO_REFRESH_RETRY_MINUTES));
        }

        #[test]
        fn unparsable_timestamp_is_allowed() {
            assert!(epg_retry_allowed(Some("yesterday"), Utc::now(), EPG_AUTO_REFRESH_RETRY_MINUTES));
        }

        #[test]
        fn recent_attempt_blocks_retry() {
            let now = Utc::now();
            let last = (now - Duration::minutes(10)).to_rfc3339();
            assert!(!epg_retry_allowed(Some(&last), now, 60));
        }

        #[test]
        fn attempt_older_than_retry_window_is_allowed() {
            let now = Utc::now();
            let last = (now - Duration::minutes(61)).to_rfc3339();
            assert!(epg_retry_allowed(Some(&last), now, 60));
        }

        #[test]
        fn retry_window_is_one_hour() {
            assert_eq!(EPG_AUTO_REFRESH_RETRY_MINUTES, 60);
        }
    }
}
