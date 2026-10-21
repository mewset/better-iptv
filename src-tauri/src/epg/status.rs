//! The guide's status as Settings and the guide's empty state see it: one
//! row per source that applies to the active profile, plus totals.
//!
//! Built in Rust so nothing that may carry credentials reaches the WebView:
//! a URL leaves masked, an Xtream source's URL (built from the login) not at
//! all.

use super::matching::guide_index;
use super::read::{active_profile, rfc3339};
use super::sources::{has_cached_feed, list_sources, SourceRecord};
use crate::epg_domain::key::channel_key;
use crate::epg_domain::matching::MatchSource;
use crate::epg_domain::policy::TimePolicy;
use crate::epg_domain::source::{applies_to, next_due_at, LastResult, SourceOrigin};
use rusqlite::{params, Connection};
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
    /// A re-read of the cached feed under a changed time policy is queued
    /// or running. Settings shows "Applying…" while it is set.
    pub applying: bool,
}

/// The active profile's live channels and the guide, as `epg::matching`
/// stored them.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct MatchCounts {
    pub by_id: u32,
    pub by_tvg_name: u32,
    pub by_name: u32,
    /// Matched by hand.
    pub manual: u32,
    /// Live channels with an id the guide does not know.
    pub unmatched_with_id: u32,
    /// Display names one source gives to two channels, which match nothing.
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
    /// `None` while no enabled source has a guide channel with programmes
    /// ("Guide not downloaded yet" rather than "0 matched").
    pub matches: Option<MatchCounts>,
}

/// The source's short name; see `EpgSourceStatus::label`.
pub fn label(source: &SourceRecord) -> String {
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

/// The source of a guide channel the picker found, in the words Settings
/// uses: the provider's and the playlist's guide by what they are, a URL
/// added by hand by its host.
pub fn picker_label(source: &SourceRecord) -> String {
    match source.origin {
        SourceOrigin::Xtream => "Your provider's guide".to_string(),
        SourceOrigin::M3uHeader => "From the playlist".to_string(),
        SourceOrigin::Manual => label(source),
    }
}

/// Shown instead of a URL that does not parse: the raw string could hold
/// anything, credentials included.
pub const HIDDEN_URL: &str = "(address hidden)";

/// A source URL as Settings may show it: scheme, host, port and path, the
/// query's keys with every value replaced by `****` (a key without a value
/// becomes `****` itself), no username, password or fragment. Built from
/// the parsed URL rather than by pattern, so `?token=`, `?key=`, `?pass=`
/// and a password with an unencoded `@` are covered alike. A secret inside
/// the path (`/get/<token>/epg.xml`) cannot be told from a directory name
/// and is shown.
pub fn display_url(raw: &str) -> String {
    let Ok(mut url) = Url::parse(raw.trim()) else {
        return HIDDEN_URL.to_string();
    };
    if url.set_username("").is_err() || url.set_password(None).is_err() {
        return HIDDEN_URL.to_string();
    }
    url.set_fragment(None);
    if let Some(query) = url.query() {
        let masked: Vec<String> = query
            .split('&')
            .filter(|part| !part.is_empty())
            .map(|part| match part.split_once('=') {
                Some((key, _)) => format!("{key}=****"),
                None => "****".to_string(),
            })
            .collect();
        url.set_query((!masked.is_empty()).then(|| masked.join("&")).as_deref());
    }
    url.to_string()
}

/// The sources with work under way, as the refresh service tracks them.
#[derive(Debug, Default)]
pub struct Busy {
    /// A download is queued or running (`epg_refreshing`).
    pub refreshing: HashSet<i64>,
    /// A time-policy re-read is queued or running.
    pub applying: HashSet<i64>,
}

/// One source's row.
pub fn source_status(source: &SourceRecord, cache_dir: &Path, busy: &Busy) -> EpgSourceStatus {
    let display_url = match source.origin {
        SourceOrigin::Xtream => None,
        SourceOrigin::Manual | SourceOrigin::M3uHeader => source.url.as_deref().map(display_url),
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
        refreshing: busy.refreshing.contains(&source.id),
        applying: busy.applying.contains(&source.id),
    }
}

/// Whether an enabled source that applies to the profile has a guide
/// channel with programmes.
const HAS_GUIDE_CHANNELS: &str = "SELECT EXISTS (SELECT 1 FROM epg_channel c
    JOIN epg_source s ON s.id = c.source_id
    WHERE s.enabled = 1 AND (s.playlist_id IS NULL OR s.playlist_id = ?1)
      AND c.programme_count > 0)";

/// The live rows the counts need: matched ones, and unmatched ones that
/// carry an id.
const MATCH_ROWS: &str = "SELECT epg_match_source, epg_id FROM channels
    WHERE playlist_id = ?1 AND content_type = 'live'
      AND (epg_match_source IS NOT NULL OR (epg_match_key IS NULL AND epg_id IS NOT NULL))";

/// How the profile's live channels are matched; `None` without a profile
/// or before any guide channel with programmes exists for it.
pub fn match_counts(
    conn: &Connection,
    profile: Option<i64>,
) -> rusqlite::Result<Option<MatchCounts>> {
    let Some(playlist_id) = profile else {
        return Ok(None);
    };
    let has_guide: bool = conn.query_row(HAS_GUIDE_CHANNELS, params![playlist_id], |r| r.get(0))?;
    if !has_guide {
        return Ok(None);
    }
    let mut counts = MatchCounts {
        ambiguous_names: guide_index(conn, playlist_id)?.ambiguous_names(),
        ..MatchCounts::default()
    };
    let mut stmt = conn.prepare(MATCH_ROWS)?;
    let mut rows = stmt.query(params![playlist_id])?;
    while let Some(row) = rows.next()? {
        let source = row.get_ref(0)?.as_str_or_null()?;
        let counter = match source.map(MatchSource::from_db) {
            Some(Some(MatchSource::Id)) => &mut counts.by_id,
            Some(Some(MatchSource::TvgName)) => &mut counts.by_tvg_name,
            Some(Some(MatchSource::Name)) => &mut counts.by_name,
            Some(Some(MatchSource::Manual)) => &mut counts.manual,
            // Written by a newer version.
            Some(None) => continue,
            None => {
                let epg_id = row.get_ref(1)?.as_str_or_null()?;
                if epg_id.and_then(channel_key).is_none() {
                    continue;
                }
                &mut counts.unmatched_with_id
            }
        };
        *counter += 1;
    }
    Ok(Some(counts))
}

/// The status for the active profile at `now` (Unix seconds); `busy`
/// holds the ids with a download or a policy re-read queued or running.
pub fn epg_status(
    conn: &Connection,
    cache_dir: &Path,
    busy: &Busy,
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
        matches: match_counts(conn, profile)?,
        sources: sources
            .iter()
            .map(|s| source_status(s, cache_dir, busy))
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
    fn a_displayed_url_keeps_no_credential() {
        let cases = [
            (
                "http://h:8080/xmltv.php?username=john&password=secret",
                "http://h:8080/xmltv.php?username=****&password=****",
            ),
            (
                "https://epg.example/guide.xml?token=abc123",
                "https://epg.example/guide.xml?token=****",
            ),
            (
                "http://h/epg?user=john&pass=secret",
                "http://h/epg?user=****&pass=****",
            ),
            (
                "http://h/epg.xml.gz?key=secret",
                "http://h/epg.xml.gz?key=****",
            ),
            ("http://h/epg?abc123&x=", "http://h/epg?****&x=****"),
            ("http://john:p@ss@h/epg.xml", "http://h/epg.xml"),
            ("http://john@h/epg.xml#secret", "http://h/epg.xml"),
            (
                "https://epg.example/guide.xml",
                "https://epg.example/guide.xml",
            ),
        ];
        for (raw, shown) in cases {
            assert_eq!(display_url(raw), shown, "{raw}");
        }
        for raw in ["not a url john secret", "http://", "", "data:secret"] {
            assert_eq!(display_url(raw), HIDDEN_URL, "{raw}");
        }
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

        let status = epg_status(&conn, &f.dir.0, &Busy::default(), NOW).unwrap();

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

        let busy = Busy {
            refreshing: HashSet::from([s]),
            applying: HashSet::new(),
        };
        let status = epg_status(&f.conn(), &f.dir.0, &busy, NOW).unwrap();

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
        assert!(!row.applying);
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
        let busy = Busy {
            refreshing: HashSet::new(),
            applying: HashSet::from([s]),
        };
        let status = epg_status(&f.conn(), &f.dir.0, &busy, NOW).unwrap();
        let row = &status.sources[0];
        assert!(row.applying);
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

        let status = epg_status(&conn, &f.dir.0, &Busy::default(), NOW).unwrap();

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
        let status = epg_status(&conn, &f.dir.0, &Busy::default(), NOW).unwrap();
        assert_eq!(status.programme_count, 0);
        assert!(!status.guide_downloaded);
        assert_eq!(status.next_auto_refresh, None);
    }

    #[tokio::test]
    async fn match_counts_describe_the_active_profile_once_a_guide_exists() {
        let f = Fixture::new("status");
        let conn = f.conn();
        conn.execute("INSERT INTO playlists (id, name) VALUES (1, 'P')", [])
            .unwrap();
        let add = |name: &str, epg_id: Option<&str>, tvg_name: Option<&str>, kind: &str| {
            conn.execute(
                "INSERT INTO channels (playlist_id, name, url, epg_id, tvg_name, content_type)
                 VALUES (1, ?1, 'http://p', ?2, ?3, ?4)",
                params![name, epg_id, tvg_name, kind],
            )
            .unwrap();
            conn.last_insert_rowid()
        };
        add("SVT1 HD", Some("SVT1.se"), None, "live");
        add("Ettan", None, Some("SVT1"), "live");
        add("SVT2", None, None, "live");
        add("TV4", Some("tv4.nl"), None, "live");
        add("Kanal 9", Some("  "), None, "live");
        add("Film", Some("film.se"), None, "vod");
        let manual = add("Sjuan", Some("sjuan.se"), None, "live");
        conn.execute(
            "UPDATE channels SET epg_match_key = 'tv7.se', epg_match_source = 'manual'
             WHERE id = ?1",
            params![manual],
        )
        .unwrap();
        set_active(&conn, 1);
        let s = add_manual(&conn, "http://epg.example/epg.xml");
        drop(conn);

        let status = epg_status(&f.conn(), &f.dir.0, &Busy::default(), NOW).unwrap();
        assert_eq!(status.matches, None, "no guide downloaded yet");

        let feed = Feed::new()
            .channel("svt1.se", &["SVT1"])
            .channel("svt2.se", &["SVT2", "Kanal 9"])
            .channel("svt24.se", &["SVT2"])
            .programme("svt1.se", NOW, NOW + H, "News")
            .programme("svt2.se", NOW, NOW + H, "News")
            .programme("svt24.se", NOW, NOW + H, "News")
            .programme("film.se", NOW, NOW + H, "Film");
        f.store(s, &feed.xml(), NOW).await;
        crate::epg::matching::recompute_playlist(&f.conn(), 1).unwrap();

        let status = epg_status(&f.conn(), &f.dir.0, &Busy::default(), NOW).unwrap();
        assert_eq!(
            status.matches,
            Some(MatchCounts {
                by_id: 1,
                by_tvg_name: 1,
                by_name: 1,
                manual: 1,
                unmatched_with_id: 1,
                ambiguous_names: 1,
            })
        );

        set_active(&f.conn(), 2);
        let status = epg_status(&f.conn(), &f.dir.0, &Busy::default(), NOW).unwrap();
        assert_eq!(
            status.matches,
            Some(MatchCounts {
                ambiguous_names: 1,
                ..MatchCounts::default()
            }),
            "another profile: the global guide applies, it has no channels"
        );
    }

    #[test]
    fn the_payload_uses_the_field_names_the_frontend_lists() {
        let f = Fixture::new("status");
        let conn = f.conn();
        add_manual(&conn, "http://epg.example/epg.xml");
        let status = epg_status(&conn, &f.dir.0, &Busy::default(), NOW).unwrap();
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
                "applying",
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
