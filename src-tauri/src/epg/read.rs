//! Reading the guide: which source speaks for a channel, and its programmes.
//!
//! Callers send channel keys as the playlist spells them; each is turned into
//! its `channel_key` on entry and the answer is keyed by the key as sent, so
//! `SVT1.se` and `svt1.se` in one request both get an entry. Times are Unix
//! seconds in SQL and RFC 3339 UTC strings (`2026-10-21T12:00:00+00:00`, the
//! form the frontend has always parsed) at the edge.
//!
//! Several sources can carry the same channel. `resolve` picks one per key:
//! the lowest priority among the sources that are enabled, apply to the active
//! profile and still have programmes ahead of the window, ties to the older
//! source. A source whose stored programmes all ended before the window falls
//! through, so a dead URL cannot hide a working source behind it forever.

use crate::db::queries::get_setting;
use crate::epg_domain::key::channel_key;
use crate::epg_domain::source::SourceRank;
use chrono::{DateTime, Utc};
use rusqlite::types::Value;
use rusqlite::{params, params_from_iter, Connection, OptionalExtension, Row};
use serde::Serialize;
use std::collections::{BTreeSet, HashMap, HashSet};

/// Keys bound per `resolve` statement, well under SQLite's 32,766 parameters.
/// The commands send at most `epg_domain::GUIDE_MAX_IDS` (5,000), so one
/// statement answers every request they make.
const RESOLVE_CHUNK: usize = 10_000;

/// The programme on air at `?2`: the latest start at or before it that has
/// not ended. Walks the primary key backwards from `?2`.
const NOW_PROGRAMME: &str = "SELECT title, start, stop FROM epg_programme
    WHERE channel_id = ?1 AND start <= ?2 AND stop > ?2
    ORDER BY start DESC LIMIT 1";
/// The first programme starting after `?2`.
const NEXT_PROGRAMME: &str = "SELECT title, start, stop FROM epg_programme
    WHERE channel_id = ?1 AND start > ?2
    ORDER BY start LIMIT 1";
/// Every programme overlapping `[?2, ?3)`: one playing at `?2` is included,
/// one ending exactly at `?2` or starting exactly at `?3` is not.
const GUIDE_PROGRAMMES: &str = "SELECT title, description, start, stop FROM epg_programme
    WHERE channel_id = ?1 AND stop > ?2 AND start < ?3
    ORDER BY start";
/// Keys of channels whose stored horizon touches `(?2, ?3)` in a source that
/// applies to profile `?1`. Reads `epg_channel` only, never the programmes.
const GUIDE_KEYS: &str = "SELECT c.key FROM epg_channel c JOIN epg_source s ON s.id = c.source_id
    WHERE s.enabled = 1 AND (s.playlist_id IS NULL OR s.playlist_id = ?1)
      AND c.programme_count > 0 AND c.last_stop > ?2 AND c.first_start < ?3";

/// The statement `resolve` runs for `count` keys: `?1` the active profile,
/// `?2` the horizon, the keys from `?3` on.
fn resolve_sql(count: usize) -> String {
    let mut keys = String::with_capacity(count * 3);
    for i in 0..count {
        if i > 0 {
            keys.push(',');
        }
        keys.push('?');
        keys.push_str(&(i + 3).to_string());
    }
    format!(
        "SELECT c.key, c.id, s.priority, s.id FROM epg_channel c
         JOIN epg_source s ON s.id = c.source_id
         WHERE c.key IN ({keys}) AND s.enabled = 1
           AND (s.playlist_id IS NULL OR s.playlist_id = ?1)
           AND c.programme_count > 0 AND c.last_stop > ?2"
    )
}

/// One programme as the frontend receives it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Programme {
    pub title: String,
    /// Always `None` in a `NowNext`: cards and the dock show titles only.
    pub description: Option<String>,
    /// RFC 3339, UTC.
    pub start: String,
    /// RFC 3339, UTC.
    pub stop: String,
}

/// What a channel shows now and next.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct NowNext {
    pub now: Option<Programme>,
    pub next: Option<Programme>,
}

/// The id `active_profile_id` names, if it is set and a number.
pub fn active_profile(conn: &Connection) -> rusqlite::Result<Option<i64>> {
    Ok(get_setting(conn, "active_profile_id")?.and_then(|id| id.trim().parse().ok()))
}

/// RFC 3339 in UTC with a `+00:00` offset, as `DateTime<Utc>::to_rfc3339`
/// wrote the old guide's times.
pub fn rfc3339(at: i64) -> Option<String> {
    DateTime::<Utc>::from_timestamp(at, 0).map(|t| t.to_rfc3339())
}

/// Read a stored time column as an RFC 3339 string; a value no date can
/// hold is a conversion error rather than an empty string the frontend
/// would parse as an invalid date.
fn time_column(row: &Row, idx: usize) -> rusqlite::Result<String> {
    let at: i64 = row.get(idx)?;
    rfc3339(at).ok_or_else(|| {
        rusqlite::Error::FromSqlConversionFailure(
            idx,
            rusqlite::types::Type::Integer,
            format!("guide time {at} is out of range").into(),
        )
    })
}

/// The distinct `channel_key`s of `keys`; keys that are blank have none.
fn wanted_keys(keys: &[String]) -> Vec<String> {
    let unique: HashSet<String> = keys.iter().filter_map(|k| channel_key(k)).collect();
    unique.into_iter().collect()
}

/// The `epg_channel` row that speaks for each key, keyed by `channel_key`.
///
/// Candidates are the channels with that key in a source that is enabled,
/// applies to `active_profile` (global sources apply to every profile; no
/// active profile leaves only the global ones), has programmes, and whose
/// last programme ends after `horizon_from`. The winner is the lowest
/// priority, ties to the older source. Keys may come in any case; keys
/// without a candidate are absent.
pub fn resolve(
    conn: &Connection,
    active_profile: Option<i64>,
    keys: &[String],
    horizon_from: i64,
) -> rusqlite::Result<HashMap<String, i64>> {
    let wanted = wanted_keys(keys);
    let mut winners: HashMap<String, (SourceRank, i64)> = HashMap::with_capacity(wanted.len());
    for chunk in wanted.chunks(RESOLVE_CHUNK) {
        let mut stmt = conn.prepare(&resolve_sql(chunk.len()))?;
        let mut values = Vec::with_capacity(chunk.len() + 2);
        values.push(active_profile.map_or(Value::Null, Value::Integer));
        values.push(Value::Integer(horizon_from));
        values.extend(chunk.iter().map(|k| Value::Text(k.clone())));
        let mut rows = stmt.query(params_from_iter(values))?;
        while let Some(row) = rows.next()? {
            let key: String = row.get(0)?;
            let channel: i64 = row.get(1)?;
            let rank = SourceRank {
                priority: row.get(2)?,
                source_id: row.get(3)?,
            };
            match winners.get(&key) {
                Some((best, _)) if *best <= rank => {}
                _ => {
                    winners.insert(key, (rank, channel));
                }
            }
        }
    }
    Ok(winners
        .into_iter()
        .map(|(key, (_, channel))| (key, channel))
        .collect())
}

fn titled_programme(row: &Row) -> rusqlite::Result<Programme> {
    Ok(Programme {
        title: row.get(0)?,
        description: None,
        start: time_column(row, 1)?,
        stop: time_column(row, 2)?,
    })
}

/// Now and next for each key, at `now` (Unix seconds).
///
/// Keyed by the key as sent; a key with neither is left out. The winning
/// source always has one of the two: its last programme ends after `now`.
pub fn now_next(
    conn: &Connection,
    active_profile: Option<i64>,
    keys: &[String],
    now: i64,
) -> rusqlite::Result<HashMap<String, NowNext>> {
    let channels = resolve(conn, active_profile, keys, now)?;
    let mut current = conn.prepare_cached(NOW_PROGRAMME)?;
    let mut next = conn.prepare_cached(NEXT_PROGRAMME)?;
    // Case variants of one key share the lookup.
    let mut by_channel: HashMap<i64, Option<NowNext>> = HashMap::new();
    let mut result = HashMap::with_capacity(keys.len());
    for key in keys {
        if result.contains_key(key) {
            continue;
        }
        let Some(&channel) = channel_key(key).and_then(|k| channels.get(&k)) else {
            continue;
        };
        let entry = match by_channel.get(&channel) {
            Some(entry) => entry.clone(),
            None => {
                let now_on = current
                    .query_row(params![channel, now], titled_programme)
                    .optional()?;
                let up_next = next
                    .query_row(params![channel, now], titled_programme)
                    .optional()?;
                let entry = (now_on.is_some() || up_next.is_some()).then_some(NowNext {
                    now: now_on,
                    next: up_next,
                });
                by_channel.insert(channel, entry.clone());
                entry
            }
        };
        if let Some(entry) = entry {
            result.insert(key.clone(), entry);
        }
    }
    Ok(result)
}

/// Programmes overlapping `[from, to)` for each key, in start order.
///
/// Every key sent is in the answer, with an empty list when no source has
/// programmes for it there. The source is resolved with `from` as the
/// horizon: one whose programmes end inside the window still speaks for the
/// part it covers.
pub fn guide(
    conn: &Connection,
    active_profile: Option<i64>,
    keys: &[String],
    from: i64,
    to: i64,
) -> rusqlite::Result<HashMap<String, Vec<Programme>>> {
    let channels = resolve(conn, active_profile, keys, from)?;
    let mut stmt = conn.prepare_cached(GUIDE_PROGRAMMES)?;
    let mut by_channel: HashMap<i64, Vec<Programme>> = HashMap::new();
    let mut result = HashMap::with_capacity(keys.len());
    for key in keys {
        if result.contains_key(key) {
            continue;
        }
        let programmes = match channel_key(key).and_then(|k| channels.get(&k)) {
            None => Vec::new(),
            Some(&channel) => match by_channel.get(&channel) {
                Some(list) => list.clone(),
                None => {
                    let list = stmt
                        .query_map(params![channel, from, to], |row| {
                            Ok(Programme {
                                title: row.get(0)?,
                                description: row.get(1)?,
                                start: time_column(row, 2)?,
                                stop: time_column(row, 3)?,
                            })
                        })?
                        .collect::<rusqlite::Result<Vec<_>>>()?;
                    by_channel.insert(channel, list.clone());
                    list
                }
            },
        };
        result.insert(key.clone(), programmes);
    }
    Ok(result)
}

/// Keys of the channels the guide can show between `from` and `to`, sorted,
/// each once: channels whose stored horizon (first start to last stop)
/// touches the range, in a source that is enabled and applies to the active
/// profile.
///
/// This answers from the per-channel summaries, so a channel with a gap
/// spanning the whole range is listed; for the guide's five-day range the
/// two readings agree.
pub fn guide_keys(
    conn: &Connection,
    active_profile: Option<i64>,
    from: i64,
    to: i64,
) -> rusqlite::Result<Vec<String>> {
    // De-duplicated here rather than with DISTINCT, which would build a
    // temporary B-tree; a key in two sources comes back twice.
    let keys: BTreeSet<String> = conn
        .prepare_cached(GUIDE_KEYS)?
        .query_map(params![active_profile, from, to], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    Ok(keys.into_iter().collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::epg::sources::ensure_xtream_source;
    use crate::epg::test_support::*;

    fn keys(list: &[&str]) -> Vec<String> {
        list.iter().map(|k| k.to_string()).collect()
    }

    fn at(t: i64) -> String {
        rfc3339(t).unwrap()
    }

    /// A global `manual` source with the given priority.
    fn manual(f: &Fixture, name: &str, priority: i32) -> i64 {
        let id = add_manual(&f.conn(), &format!("http://{name}.example/epg.xml"));
        f.conn()
            .execute(
                "UPDATE epg_source SET priority = ?2 WHERE id = ?1",
                params![id, priority],
            )
            .unwrap();
        id
    }

    /// The `xtream` source of a new Xtream playlist `playlist_id`.
    fn xtream(f: &Fixture, playlist_id: i64, priority: i32) -> i64 {
        let conn = f.conn();
        conn.execute(
            "INSERT INTO playlists (id, name, url, xtream_username, xtream_password)
             VALUES (?1, 'Provider', 'http://host', 'user', 'pass')",
            params![playlist_id],
        )
        .unwrap();
        let id = ensure_xtream_source(&conn, playlist_id).unwrap();
        conn.execute(
            "UPDATE epg_source SET priority = ?2 WHERE id = ?1",
            params![id, priority],
        )
        .unwrap();
        id
    }

    fn source_of(conn: &Connection, channel: i64) -> i64 {
        conn.query_row(
            "SELECT source_id FROM epg_channel WHERE id = ?1",
            params![channel],
            |r| r.get(0),
        )
        .unwrap()
    }

    fn titles(list: &[Programme]) -> Vec<&str> {
        list.iter().map(|p| p.title.as_str()).collect()
    }

    #[test]
    fn times_are_rfc3339_in_utc_with_a_written_offset() {
        assert_eq!(at(NOW), "2026-10-21T12:00:00+00:00");
        assert_eq!(at(NOW + 90), "2026-10-21T12:01:30+00:00");
        assert_eq!(rfc3339(i64::MAX), None);
    }

    #[tokio::test]
    async fn answers_are_keyed_by_the_key_as_sent() {
        let f = Fixture::new("read");
        let s = manual(&f, "a", 10);
        let feed = Feed::new()
            .programme("SVT1.se", NOW - H, NOW + H, "News")
            .programme("SVT1.se", NOW + H, NOW + 2 * H, "Film")
            .programme("Ämne.se", NOW, NOW + H, "Ämne");
        f.store(s, &feed.xml(), NOW).await;
        let conn = f.conn();
        let asked = keys(&[
            "svt1.se",
            "SVT1.SE",
            " Svt1.se ",
            "ÄMNE.se",
            "missing.se",
            "  ",
        ]);

        let nn = now_next(&conn, None, &asked, NOW).unwrap();

        let mut answered: Vec<&str> = nn.keys().map(String::as_str).collect();
        answered.sort();
        assert_eq!(answered, [" Svt1.se ", "SVT1.SE", "svt1.se", "ÄMNE.se"]);
        assert_eq!(
            nn["SVT1.SE"],
            NowNext {
                now: Some(Programme {
                    title: "News".into(),
                    description: None,
                    start: at(NOW - H),
                    stop: at(NOW + H),
                }),
                next: Some(Programme {
                    title: "Film".into(),
                    description: None,
                    start: at(NOW + H),
                    stop: at(NOW + 2 * H),
                }),
            }
        );
        assert_eq!(nn["svt1.se"], nn["SVT1.SE"]);
        assert_eq!(nn[" Svt1.se "], nn["SVT1.SE"]);
        assert_eq!(nn["ÄMNE.se"].now.as_ref().unwrap().title, "Ämne");
        assert_eq!(nn["ÄMNE.se"].next, None);

        let guide = guide(&conn, None, &asked, NOW, NOW + 3 * H).unwrap();

        assert_eq!(guide.len(), asked.len(), "every key sent is answered");
        assert_eq!(titles(&guide["SVT1.SE"]), ["News", "Film"]);
        assert_eq!(guide["svt1.se"], guide["SVT1.SE"]);
        assert_eq!(
            guide["SVT1.SE"][0].description.as_deref(),
            Some("About News")
        );
        assert_eq!(guide["SVT1.SE"][1].start, at(NOW + H));
        assert!(guide["missing.se"].is_empty());
        assert!(guide["  "].is_empty());
    }

    #[tokio::test]
    async fn the_guide_window_includes_what_overlaps_it() {
        let f = Fixture::new("read");
        let s = manual(&f, "a", 10);
        let feed = Feed::new()
            .programme("svt1.se", NOW - 2 * H, NOW - H, "Ended at from")
            .programme("svt1.se", NOW - H, NOW + H, "Playing at from")
            .programme("svt1.se", NOW + H, NOW + 2 * H, "Inside")
            .programme("svt1.se", NOW + 2 * H, NOW + 3 * H, "Starts at to");
        f.store(s, &feed.xml(), NOW - 2 * H).await;

        let guide = guide(
            &f.conn(),
            None,
            &keys(&["svt1.se"]),
            NOW - H + 1,
            NOW + 2 * H,
        )
        .unwrap();

        assert_eq!(titles(&guide["svt1.se"]), ["Playing at from", "Inside"]);
    }

    #[tokio::test]
    async fn the_lowest_priority_with_programmes_ahead_wins() {
        let f = Fixture::new("read");
        let high = manual(&f, "high", 5);
        let low = manual(&f, "low", 30);
        let tie = manual(&f, "tie", 30);
        // `high` has svt1.se ahead, only ended rows for tv4.se, and lists
        // kanal5.se without a programme.
        let feed = Feed::new()
            .channel("kanal5.se", &["Kanal 5"])
            .programme("svt1.se", NOW, NOW + H, "High")
            .programme("tv4.se", NOW - 4 * H, NOW - 2 * H, "High, ended");
        f.store(high, &feed.xml(), NOW - 3 * H).await;
        let all = |title: &str| {
            let mut feed = Feed::new();
            for key in ["svt1.se", "tv4.se", "kanal5.se", "sjuan.se"] {
                feed = feed.programme(key, NOW, NOW + H, title);
            }
            feed.xml()
        };
        f.store(low, &all("Low"), NOW).await;
        f.store(tie, &all("Tie"), NOW).await;
        let conn = f.conn();
        let listed: i64 = conn
            .query_row(
                "SELECT programme_count FROM epg_channel WHERE source_id = ?1 AND key = 'kanal5.se'",
                params![high],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(listed, 0, "the channel row exists without programmes");
        let asked = keys(&["svt1.se", "tv4.se", "kanal5.se", "sjuan.se", "none.se"]);

        let winners = resolve(&conn, None, &asked, NOW).unwrap();

        assert_eq!(source_of(&conn, winners["svt1.se"]), high);
        assert_eq!(
            source_of(&conn, winners["tv4.se"]),
            low,
            "high's programmes for it all ended"
        );
        assert_eq!(source_of(&conn, winners["kanal5.se"]), low, "high has none");
        assert_eq!(
            source_of(&conn, winners["sjuan.se"]),
            low,
            "a tie goes to the older source"
        );
        assert!(!winners.contains_key("none.se"));
        let nn = now_next(&conn, None, &asked, NOW).unwrap();
        assert_eq!(nn["svt1.se"].now.as_ref().unwrap().title, "High");
        assert_eq!(nn["tv4.se"].now.as_ref().unwrap().title, "Low");

        // Before its rows ended, `high` still spoke for tv4.se.
        let earlier = resolve(&conn, None, &keys(&["tv4.se"]), NOW - 3 * H).unwrap();
        assert_eq!(source_of(&conn, earlier["tv4.se"]), high);

        conn.execute(
            "UPDATE epg_source SET enabled = 0 WHERE id = ?1",
            params![high],
        )
        .unwrap();
        let winners = resolve(&conn, None, &keys(&["svt1.se"]), NOW).unwrap();
        assert_eq!(
            source_of(&conn, winners["svt1.se"]),
            low,
            "a disabled source falls through"
        );
    }

    #[tokio::test]
    async fn a_profiles_source_answers_only_while_that_profile_is_active() {
        let f = Fixture::new("read");
        let global = manual(&f, "global", 10);
        let provider = xtream(&f, 2, 1);
        f.store(
            global,
            &Feed::new()
                .programme("svt1.se", NOW, NOW + H, "Global")
                .xml(),
            NOW,
        )
        .await;
        f.store(
            provider,
            &Feed::new()
                .programme("svt1.se", NOW, NOW + H, "Provider")
                .xml(),
            NOW,
        )
        .await;
        let conn = f.conn();
        let asked = keys(&["svt1.se"]);
        let title = |profile: Option<i64>| {
            now_next(&conn, profile, &asked, NOW).unwrap()["svt1.se"]
                .now
                .clone()
                .unwrap()
                .title
        };

        assert_eq!(title(Some(2)), "Provider");
        assert_eq!(title(Some(1)), "Global");
        assert_eq!(title(None), "Global");
        assert_eq!(
            guide_keys(&conn, Some(1), NOW, NOW + H).unwrap(),
            ["svt1.se"]
        );
    }

    #[tokio::test]
    async fn five_thousand_keys_bind_in_one_request() {
        let f = Fixture::new("read");
        let s = manual(&f, "a", 10);
        let mut feed = Feed::new();
        for i in 0..5_000 {
            feed = feed.programme(&format!("kanal{i}.se"), NOW, NOW + H, "T");
        }
        f.store(s, &feed.xml(), NOW).await;
        let conn = f.conn();
        let asked: Vec<String> = (0..5_000).map(|i| format!("Kanal{i}.SE")).collect();

        assert_eq!(resolve(&conn, None, &asked, NOW).unwrap().len(), 5_000);
        assert_eq!(now_next(&conn, None, &asked, NOW).unwrap().len(), 5_000);
        let guide = guide(&conn, None, &asked, NOW, NOW + H).unwrap();
        assert!(guide.values().all(|list| list.len() == 1));

        // More than one statement's worth of keys still resolves.
        let mut many = asked.clone();
        many.extend((0..RESOLVE_CHUNK).map(|i| format!("other{i}.se")));
        assert_eq!(resolve(&conn, None, &many, NOW).unwrap().len(), 5_000);
    }

    #[tokio::test]
    async fn guide_keys_are_channels_whose_horizon_touches_the_range() {
        let f = Fixture::new("read");
        let a = manual(&f, "a", 10);
        let b = manual(&f, "b", 20);
        let off = manual(&f, "off", 30);
        let provider = xtream(&f, 2, 40);
        let (from, to) = (NOW, NOW + 3 * H);
        let feed = Feed::new()
            // A gap over the whole range; the horizon still spans it.
            .programme("gap.se", NOW - 2 * H, NOW - H, "Before")
            .programme("gap.se", NOW + 5 * H, NOW + 6 * H, "After")
            .programme("ends-at-from.se", NOW - H, NOW, "T")
            .programme("starts-at-to.se", NOW + 3 * H, NOW + 4 * H, "T")
            .programme("inside.se", NOW + H, NOW + 2 * H, "T")
            .programme("both.se", NOW, NOW + H, "T");
        f.store(a, &feed.xml(), NOW - 2 * H).await;
        let other = |key: &str| {
            Feed::new()
                .programme(key, NOW, NOW + H, "T")
                .programme("both.se", NOW, NOW + H, "T")
                .xml()
        };
        f.store(b, &other("b.se"), NOW).await;
        f.store(off, &other("disabled.se"), NOW).await;
        f.store(provider, &other("other-profile.se"), NOW).await;
        let conn = f.conn();
        conn.execute(
            "UPDATE epg_source SET enabled = 0 WHERE id = ?1",
            params![off],
        )
        .unwrap();

        assert_eq!(
            guide_keys(&conn, Some(1), from, to).unwrap(),
            ["b.se", "both.se", "gap.se", "inside.se"]
        );
        assert!(
            guide(&conn, Some(1), &keys(&["gap.se"]), from, to).unwrap()["gap.se"].is_empty(),
            "listed, with nothing to draw in the range"
        );
    }

    /// `EXPLAIN QUERY PLAN` detail lines of `sql`, parameters unbound.
    fn plan(conn: &Connection, sql: &str) -> Vec<String> {
        let mut stmt = conn.prepare(&format!("EXPLAIN QUERY PLAN {sql}")).unwrap();
        let mut rows = stmt.raw_query();
        let mut lines = Vec::new();
        while let Some(row) = rows.next().unwrap() {
            lines.push(row.get::<_, String>(3).unwrap());
        }
        lines
    }

    #[test]
    fn reads_reach_programmes_by_primary_key_and_channels_by_key() {
        let f = Fixture::new("read");
        let conn = f.conn();
        let version: String = conn
            .query_row("SELECT sqlite_version()", [], |r| r.get(0))
            .unwrap();
        assert_eq!(version, "3.46.0", "plans pinned on the bundled SQLite");

        for count in [1, 870, 5_000] {
            assert_eq!(
                plan(&conn, &resolve_sql(count)),
                [
                    "SEARCH c USING INDEX idx_epg_channel_key (key=?)",
                    "SEARCH s USING INTEGER PRIMARY KEY (rowid=?)",
                ],
                "{count} keys"
            );
        }
        assert_eq!(
            plan(&conn, NOW_PROGRAMME),
            ["SEARCH epg_programme USING PRIMARY KEY (channel_id=? AND start<?)"]
        );
        assert_eq!(
            plan(&conn, NEXT_PROGRAMME),
            ["SEARCH epg_programme USING PRIMARY KEY (channel_id=? AND start>?)"]
        );
        assert_eq!(
            plan(&conn, GUIDE_PROGRAMMES),
            ["SEARCH epg_programme USING PRIMARY KEY (channel_id=? AND start<?)"]
        );
        // One row per guide channel (2,055 in the captured feed), never the
        // programmes.
        assert_eq!(
            plan(&conn, GUIDE_KEYS),
            ["SCAN c", "SEARCH s USING INTEGER PRIMARY KEY (rowid=?)"]
        );
    }

    /// Release benches of the three reads the UI makes, each including
    /// `resolve`, on a database filled by ingesting a feed: the captured
    /// feed (`EPG_REAL_FEED`) and the synthetic 430k feed that the store's
    /// `perf_make_feeds` writes to `EPG_PERF_DIR`. The sizes are those of
    /// the old baseline (docs/plans/2026-10-16-backend-perf-baseline.md):
    /// `get_guide` 763 ids over 3 h, the guide's ids over 5 days, now/next
    /// for 100 ids. Prints only counts and timings.
    mod perf {
        use super::*;
        use crate::epg::sources::feed_path;
        use crate::epg::{ingest, Fetch, IngestOutcome, IngestScope};
        use std::path::Path;
        use std::time::{Duration, Instant};

        const RUNS: usize = 50;

        /// Median and fastest of `RUNS` timed calls after one warm-up.
        fn time<T>(mut f: impl FnMut() -> T) -> (Duration, Duration, T) {
            let mut last = f();
            let mut times = Vec::with_capacity(RUNS);
            for _ in 0..RUNS {
                let started = Instant::now();
                last = f();
                times.push(started.elapsed());
            }
            times.sort();
            (times[RUNS / 2], times[0], last)
        }

        async fn bench(feed: &Path) {
            let f = Fixture::new("read-perf");
            let s = add_manual(&f.conn(), "http://bench.example/epg.xml");
            std::fs::copy(feed, feed_path(&f.dir.0, s)).unwrap();
            let outcome = ingest(&f.env(), s, Fetch::Cache, IngestScope::Feed, NOW)
                .await
                .unwrap();
            let IngestOutcome::Stored(report) = outcome else {
                panic!("not stored: {outcome:?}");
            };
            let conn = f.conn();
            let name = feed.file_name().unwrap().to_string_lossy();

            let (from, to) = (NOW - 24 * H, NOW + 96 * H);
            let (median, fastest, keys) = time(|| guide_keys(&conn, None, from, to).unwrap());
            eprintln!(
                "PERF {name}: {} programmes on {} channels stored; guide keys 5 days: \
                 median {median:.2?}, fastest {fastest:.2?}, {} keys",
                report.stored,
                report.keys,
                keys.len()
            );

            let wanted: Vec<String> = keys.iter().take(763).cloned().collect();
            let (median, fastest, answer) =
                time(|| guide(&conn, None, &wanted, NOW, NOW + 3 * H).unwrap());
            let started = Instant::now();
            let bytes = serde_json::to_vec(&answer).unwrap().len();
            let serde = started.elapsed();
            eprintln!(
                "PERF {name}: get_guide {} ids, 3 h: median {median:.2?}, fastest {fastest:.2?}, \
                 {} programmes, {bytes} bytes JSON in {serde:.2?}",
                wanted.len(),
                answer.values().map(Vec::len).sum::<usize>()
            );

            let wanted: Vec<String> = keys.iter().take(100).cloned().collect();
            let (median, fastest, answer) = time(|| now_next(&conn, None, &wanted, NOW).unwrap());
            eprintln!(
                "PERF {name}: now/next {} ids: median {median:.2?}, fastest {fastest:.2?}, \
                 {} answered, {} bytes JSON",
                wanted.len(),
                answer.len(),
                serde_json::to_vec(&answer).unwrap().len()
            );
        }

        #[tokio::test]
        #[ignore]
        async fn perf_reads_real_feed() {
            let Some(path) = std::env::var_os("EPG_REAL_FEED") else {
                eprintln!("EPG_REAL_FEED is not set; skipped");
                return;
            };
            bench(Path::new(&path)).await;
        }

        #[tokio::test]
        #[ignore]
        async fn perf_reads_430k() {
            let Some(dir) = std::env::var_os("EPG_PERF_DIR") else {
                eprintln!("EPG_PERF_DIR is not set; skipped");
                return;
            };
            let path = Path::new(&dir).join("430k-plain.xml");
            if !path.exists() {
                eprintln!(
                    "{} is missing: run epg::store::tests::perf::perf_make_feeds",
                    path.display()
                );
                return;
            }
            bench(&path).await;
        }
    }
}
