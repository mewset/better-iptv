//! Channel-logo fallback business logic: pure, synchronous, no I/O.
//!
//! Decides which iptv-org logo to use for an EPG channel id, and when the
//! logo list is due for a refresh.

use chrono::{DateTime, Duration, Utc};
use serde::Deserialize;
use std::collections::HashMap;

/// Public iptv-org logo list.
pub const LOGOS_URL: &str = "https://iptv-org.github.io/api/logos.json";
/// How old the stored logo list may be before it is fetched again.
pub const FETCH_INTERVAL_DAYS: i64 = 7;
/// How long a logo URL that failed to load stays marked dead.
pub const DEAD_MARK_TTL_DAYS: i64 = 7;

pub const LOGO_FALLBACK_ENABLED_KEY: &str = "logo_fallback_enabled";
pub const LOGO_FALLBACK_FETCHED_AT_KEY: &str = "logo_fallback_fetched_at";
pub const LOGO_FALLBACK_ETAG_KEY: &str = "logo_fallback_etag";

/// One entry of iptv-org's `logos.json`; unknown fields are ignored.
#[derive(Debug, Clone, Deserialize)]
pub struct IptvOrgLogo {
    pub channel: String,
    pub feed: Option<String>,
    #[serde(default = "yes")]
    pub in_use: bool,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub url: String,
}

fn yes() -> bool {
    true
}

/// Normalize an EPG channel id for lookup: drop any `@feed` suffix, trim and
/// lowercase. An empty result is `None`.
pub fn normalize_epg_key(raw: &str) -> Option<String> {
    let base = raw.trim().split('@').next().unwrap_or_default().trim();
    if base.is_empty() {
        None
    } else {
        Some(base.to_lowercase())
    }
}

/// Pick one https logo URL per normalized channel key.
///
/// Best entry wins by channel-level (no feed) first, then `in_use`, then
/// pixel area. Ties keep the first one seen.
pub fn select_fallbacks(logos: Vec<IptvOrgLogo>) -> HashMap<String, String> {
    let mut best: HashMap<String, ((bool, bool, u64), String)> = HashMap::new();
    for logo in logos {
        if !logo.url.starts_with("https://") {
            continue;
        }
        let Some(key) = normalize_epg_key(&logo.channel) else {
            continue;
        };
        let area = u64::from(logo.width.unwrap_or(0)) * u64::from(logo.height.unwrap_or(0));
        let rank = (logo.feed.is_none(), logo.in_use, area);
        match best.get(&key) {
            Some((current, _)) if *current >= rank => {}
            _ => {
                best.insert(key, (rank, logo.url));
            }
        }
    }
    best.into_iter().map(|(k, (_, url))| (k, url)).collect()
}

/// Whether the logo list should be fetched now. `last_fetched` is the RFC 3339
/// string from settings; missing or unreadable counts as never fetched.
pub fn fetch_due(last_fetched: Option<&str>, now: DateTime<Utc>) -> bool {
    match last_fetched.and_then(|s| DateTime::parse_from_rfc3339(s).ok()) {
        Some(last) => now - last.with_timezone(&Utc) >= Duration::days(FETCH_INTERVAL_DAYS),
        None => true,
    }
}

/// The fallback is on unless the setting is exactly `"0"`.
pub fn is_enabled(value: Option<&str>) -> bool {
    value != Some("0")
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{Duration, TimeZone};

    fn now() -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 10, 18, 12, 0, 0).unwrap()
    }

    fn logo(
        channel: &str,
        feed: Option<&str>,
        in_use: bool,
        w: u32,
        h: u32,
        url: &str,
    ) -> IptvOrgLogo {
        IptvOrgLogo {
            channel: channel.into(),
            feed: feed.map(String::from),
            in_use,
            width: Some(w),
            height: Some(h),
            url: url.into(),
        }
    }

    #[test]
    fn normalize_lowercases_and_trims() {
        assert_eq!(normalize_epg_key("  TV3.se "), Some("tv3.se".into()));
    }

    #[test]
    fn normalize_drops_feed_suffix() {
        assert_eq!(
            normalize_epg_key("AfricaTV3.ng@SD"),
            Some("africatv3.ng".into())
        );
    }

    #[test]
    fn normalize_empty_is_none() {
        assert_eq!(normalize_epg_key("  "), None);
        assert_eq!(normalize_epg_key("@SD"), None);
    }

    #[test]
    fn select_prefers_channel_level_over_feed() {
        let map = select_fallbacks(vec![
            logo("tv3.se", Some("SD"), true, 512, 512, "https://x/feed.png"),
            logo("tv3.se", None, true, 100, 100, "https://x/channel.png"),
        ]);
        assert_eq!(
            map.get("tv3.se").map(String::as_str),
            Some("https://x/channel.png")
        );
    }

    #[test]
    fn select_prefers_in_use_then_larger() {
        let map = select_fallbacks(vec![
            logo("a.se", None, false, 1000, 1000, "https://x/unused.png"),
            logo("a.se", None, true, 10, 10, "https://x/used.png"),
        ]);
        assert_eq!(map["a.se"], "https://x/used.png");

        let map = select_fallbacks(vec![
            logo("b.se", None, true, 10, 10, "https://x/small.png"),
            logo("b.se", None, true, 20, 20, "https://x/big.png"),
        ]);
        assert_eq!(map["b.se"], "https://x/big.png");
    }

    #[test]
    fn select_ties_keep_first_seen() {
        let map = select_fallbacks(vec![
            logo("c.se", None, true, 10, 10, "https://x/first.png"),
            logo("c.se", None, true, 10, 10, "https://x/second.png"),
        ]);
        assert_eq!(map["c.se"], "https://x/first.png");
    }

    #[test]
    fn select_drops_http_urls() {
        let map = select_fallbacks(vec![logo("tv3.se", None, true, 10, 10, "http://x/a.png")]);
        assert!(!map.contains_key("tv3.se"));
    }

    #[test]
    fn select_keys_are_normalized() {
        let map = select_fallbacks(vec![logo("TV3.se", None, true, 10, 10, "https://x/a.png")]);
        assert!(map.contains_key("tv3.se"));
    }

    #[test]
    fn fetch_due_when_never_fetched_or_garbage() {
        assert!(fetch_due(None, now()));
        assert!(fetch_due(Some("nope"), now()));
    }

    #[test]
    fn fetch_not_due_within_seven_days() {
        let recent = (now() - Duration::days(6) - Duration::hours(23)).to_rfc3339();
        assert!(!fetch_due(Some(&recent), now()));
        let old = (now() - Duration::days(7) - Duration::minutes(1)).to_rfc3339();
        assert!(fetch_due(Some(&old), now()));
    }

    #[test]
    fn enabled_unless_zero() {
        assert!(is_enabled(None));
        assert!(is_enabled(Some("1")));
        assert!(!is_enabled(Some("0")));
    }

    #[test]
    fn deserializes_iptv_org_shape() {
        let json = r#"[{"channel":"TV3.se","feed":null,"in_use":true,"tags":[],"width":322,"height":512,"format":"PNG","url":"https://i.imgur.com/oysCIiw.png"}]"#;
        let parsed: Vec<IptvOrgLogo> = serde_json::from_str(json).unwrap();
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].channel, "TV3.se");
        assert_eq!(parsed[0].feed, None);
        assert!(parsed[0].in_use);
        assert_eq!(parsed[0].width, Some(322));
        assert_eq!(parsed[0].height, Some(512));
    }

    #[test]
    fn in_use_defaults_to_true() {
        let json = r#"{"channel":"x","url":"https://x/a.png"}"#;
        let parsed: IptvOrgLogo = serde_json::from_str(json).unwrap();
        assert!(parsed.in_use);
    }
}
