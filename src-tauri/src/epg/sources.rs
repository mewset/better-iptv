//! Guide sources: the `epg_source` rows, the one-time seed from the old
//! single-URL setting, and the cache files each source keeps on disk.
//!
//! Cache layout in `<app_data>/epg/`: `<id>.feed.gz` is the last feed stored
//! for source `<id>`, `<id>.download` a download in progress, `ingest.db` the
//! staging database of the ingest. Files are named by source id, which
//! `AUTOINCREMENT` never reuses, so a new source never finds another source's
//! feed under its own name.

use crate::db::mutations::set_setting;
use crate::db::queries::get_setting;
use crate::epg_domain::policy::{Interpret, TimePolicy};
use crate::epg_domain::source::{LastResult, SourceOrigin, SourceSchedule};
use crate::epg_domain::{normalize_epg_url, validate_epg_url};
use crate::error::AppError;
use rusqlite::{params, Connection, OptionalExtension, Row, Transaction, TransactionBehavior};
use std::collections::HashSet;
use std::io;
use std::path::{Path, PathBuf};

/// Settings key that records the one-time seed of `epg_source`.
pub const EPG_SOURCES_SEEDED_KEY: &str = "epg_sources_seeded";

/// Directory under the app data dir that holds the cache files.
pub const CACHE_DIR_NAME: &str = "epg";

/// Staging database of the ingest, shared by every source.
pub const STAGING_FILE: &str = "ingest.db";

const FEED_SUFFIX: &str = ".feed.gz";
const DOWNLOAD_SUFFIX: &str = ".download";

/// The single-URL form the Xtream import wrote into `settings.epg_url` before
/// per-source guides: server URL without trailing slash, credentials
/// unencoded. The seed uses it to tell an untouched provider URL from one the
/// user typed, and `playlist::xtream::get_xtream_epg_url` delegates to it
/// until the old EPG commands are replaced. Fetching a source builds its URL
/// with `epg_domain::source::xtream_epg_url` instead.
pub fn legacy_xtream_epg_url(server_url: &str, username: &str, password: &str) -> String {
    format!(
        "{}/xmltv.php?username={}&password={}",
        server_url.trim_end_matches('/'),
        username,
        password
    )
}

/// Bring `epg_source` in line with the playlists at startup.
///
/// The first time, `seed_epg_sources` migrates the old settings. On every
/// later start, `reconcile_xtream_sources` gives an Xtream playlist without a
/// source one, which covers playlists imported by an older version run on
/// this database in between. Both are bounded by the number of playlists.
pub fn sync_epg_sources(conn: &Connection) -> rusqlite::Result<()> {
    if get_setting(conn, EPG_SOURCES_SEEDED_KEY)?.is_none() {
        return seed_epg_sources(conn);
    }
    let added = reconcile_xtream_sources(conn)?;
    if added > 0 {
        log::info!("EPG sources: added {} provider source(s)", added);
    }
    Ok(())
}

/// Seed `epg_source` once from the old settings.
///
/// Every Xtream playlist gets an `xtream` source. A non-empty `epg_url` that
/// is not the legacy provider URL of any Xtream playlist was typed by the
/// user, and the old version fetched only that URL: it becomes a global
/// `manual` source and every `xtream` source starts disabled. An empty
/// `epg_url` meant the old version fetched nothing; here it leaves the
/// `xtream` sources enabled, so each Xtream profile gets its provider's
/// guide. A typed URL that is not http(s) never fetched anything either: it
/// adds no `manual` source, and the `xtream` sources are still disabled. The
/// old settings rows are read, never changed.
///
/// One transaction, guard key included: a failure leaves the database as it
/// was and the seed retries on the next start.
pub fn seed_epg_sources(conn: &Connection) -> rusqlite::Result<()> {
    if get_setting(conn, EPG_SOURCES_SEEDED_KEY)?.is_some() {
        return Ok(());
    }

    let tx = conn.unchecked_transaction()?;

    let added = reconcile_xtream_sources(&tx)?;

    let playlists: Vec<(Option<String>, String, Option<String>)> = tx
        .prepare(
            "SELECT url, xtream_username, xtream_password FROM playlists
             WHERE xtream_username IS NOT NULL",
        )?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
        .collect::<rusqlite::Result<_>>()?;

    let custom_url = get_setting(&tx, "epg_url")?
        .map(|url| normalize_epg_url(&url))
        .filter(|url| !url.is_empty())
        .filter(|url| {
            !playlists.iter().any(|(server, username, password)| {
                server.as_deref().is_some_and(|server| {
                    *url == legacy_xtream_epg_url(
                        server,
                        username,
                        password.as_deref().unwrap_or_default(),
                    )
                })
            })
        });

    let mut manual_added = false;
    if let Some(url) = &custom_url {
        if validate_epg_url(url).is_ok() {
            insert_source(&tx, None, SourceOrigin::Manual, Some(url))?;
            manual_added = true;
        } else {
            log::warn!("EPG source seed: the stored EPG URL is not an http(s) URL, not migrated");
        }
        tx.execute(
            "UPDATE epg_source SET enabled = 0 WHERE origin = 'xtream'",
            [],
        )?;
    }

    set_setting(&tx, EPG_SOURCES_SEEDED_KEY, "1")?;
    tx.commit()?;
    log::info!(
        "EPG sources seeded: {} provider source(s){}{}",
        added,
        if custom_url.is_some() {
            " (disabled: a custom URL was set)"
        } else {
            ""
        },
        if manual_added {
            ", plus the custom URL"
        } else {
            ""
        }
    );
    Ok(())
}

/// Give every Xtream playlist without an `xtream` source one; returns how
/// many were added. Existing sources are left as they are, a disabled one
/// stays disabled. A new source starts disabled when an enabled global
/// `manual` source exists, as the seed would have made it.
pub fn reconcile_xtream_sources(conn: &Connection) -> rusqlite::Result<usize> {
    let manual_enabled: bool = conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM epg_source
                        WHERE origin = 'manual' AND playlist_id IS NULL AND enabled = 1)",
        [],
        |r| r.get(0),
    )?;
    let origin = SourceOrigin::Xtream;
    conn.execute(
        "INSERT OR IGNORE INTO epg_source (playlist_id, origin, url, enabled, priority)
         SELECT id, ?1, NULL, ?2, ?3 FROM playlists WHERE xtream_username IS NOT NULL",
        params![origin.as_str(), !manual_enabled, origin.default_priority()],
    )
}

fn insert_source(
    conn: &Connection,
    playlist_id: Option<i64>,
    origin: SourceOrigin,
    url: Option<&str>,
) -> rusqlite::Result<i64> {
    conn.execute(
        "INSERT INTO epg_source (playlist_id, origin, url, priority) VALUES (?1, ?2, ?3, ?4)",
        params![playlist_id, origin.as_str(), url, origin.default_priority()],
    )?;
    Ok(conn.last_insert_rowid())
}

/// The `xtream` source of a playlist, created if it has none. Idempotent
/// through the identity index, so a re-import never adds a second one.
pub fn ensure_xtream_source(conn: &Connection, playlist_id: i64) -> rusqlite::Result<i64> {
    let origin = SourceOrigin::Xtream;
    conn.execute(
        "INSERT OR IGNORE INTO epg_source (playlist_id, origin, url, priority)
         VALUES (?1, ?2, NULL, ?3)",
        params![playlist_id, origin.as_str(), origin.default_priority()],
    )?;
    conn.query_row(
        "SELECT id FROM epg_source WHERE playlist_id = ?1 AND origin = ?2",
        params![playlist_id, origin.as_str()],
        |r| r.get(0),
    )
}

/// Whether a database error is the identity index rejecting a second source
/// with the same playlist, origin and URL.
fn is_duplicate(e: &rusqlite::Error) -> bool {
    matches!(
        e,
        rusqlite::Error::SqliteFailure(err, _)
            if err.extended_code == rusqlite::ffi::SQLITE_CONSTRAINT_UNIQUE
    )
}

fn duplicate_url() -> AppError {
    AppError::InvalidInput("This guide source has already been added".to_string())
}

fn not_found(id: i64) -> AppError {
    AppError::InvalidInput(format!("Guide source {} not found", id))
}

/// Add a URL the user typed as a global `manual` source; returns its id.
pub fn add_manual_source(conn: &Connection, url: &str) -> Result<i64, AppError> {
    let url = normalize_epg_url(url);
    validate_epg_url(&url)?;
    insert_source(conn, None, SourceOrigin::Manual, Some(&url)).map_err(|e| {
        if is_duplicate(&e) {
            duplicate_url()
        } else {
            e.into()
        }
    })
}

/// Fields `update_source` may change; `None` leaves a field as it is.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SourcePatch {
    pub enabled: Option<bool>,
    pub priority: Option<i32>,
    /// Manual sources only.
    pub url: Option<String>,
}

/// What `update_source` changed, for the caller's events and due-check.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SourceUpdate {
    pub enabled_changed: bool,
    pub url_changed: bool,
}

/// Apply a patch to a source.
///
/// A new URL is a new feed: the source's channels and programmes, its cache
/// files and its status (attempt, success, result, counters, applied policy)
/// go, so the next due-check fetches it at once and nothing from the old URL
/// can be shown or re-ingested under the new one. The cache files are
/// deleted inside the transaction, before the commit, so a failed delete
/// leaves the old URL in place rather than a new URL beside the old feed.
pub fn update_source(
    conn: &Connection,
    cache_dir: &Path,
    id: i64,
    patch: &SourcePatch,
) -> Result<SourceUpdate, AppError> {
    let tx = write_transaction(conn)?;
    let (origin, url, enabled): (String, Option<String>, bool) = tx
        .query_row(
            "SELECT origin, url, enabled FROM epg_source WHERE id = ?1",
            params![id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?
        .ok_or_else(|| not_found(id))?;

    let new_url = match &patch.url {
        None => None,
        Some(_) if origin != SourceOrigin::Manual.as_str() => {
            return Err(AppError::InvalidInput(
                "Only a guide source added by URL can change its URL".to_string(),
            ));
        }
        Some(new) => {
            let new = normalize_epg_url(new);
            validate_epg_url(&new)?;
            (url.as_deref() != Some(new.as_str())).then_some(new)
        }
    };

    if let Some(enabled) = patch.enabled {
        tx.execute(
            "UPDATE epg_source SET enabled = ?1 WHERE id = ?2",
            params![enabled, id],
        )?;
    }
    if let Some(priority) = patch.priority {
        tx.execute(
            "UPDATE epg_source SET priority = ?1 WHERE id = ?2",
            params![priority, id],
        )?;
    }
    if let Some(new) = &new_url {
        tx.execute(
            "UPDATE epg_source SET url = ?1, applied_interpret = NULL,
                 applied_shift_minutes = NULL, last_attempt_at = NULL, last_success_at = NULL,
                 last_result = NULL, last_error = NULL, programme_count = 0,
                 unknown_zone_count = 0, unknown_zone_sample = NULL, decode_replacements = 0
             WHERE id = ?2",
            params![new, id],
        )
        .map_err(|e| {
            if is_duplicate(&e) {
                duplicate_url()
            } else {
                AppError::from(e)
            }
        })?;
        delete_guide_rows(&tx, id)?;
        remove_cache_files(cache_dir, id)?;
    }
    tx.commit()?;

    Ok(SourceUpdate {
        enabled_changed: patch.enabled.is_some_and(|e| e != enabled),
        url_changed: new_url.is_some(),
    })
}

/// Set the time policy a source's feed is read with. The stored programmes
/// keep the policy they were read under until the next ingest re-reads the
/// feed; `SourceRecord::policy_pending` shows the difference meanwhile.
pub fn set_time_policy(conn: &Connection, id: i64, policy: &TimePolicy) -> Result<(), AppError> {
    policy.validate()?;
    let changed = conn.execute(
        "UPDATE epg_source SET time_interpret = ?2, time_shift_minutes = ?3 WHERE id = ?1",
        params![id, policy.interpret.as_str(), policy.shift_minutes],
    )?;
    if changed == 0 {
        return Err(not_found(id));
    }
    Ok(())
}

/// Remove a `manual` source with its rows and cache files. Provider sources
/// go with their playlist instead.
///
/// The cache files are deleted after the commit. A file that cannot be
/// deleted is logged and left to the sweep, which removes files of sources
/// that no longer exist.
pub fn remove_source(conn: &Connection, cache_dir: &Path, id: i64) -> Result<(), AppError> {
    let tx = write_transaction(conn)?;
    let origin: String = tx
        .query_row(
            "SELECT origin FROM epg_source WHERE id = ?1",
            params![id],
            |r| r.get(0),
        )
        .optional()?
        .ok_or_else(|| not_found(id))?;
    if origin != SourceOrigin::Manual.as_str() {
        return Err(AppError::InvalidInput(
            "Only a guide source added by URL can be removed".to_string(),
        ));
    }
    delete_guide_rows(&tx, id)?;
    tx.execute("DELETE FROM epg_source WHERE id = ?1", params![id])?;
    tx.commit()?;
    if let Err(e) = remove_cache_files(cache_dir, id) {
        log::warn!(
            "EPG cache: files of removed source {} not deleted: {}",
            id,
            e
        );
    }
    Ok(())
}

/// A transaction that takes the write lock at `BEGIN`. These functions read
/// a row and then write based on it; a deferred transaction in WAL mode would
/// fail with `SQLITE_BUSY_SNAPSHOT` at the first write if another connection
/// wrote in between, instead of waiting on the busy timeout.
fn write_transaction(conn: &Connection) -> rusqlite::Result<Transaction<'_>> {
    Transaction::new_unchecked(conn, TransactionBehavior::Immediate)
}

/// Delete a source's programmes, names and channels. Spelled out rather than
/// left to the cascade, so it holds on a connection without `foreign_keys`.
fn delete_guide_rows(conn: &Connection, source_id: i64) -> rusqlite::Result<()> {
    conn.execute(
        "DELETE FROM epg_programme
         WHERE channel_id IN (SELECT id FROM epg_channel WHERE source_id = ?1)",
        params![source_id],
    )?;
    conn.execute(
        "DELETE FROM epg_channel_name
         WHERE channel_id IN (SELECT id FROM epg_channel WHERE source_id = ?1)",
        params![source_id],
    )?;
    conn.execute(
        "DELETE FROM epg_channel WHERE source_id = ?1",
        params![source_id],
    )?;
    Ok(())
}

/// One `epg_source` row with its status columns.
#[derive(Clone, Debug, PartialEq)]
pub struct SourceRecord {
    pub id: i64,
    pub origin: SourceOrigin,
    pub playlist_id: Option<i64>,
    /// Name of the playlist a provider source belongs to.
    pub playlist_name: Option<String>,
    /// The stored URL; `None` for `xtream`. May hold credentials: mask
    /// before it leaves the backend.
    pub url: Option<String>,
    pub enabled: bool,
    pub priority: i32,
    /// The policy the user configured.
    pub policy: TimePolicy,
    /// The policy the stored programmes were produced under; `None` before
    /// the first stored ingest, after a URL change, and while (or after) a
    /// whole-source replace that takes several transactions is half done,
    /// when the source holds rows of two policies.
    pub applied_policy: Option<TimePolicy>,
    pub last_attempt_at: Option<i64>,
    pub last_success_at: Option<i64>,
    pub last_result: LastResult,
    pub last_error: Option<String>,
    pub programme_count: u32,
    pub channel_count: u32,
    pub unknown_zone_count: u32,
    pub unknown_zone_sample: Option<String>,
    pub decode_replacements: u64,
}

impl SourceRecord {
    /// The columns the due predicates read.
    pub fn schedule(&self) -> SourceSchedule {
        SourceSchedule {
            enabled: self.enabled,
            playlist_id: self.playlist_id,
            last_attempt_at: self.last_attempt_at,
            last_success_at: self.last_success_at,
        }
    }

    /// The stored programmes were not all produced under the configured
    /// policy; the next ingest applies it to every row. Rows under an
    /// unknown policy (a whole-source replace that stopped half way) count
    /// as pending: they may be under the old one. No rows, nothing pending.
    pub fn policy_pending(&self) -> bool {
        self.applied_policy
            .map_or(self.programme_count > 0, |applied| applied != self.policy)
    }
}

const SOURCE_SELECT: &str = "SELECT s.id, s.origin, s.playlist_id, p.name, s.url, s.enabled,
        s.priority, s.time_interpret, s.time_shift_minutes, s.applied_interpret,
        s.applied_shift_minutes, s.last_attempt_at, s.last_success_at, s.last_result,
        s.last_error, s.programme_count,
        (SELECT COUNT(*) FROM epg_channel c WHERE c.source_id = s.id),
        s.unknown_zone_count, s.unknown_zone_sample, s.decode_replacements
    FROM epg_source s LEFT JOIN playlists p ON p.id = s.playlist_id";

fn count(row: &Row, idx: usize) -> rusqlite::Result<u32> {
    let value: i64 = row.get(idx)?;
    Ok(u32::try_from(value.max(0)).unwrap_or(u32::MAX))
}

fn map_source(row: &Row) -> rusqlite::Result<SourceRecord> {
    let origin: String = row.get(1)?;
    let origin = SourceOrigin::from_db(&origin).ok_or_else(|| {
        rusqlite::Error::FromSqlConversionFailure(
            1,
            rusqlite::types::Type::Text,
            format!("unknown guide source origin {:?}", origin).into(),
        )
    })?;
    // A value this version does not know (written by a newer one) reads as
    // the default rather than failing the whole list.
    let interpret = |value: Option<String>| {
        value
            .as_deref()
            .and_then(Interpret::from_db)
            .unwrap_or(Interpret::AsWritten)
    };
    let policy = TimePolicy {
        interpret: interpret(row.get(7)?),
        shift_minutes: row.get(8)?,
    };
    let applied_interpret: Option<String> = row.get(9)?;
    let applied_shift: Option<i32> = row.get(10)?;
    let applied_policy = match (applied_interpret, applied_shift) {
        (Some(i), Some(shift_minutes)) => Some(TimePolicy {
            interpret: interpret(Some(i)),
            shift_minutes,
        }),
        _ => None,
    };
    let last_result: Option<String> = row.get(13)?;
    let decode_replacements: i64 = row.get(19)?;
    Ok(SourceRecord {
        id: row.get(0)?,
        origin,
        playlist_id: row.get(2)?,
        playlist_name: row.get(3)?,
        url: row.get(4)?,
        enabled: row.get(5)?,
        priority: row.get(6)?,
        policy,
        applied_policy,
        last_attempt_at: row.get(11)?,
        last_success_at: row.get(12)?,
        last_result: LastResult::from_db(last_result.as_deref()),
        last_error: row.get(14)?,
        programme_count: count(row, 15)?,
        channel_count: count(row, 16)?,
        unknown_zone_count: count(row, 17)?,
        unknown_zone_sample: row.get(18)?,
        decode_replacements: u64::try_from(decode_replacements).unwrap_or(0),
    })
}

/// Every source, in precedence order: lowest priority first, ties to the
/// older source.
pub fn list_sources(conn: &Connection) -> rusqlite::Result<Vec<SourceRecord>> {
    conn.prepare(&format!("{SOURCE_SELECT} ORDER BY s.priority, s.id"))?
        .query_map([], map_source)?
        .collect()
}

/// One source by id.
pub fn get_source(conn: &Connection, id: i64) -> rusqlite::Result<Option<SourceRecord>> {
    conn.query_row(
        &format!("{SOURCE_SELECT} WHERE s.id = ?1"),
        params![id],
        map_source,
    )
    .optional()
}

// ========== Cache files ==========

/// `<app_data>/epg/`.
pub fn cache_dir(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join(CACHE_DIR_NAME)
}

/// The last stored feed of a source.
pub fn feed_path(cache_dir: &Path, source_id: i64) -> PathBuf {
    cache_dir.join(format!("{source_id}{FEED_SUFFIX}"))
}

/// A source's download in progress, renamed to `feed_path` once stored.
pub fn download_path(cache_dir: &Path, source_id: i64) -> PathBuf {
    cache_dir.join(format!("{source_id}{DOWNLOAD_SUFFIX}"))
}

/// The ingest's staging database.
pub fn staging_path(cache_dir: &Path) -> PathBuf {
    cache_dir.join(STAGING_FILE)
}

/// Whether a source has a stored feed to re-ingest from.
pub fn has_cached_feed(cache_dir: &Path, source_id: i64) -> bool {
    feed_path(cache_dir, source_id).is_file()
}

/// Delete a file; `Ok(false)` when it was not there.
pub(crate) fn remove_if_present(path: &Path) -> io::Result<bool> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(true),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e),
    }
}

/// Delete a source's feed and download files; absent files are fine.
pub fn remove_cache_files(cache_dir: &Path, source_id: i64) -> io::Result<()> {
    remove_if_present(&feed_path(cache_dir, source_id))?;
    remove_if_present(&download_path(cache_dir, source_id))?;
    Ok(())
}

/// The source id a cache file belongs to, if the name is `<id>.feed.gz` or
/// `<id>.download`.
fn cache_file_source(name: &str) -> Option<i64> {
    name.strip_suffix(FEED_SUFFIX)
        .or_else(|| name.strip_suffix(DOWNLOAD_SUFFIX))
        .filter(|id| !id.is_empty() && id.bytes().all(|b| b.is_ascii_digit()))
        .and_then(|id| id.parse().ok())
}

/// The staging database and the journal files SQLite may leave beside it.
fn is_staging_file(name: &str) -> bool {
    name.strip_prefix(STAGING_FILE)
        .is_some_and(|rest| matches!(rest, "" | "-journal" | "-wal" | "-shm"))
}

/// Delete cache files whose source no longer exists. The cascade from a
/// deleted playlist removes its `epg_source` rows but cannot reach the files.
///
/// `include_staging` also deletes the staging database; only the boot sweep
/// passes it, when no ingest can have it open. Files with other names are
/// left alone. A file that cannot be deleted is logged and skipped. Returns
/// how many files were deleted.
pub fn sweep_cache_dir(
    conn: &Connection,
    cache_dir: &Path,
    include_staging: bool,
) -> Result<usize, AppError> {
    // List the directory before reading the ids: a source is inserted before
    // its first file is written, so every listed file whose id is missing
    // from the later read belongs to a deleted source, even when a new
    // source is added in between.
    let entries = match std::fs::read_dir(cache_dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(0),
        Err(e) => return Err(e.into()),
    };
    let names: Vec<String> = entries
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.file_type().is_ok_and(|t| t.is_file()))
        .filter_map(|entry| entry.file_name().into_string().ok())
        .collect();

    let live: HashSet<i64> = conn
        .prepare("SELECT id FROM epg_source")?
        .query_map([], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;

    let mut deleted = 0;
    for name in names {
        let orphan = match cache_file_source(&name) {
            Some(id) => !live.contains(&id),
            None => include_staging && is_staging_file(&name),
        };
        if !orphan {
            continue;
        }
        match remove_if_present(&cache_dir.join(&name)) {
            Ok(true) => deleted += 1,
            Ok(false) => {}
            Err(e) => log::warn!("EPG cache: could not delete {}: {}", name, e),
        }
    }
    if deleted > 0 {
        log::info!("EPG cache: deleted {} file(s) of removed sources", deleted);
    }
    Ok(deleted)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::schema::init_schema;
    use std::sync::atomic::{AtomicU32, Ordering};

    /// A fresh directory under the system temp dir, deleted on drop.
    struct TestDir(PathBuf);

    impl TestDir {
        fn new() -> Self {
            static NEXT: AtomicU32 = AtomicU32::new(0);
            let dir = std::env::temp_dir().join(format!(
                "better-iptv-epg-sources-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            TestDir(dir)
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
        init_schema(&conn).unwrap();
        conn
    }

    fn add_xtream_playlist(conn: &Connection, id: i64) {
        conn.execute(
            "INSERT INTO playlists (id, name, url, xtream_username, xtream_password)
             VALUES (?1, 'Provider', 'http://host:8080', 'user', 'pass')",
            params![id],
        )
        .unwrap();
    }

    /// One channel with a name and two programmes for `source_id`.
    fn add_guide_rows(conn: &Connection, source_id: i64, key: &str) {
        conn.execute(
            "INSERT INTO epg_channel (source_id, key, first_start, last_stop, programme_count)
             VALUES (?1, ?2, 100, 300, 2)",
            params![source_id, key],
        )
        .unwrap();
        let channel = conn.last_insert_rowid();
        conn.execute(
            "INSERT INTO epg_channel_name (channel_id, position, name, name_key)
             VALUES (?1, 0, 'SVT1', 'svt1')",
            params![channel],
        )
        .unwrap();
        for (start, stop) in [(100, 200), (200, 300)] {
            conn.execute(
                "INSERT INTO epg_programme (channel_id, start, stop, title) VALUES (?1, ?2, ?3, 'T')",
                params![channel, start, stop],
            )
            .unwrap();
        }
    }

    fn rows(conn: &Connection, table: &str) -> i64 {
        conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
            .unwrap()
    }

    fn touch(path: &Path) {
        std::fs::write(path, b"x").unwrap();
    }

    #[test]
    fn the_legacy_url_is_the_string_the_old_import_wrote() {
        assert_eq!(
            legacy_xtream_epg_url("http://host:8080/", "me@mail.se", "a&b"),
            "http://host:8080/xmltv.php?username=me@mail.se&password=a&b"
        );
    }

    #[test]
    fn a_manual_source_is_global_with_manual_priority() {
        let conn = db();
        let id = add_manual_source(&conn, "  https://epg.example/guide.xml.gz ").unwrap();
        let source = get_source(&conn, id).unwrap().unwrap();
        assert_eq!(source.origin, SourceOrigin::Manual);
        assert_eq!(source.playlist_id, None);
        assert_eq!(
            source.url.as_deref(),
            Some("https://epg.example/guide.xml.gz")
        );
        assert_eq!(source.priority, 10);
        assert!(source.enabled);
        assert_eq!(source.policy, TimePolicy::default());
        assert_eq!(source.applied_policy, None);
        assert_eq!(source.last_result, LastResult::Never);
        assert!(!source.policy_pending());
    }

    #[test]
    fn a_duplicate_manual_url_is_invalid_input() {
        let conn = db();
        add_manual_source(&conn, "https://epg.example/a.xml").unwrap();
        let err = add_manual_source(&conn, "https://epg.example/a.xml ").unwrap_err();
        assert!(matches!(err, AppError::InvalidInput(_)), "{err:?}");
        assert_eq!(rows(&conn, "epg_source"), 1);
    }

    #[test]
    fn an_invalid_manual_url_is_rejected() {
        let conn = db();
        for url in ["", "   ", "ftp://epg.example/a.xml", "epg.example"] {
            let err = add_manual_source(&conn, url).unwrap_err();
            assert!(matches!(err, AppError::InvalidInput(_)), "{url}");
        }
        assert_eq!(rows(&conn, "epg_source"), 0);
    }

    #[test]
    fn an_xtream_source_exists_once_per_playlist() {
        let conn = db();
        add_xtream_playlist(&conn, 1);
        let first = ensure_xtream_source(&conn, 1).unwrap();
        let second = ensure_xtream_source(&conn, 1).unwrap();
        assert_eq!(first, second);
        assert_eq!(rows(&conn, "epg_source"), 1);
        let source = get_source(&conn, first).unwrap().unwrap();
        assert_eq!(source.origin, SourceOrigin::Xtream);
        assert_eq!(source.priority, 30);
        assert_eq!(source.url, None);
        assert_eq!(source.playlist_name.as_deref(), Some("Provider"));
    }

    #[test]
    fn sources_list_in_precedence_order_with_channel_counts() {
        let conn = db();
        add_xtream_playlist(&conn, 1);
        let xtream = ensure_xtream_source(&conn, 1).unwrap();
        let manual = add_manual_source(&conn, "https://epg.example/a.xml").unwrap();
        add_guide_rows(&conn, xtream, "svt1.se");
        add_guide_rows(&conn, xtream, "tv4.se");

        let list = list_sources(&conn).unwrap();
        assert_eq!(
            list.iter().map(|s| s.id).collect::<Vec<_>>(),
            [manual, xtream]
        );
        assert_eq!(list[1].channel_count, 2);
        assert_eq!(list[0].channel_count, 0);
    }

    #[test]
    fn status_columns_are_read_back() {
        let conn = db();
        let id = add_manual_source(&conn, "https://epg.example/a.xml").unwrap();
        conn.execute(
            "UPDATE epg_source SET time_interpret = 'local_zone', time_shift_minutes = -60,
                 applied_interpret = 'as_written', applied_shift_minutes = 0,
                 last_attempt_at = 5, last_success_at = 4, last_result = 'partial',
                 last_error = 'broke off', programme_count = 42, unknown_zone_count = 3,
                 unknown_zone_sample = '+0200 XYZ', decode_replacements = 7
             WHERE id = ?1",
            params![id],
        )
        .unwrap();
        let source = get_source(&conn, id).unwrap().unwrap();
        assert_eq!(
            source.policy,
            TimePolicy {
                interpret: Interpret::LocalZone,
                shift_minutes: -60
            }
        );
        assert_eq!(source.applied_policy, Some(TimePolicy::default()));
        assert!(source.policy_pending());
        assert_eq!(source.last_attempt_at, Some(5));
        assert_eq!(source.last_success_at, Some(4));
        assert_eq!(source.last_result, LastResult::Partial);
        assert_eq!(source.last_error.as_deref(), Some("broke off"));
        assert_eq!(source.programme_count, 42);
        assert_eq!(source.unknown_zone_count, 3);
        assert_eq!(source.unknown_zone_sample.as_deref(), Some("+0200 XYZ"));
        assert_eq!(source.decode_replacements, 7);
    }

    #[test]
    fn rows_under_an_unknown_policy_are_pending() {
        let conn = db();
        let id = add_manual_source(&conn, "https://epg.example/a.xml").unwrap();
        let pending = |conn: &Connection| get_source(conn, id).unwrap().unwrap().policy_pending();
        assert!(!pending(&conn), "no rows yet");

        // What a whole-source replace leaves when it stops between two
        // transactions: rows, and no applied policy.
        conn.execute(
            "UPDATE epg_source SET programme_count = 5, applied_interpret = NULL,
                 applied_shift_minutes = NULL WHERE id = ?1",
            params![id],
        )
        .unwrap();
        assert!(pending(&conn));

        conn.execute(
            "UPDATE epg_source SET applied_interpret = 'as_written', applied_shift_minutes = 0
             WHERE id = ?1",
            params![id],
        )
        .unwrap();
        assert!(!pending(&conn), "applied equals configured");
        conn.execute(
            "UPDATE epg_source SET time_shift_minutes = 30 WHERE id = ?1",
            params![id],
        )
        .unwrap();
        assert!(pending(&conn), "configured changed since");
    }

    #[test]
    fn a_time_policy_is_stored_as_configured_only() {
        let conn = db();
        let id = add_manual_source(&conn, "https://epg.example/a.xml").unwrap();
        let policy = TimePolicy {
            interpret: Interpret::LocalZone,
            shift_minutes: -90,
        };
        set_time_policy(&conn, id, &policy).unwrap();
        let source = get_source(&conn, id).unwrap().unwrap();
        assert_eq!(source.policy, policy);
        assert_eq!(source.applied_policy, None);

        for bad in [45, 15 * 60, -13 * 60] {
            let policy = TimePolicy {
                shift_minutes: bad,
                ..TimePolicy::default()
            };
            let err = set_time_policy(&conn, id, &policy).unwrap_err();
            assert!(matches!(err, AppError::InvalidInput(_)), "{bad}");
        }
        let err = set_time_policy(&conn, 99, &TimePolicy::default()).unwrap_err();
        assert!(matches!(err, AppError::InvalidInput(_)));
        assert_eq!(
            get_source(&conn, id).unwrap().unwrap().policy.shift_minutes,
            -90
        );
    }

    #[test]
    fn enabled_and_priority_are_updated() {
        let conn = db();
        let dir = TestDir::new();
        let id = add_manual_source(&conn, "https://epg.example/a.xml").unwrap();
        let update = update_source(
            &conn,
            &dir.0,
            id,
            &SourcePatch {
                enabled: Some(false),
                priority: Some(5),
                url: None,
            },
        )
        .unwrap();
        assert_eq!(
            update,
            SourceUpdate {
                enabled_changed: true,
                url_changed: false
            }
        );
        let source = get_source(&conn, id).unwrap().unwrap();
        assert!(!source.enabled);
        assert_eq!(source.priority, 5);

        let again = SourcePatch {
            enabled: Some(false),
            ..SourcePatch::default()
        };
        let update = update_source(&conn, &dir.0, id, &again).unwrap();
        assert!(!update.enabled_changed);
    }

    #[test]
    fn a_url_change_deletes_rows_cache_files_and_status() {
        let conn = db();
        let dir = TestDir::new();
        let id = add_manual_source(&conn, "https://epg.example/a.xml").unwrap();
        let other = add_manual_source(&conn, "https://epg.example/b.xml").unwrap();
        add_guide_rows(&conn, id, "svt1.se");
        add_guide_rows(&conn, other, "svt1.se");
        conn.execute(
            "UPDATE epg_source SET last_success_at = 9, last_attempt_at = 9, last_result = 'ok',
                 programme_count = 2, applied_interpret = 'as_written', applied_shift_minutes = 0",
            [],
        )
        .unwrap();
        touch(&feed_path(&dir.0, id));
        touch(&download_path(&dir.0, id));
        touch(&feed_path(&dir.0, other));

        let patch = SourcePatch {
            url: Some("https://epg.example/c.xml".to_string()),
            ..SourcePatch::default()
        };
        let update = update_source(&conn, &dir.0, id, &patch).unwrap();
        assert!(update.url_changed);

        let source = get_source(&conn, id).unwrap().unwrap();
        assert_eq!(source.url.as_deref(), Some("https://epg.example/c.xml"));
        assert_eq!(source.channel_count, 0);
        assert_eq!(source.programme_count, 0);
        assert_eq!(source.last_success_at, None);
        assert_eq!(source.last_attempt_at, None);
        assert_eq!(source.last_result, LastResult::Never);
        assert_eq!(source.applied_policy, None);
        assert!(!feed_path(&dir.0, id).exists());
        assert!(!download_path(&dir.0, id).exists());

        // The other source keeps its rows and feed.
        assert_eq!(rows(&conn, "epg_channel"), 1);
        assert_eq!(rows(&conn, "epg_channel_name"), 1);
        assert_eq!(rows(&conn, "epg_programme"), 2);
        assert!(feed_path(&dir.0, other).exists());
    }

    #[test]
    fn the_same_url_again_changes_nothing() {
        let conn = db();
        let dir = TestDir::new();
        let id = add_manual_source(&conn, "https://epg.example/a.xml").unwrap();
        add_guide_rows(&conn, id, "svt1.se");
        touch(&feed_path(&dir.0, id));
        let patch = SourcePatch {
            url: Some(" https://epg.example/a.xml".to_string()),
            ..SourcePatch::default()
        };
        assert!(
            !update_source(&conn, &dir.0, id, &patch)
                .unwrap()
                .url_changed
        );
        assert_eq!(rows(&conn, "epg_programme"), 2);
        assert!(feed_path(&dir.0, id).exists());
    }

    #[test]
    fn a_url_change_to_another_sources_url_is_refused_and_keeps_everything() {
        let conn = db();
        let dir = TestDir::new();
        let id = add_manual_source(&conn, "https://epg.example/a.xml").unwrap();
        add_manual_source(&conn, "https://epg.example/b.xml").unwrap();
        add_guide_rows(&conn, id, "svt1.se");
        touch(&feed_path(&dir.0, id));
        let patch = SourcePatch {
            enabled: Some(false),
            url: Some("https://epg.example/b.xml".to_string()),
            ..SourcePatch::default()
        };
        let err = update_source(&conn, &dir.0, id, &patch).unwrap_err();
        assert!(matches!(err, AppError::InvalidInput(_)), "{err:?}");
        let source = get_source(&conn, id).unwrap().unwrap();
        assert_eq!(source.url.as_deref(), Some("https://epg.example/a.xml"));
        assert!(source.enabled, "the whole patch rolls back");
        assert_eq!(rows(&conn, "epg_programme"), 2);
        assert!(feed_path(&dir.0, id).exists());
    }

    #[test]
    fn only_manual_sources_change_url_or_are_removed() {
        let conn = db();
        let dir = TestDir::new();
        add_xtream_playlist(&conn, 1);
        let id = ensure_xtream_source(&conn, 1).unwrap();
        let patch = SourcePatch {
            url: Some("https://epg.example/a.xml".to_string()),
            ..SourcePatch::default()
        };
        let err = update_source(&conn, &dir.0, id, &patch).unwrap_err();
        assert!(matches!(err, AppError::InvalidInput(_)));
        let err = remove_source(&conn, &dir.0, id).unwrap_err();
        assert!(matches!(err, AppError::InvalidInput(_)));
        assert_eq!(rows(&conn, "epg_source"), 1);
    }

    #[test]
    fn an_unknown_source_is_invalid_input() {
        let conn = db();
        let dir = TestDir::new();
        let err = update_source(&conn, &dir.0, 99, &SourcePatch::default()).unwrap_err();
        assert!(matches!(err, AppError::InvalidInput(_)));
        let err = remove_source(&conn, &dir.0, 99).unwrap_err();
        assert!(matches!(err, AppError::InvalidInput(_)));
    }

    #[test]
    fn removing_a_manual_source_deletes_rows_and_cache_files() {
        let conn = db();
        let dir = TestDir::new();
        let id = add_manual_source(&conn, "https://epg.example/a.xml").unwrap();
        add_guide_rows(&conn, id, "svt1.se");
        touch(&feed_path(&dir.0, id));
        remove_source(&conn, &dir.0, id).unwrap();
        assert_eq!(get_source(&conn, id).unwrap(), None);
        for table in ["epg_channel", "epg_channel_name", "epg_programme"] {
            assert_eq!(rows(&conn, table), 0, "{table}");
        }
        assert!(!feed_path(&dir.0, id).exists());
        // The URL can be added again, under a new id.
        let again = add_manual_source(&conn, "https://epg.example/a.xml").unwrap();
        assert!(again > id);
    }

    #[test]
    fn deleting_a_profile_cascades_to_its_sources_and_rows() {
        let conn = db();
        add_xtream_playlist(&conn, 1);
        let xtream = ensure_xtream_source(&conn, 1).unwrap();
        let manual = add_manual_source(&conn, "https://epg.example/a.xml").unwrap();
        add_guide_rows(&conn, xtream, "svt1.se");
        add_guide_rows(&conn, manual, "svt1.se");

        crate::db::mutations::delete_playlist(&conn, 1).unwrap();

        assert_eq!(get_source(&conn, xtream).unwrap(), None);
        assert!(get_source(&conn, manual).unwrap().is_some());
        assert_eq!(rows(&conn, "epg_channel"), 1);
        assert_eq!(rows(&conn, "epg_channel_name"), 1);
        assert_eq!(rows(&conn, "epg_programme"), 2);
    }

    #[test]
    fn the_sweep_deletes_files_of_removed_sources_only() {
        let conn = db();
        let dir = TestDir::new();
        add_xtream_playlist(&conn, 1);
        let live = ensure_xtream_source(&conn, 1).unwrap();
        let orphan = live + 41;
        touch(&feed_path(&dir.0, live));
        touch(&download_path(&dir.0, live));
        touch(&feed_path(&dir.0, orphan));
        touch(&download_path(&dir.0, orphan));
        touch(&dir.0.join("notes.txt"));
        touch(&dir.0.join("x1.feed.gz"));
        touch(&staging_path(&dir.0));

        assert_eq!(sweep_cache_dir(&conn, &dir.0, false).unwrap(), 2);
        assert!(feed_path(&dir.0, live).exists());
        assert!(download_path(&dir.0, live).exists());
        assert!(!feed_path(&dir.0, orphan).exists());
        assert!(!download_path(&dir.0, orphan).exists());
        assert!(dir.0.join("notes.txt").exists());
        assert!(dir.0.join("x1.feed.gz").exists());
        assert!(staging_path(&dir.0).exists(), "an ingest may have it open");

        // A second sweep finds nothing more.
        assert_eq!(sweep_cache_dir(&conn, &dir.0, false).unwrap(), 0);
    }

    #[test]
    fn the_sweep_after_a_profile_delete_removes_its_feed() {
        let conn = db();
        let dir = TestDir::new();
        add_xtream_playlist(&conn, 1);
        let id = ensure_xtream_source(&conn, 1).unwrap();
        touch(&feed_path(&dir.0, id));
        crate::db::mutations::delete_playlist(&conn, 1).unwrap();
        assert_eq!(sweep_cache_dir(&conn, &dir.0, false).unwrap(), 1);
        assert!(!feed_path(&dir.0, id).exists());
    }

    #[test]
    fn the_sweep_skips_directories_and_symlinks() {
        let conn = db();
        let dir = TestDir::new();
        // Neither id 5 nor id 6 is a source; both names would be orphans.
        std::fs::create_dir(feed_path(&dir.0, 5)).unwrap();
        let target = dir.0.join("target.bin");
        touch(&target);
        #[cfg(unix)]
        std::os::unix::fs::symlink(&target, feed_path(&dir.0, 6)).unwrap();

        assert_eq!(sweep_cache_dir(&conn, &dir.0, true).unwrap(), 0);
        assert!(feed_path(&dir.0, 5).is_dir());
        #[cfg(unix)]
        assert!(feed_path(&dir.0, 6).is_symlink());
        assert!(target.exists());
    }

    #[test]
    fn a_failed_feed_delete_leaves_the_url_change_undone() {
        let conn = db();
        let dir = TestDir::new();
        let id = add_manual_source(&conn, "https://epg.example/a.xml").unwrap();
        add_guide_rows(&conn, id, "svt1.se");
        conn.execute(
            "UPDATE epg_source SET last_success_at = 9, last_result = 'ok', programme_count = 2
             WHERE id = ?1",
            params![id],
        )
        .unwrap();
        // remove_file cannot delete a directory.
        std::fs::create_dir(feed_path(&dir.0, id)).unwrap();
        let before = get_source(&conn, id).unwrap().unwrap();

        let patch = SourcePatch {
            url: Some("https://epg.example/c.xml".to_string()),
            ..SourcePatch::default()
        };
        let err = update_source(&conn, &dir.0, id, &patch).unwrap_err();
        assert!(matches!(err, AppError::Io(_)), "{err:?}");

        assert_eq!(get_source(&conn, id).unwrap().unwrap(), before);
        assert_eq!(rows(&conn, "epg_channel"), 1);
        assert_eq!(rows(&conn, "epg_channel_name"), 1);
        assert_eq!(rows(&conn, "epg_programme"), 2);
    }

    #[test]
    fn a_failed_feed_delete_does_not_stop_a_removal() {
        let conn = db();
        let dir = TestDir::new();
        let id = add_manual_source(&conn, "https://epg.example/a.xml").unwrap();
        add_guide_rows(&conn, id, "svt1.se");
        std::fs::create_dir(feed_path(&dir.0, id)).unwrap();

        remove_source(&conn, &dir.0, id).unwrap();

        assert_eq!(get_source(&conn, id).unwrap(), None);
        assert_eq!(rows(&conn, "epg_programme"), 0);
    }

    #[test]
    fn the_boot_sweep_also_deletes_the_staging_database() {
        let conn = db();
        let dir = TestDir::new();
        for name in [
            "ingest.db",
            "ingest.db-journal",
            "ingest.db-wal",
            "ingest.db-shm",
        ] {
            touch(&dir.0.join(name));
        }
        touch(&dir.0.join("ingest.db.bak"));
        assert_eq!(sweep_cache_dir(&conn, &dir.0, true).unwrap(), 4);
        assert!(dir.0.join("ingest.db.bak").exists());
    }

    #[test]
    fn the_sweep_of_a_missing_directory_deletes_nothing() {
        let conn = db();
        let dir = TestDir::new();
        let missing = dir.0.join("absent");
        assert_eq!(sweep_cache_dir(&conn, &missing, true).unwrap(), 0);
    }

    #[test]
    fn cache_paths_are_named_by_source_id() {
        let dir = cache_dir(Path::new("/data"));
        assert_eq!(dir, Path::new("/data/epg"));
        assert_eq!(feed_path(&dir, 7), Path::new("/data/epg/7.feed.gz"));
        assert_eq!(download_path(&dir, 7), Path::new("/data/epg/7.download"));
        assert_eq!(staging_path(&dir), Path::new("/data/epg/ingest.db"));
        assert_eq!(cache_file_source("7.feed.gz"), Some(7));
        assert_eq!(cache_file_source("12.download"), Some(12));
        for name in [".feed.gz", "-1.feed.gz", "+1.download", "7.feed", "7.xml"] {
            assert_eq!(cache_file_source(name), None, "{name}");
        }
    }

    #[test]
    fn has_cached_feed_reflects_the_feed_file() {
        let dir = TestDir::new();
        assert!(!has_cached_feed(&dir.0, 3));
        touch(&download_path(&dir.0, 3));
        assert!(!has_cached_feed(&dir.0, 3), "a download is not a feed");
        touch(&feed_path(&dir.0, 3));
        assert!(has_cached_feed(&dir.0, 3));
        remove_cache_files(&dir.0, 3).unwrap();
        assert!(!has_cached_feed(&dir.0, 3));
        assert!(!download_path(&dir.0, 3).exists());
        remove_cache_files(&dir.0, 3).unwrap();
    }
}
