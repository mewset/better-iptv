//! The guide's status as Settings and the guide's empty state see it: one
//! row per source that applies to the active profile, plus totals.
//!
//! Built in Rust so nothing that may carry credentials reaches the WebView:
//! a URL leaves masked, an Xtream source's URL (built from the login) not at
//! all.

use super::read::{active_profile, rfc3339};
use super::sources::{has_cached_feed, list_sources, SourceRecord};
use crate::epg_domain::policy::TimePolicy;
use crate::epg_domain::source::{applies_to, next_due_at, LastResult, SourceOrigin};
use crate::utils::mask_credentials;
use rusqlite::Connection;
use serde::Serialize;
use std::collections::HashSet;
use std::path::Path;
use url::Url;

/// One guide source in Settings.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct EpgSourceStatus {
    pub id: i64,
    pub origin: SourceOrigin,
    pub playlist_id: Option<i64>,
    /// A short name: the profile's name for a provider or playlist source,
    /// the server's host for a URL added by hand.
    pub label: String,
    /// The URL with credentials masked; `None` for an Xtream source, whose
    /// URL is built from the login when it is fetched.
    pub display_url: Option<String>,
    pub enabled: bool,
    pub priority: i32,
    /// The policy the user configured.
    pub policy: TimePolicy,
    /// The stored programmes are not all read under `policy` yet; see
    /// `SourceRecord::policy_pending`.
    pub policy_pending: bool,
    /// RFC 3339, UTC.
    pub last_attempt_at: Option<String>,
    /// RFC 3339, UTC.
    pub last_success_at: Option<String>,
    pub last_result: LastResult,
    /// A credential-free sentence.
    pub last_error: Option<String>,
    pub programme_count: u32,
    pub channel_count: u32,
    pub unknown_zone_count: u32,
    pub unknown_zone_sample: Option<String>,
    pub decode_replacements: u64,
    /// A feed is cached, so a time policy change applies without a download.
    pub has_cached_feed: bool,
    /// A download of this source is queued or running.
    pub refreshing: bool,
}

/// Channels matched to the guide, per way of matching. Filled once channel
/// matching exists; `None` until then.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct MatchCounts {
    pub by_id: u32,
    pub by_tvg_name: u32,
    pub by_name: u32,
    pub manual: u32,
    pub unmatched_with_id: u32,
    pub ambiguous_names: u32,
}

/// The guide's status for the active profile.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct EpgStatus {
    /// The sources that apply to the active profile, in precedence order.
    pub sources: Vec<EpgSourceStatus>,
    /// Programmes stored for the enabled sources among them.
    pub programme_count: u32,
    /// One of the enabled sources has been downloaded at least once.
    pub guide_downloaded: bool,
    /// When the background task will next find a source due (RFC 3339,
    /// UTC; it polls, so "around"); `None` without an enabled source.
    pub next_auto_refresh: Option<String>,
    pub matches: Option<MatchCounts>,
}

/// The source's short name; see `EpgSourceStatus::label`.
fn label(source: &SourceRecord) -> String {
    match source.origin {
        SourceOrigin::Xtream => source
            .playlist_name
            .clone()
            .unwrap_or_else(|| "Provider guide".to_string()),
        SourceOrigin::M3uHeader => source
            .playlist_name
            .clone()
            .unwrap_or_else(|| "Playlist guide".to_string()),
        SourceOrigin::Manual => source
            .url
            .as_deref()
            .and_then(|url| Url::parse(url).ok())
            .and_then(|url| url.host_str().map(str::to_string))
            .unwrap_or_else(|| "Guide URL".to_string()),
    }
}

/// One source's row.
pub fn source_status(source: &SourceRecord, cache_dir: &Path, refreshing: bool) -> EpgSourceStatus {
    let display_url = match source.origin {
        SourceOrigin::Xtream => None,
        SourceOrigin::Manual | SourceOrigin::M3uHeader => {
            source.url.as_deref().map(mask_credentials)
        }
    };
    EpgSourceStatus {
        id: source.id,
        origin: source.origin,
        playlist_id: source.playlist_id,
        label: label(source),
        display_url,
        enabled: source.enabled,
        priority: source.priority,
        policy: source.policy,
        policy_pending: source.policy_pending(),
        last_attempt_at: source.last_attempt_at.and_then(rfc3339),
        last_success_at: source.last_success_at.and_then(rfc3339),
        last_result: source.last_result,
        last_error: source.last_error.clone(),
        programme_count: source.programme_count,
        channel_count: source.channel_count,
        unknown_zone_count: source.unknown_zone_count,
        unknown_zone_sample: source.unknown_zone_sample.clone(),
        decode_replacements: source.decode_replacements,
        has_cached_feed: has_cached_feed(cache_dir, source.id),
        refreshing,
    }
}

/// The status for the active profile at `now` (Unix seconds); `refreshing`
/// holds the ids with a download queued or running.
pub fn epg_status(
    conn: &Connection,
    cache_dir: &Path,
    refreshing: &HashSet<i64>,
    now: i64,
) -> rusqlite::Result<EpgStatus> {
    let profile = active_profile(conn)?;
    let sources: Vec<SourceRecord> = list_sources(conn)?
        .into_iter()
        .filter(|s| applies_to(s.playlist_id, profile))
        .collect();
    let enabled = || sources.iter().filter(|s| s.enabled);
    Ok(EpgStatus {
        programme_count: enabled()
            .map(|s| s.programme_count)
            .fold(0u32, u32::saturating_add),
        guide_downloaded: enabled().any(|s| s.last_success_at.is_some()),
        next_auto_refresh: enabled()
            .map(|s| next_due_at(&s.schedule(), now))
            .min()
            .and_then(rfc3339),
        matches: None,
        sources: sources
            .iter()
            .map(|s| source_status(s, cache_dir, refreshing.contains(&s.id)))
            .collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::epg::sources::{ensure_xtream_source, feed_path};
    use crate::epg::test_support::*;
    use rusqlite::params;

    fn add_xtream_playlist(conn: &Connection, id: i64, name: &str) -> i64 {
        conn.execute(
            "INSERT INTO playlists (id, name, url, xtream_username, xtream_password)
             VALUES (?1, ?2, 'http://host', 'john', 'secret')",
            params![id, name],
        )
        .unwrap();
        ensure_xtream_source(conn, id).unwrap()
    }

    fn set_active(conn: &Connection, profile: i64) {
        crate::db::mutations::set_setting(conn, "active_profile_id", &profile.to_string()).unwrap();
    }

    #[test]
    fn rows_name_each_origin_without_credentials() {
        let f = Fixture::new("status");
        let conn = f.conn();
        let manual = add_manual(
            &conn,
            "http://epg.example:8080/xmltv.php?username=john&password=secret",
        );
        let xtream = add_xtream_playlist(&conn, 1, "My provider");
        set_active(&conn, 1);

        let status = epg_status(&conn, &f.dir.0, &HashSet::new(), NOW).unwrap();

        let by_id = |id: i64| status.sources.iter().find(|s| s.id == id).unwrap();
        assert_eq!(by_id(manual).label, "epg.example");
        assert_eq!(
            by_id(manual).display_url.as_deref(),
            Some("http://epg.example:8080/xmltv.php?username=****&password=****")
        );
        assert_eq!(by_id(xtream).label, "My provider");
        assert_eq!(by_id(xtream).display_url, None);
        let json = serde_json::to_string(&status).unwrap();
        assert!(!json.contains("secret") && !json.contains("john"), "{json}");
    }

    #[tokio::test]
    async fn a_row_carries_the_stored_state_in_rfc3339() {
        let f = Fixture::new("status");
        let s = add_manual(&f.conn(), "http://epg.example/epg.xml");
        let feed = Feed::new()
            .channel("svt1.se", &["SVT1"])
            .programme("svt1.se", NOW, NOW + H, "News")
            .programme("tv4.se", NOW, NOW + H, "News");
        f.store(s, &feed.xml(), NOW).await;
        f.conn()
            .execute(
                "UPDATE epg_source SET last_attempt_at = ?2, last_success_at = ?3,
                     last_result = 'partial', last_error = NULL WHERE id = ?1",
                params![s, NOW, NOW - H],
            )
            .unwrap();

        let refreshing = HashSet::from([s]);
        let status = epg_status(&f.conn(), &f.dir.0, &refreshing, NOW).unwrap();

        let row = &status.sources[0];
        assert_eq!(
            row.last_attempt_at.as_deref(),
            Some("2026-10-21T12:00:00+00:00")
        );
        assert_eq!(
            row.last_success_at.as_deref(),
            Some("2026-10-21T11:00:00+00:00")
        );
        assert_eq!(row.last_result, LastResult::Partial);
        assert_eq!((row.programme_count, row.channel_count), (2, 2));
        assert!(row.has_cached_feed);
        assert!(row.refreshing);
        assert!(!row.policy_pending);
        assert_eq!(status.programme_count, 2);
        assert!(status.guide_downloaded);
        // Six hours after the success, but no earlier than an hour after
        // the attempt.
        assert_eq!(
            status.next_auto_refresh.as_deref(),
            Some("2026-10-21T17:00:00+00:00")
        );

        f.set_shift(s, 30);
        std::fs::remove_file(feed_path(&f.dir.0, s)).unwrap();
        let status = epg_status(&f.conn(), &f.dir.0, &HashSet::new(), NOW).unwrap();
        let row = &status.sources[0];
        assert!(row.policy_pending);
        assert_eq!(row.policy.shift_minutes, 30);
        assert!(!row.has_cached_feed);
        assert!(!row.refreshing);
    }

    #[test]
    fn only_sources_for_the_active_profile_are_listed_and_counted() {
        let f = Fixture::new("status");
        let conn = f.conn();
        let manual = add_manual(&conn, "http://epg.example/epg.xml");
        let mine = add_xtream_playlist(&conn, 1, "Mine");
        let other = add_xtream_playlist(&conn, 2, "Other");
        conn.execute(
            "UPDATE epg_source SET programme_count = 10, last_success_at = ?1",
            params![NOW - H],
        )
        .unwrap();
        conn.execute(
            "UPDATE epg_source SET enabled = 0 WHERE id = ?1",
            params![manual],
        )
        .unwrap();
        set_active(&conn, 1);

        let status = epg_status(&conn, &f.dir.0, &HashSet::new(), NOW).unwrap();

        let ids: Vec<i64> = status.sources.iter().map(|s| s.id).collect();
        assert_eq!(
            ids,
            [manual, mine],
            "precedence order, other profile left out"
        );
        assert!(!ids.contains(&other));
        assert_eq!(
            status.programme_count, 10,
            "the disabled source is not counted"
        );
        assert_eq!(status.matches, None);

        conn.execute(
            "UPDATE epg_source SET enabled = 0 WHERE id = ?1",
            params![mine],
        )
        .unwrap();
        let status = epg_status(&conn, &f.dir.0, &HashSet::new(), NOW).unwrap();
        assert_eq!(status.programme_count, 0);
        assert!(!status.guide_downloaded);
        assert_eq!(status.next_auto_refresh, None);
    }

    #[test]
    fn the_payload_uses_the_field_names_the_frontend_lists() {
        let f = Fixture::new("status");
        let conn = f.conn();
        add_manual(&conn, "http://epg.example/epg.xml");
        let status = epg_status(&conn, &f.dir.0, &HashSet::new(), NOW).unwrap();
        let json = serde_json::to_value(&status).unwrap();
        let mut top: Vec<&str> = json
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        top.sort();
        assert_eq!(
            top,
            [
                "guide_downloaded",
                "matches",
                "next_auto_refresh",
                "programme_count",
                "sources"
            ]
        );
        let row = &json["sources"][0];
        let mut fields: Vec<&str> = row
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        fields.sort();
        assert_eq!(
            fields,
            [
                "channel_count",
                "decode_replacements",
                "display_url",
                "enabled",
                "has_cached_feed",
                "id",
                "label",
                "last_attempt_at",
                "last_error",
                "last_result",
                "last_success_at",
                "origin",
                "playlist_id",
                "policy",
                "policy_pending",
                "priority",
                "programme_count",
                "refreshing",
                "unknown_zone_count",
                "unknown_zone_sample",
            ]
        );
        assert_eq!(row["origin"], "manual");
        assert_eq!(row["last_result"], "never");
        assert_eq!(
            row["policy"],
            serde_json::json!({"interpret": "as_written", "shift_minutes": 0})
        );
    }
}
