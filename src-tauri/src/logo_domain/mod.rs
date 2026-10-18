//! Channel-logo fallback business logic: pure, synchronous, no I/O.
//!
//! Decides which iptv-org logo to use for an EPG channel id, and when the
//! logo list is due for a refresh.

use chrono::{DateTime, Duration, Utc};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Deserializer};
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

/// One entry of iptv-org's `logos.json`; unknown fields are ignored. Every
/// field is lenient: a missing, null or wrongly typed value reads as absent,
/// so one odd entry costs only itself, never the whole list.
#[derive(Debug, Clone, Deserialize)]
pub struct IptvOrgLogo {
    #[serde(default, deserialize_with = "lenient")]
    pub channel: Option<String>,
    #[serde(default, deserialize_with = "lenient")]
    pub feed: Option<String>,
    #[serde(default = "yes", deserialize_with = "lenient_in_use")]
    pub in_use: bool,
    #[serde(default, deserialize_with = "lenient")]
    pub width: Option<f64>,
    #[serde(default, deserialize_with = "lenient")]
    pub height: Option<f64>,
    #[serde(default, deserialize_with = "lenient")]
    pub url: Option<String>,
}

fn yes() -> bool {
    true
}

/// `Some` when the value has the expected type, otherwise `None`.
fn lenient<'de, D: Deserializer<'de>, T: DeserializeOwned>(d: D) -> Result<Option<T>, D::Error> {
    let value = serde_json::Value::deserialize(d)?;
    Ok(serde_json::from_value(value).ok())
}

fn lenient_in_use<'de, D: Deserializer<'de>>(d: D) -> Result<bool, D::Error> {
    Ok(lenient::<D, bool>(d)?.unwrap_or(true))
}

/// A pixel size as a whole number; negative or NaN counts as 0.
fn pixels(size: Option<f64>) -> u64 {
    // `as` saturates: NaN and negatives become 0.
    size.unwrap_or(0.0) as u64
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
        let Some(url) = logo.url.filter(|u| u.starts_with("https://")) else {
            continue;
        };
        let Some(key) = logo.channel.as_deref().and_then(normalize_epg_key) else {
            continue;
        };
        let area = pixels(logo.width).saturating_mul(pixels(logo.height));
        let rank = (logo.feed.is_none(), logo.in_use, area);
        match best.get(&key) {
            Some((current, _)) if *current >= rank => {}
            _ => {
                best.insert(key, (rank, url));
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
            channel: Some(channel.into()),
            feed: feed.map(String::from),
            in_use,
            width: Some(f64::from(w)),
            height: Some(f64::from(h)),
            url: Some(url.into()),
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
        assert_eq!(parsed[0].channel.as_deref(), Some("TV3.se"));
        assert_eq!(parsed[0].feed, None);
        assert!(parsed[0].in_use);
        assert_eq!(parsed[0].width, Some(322.0));
        assert_eq!(parsed[0].height, Some(512.0));
    }

    #[test]
    fn one_malformed_entry_does_not_fail_the_list() {
        let json = r#"[
            {"channel":"TV3.se","feed":null,"in_use":true,"width":100,"height":100,"url":"https://x/tv3.png"},
            {"channel":"Bad.se","feed":null,"in_use":true,"width":12.5,"height":null,"url":null},
            {"channel":null,"feed":7,"in_use":"yes","width":"wide","height":{},"url":"https://x/none.png"},
            {"channel":"Float.se","feed":null,"in_use":true,"width":64.0,"height":32.5,"url":"https://x/float.png"},
            {"channel":"SVT1.se","url":"https://x/svt1.png"}
        ]"#;
        let parsed: Vec<IptvOrgLogo> = serde_json::from_str(json).unwrap();
        let map = select_fallbacks(parsed);
        let mut keys: Vec<_> = map.keys().cloned().collect();
        keys.sort();
        assert_eq!(keys, ["float.se", "svt1.se", "tv3.se"]);
        assert_eq!(map["float.se"], "https://x/float.png");
    }

    #[test]
    fn float_sizes_still_rank_by_area() {
        let json = r#"[
            {"channel":"a.se","width":10.5,"height":10,"url":"https://x/small.png"},
            {"channel":"a.se","width":20.5,"height":20,"url":"https://x/big.png"}
        ]"#;
        let parsed: Vec<IptvOrgLogo> = serde_json::from_str(json).unwrap();
        assert_eq!(select_fallbacks(parsed)["a.se"], "https://x/big.png");
    }

    #[test]
    fn in_use_defaults_to_true() {
        let json = r#"{"channel":"x","url":"https://x/a.png"}"#;
        let parsed: IptvOrgLogo = serde_json::from_str(json).unwrap();
        assert!(parsed.in_use);
    }
}
