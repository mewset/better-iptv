//! Storage for the iptv-org logo fallback: the fallback table, the per-channel
//! override and the dead provider-logo marks. All SQL for the feature lives here.

use crate::logo_domain::{normalize_epg_key, DEAD_MARK_TTL_DAYS, LOGO_FALLBACK_ENABLED_KEY};
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

/// SQL twin of `logo_domain::is_enabled`: on unless the stored setting is
/// exactly `'0'` (absent = on). Read inside each recompute statement so a
/// switch-off that lands while a job or report is in flight is never undone
/// by a value read earlier.
fn sql_enabled() -> String {
    format!("(SELECT value FROM settings WHERE key = '{LOGO_FALLBACK_ENABLED_KEY}') IS NOT '0'")
}

/// The override a live channel should carry: the fallback for its EPG key when
/// the feature is on and the provider logo is blank or marked dead, otherwise
/// NULL.
fn new_override_sql() -> String {
    let enabled = sql_enabled();
    format!(
        "CASE WHEN {enabled} AND (logo IS NULL OR trim(logo) = '' OR EXISTS ( \
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
pub fn recompute_overrides(conn: &Connection, playlist_id: Option<i64>) -> Result<usize> {
    match playlist_id {
        Some(id) => conn.execute(&recompute_sql(true), [id]),
        None => conn.execute(&recompute_sql(false), []),
    }
}

/// Two statements rather than `?1 IS NULL OR playlist_id = ?1`, so the
/// per-playlist one (`?1` = playlist id) can search a playlist_id index.
fn recompute_sql(per_playlist: bool) -> String {
    let new = new_override_sql();
    let playlist = if per_playlist {
        " AND playlist_id = ?1"
    } else {
        ""
    };
    format!(
        "UPDATE channels SET logo_override = {new} \
         WHERE content_type = 'live'{playlist} AND logo_override IS NOT ({new})"
    )
}

/// Recompute one playlist's overrides after its channels were written (import
/// or refresh); returns rows changed.
pub fn apply_after_channel_write(conn: &Connection, playlist_id: i64) -> Result<usize> {
    let start = std::time::Instant::now();
    let changed = recompute_overrides(conn, Some(playlist_id))?;
    log::debug!(
        "Logo overrides for playlist {}: {} changed in {:?}",
        playlist_id,
        changed,
        start.elapsed()
    );
    Ok(changed)
}

/// Same as `recompute_overrides`, for specific channel ids (chunked at 500).
pub fn recompute_overrides_for_channels(conn: &Connection, channel_ids: &[i64]) -> Result<usize> {
    let new = new_override_sql();
    let mut changed = 0;
    for chunk in channel_ids.chunks(500) {
        let placeholders = vec!["?"; chunk.len()].join(", ");
        let sql = format!(
            "UPDATE channels SET logo_override = {new} \
             WHERE content_type = 'live' AND logo_override IS NOT ({new}) \
               AND id IN ({placeholders})"
        );
        changed += conn.execute(&sql, rusqlite::params_from_iter(chunk))?;
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
    recompute_overrides_for_channels(&tx, &ids)?;
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
        assert_eq!(recompute_overrides(&conn, Some(pid)).unwrap(), 2);
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
        recompute_overrides(&conn, None).unwrap();
        assert_eq!(override_of(&conn, id), None);
    }

    #[test]
    fn dead_provider_logo_gets_fallback() {
        let (conn, pid) = setup();
        let id = seed(&conn, pid, "A", Some("http://p/a.png"), Some("tv3.se"));
        mark(&conn, "http://p/a.png", "dead", "2026-10-18T00:00:00Z", 1);
        recompute_overrides(&conn, None).unwrap();
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
        recompute_overrides(&conn, None).unwrap();
        assert_eq!(override_of(&conn, id), None);
    }

    #[test]
    fn disabled_clears_every_override() {
        let (conn, pid) = setup();
        let id = seed(&conn, pid, "A", None, Some("tv3.se"));
        recompute_overrides(&conn, None).unwrap();
        assert!(override_of(&conn, id).is_some());
        disable(&conn);
        assert_eq!(recompute_overrides(&conn, None).unwrap(), 1);
        assert_eq!(override_of(&conn, id), None);
    }

    /// The job reads the setting before a fetch that can take minutes; the
    /// recompute after it must use the value stored when it runs.
    #[test]
    fn recompute_reads_the_setting_when_it_runs() {
        let (conn, pid) = setup();
        let id = seed(&conn, pid, "A", None, Some("tv3.se"));
        // Absent = on.
        recompute_overrides(&conn, None).unwrap();
        assert!(override_of(&conn, id).is_some());
        // Switched off "during the fetch": the recompute clears, never refills.
        disable(&conn);
        recompute_overrides(&conn, Some(pid)).unwrap();
        recompute_overrides_for_channels(&conn, &[id]).unwrap();
        assert_eq!(override_of(&conn, id), None);
        crate::db::mutations::set_setting(&conn, LOGO_FALLBACK_ENABLED_KEY, "1").unwrap();
        recompute_overrides(&conn, None).unwrap();
        assert!(override_of(&conn, id).is_some());
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
        recompute_overrides(&conn, None).unwrap();
        recompute_overrides_for_channels(&conn, &[id]).unwrap();
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
            assert_eq!(recompute_overrides(&conn, Some(pid)).unwrap(), 1, "{raw:?}");
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
        assert_eq!(recompute_overrides(&conn, Some(pid)).unwrap(), 0);
        assert_eq!(override_of(&conn, id), None);
    }

    fn plan(conn: &Connection, sql: &str) -> String {
        let mut stmt = conn.prepare(&format!("EXPLAIN QUERY PLAN {sql}")).unwrap();
        let rows = stmt
            .query_map([1_i64], |r| r.get::<_, String>(3))
            .unwrap()
            .map(|r| r.unwrap())
            .collect::<Vec<_>>();
        rows.join("\n")
    }

    #[test]
    fn per_playlist_recompute_searches_an_index() {
        let conn = setup_test_db();
        let per_playlist = plan(&conn, &recompute_sql(true));
        assert!(
            per_playlist
                .lines()
                .any(|l| l.starts_with("SEARCH channels USING INDEX idx_channels_")),
            "{per_playlist}"
        );
        assert!(!per_playlist.contains("SCAN channels"), "{per_playlist}");
    }

    #[test]
    fn recompute_is_idempotent_and_writes_nothing_the_second_time() {
        let (conn, pid) = setup();
        seed(&conn, pid, "A", None, Some("tv3.se"));
        seed(&conn, pid, "B", Some("http://p/b.png"), Some("tv3.se"));
        assert_eq!(recompute_overrides(&conn, Some(pid)).unwrap(), 1);
        assert_eq!(recompute_overrides(&conn, Some(pid)).unwrap(), 0);
    }

    #[test]
    fn recompute_for_channels_only_touches_the_given_ids() {
        let (conn, pid) = setup();
        let a = seed(&conn, pid, "A", None, Some("tv3.se"));
        let b = seed(&conn, pid, "B", None, Some("tv3.se"));
        assert_eq!(recompute_overrides_for_channels(&conn, &[a]).unwrap(), 1);
        assert!(override_of(&conn, a).is_some());
        assert_eq!(override_of(&conn, b), None);
        assert_eq!(recompute_overrides_for_channels(&conn, &[]).unwrap(), 0);
    }

    #[test]
    fn recompute_for_channels_handles_more_than_one_chunk() {
        let (conn, pid) = setup();
        let ids: Vec<i64> = (0..1200)
            .map(|i| seed(&conn, pid, &format!("C{i}"), None, Some("tv3.se")))
            .collect();
        assert_eq!(recompute_overrides_for_channels(&conn, &ids).unwrap(), 1200);
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
        recompute_overrides(&conn, None).unwrap();
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

    fn channel(
        pid: i64,
        name: &str,
        url: &str,
        logo: Option<&str>,
        epg: Option<&str>,
    ) -> crate::db::models::Channel {
        crate::db::models::Channel {
            id: None,
            playlist_id: pid,
            name: name.to_string(),
            url: url.to_string(),
            logo: logo.map(String::from),
            group_name: Some("G".to_string()),
            epg_id: epg.map(String::from),
            tvg_name: None,
            content_type: "live".to_string(),
            is_favorite: false,
            sort_order: 0,
            category_order: 0,
            created_at: None,
        }
    }

    #[test]
    fn apply_after_write_fills_new_channels() {
        let (conn, pid) = setup();
        let ch = channel(pid, "TV3", "http://s/1.m3u8", None, Some("tv3.se"));
        crate::db::mutations::create_channels_batch(&conn, &[ch]).unwrap();
        let changed = apply_after_channel_write(&conn, pid).unwrap();
        assert_eq!(changed, 1);
        let id: i64 = conn
            .query_row(
                "SELECT id FROM channels WHERE playlist_id = ?1",
                [pid],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(override_of(&conn, id).as_deref(), Some("http://fb/tv3.png"));
    }

    #[test]
    fn recompute_clears_override_when_provider_url_changes() {
        let (conn, pid) = setup();
        let url = "http://s/1.m3u8";
        let ch = channel(pid, "TV3", url, Some("http://p/a.png"), Some("tv3.se"));
        crate::db::mutations::create_channels_batch(&conn, &[ch]).unwrap();
        mark(&conn, "http://p/a.png", "dead", "2999-01-01T00:00:00Z", 1);
        apply_after_channel_write(&conn, pid).unwrap();
        let id: i64 = conn
            .query_row(
                "SELECT id FROM channels WHERE playlist_id = ?1",
                [pid],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(override_of(&conn, id).as_deref(), Some("http://fb/tv3.png"));

        let fresh = channel(pid, "TV3", url, Some("http://p/b.png"), Some("tv3.se"));
        crate::db::mutations::merge_channels(&conn, pid, &[fresh], false).unwrap();
        apply_after_channel_write(&conn, pid).unwrap();
        assert_eq!(override_of(&conn, id), None);
        let rows = queries::get_channel_summaries(&conn, Some(pid), None).unwrap();
        assert_eq!(rows[0].logo.as_deref(), Some("http://p/b.png"));
    }

    fn disable(conn: &Connection) {
        crate::db::mutations::set_setting(conn, crate::logo_domain::LOGO_FALLBACK_ENABLED_KEY, "0")
            .unwrap();
    }

    #[test]
    fn record_failures_sets_no_override_while_disabled() {
        let (conn, pid) = setup();
        let id = seed(&conn, pid, "A", Some("http://p/a.png"), Some("tv3.se"));
        let r = reports(id, "http://p/a.png", 1);
        record_failures(&conn, &r, 1, Utc::now()).unwrap();
        // Switched off between the command's setting read and its recompute.
        disable(&conn);
        record_failures(&conn, &r, 2, Utc::now()).unwrap();
        assert_eq!(state_of(&conn, "http://p/a.png").as_deref(), Some("dead"));
        assert_eq!(override_of(&conn, id), None);
    }

    /// Import and refresh log a failed recompute and go on (the override is
    /// cosmetic). That is only safe if a failed UPDATE leaves the enclosing
    /// transaction usable: SQLite rolls back the statement, not the transaction.
    #[test]
    fn failed_recompute_leaves_the_import_transaction_committable() {
        let (conn, pid) = setup();
        conn.execute_batch(
            "CREATE TEMP TRIGGER boom BEFORE UPDATE OF logo_override ON channels \
             BEGIN SELECT RAISE(ABORT, 'boom'); END;",
        )
        .unwrap();
        let tx = conn.unchecked_transaction().unwrap();
        let ch = channel(pid, "TV3", "http://s/1.m3u8", None, Some("tv3.se"));
        crate::db::mutations::create_channels_batch(&tx, &[ch]).unwrap();
        assert!(apply_after_channel_write(&tx, pid).is_err());
        assert!(!tx.is_autocommit(), "the transaction must still be open");
        tx.commit().unwrap();
        let n: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM channels WHERE playlist_id = ?1",
                [pid],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n, 1);
    }

    #[test]
    fn apply_respects_disabled_setting() {
        let (conn, pid) = setup();
        let id = seed(&conn, pid, "TV3", None, Some("tv3.se"));
        crate::db::mutations::set_setting(
            &conn,
            crate::logo_domain::LOGO_FALLBACK_ENABLED_KEY,
            "0",
        )
        .unwrap();
        apply_after_channel_write(&conn, pid).unwrap();
        assert_eq!(override_of(&conn, id), None);
    }
}
