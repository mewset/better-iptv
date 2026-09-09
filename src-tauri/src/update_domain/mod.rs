//! Update-check business logic: pure, synchronous, no I/O.

use chrono::{DateTime, Utc};

/// Parse a release version into comparable parts.
///
/// Accepts a leading `v`, one to three dot-separated numbers with any missing
/// component counting as zero, and ignores a `-rc1` or `+build` suffix.
/// Anything else is unparsable and yields `None`.
fn parse_version(raw: &str) -> Option<(u32, u32, u32)> {
    let trimmed = raw.trim();
    let without_v = trimmed.strip_prefix(['v', 'V']).unwrap_or(trimmed);
    let core = without_v
        .split(['-', '+'])
        .next()
        .unwrap_or_default()
        .trim();

    let mut parts = [0u32; 3];
    let mut seen = 0;
    for field in core.split('.') {
        if seen == 3 {
            return None;
        }
        parts[seen] = field.parse().ok()?;
        seen += 1;
    }
    if seen == 0 {
        return None;
    }
    Some((parts[0], parts[1], parts[2]))
}

/// Whether `candidate` is a strictly newer release than `current`.
///
/// If either side is unparsable the answer is `false`: a version we cannot
/// read is never grounds for telling the user to update.
pub fn is_newer_version(current: &str, candidate: &str) -> bool {
    match (parse_version(current), parse_version(candidate)) {
        (Some(current), Some(candidate)) => candidate > current,
        _ => false,
    }
}

/// How old `update_last_checked` may be before another check runs.
pub const UPDATE_CHECK_INTERVAL_HOURS: i64 = 24;

/// Decide whether an update check should run now.
///
/// `last_checked` is the RFC 3339 string stored in the `update_last_checked`
/// setting. A missing or unreadable value counts as "never checked".
pub fn update_check_due(
    last_checked: Option<&str>,
    now: DateTime<Utc>,
    interval_hours: i64,
) -> bool {
    match last_checked.and_then(|s| DateTime::parse_from_rfc3339(s).ok()) {
        Some(last) => now - last.with_timezone(&Utc) >= chrono::Duration::hours(interval_hours),
        None => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn at(hour: u32) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 9, 9, hour, 0, 0).unwrap()
    }

    #[test]
    fn a_higher_patch_is_newer() {
        assert!(is_newer_version("2.8.0", "2.8.1"));
    }

    #[test]
    fn the_same_version_is_not_newer() {
        assert!(!is_newer_version("2.8.1", "2.8.1"));
    }

    #[test]
    fn an_older_version_is_not_newer() {
        assert!(!is_newer_version("2.8.1", "2.8.0"));
    }

    #[test]
    fn minor_ten_beats_minor_nine() {
        // A string comparison would call "2.10.0" older than "2.9.0".
        assert!(is_newer_version("2.9.0", "2.10.0"));
    }

    #[test]
    fn a_leading_v_is_ignored() {
        assert!(is_newer_version("2.8.0", "v2.8.1"));
        assert!(!is_newer_version("2.8.1", "v2.8.1"));
    }

    #[test]
    fn a_prerelease_suffix_is_ignored() {
        assert!(is_newer_version("2.8.1", "v2.9.0-rc1"));
    }

    #[test]
    fn a_missing_component_counts_as_zero() {
        assert!(is_newer_version("2.8.1", "2.9"));
        assert!(!is_newer_version("2.9.0", "2.9"));
    }

    #[test]
    fn an_unparsable_candidate_is_not_newer() {
        assert!(!is_newer_version("2.8.1", "banana"));
        assert!(!is_newer_version("2.8.1", ""));
    }

    #[test]
    fn an_unparsable_current_version_never_nags() {
        assert!(!is_newer_version("", "2.8.1"));
        assert!(!is_newer_version("nightly", "2.8.1"));
    }

    #[test]
    fn a_check_that_never_ran_is_due() {
        assert!(update_check_due(None, at(12), 24));
    }

    #[test]
    fn a_check_older_than_the_interval_is_due() {
        assert!(update_check_due(Some("2026-09-08T11:00:00Z"), at(12), 24));
    }

    #[test]
    fn a_recent_check_is_not_due() {
        assert!(!update_check_due(Some("2026-09-09T11:00:00Z"), at(12), 24));
    }

    #[test]
    fn an_unreadable_timestamp_is_due() {
        assert!(update_check_due(Some("not a timestamp"), at(12), 24));
    }
}
