//! EPG domain logic module
//!
//! This module contains business logic for EPG operations, separated from
//! database and command layers for better testability and maintainability.

pub mod key;
pub mod normalize;
pub mod policy;
pub mod report;
pub mod source;
pub mod text;
pub mod time;

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
        return Err(AppError::InvalidInput(
            "EPG URL cannot be empty".to_string(),
        ));
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

/// Longest window a single guide request may span.
pub const GUIDE_MAX_WINDOW_HOURS: i64 = 48;

/// Longest range the "which channels have guide data" lookup may span: the
/// guide's five days fit with room for a day boundary in any time zone.
pub const GUIDE_IDS_MAX_WINDOW_HOURS: i64 = 168;

/// Most EPG ids one `get_guide` request may name. The frontend asks for every
/// row with guide data at once and splits larger sets into requests of this size.
pub const GUIDE_MAX_IDS: usize = 5000;

/// Validate a guide request's time window and turn it into Unix seconds.
///
/// Parses `from` and `to` as RFC 3339 (any offset), requires `to` to be
/// strictly after `from`, and rejects a window longer than
/// `GUIDE_MAX_WINDOW_HOURS`. `from` is truncated to its second and `to`
/// rounded up to the next whole second, so a programme starting inside the
/// last fraction of the window is still in it, as with the RFC 3339 strings
/// the guide was compared against before it was stored in seconds.
pub fn validate_guide_window(from: &str, to: &str) -> Result<(i64, i64), AppError> {
    validate_window(from, to, GUIDE_MAX_WINDOW_HOURS)
}

/// `validate_guide_window` for the key lookup, which spans the guide's days.
pub fn validate_guide_ids_window(from: &str, to: &str) -> Result<(i64, i64), AppError> {
    validate_window(from, to, GUIDE_IDS_MAX_WINDOW_HOURS)
}

fn validate_window(from: &str, to: &str, max_hours: i64) -> Result<(i64, i64), AppError> {
    let from_dt = DateTime::parse_from_rfc3339(from)
        .map_err(|e| AppError::InvalidInput(format!("Invalid 'from' timestamp: {}", e)))?
        .with_timezone(&Utc);
    let to_dt = DateTime::parse_from_rfc3339(to)
        .map_err(|e| AppError::InvalidInput(format!("Invalid 'to' timestamp: {}", e)))?
        .with_timezone(&Utc);

    if to_dt <= from_dt {
        return Err(AppError::InvalidInput(
            "'to' must be after 'from'".to_string(),
        ));
    }

    if to_dt - from_dt > chrono::Duration::hours(max_hours) {
        return Err(AppError::InvalidInput(format!(
            "Guide window cannot exceed {} hours",
            max_hours
        )));
    }

    let to_secs = to_dt.timestamp() + i64::from(to_dt.timestamp_subsec_nanos() > 0);
    Ok((from_dt.timestamp(), to_secs))
}

/// Reject a guide request naming more than `GUIDE_MAX_IDS` ids.
pub fn validate_guide_id_count(count: usize) -> Result<(), AppError> {
    if count > GUIDE_MAX_IDS {
        return Err(AppError::InvalidInput(format!(
            "At most {} EPG ids per guide request",
            GUIDE_MAX_IDS
        )));
    }
    Ok(())
}

/// How long a source's guide stays fresh before the background task fetches
/// it again (`source::source_due`).
pub const EPG_AUTO_REFRESH_INTERVAL_HOURS: i64 = 6;

/// Minimum spacing between attempts on one source, so a broken URL is not
/// downloaded again at every poll.
pub const EPG_AUTO_REFRESH_RETRY_MINUTES: i64 = 60;

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

    mod guide_window {
        use super::super::{
            validate_guide_id_count, validate_guide_ids_window, validate_guide_window,
        };
        use crate::error::AppError;
        use chrono::{Duration, Utc};

        #[test]
        fn valid_window_is_accepted_as_unix_seconds_whatever_the_offset() {
            let (from, to) =
                validate_guide_window("2026-10-21T14:00:00+02:00", "2026-10-21T13:00:00Z").unwrap();
            assert_eq!((from, to), (1_792_584_000, 1_792_587_600));
        }

        #[test]
        fn from_is_truncated_and_to_rounded_up_to_whole_seconds() {
            let (from, to) =
                validate_guide_window("2026-10-21T12:00:00.900Z", "2026-10-21T13:00:00.001Z")
                    .unwrap();
            assert_eq!(from, 1_792_584_000);
            assert_eq!(to, 1_792_587_601, "a start at 13:00:00 is still inside");
            let (_, to) =
                validate_guide_window("2026-10-21T12:00:00Z", "2026-10-21T13:00:00.000Z").unwrap();
            assert_eq!(to, 1_792_587_600, "a whole second stays as it is");
        }

        #[test]
        fn unparsable_from_is_rejected() {
            let to = Utc::now() + Duration::hours(1);
            let err = validate_guide_window("not-a-date", &to.to_rfc3339()).unwrap_err();
            assert!(matches!(err, AppError::InvalidInput(_)));
        }

        #[test]
        fn unparsable_to_is_rejected() {
            let from = Utc::now();
            let err = validate_guide_window(&from.to_rfc3339(), "not-a-date").unwrap_err();
            assert!(matches!(err, AppError::InvalidInput(_)));
        }

        #[test]
        fn equal_bounds_are_rejected() {
            let now = Utc::now().to_rfc3339();
            assert!(validate_guide_window(&now, &now).is_err());
        }

        #[test]
        fn inverted_window_is_rejected() {
            let now = Utc::now();
            let earlier = (now - Duration::hours(1)).to_rfc3339();
            assert!(validate_guide_window(&now.to_rfc3339(), &earlier).is_err());
        }

        #[test]
        fn window_longer_than_48_hours_is_rejected() {
            let from = Utc::now();
            let to = from + Duration::hours(48) + Duration::minutes(1);
            assert!(validate_guide_window(&from.to_rfc3339(), &to.to_rfc3339()).is_err());
        }

        #[test]
        fn window_of_exactly_48_hours_is_accepted() {
            let from = Utc::now();
            let to = from + Duration::hours(48);
            assert!(validate_guide_window(&from.to_rfc3339(), &to.to_rfc3339()).is_ok());
        }

        #[test]
        fn ids_window_accepts_seven_days_and_rejects_more() {
            let from = Utc::now();
            let week = from + Duration::hours(168);
            assert!(validate_guide_ids_window(&from.to_rfc3339(), &week.to_rfc3339()).is_ok());
            let longer = week + Duration::minutes(1);
            assert!(validate_guide_ids_window(&from.to_rfc3339(), &longer.to_rfc3339()).is_err());
        }

        #[test]
        fn ids_window_rejects_unparsable_and_inverted_bounds() {
            let now = Utc::now();
            assert!(validate_guide_ids_window("nope", &now.to_rfc3339()).is_err());
            let earlier = (now - Duration::hours(1)).to_rfc3339();
            assert!(validate_guide_ids_window(&now.to_rfc3339(), &earlier).is_err());
        }

        #[test]
        fn ids_window_returns_unix_seconds() {
            let (from, to) =
                validate_guide_ids_window("2026-10-08T00:00:00+02:00", "2026-10-13T00:00:00+02:00")
                    .unwrap();
            assert_eq!(from, 1_791_410_400);
            assert_eq!(to - from, 5 * 24 * 3600);
        }

        #[test]
        fn guide_id_count_allows_5000_and_rejects_5001() {
            assert!(validate_guide_id_count(5000).is_ok());
            assert!(matches!(
                validate_guide_id_count(5001),
                Err(AppError::InvalidInput(_))
            ));
        }
    }
}
