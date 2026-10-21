//! Guide sources: where a feed comes from, which source wins, when it is due.

use super::{EPG_AUTO_REFRESH_INTERVAL_HOURS, EPG_AUTO_REFRESH_RETRY_MINUTES};
use crate::error::AppError;
use percent_encoding::{utf8_percent_encode, AsciiSet, NON_ALPHANUMERIC};
use serde::Serialize;
use url::Url;

/// Where a guide source came from.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SourceOrigin {
    /// A URL the user added in Settings; applies to every profile.
    Manual,
    /// The `xmltv.php` feed of an Xtream profile, built at fetch time.
    Xtream,
    /// The `url-tvg`/`x-tvg-url` of an M3U playlist header.
    M3uHeader,
}

impl SourceOrigin {
    /// The value stored in `epg_source.origin`.
    pub fn as_str(self) -> &'static str {
        match self {
            SourceOrigin::Manual => "manual",
            SourceOrigin::Xtream => "xtream",
            SourceOrigin::M3uHeader => "m3u_header",
        }
    }

    pub fn from_db(value: &str) -> Option<Self> {
        match value {
            "manual" => Some(SourceOrigin::Manual),
            "xtream" => Some(SourceOrigin::Xtream),
            "m3u_header" => Some(SourceOrigin::M3uHeader),
            _ => None,
        }
    }

    /// Priority a new source of this origin gets; lower wins. A URL the user
    /// chose beats the playlist's own hint, which beats the provider default.
    pub fn default_priority(self) -> i32 {
        match self {
            SourceOrigin::Manual => 10,
            SourceOrigin::M3uHeader => 20,
            SourceOrigin::Xtream => 30,
        }
    }
}

/// Outcome of a source's last attempt.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LastResult {
    Ok,
    /// The feed broke off; what was read before the break was stored.
    Partial,
    Error,
    /// No attempt yet.
    Never,
}

impl LastResult {
    /// The value stored in `epg_source.last_result`; `None` (SQL NULL) for `Never`.
    pub fn as_db(self) -> Option<&'static str> {
        match self {
            LastResult::Ok => Some("ok"),
            LastResult::Partial => Some("partial"),
            LastResult::Error => Some("error"),
            LastResult::Never => None,
        }
    }

    /// Read a stored value; NULL or an unknown value reads as `Never`.
    pub fn from_db(value: Option<&str>) -> Self {
        match value {
            Some("ok") => LastResult::Ok,
            Some("partial") => LastResult::Partial,
            Some("error") => LastResult::Error,
            _ => LastResult::Never,
        }
    }

    /// Whether an attempt with this outcome counts as a success for
    /// scheduling. A partial feed does: retrying at once would most likely
    /// break off at the same place and costs a provider request.
    pub fn counts_as_success(self) -> bool {
        matches!(self, LastResult::Ok | LastResult::Partial)
    }
}

/// `last_success_at` after an ingest that ended with `result` at `now`.
///
/// Advances on a successful network fetch only; a re-ingest from the cached
/// feed (a time policy change) downloads nothing and must not postpone the
/// next download.
pub fn success_after(
    previous: Option<i64>,
    result: LastResult,
    from_network: bool,
    now: i64,
) -> Option<i64> {
    if from_network && result.counts_as_success() {
        Some(now)
    } else {
        previous
    }
}

/// Whether the last successful fetch is old enough to fetch again.
/// Never fetched counts as due.
pub fn refresh_due(last_success_at: Option<i64>, now: i64) -> bool {
    last_success_at.is_none_or(|last| now - last >= EPG_AUTO_REFRESH_INTERVAL_HOURS * 3600)
}

/// Whether enough time has passed since the last attempt, successful or not,
/// so a failing source is not fetched at every poll. Never attempted counts
/// as allowed.
pub fn retry_allowed(last_attempt_at: Option<i64>, now: i64) -> bool {
    last_attempt_at.is_none_or(|last| now - last >= EPG_AUTO_REFRESH_RETRY_MINUTES * 60)
}

/// Whether a source belongs to the active profile: global sources
/// (`playlist_id` NULL) apply to every profile.
pub fn applies_to(playlist_id: Option<i64>, active_profile: Option<i64>) -> bool {
    match playlist_id {
        None => true,
        Some(id) => active_profile == Some(id),
    }
}

/// The scheduling columns of one `epg_source` row.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SourceSchedule {
    pub enabled: bool,
    pub playlist_id: Option<i64>,
    pub last_attempt_at: Option<i64>,
    pub last_success_at: Option<i64>,
}

/// Whether the background task should fetch this source now: enabled,
/// applying to the active profile, stale, and not attempted recently.
pub fn source_due(source: &SourceSchedule, active_profile: Option<i64>, now: i64) -> bool {
    source.enabled
        && applies_to(source.playlist_id, active_profile)
        && refresh_due(source.last_success_at, now)
        && retry_allowed(source.last_attempt_at, now)
}

/// When `source_due` next holds for an enabled source that applies: six
/// hours after the last success and an hour after the last attempt, but not
/// before `now`. The background task polls, so the fetch follows within
/// one poll interval.
pub fn next_due_at(source: &SourceSchedule, now: i64) -> i64 {
    let after_success = source
        .last_success_at
        .map_or(now, |last| last + EPG_AUTO_REFRESH_INTERVAL_HOURS * 3600);
    let after_attempt = source
        .last_attempt_at
        .map_or(now, |last| last + EPG_AUTO_REFRESH_RETRY_MINUTES * 60);
    after_success.max(after_attempt).max(now)
}

/// Rank of a source when several have programmes for one channel: lower
/// priority wins, ties go to the older source. Ordered so the minimum wins.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct SourceRank {
    pub priority: i32,
    pub source_id: i64,
}

/// Everything but RFC 3986's unreserved characters (`A-Z a-z 0-9 - . _ ~`)
/// is percent-encoded in a credential.
const CREDENTIAL: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'.')
    .remove(b'_')
    .remove(b'~');

/// The `xmltv.php` URL of an Xtream server for these credentials.
///
/// The path is the server URL with `/xmltv.php` appended, the rule every
/// `player_api.php` call uses, so a panel under a path (`http://host/panel`)
/// keeps it. `Url::join` would replace the last segment instead. Username and
/// password are percent-encoded down to the unreserved characters, a space as
/// `%20`, so the request means the same whether or not the panel reads `+`
/// as a space.
///
/// A server URL that leaves no host (`http://`), or carries a query or
/// fragment the appended path would land in, is rejected rather than sending
/// the credentials somewhere else. Errors never contain the credentials.
pub fn xtream_epg_url(server_url: &str, username: &str, password: &str) -> Result<Url, AppError> {
    let invalid = || AppError::InvalidInput("Invalid Xtream server URL".to_string());
    let base = format!("{}/xmltv.php", server_url.trim().trim_end_matches('/'));
    let mut url = Url::parse(&base).map_err(|_| invalid())?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(AppError::InvalidInput(
            "Xtream server URL must start with http:// or https://".to_string(),
        ));
    }
    // `http:/xmltv.php` (from `http://`) parses with host `xmltv.php` and path
    // `/`; `http://h/?x` puts `/xmltv.php` into the query.
    let host_ok = url.host_str().is_some_and(|host| !host.is_empty());
    if !host_ok
        || url.query().is_some()
        || url.fragment().is_some()
        || !url.path().ends_with("/xmltv.php")
    {
        return Err(invalid());
    }
    url.set_query(Some(&format!(
        "username={}&password={}",
        utf8_percent_encode(username, CREDENTIAL),
        utf8_percent_encode(password, CREDENTIAL)
    )));
    Ok(url)
}

/// Whether two URLs point at the same server: same host and port, the port
/// taken from the scheme when not written. A manual source on an Xtream
/// profile's server gets that profile's user agent. Unparsable URLs match
/// nothing.
pub fn same_server(a: &str, b: &str) -> bool {
    let (Ok(a), Ok(b)) = (Url::parse(a.trim()), Url::parse(b.trim())) else {
        return false;
    };
    a.host().is_some()
        && a.host() == b.host()
        && a.port_or_known_default() == b.port_or_known_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_800_000_000;
    const H: i64 = 3600;

    #[test]
    fn the_xtream_feed_sits_next_to_player_api() {
        let url = xtream_epg_url("http://host:8080", "user", "pass").unwrap();
        assert_eq!(
            url.as_str(),
            "http://host:8080/xmltv.php?username=user&password=pass"
        );
        let url = xtream_epg_url("http://host:8080/", "user", "pass").unwrap();
        assert_eq!(url.path(), "/xmltv.php");
    }

    #[test]
    fn a_server_path_without_a_trailing_slash_is_kept() {
        let url = xtream_epg_url("http://host/panel", "user", "pass").unwrap();
        assert_eq!(url.path(), "/panel/xmltv.php");
        let url = xtream_epg_url("http://host/panel/", "user", "pass").unwrap();
        assert_eq!(url.path(), "/panel/xmltv.php");
    }

    #[test]
    fn credentials_are_encoded_in_the_query() {
        let url = xtream_epg_url("http://host", "me@mail.se", "a&b%c+d e").unwrap();
        assert_eq!(
            url.query(),
            Some("username=me%40mail.se&password=a%26b%25c%2Bd%20e")
        );
        let pairs: Vec<(String, String)> = url.query_pairs().into_owned().collect();
        assert_eq!(
            pairs,
            [
                ("username".to_string(), "me@mail.se".to_string()),
                ("password".to_string(), "a&b%c+d e".to_string()),
            ]
        );
    }

    #[test]
    fn only_unreserved_characters_stay_unencoded() {
        let url = xtream_epg_url("http://host", "aZ09-._~", "ö=?#/:é").unwrap();
        assert_eq!(
            url.query(),
            Some("username=aZ09-._~&password=%C3%B6%3D%3F%23%2F%3A%C3%A9")
        );
        let pairs: Vec<(String, String)> = url.query_pairs().into_owned().collect();
        assert_eq!(pairs[1].1, "ö=?#/:é");
    }

    #[test]
    fn the_feed_url_shares_scheme_host_and_path_prefix_with_player_api() {
        let servers = [
            "http://host",
            "http://host:8080/",
            "https://host.example/panel",
            "http://10.0.0.2:25461/a/b/",
        ];
        for server in servers {
            // As the import builds it (playlist/xtream.rs, fetch_user_info).
            let player_api = Url::parse(&format!(
                "{}/player_api.php?username={}&password={}",
                server.trim_end_matches('/'),
                "user",
                "pass"
            ))
            .unwrap();
            let feed = xtream_epg_url(server, "user", "pass").unwrap();
            assert_eq!(feed.scheme(), player_api.scheme(), "{server}");
            assert_eq!(feed.host(), player_api.host(), "{server}");
            assert_eq!(
                feed.port_or_known_default(),
                player_api.port_or_known_default(),
                "{server}"
            );
            assert_eq!(
                feed.path().strip_suffix("xmltv.php"),
                player_api.path().strip_suffix("player_api.php"),
                "{server}"
            );
        }
    }

    #[test]
    fn an_unusable_server_url_is_rejected_without_echoing_credentials() {
        for server in [
            "",
            "host:8080",
            "ftp://host",
            "not a url",
            "http://",
            "https:///",
            "http://h/?x",
            "http://h/panel?x=1",
            "http://h#frag",
        ] {
            let err = xtream_epg_url(server, "user", "secret").unwrap_err();
            assert!(matches!(err, AppError::InvalidInput(_)), "{server}");
            assert!(!err.to_string().contains("secret"), "{server}");
        }
    }

    #[test]
    fn servers_match_on_host_and_port() {
        assert!(same_server(
            "http://host:8080/xmltv.php?username=a",
            "http://host:8080"
        ));
        assert!(same_server("http://host/epg.xml", "http://host:80/"));
        assert!(same_server("https://HOST/epg.xml", "https://host:443"));
        assert!(!same_server("http://host:8080/epg", "http://host:8081"));
        assert!(!same_server("http://host/epg", "https://host"));
        assert!(!same_server("http://other/epg", "http://host"));
        assert!(!same_server("not a url", "http://host"));
    }

    #[test]
    fn never_fetched_or_attempted_is_due() {
        assert!(refresh_due(None, NOW));
        assert!(retry_allowed(None, NOW));
    }

    #[test]
    fn a_fetch_is_due_after_six_hours() {
        assert!(!refresh_due(Some(NOW - 6 * H + 1), NOW));
        assert!(refresh_due(Some(NOW - 6 * H), NOW));
    }

    #[test]
    fn an_attempt_blocks_retries_for_an_hour() {
        assert!(!retry_allowed(Some(NOW - H + 1), NOW));
        assert!(retry_allowed(Some(NOW - H), NOW));
    }

    #[test]
    fn global_sources_apply_to_every_profile() {
        assert!(applies_to(None, Some(3)));
        assert!(applies_to(None, None));
        assert!(applies_to(Some(3), Some(3)));
        assert!(!applies_to(Some(3), Some(4)));
        assert!(!applies_to(Some(3), None));
    }

    fn schedule() -> SourceSchedule {
        SourceSchedule {
            enabled: true,
            playlist_id: Some(1),
            last_attempt_at: None,
            last_success_at: None,
        }
    }

    #[test]
    fn a_source_is_due_only_when_every_condition_holds() {
        assert!(source_due(&schedule(), Some(1), NOW));
        let disabled = SourceSchedule {
            enabled: false,
            ..schedule()
        };
        assert!(!source_due(&disabled, Some(1), NOW));
        assert!(!source_due(&schedule(), Some(2), NOW));
        let fresh = SourceSchedule {
            last_success_at: Some(NOW - H),
            last_attempt_at: Some(NOW - H),
            ..schedule()
        };
        assert!(!source_due(&fresh, Some(1), NOW));
        let failing = SourceSchedule {
            last_success_at: Some(NOW - 7 * H),
            last_attempt_at: Some(NOW - 10 * 60),
            ..schedule()
        };
        assert!(!source_due(&failing, Some(1), NOW));
        let stale = SourceSchedule {
            last_success_at: Some(NOW - 7 * H),
            last_attempt_at: Some(NOW - 7 * H),
            ..schedule()
        };
        assert!(source_due(&stale, Some(1), NOW));
    }

    #[test]
    fn the_next_due_time_is_when_source_due_turns_true() {
        let cases = [
            (None, None, NOW),
            (Some(NOW - H), Some(NOW - H), NOW + 5 * H),
            (Some(NOW - 7 * H), Some(NOW - 10 * 60), NOW + 50 * 60),
            (Some(NOW - 7 * H), Some(NOW - 7 * H), NOW),
            (None, Some(NOW - 30 * 60), NOW + 30 * 60),
        ];
        for (last_success_at, last_attempt_at, expected) in cases {
            let source = SourceSchedule {
                last_success_at,
                last_attempt_at,
                ..schedule()
            };
            let at = next_due_at(&source, NOW);
            assert_eq!(at, expected, "{source:?}");
            assert!(source_due(&source, Some(1), at), "{source:?}");
            if at > NOW {
                assert!(!source_due(&source, Some(1), at - 1), "{source:?}");
            }
        }
    }

    #[test]
    fn a_partial_fetch_advances_success() {
        let after = success_after(Some(NOW - 7 * H), LastResult::Partial, true, NOW);
        assert_eq!(after, Some(NOW));
        assert!(!refresh_due(after, NOW));
        assert_eq!(success_after(None, LastResult::Ok, true, NOW), Some(NOW));
    }

    #[test]
    fn a_failure_or_a_cache_re_ingest_leaves_success_alone() {
        let previous = Some(NOW - 7 * H);
        assert_eq!(
            success_after(previous, LastResult::Error, true, NOW),
            previous
        );
        assert_eq!(
            success_after(previous, LastResult::Ok, false, NOW),
            previous
        );
        assert_eq!(success_after(None, LastResult::Error, true, NOW), None);
    }

    #[test]
    fn lower_priority_wins_and_ties_go_to_the_older_source() {
        let manual = SourceRank {
            priority: SourceOrigin::Manual.default_priority(),
            source_id: 9,
        };
        let xtream = SourceRank {
            priority: SourceOrigin::Xtream.default_priority(),
            source_id: 1,
        };
        let header = SourceRank {
            priority: SourceOrigin::M3uHeader.default_priority(),
            source_id: 2,
        };
        assert_eq!([xtream, header, manual].into_iter().min(), Some(manual));
        let older = SourceRank {
            priority: 30,
            source_id: 1,
        };
        let newer = SourceRank {
            priority: 30,
            source_id: 2,
        };
        assert!(older < newer);
    }

    #[test]
    fn origins_round_trip_through_the_database_value() {
        for origin in [
            SourceOrigin::Manual,
            SourceOrigin::Xtream,
            SourceOrigin::M3uHeader,
        ] {
            assert_eq!(SourceOrigin::from_db(origin.as_str()), Some(origin));
        }
        assert_eq!(SourceOrigin::from_db("other"), None);
    }

    #[test]
    fn last_results_round_trip_through_the_database_value() {
        for result in [
            LastResult::Ok,
            LastResult::Partial,
            LastResult::Error,
            LastResult::Never,
        ] {
            assert_eq!(LastResult::from_db(result.as_db()), result);
        }
    }

    #[test]
    fn origins_serialise_as_the_strings_the_frontend_lists() {
        let json = |o: SourceOrigin| serde_json::to_string(&o).unwrap();
        assert_eq!(json(SourceOrigin::Manual), "\"manual\"");
        assert_eq!(json(SourceOrigin::Xtream), "\"xtream\"");
        assert_eq!(json(SourceOrigin::M3uHeader), "\"m3u_header\"");
    }

    #[test]
    fn last_results_serialise_as_the_strings_the_frontend_lists() {
        let json = |r: LastResult| serde_json::to_string(&r).unwrap();
        assert_eq!(json(LastResult::Ok), "\"ok\"");
        assert_eq!(json(LastResult::Partial), "\"partial\"");
        assert_eq!(json(LastResult::Error), "\"error\"");
        assert_eq!(json(LastResult::Never), "\"never\"");
    }
}
