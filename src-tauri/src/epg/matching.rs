//! Channel matching against the stored guide: reads what
//! `epg_domain::matching` decides on and writes its answer into
//! `channels.epg_match_key` / `epg_match_source`, the only writer of those
//! two columns. Every other column of `channels` is left as it is.
//!
//! A recompute covers one playlist over the enabled sources that apply to
//! it (its own and the global ones). It runs in one write transaction: the
//! guide and the channels are read, the cursor over `channels` is finished
//! with only the rows whose match changes collected, and then those rows
//! are updated. SQLite does not define whether a query sees rows its own
//! connection changes while it runs, so the reads never overlap the writes.
//!
//! A match set by hand (`set_manual_match`) is written the same way, for one row:
//! its key must have programmes in a source that applies to the channel's
//! playlist when it is set. It stays when the key later loses them.

use crate::db::mutations::set_setting;
use crate::db::queries::get_setting;
use crate::epg_domain::key::channel_key;
use crate::epg_domain::matching::{
    self, ChannelRow, GuideIndex, MatchReport, MatchUpdate, Matcher, SourceGuide,
};
use crate::error::AppError;
use log::warn;
use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde::Serialize;

/// Settings key that records the one-time recompute of every playlist for a
/// database whose guide was stored before matching existed.
pub const MATCHES_INITIALISED_KEY: &str = "epg_matches_initialised";

/// Enabled sources that apply to a playlist, in precedence order.
const APPLYING_SOURCES: &str = "SELECT id FROM epg_source
    WHERE enabled = 1 AND (playlist_id IS NULL OR playlist_id = ?1)
    ORDER BY priority, id";
const SOURCE_KEYS: &str =
    "SELECT key FROM epg_channel WHERE source_id = ?1 AND programme_count > 0";
const SOURCE_NAMES: &str = "SELECT n.name_key, c.key FROM epg_channel_name n
    JOIN epg_channel c ON c.id = n.channel_id
    WHERE c.source_id = ?1 AND c.programme_count > 0";
const PLAYLIST_CHANNELS: &str = "SELECT id, content_type, epg_id, tvg_name, name,
        epg_match_key, epg_match_source
    FROM channels WHERE playlist_id = ?1";
const UPDATE_MATCH: &str =
    "UPDATE channels SET epg_match_key = ?2, epg_match_source = ?3 WHERE id = ?1";

/// The guide as it applies to a playlist: the keys of the channels with
/// programmes in its enabled sources, and their display names.
pub fn guide_index(conn: &Connection, playlist_id: i64) -> rusqlite::Result<GuideIndex> {
    let sources: Vec<i64> = conn
        .prepare_cached(APPLYING_SOURCES)?
        .query_map(params![playlist_id], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    let mut guides = Vec::with_capacity(sources.len());
    for source_id in sources {
        let keys = conn
            .prepare_cached(SOURCE_KEYS)?
            .query_map(params![source_id], |r| r.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        let names = conn
            .prepare_cached(SOURCE_NAMES)?
            .query_map(params![source_id], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<rusqlite::Result<_>>()?;
        guides.push(SourceGuide { keys, names });
    }
    Ok(GuideIndex::build(guides))
}

/// The rows of a playlist whose match changes, with the counts.
fn collect_updates(
    conn: &Connection,
    playlist_id: i64,
    index: &GuideIndex,
) -> rusqlite::Result<(Vec<MatchUpdate>, MatchReport)> {
    let mut matcher = Matcher::new(index);
    let mut updates = Vec::new();
    let mut stmt = conn.prepare(PLAYLIST_CHANNELS)?;
    let mut rows = stmt.query(params![playlist_id])?;
    while let Some(row) = rows.next()? {
        let channel = ChannelRow {
            id: row.get(0)?,
            live: row.get_ref(1)?.as_str_or_null()? == Some("live"),
            epg_id: row.get_ref(2)?.as_str_or_null()?,
            tvg_name: row.get_ref(3)?.as_str_or_null()?,
            name: row.get_ref(4)?.as_str()?,
            match_key: row.get_ref(5)?.as_str_or_null()?,
            match_source: row.get_ref(6)?.as_str_or_null()?,
        };
        if let Some(update) = matcher.visit(&channel) {
            updates.push(update);
        }
    }
    Ok((updates, matcher.finish()))
}

/// Write the collected updates.
fn apply_updates(conn: &Connection, updates: &[MatchUpdate]) -> rusqlite::Result<()> {
    let mut stmt = conn.prepare_cached(UPDATE_MATCH)?;
    for update in updates {
        stmt.execute(params![
            update.channel_id,
            update.key,
            update.source.map(|s| s.as_db())
        ])?;
    }
    Ok(())
}

/// Match one playlist's channels to the guide, in one transaction that
/// takes the write lock at `BEGIN` (it reads, then writes based on what it
/// read). Writes only the rows whose match changed; `changed` counts them.
pub fn recompute_playlist(conn: &Connection, playlist_id: i64) -> rusqlite::Result<MatchReport> {
    let tx = Transaction::new_unchecked(conn, TransactionBehavior::Immediate)?;
    let index = guide_index(&tx, playlist_id)?;
    let (updates, report) = collect_updates(&tx, playlist_id, &index)?;
    apply_updates(&tx, &updates)?;
    tx.commit()?;
    Ok(report)
}

/// Recompute every playlist a source with this `playlist_id` applies to: the
/// one playlist, or every playlist for a global source (`None`). One
/// transaction per playlist; the reports are added up. A playlist whose
/// recompute fails is rolled back, logged and counted in
/// `failed_playlists`, and the next one still runs: the rows the others
/// changed are committed and must be reported.
pub fn recompute_where_applies(
    conn: &Connection,
    playlist_id: Option<i64>,
) -> rusqlite::Result<MatchReport> {
    let playlists: Vec<i64> = match playlist_id {
        Some(id) => vec![id],
        None => conn
            .prepare("SELECT id FROM playlists ORDER BY id")?
            .query_map([], |r| r.get(0))?
            .collect::<rusqlite::Result<_>>()?,
    };
    let mut total = MatchReport::default();
    for id in playlists {
        match recompute_playlist(conn, id) {
            Ok(report) => total.add(&report),
            Err(e) => {
                warn!("EPG channel matching for playlist {id} failed, its matches stay: {e}");
                total.failed_playlists += 1;
            }
        }
    }
    Ok(total)
}

/// Recompute every playlist source `source_id` applies to. A source that no
/// longer exists (just removed) may have applied anywhere: every playlist.
pub fn recompute_for_source(conn: &Connection, source_id: i64) -> rusqlite::Result<MatchReport> {
    let playlist_id: Option<i64> = conn
        .query_row(
            "SELECT playlist_id FROM epg_source WHERE id = ?1",
            params![source_id],
            |r| r.get(0),
        )
        .optional()?
        .flatten();
    recompute_where_applies(conn, playlist_id)
}

/// Once per database: match every playlist against the guide already
/// stored. A database that held guide data before matching existed would
/// otherwise show no programme until the next download. The guard key is
/// written only when every playlist succeeded, so a failure retries at the
/// next start; the recompute itself is idempotent. `None` when it ran before.
pub fn recompute_once_after_upgrade(conn: &Connection) -> rusqlite::Result<Option<MatchReport>> {
    if get_setting(conn, MATCHES_INITIALISED_KEY)?.is_some() {
        return Ok(None);
    }
    let report = recompute_where_applies(conn, None)?;
    if report.failed_playlists == 0 {
        set_setting(conn, MATCHES_INITIALISED_KEY, "1")?;
    }
    Ok(Some(report))
}

// ========== Matches set by hand ==========

/// The first display name of `key` in the highest-precedence enabled
/// source that applies to the playlist and has programmes for it. No row:
/// no such source.
const GUIDE_CHANNEL: &str = "SELECT n.name FROM epg_channel c
    JOIN epg_source s ON s.id = c.source_id
    LEFT JOIN epg_channel_name n ON n.channel_id = c.id
        AND n.position = (SELECT MIN(position) FROM epg_channel_name WHERE channel_id = c.id)
    WHERE c.key = ?1 AND c.programme_count > 0
      AND s.enabled = 1 AND (s.playlist_id IS NULL OR s.playlist_id = ?2)
    ORDER BY s.priority, s.id
    LIMIT 1";
const CHANNEL_FOR_MATCH: &str = "SELECT playlist_id, content_type, epg_id, tvg_name, name,
        epg_match_key, epg_match_source
    FROM channels WHERE id = ?1";
const MANUAL_MATCHES: &str = "SELECT id, name, epg_match_key FROM channels
    WHERE playlist_id = ?1 AND content_type = 'live' AND epg_match_source = 'manual'
    ORDER BY name COLLATE NOCASE, id";
const NAME_MATCHES: &str = "SELECT id FROM channels
    WHERE playlist_id = ?1 AND content_type = 'live'
      AND epg_match_source IN ('tvg_name', 'name')
    ORDER BY id";

/// Whether `key` has programmes in a source that applies to the playlist,
/// and the guide's name for it: `None` when it has none, `Some(None)`
/// when the feed names it nowhere.
fn guide_channel(
    conn: &Connection,
    playlist_id: i64,
    key: &str,
) -> rusqlite::Result<Option<Option<String>>> {
    conn.prepare_cached(GUIDE_CHANNEL)?
        .query_row(params![key, playlist_id], |r| r.get(0))
        .optional()
}

/// A `channels` row as `set_manual_match` reads it.
struct StoredChannel {
    playlist_id: i64,
    live: bool,
    epg_id: Option<String>,
    tvg_name: Option<String>,
    name: String,
    match_key: Option<String>,
    match_source: Option<String>,
}

impl StoredChannel {
    fn row(&self, id: i64) -> ChannelRow<'_> {
        ChannelRow {
            id,
            live: self.live,
            epg_id: self.epg_id.as_deref(),
            tvg_name: self.tvg_name.as_deref(),
            name: &self.name,
            match_key: self.match_key.as_deref(),
            match_source: self.match_source.as_deref(),
        }
    }
}

/// Match a live channel to the guide channel `key` by hand, or with `None`
/// clear a match set by hand and match the channel automatically again.
/// The key must have programmes in an enabled source that applies to the
/// channel's playlist. Returns whether the stored match changed.
pub fn set_manual_match(
    conn: &Connection,
    channel_id: i64,
    key: Option<&str>,
) -> Result<bool, AppError> {
    let tx = Transaction::new_unchecked(conn, TransactionBehavior::Immediate)?;
    let channel = tx
        .query_row(CHANNEL_FOR_MATCH, params![channel_id], |r| {
            Ok(StoredChannel {
                playlist_id: r.get(0)?,
                live: r.get_ref(1)?.as_str_or_null()? == Some("live"),
                epg_id: r.get(2)?,
                tvg_name: r.get(3)?,
                name: r.get(4)?,
                match_key: r.get(5)?,
                match_source: r.get(6)?,
            })
        })
        .optional()?
        .ok_or(AppError::ChannelNotFound(channel_id))?;
    if !channel.live {
        return Err(AppError::InvalidInput(
            "Only live channels can be matched to the guide".to_string(),
        ));
    }
    let row = channel.row(channel_id);
    let update = match key {
        Some(raw) => {
            let key = channel_key(raw)
                .ok_or_else(|| AppError::InvalidInput("Choose a guide channel".to_string()))?;
            if guide_channel(&tx, channel.playlist_id, &key)?.is_none() {
                return Err(AppError::InvalidInput(format!(
                    "The guide of this profile has no programmes for \"{}\"",
                    raw.trim()
                )));
            }
            matching::set_by_hand(&row, key)
        }
        None => {
            let index = guide_index(&tx, channel.playlist_id)?;
            matching::clear_by_hand(&index, &row)
        }
    };
    let changed = update.is_some();
    if let Some(update) = update {
        apply_updates(&tx, &[update])?;
    }
    tx.commit()?;
    Ok(changed)
}

/// A live channel matched by hand, as Settings lists it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ManualMatch {
    pub channel_id: i64,
    pub channel_name: String,
    pub key: String,
    /// The guide's name for the key; `None` when it has none or has no
    /// programmes now.
    pub guide_name: Option<String>,
    /// The key has programmes in a source that applies to the playlist. A
    /// match set by hand stays when they go.
    pub has_programmes: bool,
}

/// What the channel list does not carry about a playlist's matches: which
/// were set by hand, and which were found by name. Every other live channel
/// with a guide key was matched by its id.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct MatchDetails {
    /// By channel name.
    pub manual: Vec<ManualMatch>,
    /// Channel ids, ascending.
    pub by_name: Vec<i64>,
}

/// The matches of a playlist's live channels that were set by hand or
/// found by name.
pub fn match_details(conn: &Connection, playlist_id: i64) -> rusqlite::Result<MatchDetails> {
    let rows: Vec<(i64, String, Option<String>)> = conn
        .prepare(MANUAL_MATCHES)?
        .query_map(params![playlist_id], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })?
        .collect::<rusqlite::Result<_>>()?;
    let mut manual = Vec::with_capacity(rows.len());
    for (channel_id, channel_name, key) in rows {
        // A manual row always has a key; one without is not listed.
        let Some(key) = key else { continue };
        let guide = guide_channel(conn, playlist_id, &key)?;
        manual.push(ManualMatch {
            channel_id,
            channel_name,
            has_programmes: guide.is_some(),
            guide_name: guide.flatten(),
            key,
        });
    }
    let by_name = conn
        .prepare(NAME_MATCHES)?
        .query_map(params![playlist_id], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    Ok(MatchDetails { manual, by_name })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::models::Channel;
    use crate::db::mutations::merge_channels;
    use crate::db::queries::{get_channel_summaries, get_channel_summaries_by_ids};
    use crate::db::test_helpers::{create_test_playlist, setup_test_db};
    use rusqlite::types::Value;

    /// A source with the given priority and its guide channels: each key
    /// with one programme and its display names.
    fn add_source(
        conn: &Connection,
        playlist_id: Option<i64>,
        priority: i32,
        channels: &[(&str, &[&str])],
    ) -> i64 {
        let url = format!("http://epg{priority}.example/epg.xml");
        conn.execute(
            "INSERT INTO epg_source (playlist_id, origin, url, priority)
             VALUES (?1, 'manual', ?2, ?3)",
            params![playlist_id, url, priority],
        )
        .unwrap();
        let source = conn.last_insert_rowid();
        for (key, names) in channels {
            add_guide_channel(conn, source, key, names, 1);
        }
        source
    }

    fn add_guide_channel(conn: &Connection, source: i64, key: &str, names: &[&str], count: i64) {
        conn.execute(
            "INSERT INTO epg_channel (source_id, key, first_start, last_stop, programme_count)
             VALUES (?1, ?2, 100, 200, ?3)",
            params![source, key, count],
        )
        .unwrap();
        let channel = conn.last_insert_rowid();
        for (position, name) in names.iter().enumerate() {
            conn.execute(
                "INSERT INTO epg_channel_name (channel_id, position, name, name_key)
                 VALUES (?1, ?2, ?3, ?4)",
                params![
                    channel,
                    position as i64,
                    name,
                    crate::epg_domain::key::name_key(name).unwrap()
                ],
            )
            .unwrap();
        }
    }

    fn add_channel(
        conn: &Connection,
        playlist_id: i64,
        name: &str,
        epg_id: Option<&str>,
        content_type: &str,
    ) -> i64 {
        conn.execute(
            "INSERT INTO channels (playlist_id, name, url, epg_id, content_type)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                playlist_id,
                name,
                format!("http://p.example/{name}"),
                epg_id,
                content_type
            ],
        )
        .unwrap();
        conn.last_insert_rowid()
    }

    type Stored = (Option<String>, Option<String>);

    fn stored(conn: &Connection, id: i64) -> Stored {
        conn.query_row(
            "SELECT epg_match_key, epg_match_source FROM channels WHERE id = ?1",
            params![id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap()
    }

    fn matched(key: &str, source: &str) -> Stored {
        (Some(key.to_string()), Some(source.to_string()))
    }

    fn set_manual(conn: &Connection, id: i64, key: &str) {
        conn.execute(
            "UPDATE channels SET epg_match_key = ?2, epg_match_source = 'manual' WHERE id = ?1",
            params![id, key],
        )
        .unwrap();
    }

    fn columns(conn: &Connection, table: &str) -> Vec<String> {
        conn.prepare(&format!("PRAGMA table_info({table})"))
            .unwrap()
            .query_map([], |r| r.get::<_, String>(1))
            .unwrap()
            .map(|c| c.unwrap())
            .collect()
    }

    /// Every row of `channels` without the two match columns.
    fn other_columns(conn: &Connection) -> Vec<Vec<Value>> {
        let cols: Vec<String> = columns(conn, "channels")
            .into_iter()
            .filter(|c| !c.starts_with("epg_match_"))
            .collect();
        let sql = format!("SELECT {} FROM channels ORDER BY id", cols.join(", "));
        let mut stmt = conn.prepare(&sql).unwrap();
        stmt.query_map([], |row| {
            (0..cols.len())
                .map(|i| row.get::<_, Value>(i))
                .collect::<rusqlite::Result<Vec<_>>>()
        })
        .unwrap()
        .map(|r| r.unwrap())
        .collect()
    }

    /// Log every write of a match column into `match_writes`.
    fn log_match_writes(conn: &Connection) {
        conn.execute_batch(
            "CREATE TABLE match_writes (channel_id INTEGER);
             CREATE TRIGGER log_match AFTER UPDATE OF epg_match_key, epg_match_source
             ON channels BEGIN INSERT INTO match_writes VALUES (NEW.id); END;",
        )
        .unwrap();
    }

    fn match_writes(conn: &Connection) -> Vec<i64> {
        conn.prepare("SELECT channel_id FROM match_writes ORDER BY channel_id")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .map(|r| r.unwrap())
            .collect()
    }

    #[test]
    fn a_fresh_database_has_the_match_columns_and_they_start_empty() {
        let conn = setup_test_db();
        let cols = columns(&conn, "channels");
        assert!(cols.contains(&"epg_match_key".to_string()), "{cols:?}");
        assert!(cols.contains(&"epg_match_source".to_string()), "{cols:?}");
        let p = create_test_playlist(&conn, "P");
        let c = add_channel(&conn, p, "SVT1", Some("svt1.se"), "live");
        assert_eq!(stored(&conn, c), (None, None));
        // A second start adds nothing and fails nothing.
        crate::db::schema::init_schema(&conn).unwrap();
        assert_eq!(columns(&conn, "channels"), cols);
    }

    #[test]
    fn the_match_columns_are_added_to_an_existing_channels_table() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE playlists (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
                url TEXT, file_path TEXT, last_updated TIMESTAMP, auto_refresh BOOLEAN DEFAULT 0,
                created_at TIMESTAMP);
             CREATE TABLE channels (id INTEGER PRIMARY KEY AUTOINCREMENT,
                playlist_id INTEGER NOT NULL, name TEXT NOT NULL, url TEXT NOT NULL, logo TEXT,
                group_name TEXT, epg_id TEXT, tvg_name TEXT, content_type TEXT DEFAULT 'live',
                is_favorite BOOLEAN DEFAULT 0, sort_order INTEGER DEFAULT 0,
                category_order INTEGER DEFAULT 0, created_at TIMESTAMP);
             INSERT INTO playlists (id, name) VALUES (1, 'P');
             INSERT INTO channels (id, playlist_id, name, url, epg_id)
                VALUES (5, 1, 'SVT1', 'http://p/1', 'SVT1.se');",
        )
        .unwrap();
        let before = other_columns(&conn);

        crate::db::schema::init_schema(&conn).unwrap();

        let cols = columns(&conn, "channels");
        assert!(cols.ends_with(&["epg_match_key".to_string(), "epg_match_source".to_string()]));
        assert_eq!(stored(&conn, 5), (None, None));
        assert_eq!(
            other_columns(&conn)
                .into_iter()
                .map(|row| row[..before[0].len()].to_vec())
                .collect::<Vec<_>>(),
            before,
            "existing values untouched"
        );
    }

    #[test]
    fn a_recompute_matches_by_id_and_by_name_for_channels_without_an_id() {
        let conn = setup_test_db();
        let p = create_test_playlist(&conn, "P");
        add_source(
            &conn,
            None,
            10,
            &[("svt1.se", &["SVT1"]), ("tv4.se", &["TV4"])],
        );
        let by_id = add_channel(&conn, p, "Ettan", Some("SVT1.se"), "live");
        let unknown_id = add_channel(&conn, p, "TV4", Some("tv4.nl"), "live");
        let by_name = add_channel(&conn, p, "TV4", None, "live");
        let vod = add_channel(&conn, p, "SVT1", Some("svt1.se"), "vod");

        let report = recompute_playlist(&conn, p).unwrap();

        assert_eq!(stored(&conn, by_id), matched("svt1.se", "id"));
        assert_eq!(stored(&conn, unknown_id), (None, None));
        assert_eq!(stored(&conn, by_name), matched("tv4.se", "name"));
        assert_eq!(stored(&conn, vod), (None, None));
        assert_eq!(
            (
                report.by_id,
                report.by_name,
                report.unmatched_with_id,
                report.changed
            ),
            (1, 1, 1, 2)
        );
    }

    #[test]
    fn a_recompute_writes_only_changed_rows_and_nothing_the_second_time() {
        let conn = setup_test_db();
        let p = create_test_playlist(&conn, "P");
        let s = add_source(&conn, None, 10, &[("svt1.se", &[]), ("tv4.se", &[])]);
        let svt1 = add_channel(&conn, p, "SVT1", Some("svt1.se"), "live");
        let tv4 = add_channel(&conn, p, "TV4", Some("tv4.se"), "live");
        add_channel(&conn, p, "Other", Some("other.se"), "live");
        log_match_writes(&conn);

        assert_eq!(recompute_playlist(&conn, p).unwrap().changed, 2);
        assert_eq!(match_writes(&conn), [svt1, tv4]);

        assert_eq!(recompute_playlist(&conn, p).unwrap().changed, 0);
        assert_eq!(match_writes(&conn), [svt1, tv4], "nothing written again");

        // TV4 leaves the guide: only its row is written.
        conn.execute(
            "UPDATE epg_channel SET programme_count = 0 WHERE source_id = ?1 AND key = 'tv4.se'",
            params![s],
        )
        .unwrap();
        assert_eq!(recompute_playlist(&conn, p).unwrap().changed, 1);
        assert_eq!(match_writes(&conn), [svt1, tv4, tv4]);
        assert_eq!(stored(&conn, tv4), (None, None));
    }

    #[test]
    fn a_failing_recompute_writes_nothing() {
        let conn = setup_test_db();
        let p = create_test_playlist(&conn, "P");
        add_source(&conn, None, 10, &[("svt1.se", &[]), ("tv4.se", &[])]);
        let svt1 = add_channel(&conn, p, "SVT1", Some("svt1.se"), "live");
        let tv4 = add_channel(&conn, p, "Fail", Some("tv4.se"), "live");
        conn.execute_batch(
            "CREATE TRIGGER fail_match BEFORE UPDATE OF epg_match_key ON channels
             WHEN NEW.name = 'Fail' BEGIN SELECT RAISE(ABORT, 'boom'); END;",
        )
        .unwrap();

        assert!(recompute_playlist(&conn, p).is_err());

        assert_eq!(stored(&conn, svt1), (None, None), "rolled back");
        assert_eq!(stored(&conn, tv4), (None, None));
        assert!(conn.is_autocommit(), "no transaction left open");
    }

    #[test]
    fn a_failing_playlist_is_skipped_and_the_others_still_count() {
        let conn = setup_test_db();
        add_source(&conn, None, 10, &[("svt1.se", &[])]);
        let channels: Vec<i64> = ["First", "Second", "Third"]
            .into_iter()
            .map(|name| {
                let p = create_test_playlist(&conn, name);
                add_channel(&conn, p, "SVT1", Some("svt1.se"), "live")
            })
            .collect();
        conn.execute_batch(&format!(
            "CREATE TRIGGER fail_match BEFORE UPDATE OF epg_match_key ON channels
             WHEN NEW.id = {} BEGIN SELECT RAISE(ABORT, 'boom'); END;",
            channels[1]
        ))
        .unwrap();

        let report = recompute_where_applies(&conn, None).unwrap();

        assert_eq!((report.changed, report.failed_playlists), (2, 1));
        assert_eq!(stored(&conn, channels[0]), matched("svt1.se", "id"));
        assert_eq!(stored(&conn, channels[1]), (None, None), "rolled back");
        assert_eq!(stored(&conn, channels[2]), matched("svt1.se", "id"));
        assert!(conn.is_autocommit(), "no transaction left open");
    }

    #[test]
    fn only_enabled_sources_that_apply_to_the_playlist_count() {
        let conn = setup_test_db();
        let mine = create_test_playlist(&conn, "Mine");
        let other = create_test_playlist(&conn, "Other");
        add_source(&conn, Some(other), 30, &[("tv4.se", &[])]);
        let off = add_source(&conn, None, 10, &[("svt1.se", &[])]);
        conn.execute(
            "UPDATE epg_source SET enabled = 0 WHERE id = ?1",
            params![off],
        )
        .unwrap();
        add_source(&conn, Some(mine), 20, &[("kanal5.se", &[])]);
        let s = add_source(&conn, None, 5, &[]);
        add_guide_channel(&conn, s, "kanal9.se", &[], 0);
        let tv4 = add_channel(&conn, mine, "TV4", Some("tv4.se"), "live");
        let svt1 = add_channel(&conn, mine, "SVT1", Some("svt1.se"), "live");
        let kanal5 = add_channel(&conn, mine, "Kanal 5", Some("kanal5.se"), "live");
        let kanal9 = add_channel(&conn, mine, "Kanal 9", Some("kanal9.se"), "live");

        recompute_playlist(&conn, mine).unwrap();

        assert_eq!(stored(&conn, tv4), (None, None), "another profile's source");
        assert_eq!(stored(&conn, svt1), (None, None), "a disabled source");
        assert_eq!(stored(&conn, kanal5), matched("kanal5.se", "id"));
        assert_eq!(
            stored(&conn, kanal9),
            (None, None),
            "a key without programmes"
        );
    }

    #[test]
    fn a_name_takes_the_key_of_the_higher_priority_source() {
        let conn = setup_test_db();
        let p = create_test_playlist(&conn, "P");
        add_source(&conn, Some(p), 30, &[("tv4.no", &["TV4"])]);
        add_source(&conn, None, 10, &[("tv4.se", &["TV4"])]);
        let tv4 = add_channel(&conn, p, "TV4", None, "live");

        recompute_playlist(&conn, p).unwrap();

        assert_eq!(stored(&conn, tv4), matched("tv4.se", "name"));
    }

    #[test]
    fn a_name_ambiguous_in_the_higher_priority_source_is_not_taken_from_a_lower_one() {
        let conn = setup_test_db();
        let p = create_test_playlist(&conn, "P");
        add_source(
            &conn,
            None,
            10,
            &[("tv4.se", &["TV4"]), ("tv4hd.se", &["TV4"])],
        );
        add_source(&conn, Some(p), 30, &[("tv4.no", &["TV4"])]);
        let tv4 = add_channel(&conn, p, "TV4", None, "live");

        let report = recompute_playlist(&conn, p).unwrap();

        assert_eq!(stored(&conn, tv4), (None, None));
        assert_eq!((report.by_name, report.ambiguous_names), (0, 1));
    }

    #[test]
    fn a_manual_match_survives_a_recompute_and_a_refresh() {
        let conn = setup_test_db();
        let p = create_test_playlist(&conn, "P");
        add_source(
            &conn,
            None,
            10,
            &[("svt1.se", &[]), ("svt1hd.se", &[]), ("tv4.se", &[])],
        );
        let channel = |name: &str, epg_id: &str| Channel {
            id: None,
            playlist_id: p,
            name: name.to_string(),
            url: format!("http://p.example/{name}"),
            logo: None,
            group_name: Some("G".to_string()),
            epg_id: Some(epg_id.to_string()),
            tvg_name: None,
            content_type: "live".to_string(),
            is_favorite: false,
            sort_order: 0,
            category_order: 0,
            created_at: None,
        };
        merge_channels(
            &conn,
            p,
            &[channel("SVT1", "svt1.se"), channel("TV4", "tv4.se")],
            false,
        )
        .unwrap();
        let id_of = |name: &str| -> i64 {
            conn.query_row("SELECT id FROM channels WHERE name = ?1", [name], |r| {
                r.get(0)
            })
            .unwrap()
        };
        let (svt1, tv4) = (id_of("SVT1"), id_of("TV4"));
        recompute_playlist(&conn, p).unwrap();
        set_manual(&conn, tv4, "gone.se");

        // The provider now sends another id for both channels.
        merge_channels(
            &conn,
            p,
            &[channel("SVT1", "SVT1HD.se"), channel("TV4", "svt1.se")],
            false,
        )
        .unwrap();
        assert_eq!(
            stored(&conn, svt1),
            matched("svt1.se", "id"),
            "a refresh leaves the match columns to the matcher"
        );
        recompute_playlist(&conn, p).unwrap();

        assert_eq!(stored(&conn, svt1), matched("svt1hd.se", "id"));
        assert_eq!(stored(&conn, tv4), matched("gone.se", "manual"));
    }

    #[test]
    fn a_recompute_leaves_every_other_column_byte_identical() {
        let conn = setup_test_db();
        let p = create_test_playlist(&conn, "P");
        add_source(&conn, None, 10, &[("svt1.se", &["SVT1"])]);
        add_channel(&conn, p, "SVT1", Some(" SVT1.se "), "live");
        let named = add_channel(&conn, p, "Ettan", None, "live");
        conn.execute(
            "UPDATE channels SET tvg_name = 'SVT1', logo_override = 'http://l/1.png',
                 is_favorite = 1 WHERE id = ?1",
            params![named],
        )
        .unwrap();
        add_channel(&conn, p, "Film", Some("svt1.se"), "vod");
        let before = other_columns(&conn);

        let report = recompute_playlist(&conn, p).unwrap();

        assert_eq!(report.changed, 2);
        assert_eq!(other_columns(&conn), before);
    }

    #[test]
    fn summaries_carry_the_match_key_where_the_raw_id_was() {
        let conn = setup_test_db();
        let p = create_test_playlist(&conn, "P");
        add_source(&conn, None, 10, &[("svt1.se", &["SVT1"])]);
        let raw = add_channel(&conn, p, "SVT1 HD", Some("SVT1.se"), "live");
        let named = add_channel(&conn, p, "SVT1", None, "live");
        let unknown = add_channel(&conn, p, "TV4", Some("tv4.se"), "live");
        recompute_playlist(&conn, p).unwrap();

        let all = get_channel_summaries(&conn, Some(p), None).unwrap();
        let by_ids = get_channel_summaries_by_ids(&conn, &[raw, named, unknown]).unwrap();

        for summary in &all {
            assert_eq!(&by_ids[&summary.id], summary);
        }
        let key = |id: i64| by_ids[&id].epg_id.clone();
        assert_eq!(key(raw).as_deref(), Some("svt1.se"));
        assert_eq!(key(named).as_deref(), Some("svt1.se"));
        assert_eq!(key(unknown), None, "the raw id stays out of the summary");
        // The full row keeps the raw id.
        let channel = crate::db::queries::get_channel_by_id(&conn, raw)
            .unwrap()
            .unwrap();
        assert_eq!(channel.epg_id.as_deref(), Some("SVT1.se"));
    }

    #[test]
    fn a_global_source_recomputes_every_playlist_and_an_own_source_one() {
        let conn = setup_test_db();
        let first = create_test_playlist(&conn, "First");
        let second = create_test_playlist(&conn, "Second");
        let a = add_channel(&conn, first, "SVT1", Some("svt1.se"), "live");
        let b = add_channel(&conn, second, "SVT1", Some("svt1.se"), "live");
        let own = add_source(&conn, Some(first), 30, &[("svt1.se", &[])]);

        assert_eq!(recompute_for_source(&conn, own).unwrap().changed, 1);
        assert_eq!(stored(&conn, a), matched("svt1.se", "id"));
        assert_eq!(stored(&conn, b), (None, None));

        let global = add_source(&conn, None, 10, &[("svt1.se", &[])]);
        assert_eq!(recompute_for_source(&conn, global).unwrap().changed, 1);
        assert_eq!(stored(&conn, b), matched("svt1.se", "id"));

        conn.execute("DELETE FROM epg_source", []).unwrap();
        assert_eq!(
            recompute_for_source(&conn, global).unwrap().changed,
            2,
            "a removed source recomputes every playlist"
        );
        assert_eq!(
            (stored(&conn, a), stored(&conn, b)),
            ((None, None), (None, None))
        );
    }

    #[test]
    fn the_upgrade_recompute_runs_once() {
        let conn = setup_test_db();
        let p = create_test_playlist(&conn, "P");
        add_source(&conn, None, 10, &[("svt1.se", &[])]);
        let svt1 = add_channel(&conn, p, "SVT1", Some("svt1.se"), "live");

        let report = recompute_once_after_upgrade(&conn).unwrap();

        assert_eq!(report.map(|r| r.changed), Some(1));
        assert_eq!(stored(&conn, svt1), matched("svt1.se", "id"));
        assert_eq!(
            get_setting(&conn, MATCHES_INITIALISED_KEY)
                .unwrap()
                .as_deref(),
            Some("1")
        );

        // Cleared behind its back: the second start does not look again.
        conn.execute(
            "UPDATE channels SET epg_match_key = NULL, epg_match_source = NULL",
            [],
        )
        .unwrap();
        assert_eq!(recompute_once_after_upgrade(&conn).unwrap(), None);
        assert_eq!(stored(&conn, svt1), (None, None));
    }

    #[test]
    fn a_failed_upgrade_recompute_retries_at_the_next_start() {
        let conn = setup_test_db();
        let p = create_test_playlist(&conn, "P");
        add_source(&conn, None, 10, &[("svt1.se", &[])]);
        let svt1 = add_channel(&conn, p, "SVT1", Some("svt1.se"), "live");
        conn.execute_batch(
            "CREATE TRIGGER fail_match BEFORE UPDATE OF epg_match_key ON channels
             BEGIN SELECT RAISE(ABORT, 'boom'); END;",
        )
        .unwrap();

        let failed = recompute_once_after_upgrade(&conn).unwrap().unwrap();
        assert_eq!((failed.failed_playlists, failed.changed), (1, 0));
        assert_eq!(get_setting(&conn, MATCHES_INITIALISED_KEY).unwrap(), None);

        conn.execute_batch("DROP TRIGGER fail_match;").unwrap();
        assert!(recompute_once_after_upgrade(&conn).unwrap().is_some());
        assert_eq!(stored(&conn, svt1), matched("svt1.se", "id"));
    }

    #[test]
    fn the_epg_keys_list_the_matched_live_channels_of_one_playlist() {
        let conn = setup_test_db();
        let p = create_test_playlist(&conn, "P");
        let other = create_test_playlist(&conn, "Other");
        add_source(&conn, None, 10, &[("svt1.se", &[]), ("film.se", &[])]);
        let svt1 = add_channel(&conn, p, "SVT1", Some("SVT1.se"), "live");
        let manual = add_channel(&conn, p, "Sjuan", None, "live");
        add_channel(&conn, p, "TV4", Some("tv4.se"), "live");
        add_channel(&conn, p, "Film", Some("film.se"), "vod");
        add_channel(&conn, other, "SVT1", Some("svt1.se"), "live");
        recompute_where_applies(&conn, None).unwrap();
        set_manual(&conn, manual, "tv7.se");

        assert_eq!(
            crate::db::queries::get_channel_epg_keys(&conn, p).unwrap(),
            [
                (svt1, "svt1.se".to_string()),
                (manual, "tv7.se".to_string())
            ]
        );
    }

    // ========== Matches set by hand ==========

    fn invalid_input(result: Result<bool, AppError>) -> String {
        match result {
            Err(AppError::InvalidInput(details)) => details,
            other => panic!("expected InvalidInput, got {other:?}"),
        }
    }

    #[test]
    fn only_an_existing_live_channel_can_be_matched_by_hand() {
        let conn = setup_test_db();
        let p = create_test_playlist(&conn, "P");
        add_source(&conn, None, 10, &[("film.se", &[])]);
        let vod = add_channel(&conn, p, "Film", Some("film.se"), "vod");
        let series = add_channel(&conn, p, "Serie", None, "series");

        for id in [vod, series] {
            invalid_input(set_manual_match(&conn, id, Some("film.se")));
            invalid_input(set_manual_match(&conn, id, None));
            assert_eq!(stored(&conn, id), (None, None));
        }
        assert!(matches!(
            set_manual_match(&conn, 999, Some("film.se")),
            Err(AppError::ChannelNotFound(999))
        ));
        assert!(conn.is_autocommit(), "no transaction left open");
    }

    #[test]
    fn a_key_without_programmes_for_the_playlist_is_refused() {
        let conn = setup_test_db();
        let p = create_test_playlist(&conn, "P");
        let other = create_test_playlist(&conn, "Other");
        add_source(&conn, Some(other), 30, &[("tv4.no", &[])]);
        let off = add_source(&conn, None, 20, &[("tv4.dk", &[])]);
        conn.execute(
            "UPDATE epg_source SET enabled = 0 WHERE id = ?1",
            params![off],
        )
        .unwrap();
        let s = add_source(&conn, None, 10, &[]);
        add_guide_channel(&conn, s, "tv4.fi", &[], 0);
        let tv4 = add_channel(&conn, p, "TV4", Some("tv4.se"), "live");

        let details = invalid_input(set_manual_match(&conn, tv4, Some("unknown.se")));
        assert_eq!(
            details,
            "The guide of this profile has no programmes for \"unknown.se\""
        );
        for key in ["tv4.no", "tv4.dk", "tv4.fi"] {
            invalid_input(set_manual_match(&conn, tv4, Some(key)));
        }
        invalid_input(set_manual_match(&conn, tv4, Some("   ")));
        assert_eq!(stored(&conn, tv4), (None, None));
        assert!(conn.is_autocommit(), "no transaction left open");
    }

    #[test]
    fn a_match_set_by_hand_is_normalised_and_written_once() {
        let conn = setup_test_db();
        let p = create_test_playlist(&conn, "P");
        add_source(&conn, Some(p), 30, &[("tv4hd.se", &["TV4 HD"])]);
        let tv4 = add_channel(&conn, p, "TV4", Some("tv4.nl"), "live");
        log_match_writes(&conn);

        assert!(set_manual_match(&conn, tv4, Some(" TV4HD.se ")).unwrap());
        assert_eq!(stored(&conn, tv4), matched("tv4hd.se", "manual"));
        assert!(!set_manual_match(&conn, tv4, Some("tv4hd.se")).unwrap());
        assert_eq!(match_writes(&conn), [tv4], "the second set wrote nothing");
    }

    #[test]
    fn a_match_set_by_hand_survives_a_recompute_a_refresh_and_its_key_leaving() {
        let conn = setup_test_db();
        let p = create_test_playlist(&conn, "P");
        let s = add_source(&conn, None, 10, &[("svt1.se", &[]), ("tv4hd.se", &[])]);
        let channel = |epg_id: &str| Channel {
            id: None,
            playlist_id: p,
            name: "TV4".to_string(),
            url: "http://p.example/tv4".to_string(),
            logo: None,
            group_name: Some("G".to_string()),
            epg_id: Some(epg_id.to_string()),
            tvg_name: None,
            content_type: "live".to_string(),
            is_favorite: false,
            sort_order: 0,
            category_order: 0,
            created_at: None,
        };
        merge_channels(&conn, p, &[channel("tv4.se")], false).unwrap();
        let tv4: i64 = conn
            .query_row("SELECT id FROM channels WHERE name = 'TV4'", [], |r| {
                r.get(0)
            })
            .unwrap();

        set_manual_match(&conn, tv4, Some("tv4hd.se")).unwrap();
        recompute_playlist(&conn, p).unwrap();
        // The provider now sends an id the guide knows.
        merge_channels(&conn, p, &[channel("svt1.se")], false).unwrap();
        let report = recompute_playlist(&conn, p).unwrap();
        assert_eq!((report.manual_kept, report.changed), (1, 0));
        assert_eq!(stored(&conn, tv4), matched("tv4hd.se", "manual"));

        conn.execute(
            "UPDATE epg_channel SET programme_count = 0 WHERE source_id = ?1 AND key = 'tv4hd.se'",
            params![s],
        )
        .unwrap();
        recompute_playlist(&conn, p).unwrap();
        assert_eq!(stored(&conn, tv4), matched("tv4hd.se", "manual"));
        let details = match_details(&conn, p).unwrap();
        assert_eq!(
            details.manual,
            [ManualMatch {
                channel_id: tv4,
                channel_name: "TV4".to_string(),
                key: "tv4hd.se".to_string(),
                guide_name: None,
                has_programmes: false,
            }]
        );
    }

    #[test]
    fn clearing_a_match_set_by_hand_matches_the_channel_automatically_again() {
        let conn = setup_test_db();
        let p = create_test_playlist(&conn, "P");
        add_source(
            &conn,
            None,
            10,
            &[("tv4.se", &[]), ("tv4hd.se", &[]), ("sjuan.se", &["Sjuan"])],
        );
        let by_id = add_channel(&conn, p, "TV4", Some("tv4.se"), "live");
        let by_name = add_channel(&conn, p, "Sjuan", None, "live");
        let unknown = add_channel(&conn, p, "Kanal 9", Some("kanal9.se"), "live");
        recompute_playlist(&conn, p).unwrap();
        for id in [by_id, by_name, unknown] {
            set_manual_match(&conn, id, Some("tv4hd.se")).unwrap();
        }

        for id in [by_id, by_name, unknown] {
            assert!(set_manual_match(&conn, id, None).unwrap());
        }

        assert_eq!(stored(&conn, by_id), matched("tv4.se", "id"));
        assert_eq!(stored(&conn, by_name), matched("sjuan.se", "name"));
        assert_eq!(stored(&conn, unknown), (None, None));
        // Clearing an automatic match changes nothing.
        assert!(!set_manual_match(&conn, by_id, None).unwrap());
        assert_eq!(stored(&conn, by_id), matched("tv4.se", "id"));
    }

    #[test]
    fn match_details_list_the_hand_set_and_the_name_matches_of_one_playlist() {
        let conn = setup_test_db();
        let p = create_test_playlist(&conn, "P");
        let other = create_test_playlist(&conn, "Other");
        add_source(&conn, Some(p), 30, &[("tv4hd.se", &["TV4 HD", "TV4"])]);
        add_source(
            &conn,
            None,
            10,
            &[("svt1.se", &["SVT1"]), ("sjuan.se", &["Sjuan"])],
        );
        add_channel(&conn, p, "SVT1", Some("svt1.se"), "live");
        let sjuan = add_channel(&conn, p, "Sjuan", None, "live");
        let tv4 = add_channel(&conn, p, "tv4", Some("tv4.nl"), "live");
        let ettan = add_channel(&conn, p, "Ettan", Some("x.se"), "live");
        let elsewhere = add_channel(&conn, other, "Sjuan", None, "live");
        recompute_where_applies(&conn, None).unwrap();
        set_manual_match(&conn, tv4, Some("tv4hd.se")).unwrap();
        set_manual_match(&conn, ettan, Some("svt1.se")).unwrap();

        let details = match_details(&conn, p).unwrap();

        let manual = |id: i64, channel: &str, key: &str, guide: &str| ManualMatch {
            channel_id: id,
            channel_name: channel.to_string(),
            key: key.to_string(),
            guide_name: Some(guide.to_string()),
            has_programmes: true,
        };
        assert_eq!(
            details,
            MatchDetails {
                manual: vec![
                    manual(ettan, "Ettan", "svt1.se", "SVT1"),
                    manual(tv4, "tv4", "tv4hd.se", "TV4 HD"),
                ],
                by_name: vec![sjuan],
            }
        );
        assert_eq!(match_details(&conn, other).unwrap().by_name, [elsewhere]);
        assert_eq!(
            serde_json::to_value(&details.manual[0]).unwrap(),
            serde_json::json!({
                "channel_id": ettan, "channel_name": "Ettan", "key": "svt1.se",
                "guide_name": "SVT1", "has_programmes": true
            })
        );
    }

    /// Release benches of the recompute, written for the orchestrator to run
    /// (see the PR B brief); they print counts and timings only, and the
    /// peak RSS the kernel recorded for the test process.
    ///
    /// `perf_recompute_db` runs on a copy of the database `EPG_BENCH_DB`
    /// names (itself a read-only backup of the app's database), every
    /// playlist. `perf_make_matching_db` writes a synthetic database with one
    /// 200,000-channel playlist and a 5,000-channel guide to
    /// `EPG_PERF_DIR/matching-200k.db`; `perf_recompute_200k` recomputes a
    /// copy of it.
    mod perf {
        use super::*;
        use crate::epg::test_support::{pool_in, TestDir};
        use std::path::Path;
        use std::time::Instant;

        const SYNTHETIC: &str = "matching-200k.db";
        const CHANNELS: i64 = 200_000;
        const GUIDE_KEYS: i64 = 5_000;

        fn peak_rss() -> String {
            std::fs::read_to_string("/proc/self/status")
                .ok()
                .and_then(|s| {
                    s.lines()
                        .find(|l| l.starts_with("VmHWM:"))
                        .map(|l| l.trim_start_matches("VmHWM:").trim().to_string())
                })
                .unwrap_or_else(|| "unknown".to_string())
        }

        fn line(label: &str, report: &MatchReport, wall: std::time::Duration) -> String {
            format!(
                "{label}: wall {wall:.3?}, rows updated {}, live {}, by id {}, by tvg-name {}, \
                 by name {}, manual {}, unknown id {}, ambiguous names {}",
                report.changed,
                report.considered,
                report.by_id,
                report.by_tvg_name,
                report.by_name,
                report.manual_kept,
                report.unmatched_with_id,
                report.ambiguous_names,
            )
        }

        /// Copy `db` into a scratch directory, open it as the app does and
        /// recompute every playlist twice: the first run writes the matches,
        /// the second finds nothing to change (the steady state).
        fn bench(db: &Path, name: &str) {
            let dir = TestDir::new("matching-perf");
            std::fs::copy(db, dir.0.join("app.db")).unwrap();
            let pool = pool_in(&dir, 1);
            let conn = pool.get().unwrap();
            let count = |sql: &str| -> i64 { conn.query_row(sql, [], |r| r.get(0)).unwrap() };
            eprintln!(
                "PERF {name}: {} playlists, {} channels ({} live), {} guide channels \
                 with programmes, {} display names",
                count("SELECT COUNT(*) FROM playlists"),
                count("SELECT COUNT(*) FROM channels"),
                count("SELECT COUNT(*) FROM channels WHERE content_type = 'live'"),
                count("SELECT COUNT(*) FROM epg_channel WHERE programme_count > 0"),
                count("SELECT COUNT(*) FROM epg_channel_name"),
            );
            for label in ["first", "again"] {
                let started = Instant::now();
                let report = recompute_where_applies(&conn, None).unwrap();
                eprintln!("PERF {name} {}", line(label, &report, started.elapsed()));
            }
            eprintln!("PERF {name}: peak RSS {}", peak_rss());
        }

        #[test]
        #[ignore]
        fn perf_recompute_db() {
            let Some(path) = std::env::var_os("EPG_BENCH_DB") else {
                eprintln!("EPG_BENCH_DB is not set; skipped");
                return;
            };
            bench(Path::new(&path), "db copy");
        }

        /// One global source with `GUIDE_KEYS` channels `kanal<k>.se`, named
        /// `Kanal <k>` and `Kanal <k> HD`, plus 50 names given to two
        /// channels each. One playlist of `CHANNELS` rows: 80 % live, 10 %
        /// vod, 10 % series; three in four carry an id `Kanal<n>.se` over
        /// 20,000 values (a quarter of them in the guide), the rest no id,
        /// with a `tvg_name` on every other one.
        fn write_synthetic(path: &Path) {
            let conn = Connection::open(path).unwrap();
            crate::db::schema::init_schema(&conn).unwrap();
            let tx = conn.unchecked_transaction().unwrap();
            tx.execute("INSERT INTO playlists (id, name) VALUES (1, 'Bench')", [])
                .unwrap();
            tx.execute(
                "INSERT INTO epg_source (id, origin, url, priority)
                 VALUES (1, 'manual', 'http://bench.example/epg.xml', 10)",
                [],
            )
            .unwrap();
            {
                let mut channel = tx
                    .prepare(
                        "INSERT INTO epg_channel (id, source_id, key, first_start, last_stop,
                             programme_count) VALUES (?1, 1, ?2, 0, 1, 20)",
                    )
                    .unwrap();
                let mut name = tx
                    .prepare(
                        "INSERT INTO epg_channel_name (channel_id, position, name, name_key)
                         VALUES (?1, ?2, ?3, ?4)",
                    )
                    .unwrap();
                for k in 0..GUIDE_KEYS {
                    channel
                        .execute(params![k + 1, format!("kanal{k}.se")])
                        .unwrap();
                    let mut names = vec![format!("Kanal {k}"), format!("Kanal {k} HD")];
                    if k < 100 {
                        names.push(format!("Delad {}", k / 2));
                    }
                    for (position, display) in names.iter().enumerate() {
                        let key = crate::epg_domain::key::name_key(display).unwrap();
                        name.execute(params![k + 1, position as i64, display, key])
                            .unwrap();
                    }
                }
                let mut row = tx
                    .prepare(
                        "INSERT INTO channels (playlist_id, name, url, epg_id, tvg_name,
                             content_type, sort_order) VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6)",
                    )
                    .unwrap();
                for i in 0..CHANNELS {
                    let n = i % 20_000;
                    let kind = match i % 10 {
                        8 => "vod",
                        9 => "series",
                        _ => "live",
                    };
                    let epg_id = (i % 4 != 0).then(|| format!("Kanal{n}.se"));
                    let tvg_name = (i % 8 == 0).then(|| format!("Kanal {} HD", n % 7_000));
                    row.execute(params![
                        format!("Kanal {n}"),
                        format!("http://bench.example/live/u/p/{i}.ts"),
                        epg_id,
                        tvg_name,
                        kind,
                        i
                    ])
                    .unwrap();
                }
            }
            tx.commit().unwrap();
        }

        #[test]
        #[ignore]
        fn perf_make_matching_db() {
            let Some(dir) = std::env::var_os("EPG_PERF_DIR") else {
                eprintln!("EPG_PERF_DIR is not set; skipped");
                return;
            };
            std::fs::create_dir_all(&dir).unwrap();
            let path = Path::new(&dir).join(SYNTHETIC);
            if !path.exists() {
                write_synthetic(&path);
            }
            eprintln!(
                "{} {} bytes",
                path.display(),
                std::fs::metadata(&path).unwrap().len()
            );
        }

        #[test]
        #[ignore]
        fn perf_recompute_200k() {
            let Some(dir) = std::env::var_os("EPG_PERF_DIR") else {
                eprintln!("EPG_PERF_DIR is not set; skipped");
                return;
            };
            let path = Path::new(&dir).join(SYNTHETIC);
            if !path.exists() {
                eprintln!(
                    "{} is missing: run epg::matching::tests::perf::perf_make_matching_db",
                    path.display()
                );
                return;
            }
            bench(&path, "synthetic 200k");
        }
    }
}
