//! Storage for the iptv-org logo fallback: the fallback table, the per-channel
//! override and the dead provider-logo marks. All SQL for the feature lives here.
// Later tasks (import, background job, command) consume these items.
#![allow(dead_code)]

use crate::logo_domain::{normalize_epg_key, DEAD_MARK_TTL_DAYS};
use chrono::{DateTime, SecondsFormat, Utc};
use rusqlite::{params, Connection, Result};
use serde::Deserialize;
use std::collections::HashMap;

/// A logo URL the frontend failed to load for one channel.
#[derive(Debug, Clone, Deserialize)]
pub struct DeadLogoReport {
    pub channel_id: i64,
    pub url: String,
}

/// SQL twin of `logo_domain::normalize_epg_key`: cut at the first `@`, trim
/// whitespace (all of it, as Rust's `trim` does), lowercase. A parity test pins
/// the two together. `lower` is ASCII-only in SQLite; iptv-org keys are ASCII.
const SQL_EPG_KEY: &str = "lower(trim(CASE WHEN instr(epg_id, '@') > 0 \
     THEN substr(epg_id, 1, instr(epg_id, '@') - 1) ELSE epg_id END, \
     ' ' || char(9) || char(10) || char(11) || char(12) || char(13)))";

/// The override a live channel should carry: the fallback for its EPG key when
/// the feature is on (`?1`) and the provider logo is blank or marked dead,
/// otherwise NULL.
fn new_override_sql() -> String {
    format!(
        "CASE WHEN ?1 AND (logo IS NULL OR trim(logo) = '' OR EXISTS ( \
             SELECT 1 FROM dead_logo_urls d WHERE d.url = channels.logo AND d.state = 'dead')) \
         THEN (SELECT f.url FROM logo_fallbacks f WHERE f.epg_key = {SQL_EPG_KEY}) \
         ELSE NULL END"
    )
}

fn timestamp(t: DateTime<Utc>) -> String {
    t.to_rfc3339_opts(SecondsFormat::Secs, true)
}

/// Replace the whole fallback table in one transaction. Returns rows stored.
pub fn replace_fallbacks(conn: &Connection, fallbacks: &HashMap<String, String>) -> Result<usize> {
    let tx = conn.unchecked_transaction()?;
    tx.execute("DELETE FROM logo_fallbacks", [])?;
    let mut stored = 0;
    {
        let mut stmt =
            tx.prepare("INSERT OR REPLACE INTO logo_fallbacks (epg_key, url) VALUES (?1, ?2)")?;
        for (key, url) in fallbacks {
            stored += stmt.execute(params![key, url])?;
        }
    }
    tx.commit()?;
    Ok(stored)
}

/// Recompute `logo_override` for the live rows of one playlist (or all). Only
/// rows whose value changes are written; returns that count.
pub fn recompute_overrides(
    conn: &Connection,
    playlist_id: Option<i64>,
    enabled: bool,
) -> Result<usize> {
    let new = new_override_sql();
    let sql = format!(
        "UPDATE channels SET logo_override = {new} \
         WHERE content_type = 'live' AND (?2 IS NULL OR playlist_id = ?2) \
           AND logo_override IS NOT ({new})"
    );
    conn.execute(&sql, params![enabled, playlist_id])
}

/// Same as `recompute_overrides`, for specific channel ids (chunked at 500).
pub fn recompute_overrides_for_channels(
    conn: &Connection,
    channel_ids: &[i64],
    enabled: bool,
) -> Result<usize> {
    let new = new_override_sql();
    let mut changed = 0;
    for chunk in channel_ids.chunks(500) {
        let placeholders = vec!["?"; chunk.len()].join(", ");
        let sql = format!(
            "UPDATE channels SET logo_override = {new} \
             WHERE content_type = 'live' AND logo_override IS NOT ({new}) \
               AND id IN ({placeholders})"
        );
        let mut values: Vec<rusqlite::types::Value> = vec![enabled.into()];
        values.extend(chunk.iter().map(|id| rusqlite::types::Value::from(*id)));
        changed += conn.execute(&sql, rusqlite::params_from_iter(values))?;
    }
    Ok(changed)
}

/// Record logo load failures reported by the frontend. A report counts only
/// for a live channel whose stored provider logo is the reported URL and that
/// has a fallback. First sighting is `suspect`; a sighting from a different
/// launch makes it `dead`; the same launch again changes nothing. Affected
/// channels are recomputed; returns `channel_id -> fallback url` for every
/// accepted report.
pub fn record_failures(
    conn: &Connection,
    reports: &[DeadLogoReport],
    launch_id: i64,
    now: DateTime<Utc>,
) -> Result<HashMap<i64, String>> {
    let marked_at = timestamp(now);
    let mut accepted: HashMap<i64, String> = HashMap::new();
    let tx = conn.unchecked_transaction()?;
    for report in reports {
        let row: Option<(Option<String>, Option<String>, String)> = tx
            .query_row(
                "SELECT logo, epg_id, content_type FROM channels WHERE id = ?1",
                [report.channel_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .map(Some)
            .or_else(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => Ok(None),
                e => Err(e),
            })?;
        let Some((logo, epg_id, content_type)) = row else {
            continue;
        };
        if content_type != "live" || logo.as_deref() != Some(report.url.as_str()) {
            continue;
        }
        let Some(key) = epg_id.as_deref().and_then(normalize_epg_key) else {
            continue;
        };
        let fallback: Option<String> = tx
            .query_row(
                "SELECT url FROM logo_fallbacks WHERE epg_key = ?1",
                [&key],
                |r| r.get(0),
            )
            .map(Some)
            .or_else(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => Ok(None),
                e => Err(e),
            })?;
        let Some(fallback) = fallback else { continue };

        let existing: Option<i64> = tx
            .query_row(
                "SELECT launch_id FROM dead_logo_urls WHERE url = ?1",
                [&report.url],
                |r| r.get(0),
            )
            .map(Some)
            .or_else(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => Ok(None),
                e => Err(e),
            })?;
        match existing {
            None => {
                tx.execute(
                    "INSERT INTO dead_logo_urls (url, state, marked_at, launch_id) VALUES (?1, 'suspect', ?2, ?3)",
                    params![report.url, marked_at, launch_id],
                )?;
            }
            Some(prev) if prev != launch_id => {
                tx.execute(
                    "UPDATE dead_logo_urls SET state = 'dead', marked_at = ?2, launch_id = ?3 WHERE url = ?1",
                    params![report.url, marked_at, launch_id],
                )?;
            }
            Some(_) => {}
        }
        accepted.insert(report.channel_id, fallback);
    }
    let ids: Vec<i64> = accepted.keys().copied().collect();
    recompute_overrides_for_channels(&tx, &ids, true)?;
    tx.commit()?;
    Ok(accepted)
}

/// Delete marks older than `DEAD_MARK_TTL_DAYS`; the caller recomputes.
/// Timestamps are RFC 3339 UTC with seconds and `Z`, so text order is time order.
pub fn expire_marks(conn: &Connection, now: DateTime<Utc>) -> Result<usize> {
    let cutoff = timestamp(now - chrono::Duration::days(DEAD_MARK_TTL_DAYS));
    conn.execute("DELETE FROM dead_logo_urls WHERE marked_at < ?1", [cutoff])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::queries;
    use crate::db::test_helpers::{create_test_channel, create_test_playlist, setup_test_db};
    use chrono::Duration;

    fn fb(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    /// A live channel with the given provider logo and raw epg_id.
    fn seed(conn: &Connection, pid: i64, name: &str, logo: Option<&str>, epg: Option<&str>) -> i64 {
        let id = create_test_channel(conn, pid, name);
        conn.execute(
            "UPDATE channels SET logo = ?1, epg_id = ?2 WHERE id = ?3",
            params![logo, epg, id],
        )
        .unwrap();
        id
    }

    fn override_of(conn: &Connection, id: i64) -> Option<String> {
        conn.query_row(
            "SELECT logo_override FROM channels WHERE id = ?1",
            [id],
            |r| r.get(0),
        )
        .unwrap()
    }

    fn state_of(conn: &Connection, url: &str) -> Option<String> {
        conn.query_row(
            "SELECT state FROM dead_logo_urls WHERE url = ?1",
            [url],
            |r| r.get(0),
        )
        .ok()
    }

    fn mark(conn: &Connection, url: &str, state: &str, marked_at: &str, launch: i64) {
        conn.execute(
            "INSERT INTO dead_logo_urls (url, state, marked_at, launch_id) VALUES (?1, ?2, ?3, ?4)",
            params![url, state, marked_at, launch],
        )
        .unwrap();
    }

    fn setup() -> (Connection, i64) {
        let conn = setup_test_db();
        let pid = create_test_playlist(&conn, "P");
        replace_fallbacks(&conn, &fb(&[("tv3.se", "http://fb/tv3.png")])).unwrap();
        (conn, pid)
    }

    #[test]
    fn summary_reads_override_before_provider_logo() {
        let (conn, pid) = setup();
        let a = seed(&conn, pid, "A", Some("http://p/a.png"), None);
        let b = seed(&conn, pid, "B", Some("http://p/b.png"), None);
        conn.execute(
            "UPDATE channels SET logo_override = 'http://o/a.png' WHERE id = ?1",
            [a],
        )
        .unwrap();
        let rows = queries::get_channel_summaries(&conn, Some(pid), None).unwrap();
        let logo = |id| rows.iter().find(|c| c.id == id).unwrap().logo.clone();
        assert_eq!(logo(a).as_deref(), Some("http://o/a.png"));
        assert_eq!(logo(b).as_deref(), Some("http://p/b.png"));
        let by_ids = queries::get_channel_summaries_by_ids(&conn, &[a, b]).unwrap();
        assert_eq!(by_ids[&a].logo.as_deref(), Some("http://o/a.png"));
        assert_eq!(by_ids[&b].logo.as_deref(), Some("http://p/b.png"));
    }

    #[test]
    fn empty_provider_logo_gets_fallback() {
        let (conn, pid) = setup();
        let null = seed(&conn, pid, "N", None, Some("TV3.se"));
        let blank = seed(&conn, pid, "B", Some("  "), Some("TV3.se"));
        assert_eq!(recompute_overrides(&conn, Some(pid), true).unwrap(), 2);
        assert_eq!(
            override_of(&conn, null).as_deref(),
            Some("http://fb/tv3.png")
        );
        assert_eq!(
            override_of(&conn, blank).as_deref(),
            Some("http://fb/tv3.png")
        );
    }

    #[test]
    fn working_provider_logo_is_kept() {
        let (conn, pid) = setup();
        let id = seed(&conn, pid, "A", Some("http://p/a.png"), Some("tv3.se"));
        recompute_overrides(&conn, None, true).unwrap();
        assert_eq!(override_of(&conn, id), None);
    }

    #[test]
    fn dead_provider_logo_gets_fallback() {
        let (conn, pid) = setup();
        let id = seed(&conn, pid, "A", Some("http://p/a.png"), Some("tv3.se"));
        mark(&conn, "http://p/a.png", "dead", "2026-10-18T00:00:00Z", 1);
        recompute_overrides(&conn, None, true).unwrap();
        assert_eq!(override_of(&conn, id).as_deref(), Some("http://fb/tv3.png"));
    }

    #[test]
    fn suspect_provider_logo_keeps_provider() {
        let (conn, pid) = setup();
        let id = seed(&conn, pid, "A", Some("http://p/a.png"), Some("tv3.se"));
        mark(
            &conn,
            "http://p/a.png",
            "suspect",
            "2026-10-18T00:00:00Z",
            1,
        );
        recompute_overrides(&conn, None, true).unwrap();
        assert_eq!(override_of(&conn, id), None);
    }

    #[test]
    fn disabled_clears_every_override() {
        let (conn, pid) = setup();
        let id = seed(&conn, pid, "A", None, Some("tv3.se"));
        recompute_overrides(&conn, None, true).unwrap();
        assert!(override_of(&conn, id).is_some());
        assert_eq!(recompute_overrides(&conn, None, false).unwrap(), 1);
        assert_eq!(override_of(&conn, id), None);
    }

    #[test]
    fn vod_rows_never_get_an_override() {
        let (conn, pid) = setup();
        let id = seed(&conn, pid, "V", None, Some("tv3.se"));
        conn.execute(
            "UPDATE channels SET content_type = 'vod' WHERE id = ?1",
            [id],
        )
        .unwrap();
        recompute_overrides(&conn, None, true).unwrap();
        recompute_overrides_for_channels(&conn, &[id], true).unwrap();
        assert_eq!(override_of(&conn, id), None);
    }

    #[test]
    fn sql_key_matches_normalize_epg_key() {
        let conn = setup_test_db();
        let pid = create_test_playlist(&conn, "P");
        for raw in [
            " TV3.se ",
            "AfricaTV3.ng@SD",
            "Kanal 5.se",
            "Tab\tX.se\t@HD",
        ] {
            let key = normalize_epg_key(raw).unwrap();
            replace_fallbacks(&conn, &fb(&[(key.as_str(), "http://fb/x.png")])).unwrap();
            let id = seed(&conn, pid, "C", None, Some(raw));
            assert_eq!(
                recompute_overrides(&conn, Some(pid), true).unwrap(),
                1,
                "{raw:?}"
            );
            assert_eq!(
                override_of(&conn, id).as_deref(),
                Some("http://fb/x.png"),
                "{raw:?}"
            );
            conn.execute("DELETE FROM channels WHERE id = ?1", [id])
                .unwrap();
        }
        // No fallback stored under the key: nothing found.
        replace_fallbacks(&conn, &fb(&[("other.se", "http://fb/o.png")])).unwrap();
        let id = seed(&conn, pid, "C", None, Some("Kanal 5.se"));
        assert_eq!(recompute_overrides(&conn, Some(pid), true).unwrap(), 0);
        assert_eq!(override_of(&conn, id), None);
    }

    #[test]
    fn recompute_is_idempotent_and_writes_nothing_the_second_time() {
        let (conn, pid) = setup();
        seed(&conn, pid, "A", None, Some("tv3.se"));
        seed(&conn, pid, "B", Some("http://p/b.png"), Some("tv3.se"));
        assert_eq!(recompute_overrides(&conn, Some(pid), true).unwrap(), 1);
        assert_eq!(recompute_overrides(&conn, Some(pid), true).unwrap(), 0);
    }

    #[test]
    fn recompute_for_channels_only_touches_the_given_ids() {
        let (conn, pid) = setup();
        let a = seed(&conn, pid, "A", None, Some("tv3.se"));
        let b = seed(&conn, pid, "B", None, Some("tv3.se"));
        assert_eq!(
            recompute_overrides_for_channels(&conn, &[a], true).unwrap(),
            1
        );
        assert!(override_of(&conn, a).is_some());
        assert_eq!(override_of(&conn, b), None);
        assert_eq!(
            recompute_overrides_for_channels(&conn, &[], true).unwrap(),
            0
        );
    }

    #[test]
    fn recompute_for_channels_handles_more_than_one_chunk() {
        let (conn, pid) = setup();
        let ids: Vec<i64> = (0..1200)
            .map(|i| seed(&conn, pid, &format!("C{i}"), None, Some("tv3.se")))
            .collect();
        assert_eq!(
            recompute_overrides_for_channels(&conn, &ids, true).unwrap(),
            1200
        );
    }

    fn reports(id: i64, url: &str, times: usize) -> Vec<DeadLogoReport> {
        (0..times)
            .map(|_| DeadLogoReport {
                channel_id: id,
                url: url.to_string(),
            })
            .collect()
    }

    #[test]
    fn one_session_only_marks_suspect() {
        let (conn, pid) = setup();
        let id = seed(&conn, pid, "A", Some("http://p/a.png"), Some("tv3.se"));
        let got = record_failures(&conn, &reports(id, "http://p/a.png", 2), 5, Utc::now()).unwrap();
        assert_eq!(
            state_of(&conn, "http://p/a.png").as_deref(),
            Some("suspect")
        );
        assert_eq!(override_of(&conn, id), None);
        assert_eq!(got.get(&id).map(String::as_str), Some("http://fb/tv3.png"));
        assert_eq!(got.len(), 1);
    }

    #[test]
    fn second_session_marks_dead_and_overrides() {
        let (conn, pid) = setup();
        let id = seed(&conn, pid, "A", Some("http://p/a.png"), Some("tv3.se"));
        let r = reports(id, "http://p/a.png", 1);
        record_failures(&conn, &r, 1, Utc::now()).unwrap();
        let got = record_failures(&conn, &r, 2, Utc::now()).unwrap();
        assert_eq!(state_of(&conn, "http://p/a.png").as_deref(), Some("dead"));
        assert_eq!(override_of(&conn, id).as_deref(), Some("http://fb/tv3.png"));
        assert_eq!(got.get(&id).map(String::as_str), Some("http://fb/tv3.png"));
    }

    #[test]
    fn report_for_a_url_that_is_not_the_provider_logo_is_ignored() {
        let (conn, pid) = setup();
        let id = seed(&conn, pid, "A", None, Some("tv3.se"));
        recompute_overrides(&conn, None, true).unwrap();
        let got =
            record_failures(&conn, &reports(id, "http://fb/tv3.png", 1), 1, Utc::now()).unwrap();
        assert!(got.is_empty());
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM dead_logo_urls", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 0);
    }

    #[test]
    fn report_without_fallback_is_not_stored() {
        let (conn, pid) = setup();
        let id = seed(&conn, pid, "A", Some("http://p/a.png"), Some("unknown.se"));
        let got = record_failures(&conn, &reports(id, "http://p/a.png", 1), 1, Utc::now()).unwrap();
        assert!(got.is_empty());
        assert_eq!(state_of(&conn, "http://p/a.png"), None);
    }

    #[test]
    fn expire_removes_marks_older_than_seven_days() {
        let (conn, _pid) = setup();
        let now = Utc::now();
        let ts = |d: i64| (now - Duration::days(d)).to_rfc3339_opts(SecondsFormat::Secs, true);
        mark(&conn, "http://old", "dead", &ts(8), 1);
        mark(&conn, "http://new", "dead", &ts(6), 1);
        assert_eq!(expire_marks(&conn, now).unwrap(), 1);
        assert_eq!(state_of(&conn, "http://old"), None);
        assert!(state_of(&conn, "http://new").is_some());
    }
}
