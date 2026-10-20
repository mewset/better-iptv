//! XMLTV time values as written, before any time correction.
//!
//! The XMLTV DTD writes times as `YYYYMMDDhhmmss` "or some initial substring",
//! optionally followed by a zone. This module reads the wall-clock part and the
//! zone exactly as the feed states them; turning that into a UTC instant is the
//! job of `policy::TimePolicy`, because whether the stated zone can be trusted
//! is a per-source setting.

use chrono::{NaiveDate, NaiveDateTime};
use thiserror::Error;

/// The zone a feed wrote after a time.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RawOffset {
    /// A numeric offset (`+0200`, `+02:00`) or a zone name with a known
    /// offset (`Z`, `UTC`, `GMT`, `BST`), in minutes east of UTC.
    Explicit(i32),
    /// Nothing after the time.
    Missing,
    /// Something after the time that is not a readable zone.
    Unknown,
}

/// A time as the feed wrote it: wall-clock reading plus the stated zone.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RawTime {
    pub wall: NaiveDateTime,
    pub offset: RawOffset,
}

/// Why a time value could not be read.
#[derive(Debug, Error, PartialEq, Eq)]
pub enum TimeParseError {
    /// The leading digit run is not 4, 6, 8, 10, 12 or 14 digits long.
    #[error("time has {0} leading digits, expected 4 to 14 in pairs after the year")]
    Length(usize),
    /// The digits do not form a calendar date and time (month 13, hour 25).
    #[error("time digits are not a valid date and time")]
    OutOfRange,
}

/// Largest offset magnitude accepted as a zone, in minutes. chrono's
/// `FixedOffset` accepts strictly less than a day, as did the old parser.
const MAX_OFFSET_MINUTES: i32 = 24 * 60;

fn is_xml_whitespace(c: char) -> bool {
    matches!(c, ' ' | '\t' | '\n' | '\r')
}

/// Split a time value into its leading digit run and what follows it.
fn split_digits(value: &str) -> (&str, &str) {
    let value = value.trim_start_matches(is_xml_whitespace);
    let len = value.bytes().take_while(u8::is_ascii_digit).count();
    value.split_at(len)
}

/// The zone token of a time value: the first whitespace-separated word after
/// the digits, so `+0200 CEST` gives `+0200` and `20261020140000+0200` gives
/// `+0200`. `None` when nothing follows the digits.
///
/// The parse sink uses this to keep a sample of a zone it could not read.
pub fn offset_token(value: &str) -> Option<&str> {
    let (_, rest) = split_digits(value);
    rest.trim_start_matches(is_xml_whitespace)
        .split(is_xml_whitespace)
        .next()
        .filter(|token| !token.is_empty())
}

/// Read an XMLTV time value without converting it.
///
/// The digit run may be any initial substring of `YYYYMMDDhhmmss` that ends on
/// a field boundary: 4, 6, 8, 10, 12 or 14 digits. A missing month or day is
/// 1, a missing hour, minute or second is 0. The zone is read from
/// `offset_token`; a numeric offset beyond a day counts as `Unknown`.
pub fn parse_raw_time(value: &str) -> Result<RawTime, TimeParseError> {
    let (digits, _) = split_digits(value);
    let len = digits.len();
    if !matches!(len, 4 | 6 | 8 | 10 | 12 | 14) {
        return Err(TimeParseError::Length(len));
    }
    // Every byte is an ASCII digit, so slicing on byte offsets is safe.
    let field = |from: usize, default: u32| -> u32 {
        digits
            .get(from..from + 2)
            .map_or(default, |pair| pair.parse().unwrap_or(default))
    };
    let year: i32 = digits[..4]
        .parse()
        .map_err(|_| TimeParseError::OutOfRange)?;
    let wall = NaiveDate::from_ymd_opt(year, field(4, 1), field(6, 1))
        .and_then(|date| date.and_hms_opt(field(8, 0), field(10, 0), field(12, 0)))
        .ok_or(TimeParseError::OutOfRange)?;

    Ok(RawTime {
        wall,
        offset: classify_offset(offset_token(value)),
    })
}

fn classify_offset(token: Option<&str>) -> RawOffset {
    let Some(token) = token else {
        return RawOffset::Missing;
    };
    if let Some(minutes) = parse_tz_offset(token.as_bytes()) {
        if minutes.abs() < MAX_OFFSET_MINUTES {
            return RawOffset::Explicit(minutes);
        }
        return RawOffset::Unknown;
    }
    // The zone names the DTD itself mentions.
    if ["Z", "UTC", "GMT"]
        .iter()
        .any(|name| token.eq_ignore_ascii_case(name))
    {
        RawOffset::Explicit(0)
    } else if token.eq_ignore_ascii_case("BST") {
        RawOffset::Explicit(60)
    } else {
        RawOffset::Unknown
    }
}

/// Parse timezone offset (+0100, -0500, +01:00, etc.) into minutes
pub fn parse_tz_offset(tz: &[u8]) -> Option<i32> {
    let (sign, digits) = match tz {
        [b'+', rest @ ..] => (1, rest),
        [b'-', rest @ ..] => (-1, rest),
        _ => return None,
    };
    let (hh, mm) = match digits {
        [h1, h2, b':', m1, m2] | [h1, h2, m1, m2] => ([*h1, *h2], [*m1, *m2]),
        _ => return None,
    };
    let two_digits = |pair: [u8; 2]| -> Option<i32> {
        pair.iter()
            .all(u8::is_ascii_digit)
            .then(|| i32::from(pair[0] - b'0') * 10 + i32::from(pair[1] - b'0'))
    };

    Some(sign * (two_digits(hh)? * 60 + two_digits(mm)?))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wall(s: &str) -> NaiveDateTime {
        NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S").unwrap()
    }

    fn offset(value: &str) -> RawOffset {
        parse_raw_time(value).unwrap().offset
    }

    #[test]
    fn a_full_time_is_read_as_written() {
        let raw = parse_raw_time("20261020140000 +0200").unwrap();
        assert_eq!(raw.wall, wall("2026-10-20 14:00:00"));
        assert_eq!(raw.offset, RawOffset::Explicit(120));
    }

    #[test]
    fn initial_substrings_fill_the_missing_fields() {
        let cases = [
            ("2026", "2026-01-01 00:00:00"),
            ("202610", "2026-10-01 00:00:00"),
            ("20261020", "2026-10-20 00:00:00"),
            ("2026102014", "2026-10-20 14:00:00"),
            ("202610201430", "2026-10-20 14:30:00"),
            ("20261020143015", "2026-10-20 14:30:15"),
        ];
        for (value, expected) in cases {
            let raw = parse_raw_time(value).unwrap();
            assert_eq!(raw.wall, wall(expected), "{value}");
            assert_eq!(raw.offset, RawOffset::Missing, "{value}");
        }
    }

    #[test]
    fn odd_and_overlong_digit_runs_are_rejected() {
        for len in [0, 1, 2, 3, 5, 7, 9, 11, 13, 15, 16] {
            let value = "2".repeat(len);
            assert_eq!(
                parse_raw_time(&value),
                Err(TimeParseError::Length(len)),
                "{len}"
            );
        }
        assert_eq!(
            parse_raw_time("2026102014000 +0200"),
            Err(TimeParseError::Length(13))
        );
    }

    #[test]
    fn digits_that_are_not_a_date_are_rejected() {
        assert_eq!(
            parse_raw_time("20261320140000 +0200"),
            Err(TimeParseError::OutOfRange)
        );
        assert_eq!(
            parse_raw_time("20261020250000"),
            Err(TimeParseError::OutOfRange)
        );
        assert_eq!(
            parse_raw_time("20260230000000"),
            Err(TimeParseError::OutOfRange)
        );
    }

    #[test]
    fn a_non_digit_inside_the_time_ends_the_digit_run() {
        // The old parser's malformed case: the run stops after "202".
        assert_eq!(
            parse_raw_time("202ö61020140000 +0200"),
            Err(TimeParseError::Length(3))
        );
    }

    #[test]
    fn numeric_offsets_are_read_in_every_spelling() {
        assert_eq!(offset("20261020140000 +0200"), RawOffset::Explicit(120));
        assert_eq!(offset("20261020140000+0200"), RawOffset::Explicit(120));
        assert_eq!(offset("20261020140000  +0200"), RawOffset::Explicit(120));
        assert_eq!(offset("20261020140000 +02:00"), RawOffset::Explicit(120));
        assert_eq!(offset("20261020100000 -0200"), RawOffset::Explicit(-120));
        assert_eq!(offset("20261020140000 +0530"), RawOffset::Explicit(330));
    }

    #[test]
    fn only_the_first_word_after_the_time_is_the_zone() {
        assert_eq!(
            offset("20261020140000 +0200 CEST"),
            RawOffset::Explicit(120)
        );
        assert_eq!(offset_token("20261020140000 +0200 CEST"), Some("+0200"));
    }

    #[test]
    fn utc_names_and_bst_are_known_zones() {
        assert_eq!(offset("20261020140000 Z"), RawOffset::Explicit(0));
        assert_eq!(offset("20261020140000Z"), RawOffset::Explicit(0));
        assert_eq!(offset("20261020140000 UTC"), RawOffset::Explicit(0));
        assert_eq!(offset("20261020140000 GMT"), RawOffset::Explicit(0));
        assert_eq!(offset("20261020140000 gmt"), RawOffset::Explicit(0));
        assert_eq!(offset("20261020140000 BST"), RawOffset::Explicit(60));
    }

    #[test]
    fn unreadable_zones_are_unknown_and_keep_their_token() {
        assert_eq!(offset("20261020140000 CEST"), RawOffset::Unknown);
        assert_eq!(offset_token("20261020140000 CEST"), Some("CEST"));
        assert_eq!(offset("20261020140000 +2"), RawOffset::Unknown);
        assert_eq!(offset("20261020140000 0200"), RawOffset::Unknown);
        assert_eq!(offset("20261020140000 +02x0"), RawOffset::Unknown);
    }

    #[test]
    fn offsets_of_a_day_or_more_are_unknown() {
        assert_eq!(offset("20261020140000 +2400"), RawOffset::Unknown);
        assert_eq!(offset("20261020140000 -9999"), RawOffset::Unknown);
        assert_eq!(offset("20261020140000 +2359"), RawOffset::Explicit(1439));
    }

    #[test]
    fn nothing_after_the_time_is_missing() {
        assert_eq!(offset("20261020140000"), RawOffset::Missing);
        assert_eq!(offset("20261020140000   "), RawOffset::Missing);
        assert_eq!(offset_token("20261020140000 "), None);
    }

    #[test]
    fn leading_whitespace_is_skipped() {
        let raw = parse_raw_time("  20261020140000 +0200").unwrap();
        assert_eq!(raw.wall, wall("2026-10-20 14:00:00"));
        assert_eq!(raw.offset, RawOffset::Explicit(120));
    }

    #[test]
    fn parse_tz_offset_reads_both_numeric_forms() {
        assert_eq!(parse_tz_offset(b"+0100"), Some(60));
        assert_eq!(parse_tz_offset(b"-0500"), Some(-300));
        assert_eq!(parse_tz_offset(b"+01:00"), Some(60));
        assert_eq!(parse_tz_offset(b"-03:30"), Some(-210));
        assert_eq!(parse_tz_offset(b"+0000"), Some(0));
        assert_eq!(parse_tz_offset(b"0100"), None);
        assert_eq!(parse_tz_offset(b"+100"), None);
        assert_eq!(parse_tz_offset(b"+01000"), None);
        assert_eq!(parse_tz_offset(b"+0a00"), None);
        assert_eq!(parse_tz_offset(b"+"), None);
        assert_eq!(parse_tz_offset(b""), None);
    }
}
