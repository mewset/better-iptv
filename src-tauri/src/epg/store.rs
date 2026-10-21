//! Storing a feed: staging, normalisation and the swap into the guide tables.
//!
//! The ingest runs on a connection of its own (`IngestConnection`), opened
//! on the app database for one ingest and closed after it, so its settings
//! (small page cache, no foreign keys, no automatic checkpoint) never reach
//! the pool and nothing it attached outlives it.
//!
//! The parse sink corrects each programme's times with the source's policy,
//! writes the programme to a staging table in a separate database file
//! (`<cache_dir>/ingest.db`, attached for one ingest) in short transactions,
//! and keeps only a 32-byte `Slot` per programme in memory. `normalise`
//! decides per programme from those slots, the verdicts are written back to
//! staging, and one transaction on the main database then replaces the
//! source's programmes with `INSERT … SELECT` from staging. A feed above
//! `SWAP_CHUNK_ROWS` programmes is swapped per range of channels, one
//! transaction each, so the write lock is never held for long; each channel
//! is still replaced whole in one transaction.
//!
//! Stored rows are never updated in place. For each channel in the feed the
//! rows that reach past its first new start are deleted before the new rows
//! go in, so a programme whose start moved leaves nothing behind, and the
//! primary key turns two rows at one start into a failed swap instead of a
//! duplicate. Rows that ended before a channel's first new start, and
//! channels the feed no longer lists, stay until they ended a day ago,
//! unless the stored rows were read under another time policy: then every
//! row of the source is replaced, so two policies never mix.
//!
//! Staging and main are separate databases, and a transaction is atomic per
//! database in WAL mode, not across them. Staging is disposable: the swap
//! only reads it, and the file is deleted when the ingest ends.

use super::parse::{parse_feed, ParseSink, ParsedChannel, ParsedProgramme};
use super::sources::{remove_if_present, staging_path};
use super::{AbandonReason, IngestScope, EMPTY_CACHE_MESSAGE, EMPTY_GUIDE_MESSAGE};
use crate::epg_domain::key::{channel_key, name_key};
use crate::epg_domain::normalize::{
    normalise, KeyBounds, Slot, Verdict, ENDED_GRACE_SECS, NO_STOP,
};
use crate::epg_domain::policy::{Interpret, TimePolicy};
use crate::epg_domain::report::{NormaliseReport, ParseReport};
use crate::epg_domain::source::{success_after, LastResult};
use anyhow::{bail, ensure, Context, Result};
use chrono::TimeZone;
use log::warn;
use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use std::collections::HashMap;
use std::io::{self, BufRead};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

/// Programmes per staging transaction.
pub const STAGING_BATCH: usize = 1000;

/// Kept programmes per swap transaction; a larger feed commits per range of
/// channels, so another writer never waits on the lock for long. Measured
/// in release on the weak dev machine: about 50-135 ms per transaction for
/// 43k and 430k programmes, against 105-230 ms with 50,000, at a slightly
/// longer ingest. Each channel is still replaced in one transaction.
pub const SWAP_CHUNK_ROWS: u32 = 20_000;

/// The ingest connection's page cache, in KiB. The pool's connections get
/// 10,000 pages (about 40 MB); the swap writes every page of the source's
/// programmes and would fill a cache that size, so the ingest's memory
/// would grow with the feed instead of staying flat.
const INGEST_CACHE_KIB: i64 = 2048;

/// The WAL is cut back to this size, in bytes, when the ingest connection
/// restarts it, and truncated when the ingest ends if no one is reading.
const WAL_SIZE_LIMIT: i64 = 4 * 1024 * 1024;

const STAGE_FAILURE: &str = "Failed to stage the EPG";
const STORE_FAILURE: &str = "Failed to store the EPG";

/// Journal off and no syncs: the file is deleted after every ingest and
/// rebuilt from the feed, so a crash costs nothing worth protecting.
///
/// Rows are stored in feed order. The index on the channel number (`knum`,
/// the order channels first appear in the feed) lets the swap read one
/// channel at a time without a sorter; it costs a few bytes per row and
/// stays cheap to extend whatever order the feed lists programmes in.
const STAGING_SETUP: &str = "PRAGMA ingest.journal_mode = OFF;
    PRAGMA ingest.synchronous = OFF;
    CREATE TABLE IF NOT EXISTS ingest.epg_ingest (
        seq INTEGER PRIMARY KEY,
        knum INTEGER NOT NULL,
        start INTEGER NOT NULL,
        stop INTEGER,                     -- NULL until a verdict infers it
        keep INTEGER NOT NULL DEFAULT 1,  -- 0 = dropped by its verdict
        title TEXT NOT NULL,
        description TEXT,
        category TEXT
    );
    CREATE INDEX IF NOT EXISTS ingest.epg_ingest_knum ON epg_ingest (knum);
    DELETE FROM ingest.epg_ingest;";

const STAGE_ROW: &str = "INSERT INTO ingest.epg_ingest
    (knum, seq, start, stop, title, description, category) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)";
const MARK_STOP: &str = "UPDATE ingest.epg_ingest SET stop = ?2 WHERE seq = ?1";
const MARK_DROPPED: &str = "UPDATE ingest.epg_ingest SET keep = 0 WHERE seq = ?1";

// The swap's statements, named so the query-plan test checks each one.
const UPSERT_CHANNEL: &str = "INSERT OR IGNORE INTO epg_channel (source_id, key) VALUES (?1, ?2)";
const SELECT_CHANNEL: &str = "SELECT id, key, first_start, last_stop, programme_count
    FROM epg_channel WHERE source_id = ?1 AND key = ?2";
const SELECT_CHANNELS: &str = "SELECT id, key, first_start, last_stop, programme_count
    FROM epg_channel WHERE source_id = ?1";
const DELETE_NAMES: &str = "DELETE FROM epg_channel_name WHERE channel_id = ?1";
const INSERT_NAME: &str = "INSERT INTO epg_channel_name (channel_id, position, name, name_key)
    VALUES (?1, ?2, ?3, ?4)";
const DELETE_CHANNEL_ROWS: &str = "DELETE FROM epg_programme WHERE channel_id = ?1";
const DELETE_FROM_FIRST_START: &str =
    "DELETE FROM epg_programme WHERE channel_id = ?1 AND stop > ?2";
const DELETE_WINDOW: &str =
    "DELETE FROM epg_programme WHERE channel_id = ?1 AND stop > ?2 AND start < ?3";
/// One channel's kept rows from staging, through its `knum` index in feed
/// order. No `ORDER BY`: under `temp_store = memory` a sorter would sit in
/// RAM. `OR FAIL` still fails the statement, and with it the swap, on a
/// duplicate start; the default `ABORT` would make SQLite keep a statement
/// journal of every page the insert reuses, in RAM as well.
const INSERT_FROM_STAGING: &str = "INSERT OR FAIL INTO epg_programme
        (channel_id, start, stop, title, description, category)
    SELECT ?1, start, stop, title, description, category
    FROM ingest.epg_ingest WHERE knum = ?2 AND keep = 1";
/// `stop > start` holds for every stored row, so `start < cutoff` only
/// narrows the primary-key range to the rows that can qualify.
const PRUNE: &str = "DELETE FROM epg_programme WHERE channel_id = ?1 AND start < ?2 AND stop <= ?2";
const FIRST_START: &str =
    "SELECT start FROM epg_programme WHERE channel_id = ?1 ORDER BY start LIMIT 1";
const LAST_STOP_FROM: &str =
    "SELECT MAX(stop) FROM epg_programme WHERE channel_id = ?1 AND start >= ?2";
const RECOUNT: &str =
    "SELECT MIN(start), MAX(stop), COUNT(*) FROM epg_programme WHERE channel_id = ?1";
const UPDATE_SUMMARY: &str = "UPDATE epg_channel
    SET first_start = ?2, last_stop = ?3, programme_count = ?4 WHERE id = ?1";
const SOURCE_STATE: &str = "SELECT enabled, url, last_success_at, applied_interpret,
        applied_shift_minutes
    FROM epg_source WHERE id = ?1";
/// Written in the first transaction of a swap that replaces the whole
/// source over several transactions: until the last one commits, the
/// source's rows are under two policies, and an unknown applied policy makes
/// the next ingest replace them all.
const CLEAR_APPLIED: &str = "UPDATE epg_source
    SET applied_interpret = NULL, applied_shift_minutes = NULL WHERE id = ?1";
/// After every swap transaction, so the source's count matches its rows
/// even when a later one fails. Reads `epg_channel`, never the programmes.
const UPDATE_COUNT: &str = "UPDATE epg_source SET programme_count =
        (SELECT COALESCE(SUM(programme_count), 0) FROM epg_channel WHERE source_id = ?1)
    WHERE id = ?1";
/// After a download: the provider answered, so its result is recorded.
const UPDATE_STATUS: &str = "UPDATE epg_source SET last_result = ?2, last_error = NULL,
        unknown_zone_count = ?3, unknown_zone_sample = ?4, decode_replacements = ?5,
        applied_interpret = ?6, applied_shift_minutes = ?7, last_success_at = ?8
    WHERE id = ?1";
/// After a re-read of the cached feed: `last_result` and `last_error`
/// describe the provider's last answer and stay as they are.
const UPDATE_CACHE_STATUS: &str = "UPDATE epg_source SET
        unknown_zone_count = ?2, unknown_zone_sample = ?3, decode_replacements = ?4,
        applied_interpret = ?5, applied_shift_minutes = ?6
    WHERE id = ?1";

// ========== The ingest's connection ==========

/// The ingest's own connection to the app database, closed on drop.
///
/// Separate from the pool so that what an ingest sets never reaches a pooled
/// connection: foreign keys are off (with them on, SQLite gives every
/// insert into a child table of an immediate foreign key a statement
/// journal, `defer_foreign_keys` or not, which holds every reused page in
/// RAM under `temp_store = memory`; every id the swap writes was read in the
/// same transaction), the page cache is small, and automatic checkpoints are
/// off because the swap checkpoints after each transaction itself. On drop
/// the WAL is truncated if no one is reading, the connection closes, and the
/// staging file goes with it.
pub(crate) struct IngestConnection {
    conn: Option<Connection>,
    staging: PathBuf,
}

impl IngestConnection {
    /// Open `db_path`, which must exist; `cache_dir` holds the staging file.
    pub fn open(db_path: &Path, cache_dir: &Path) -> Result<Self> {
        const OPEN_FAILURE: &str = "Could not open the database for the EPG update";
        // The flags allow creating files, which `ATTACH` of the staging
        // database needs; the app database itself must already be there.
        ensure!(db_path.is_file(), OPEN_FAILURE);
        let open = || -> rusqlite::Result<Connection> {
            let conn = Connection::open(db_path)?;
            conn.busy_timeout(Duration::from_secs(5))?;
            conn.execute_batch(&format!(
                "PRAGMA journal_mode = WAL;
                 PRAGMA synchronous = NORMAL;
                 PRAGMA foreign_keys = OFF;
                 PRAGMA temp_store = memory;
                 PRAGMA cache_size = -{INGEST_CACHE_KIB};
                 PRAGMA wal_autocheckpoint = 0;
                 PRAGMA journal_size_limit = {WAL_SIZE_LIMIT};"
            ))?;
            Ok(conn)
        };
        Ok(IngestConnection {
            conn: Some(open().context(OPEN_FAILURE)?),
            staging: staging_path(cache_dir),
        })
    }

    pub fn conn(&self) -> &Connection {
        self.conn
            .as_ref()
            .expect("the ingest connection is open until dropped")
    }
}

impl Drop for IngestConnection {
    fn drop(&mut self) {
        let Some(conn) = self.conn.take() else {
            return;
        };
        // Truncate only if it costs nobody a wait: no busy handler.
        let truncated = conn.busy_timeout(Duration::ZERO).and_then(|()| {
            conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |r| {
                r.get::<_, i64>(0)
            })
        });
        match truncated {
            Ok(0) => {}
            Ok(_) => log::debug!("EPG ingest: WAL not truncated, the database is in use"),
            Err(e) => warn!("EPG ingest: WAL not truncated: {e}"),
        }
        if let Err((_, e)) = conn.close() {
            warn!("EPG ingest: database connection not closed cleanly: {e}");
        }
        if let Err(e) = remove_staging_files(&self.staging) {
            warn!("EPG staging database not deleted: {e}");
        }
    }
}

// ========== Staging ==========

/// The staging database, attached to a connection for one ingest. Dropping
/// it detaches and deletes the file, after a success and a failure alike.
pub(crate) struct Staging<'c> {
    conn: &'c Connection,
    path: PathBuf,
}

impl<'c> Staging<'c> {
    /// Attach a fresh, empty staging database to `conn`. The caller holds
    /// the EPG refresh lock: every ingest shares the one file.
    pub fn attach(conn: &'c Connection, cache_dir: &Path) -> Result<Self> {
        if is_attached(conn).context(STAGE_FAILURE)? {
            conn.execute_batch("DETACH DATABASE ingest")
                .context(STAGE_FAILURE)?;
        }
        let path = staging_path(cache_dir);
        remove_staging_files(&path).context(STAGE_FAILURE)?;
        let name = path
            .to_str()
            .context("The EPG cache folder has a name the database cannot open")?;
        conn.execute("ATTACH DATABASE ?1 AS ingest", params![name])
            .context(STAGE_FAILURE)?;
        let staging = Staging { conn, path };
        conn.execute_batch(STAGING_SETUP).context(STAGE_FAILURE)?;
        Ok(staging)
    }
}

impl Drop for Staging<'_> {
    fn drop(&mut self) {
        if let Err(e) = self.conn.execute_batch("DETACH DATABASE ingest") {
            // Closing the ingest connection releases it; the file goes then.
            warn!("EPG staging database not detached: {e}");
            return;
        }
        if let Err(e) = remove_staging_files(&self.path) {
            warn!("EPG staging database not deleted: {e}");
        }
    }
}

fn is_attached(conn: &Connection) -> rusqlite::Result<bool> {
    conn.prepare("SELECT 1 FROM pragma_database_list WHERE name = 'ingest'")?
        .exists([])
}

/// The staging database and any journal SQLite may have left beside it.
fn remove_staging_files(path: &Path) -> io::Result<()> {
    remove_if_present(path)?;
    for suffix in ["-journal", "-wal", "-shm"] {
        let mut name = path.as_os_str().to_owned();
        name.push(suffix);
        remove_if_present(Path::new(&name))?;
    }
    Ok(())
}

/// The channel keys of one feed, numbered in order of first appearance;
/// `Slot::key`, `KeyBounds::key` and the staging `knum` are these numbers.
#[derive(Default)]
pub(crate) struct FeedKeys {
    keys: Vec<String>,
    index: HashMap<String, u32>,
    /// Display names per key, for keys a `<channel>` element described.
    names: Vec<Option<Vec<String>>>,
}

impl FeedKeys {
    /// The number of `key`, assigned on first sight; `None` past `u32::MAX`
    /// keys.
    fn intern(&mut self, key: String) -> Option<u32> {
        if let Some(&number) = self.index.get(&key) {
            return Some(number);
        }
        let number = u32::try_from(self.keys.len()).ok()?;
        self.keys.push(key.clone());
        self.names.push(None);
        self.index.insert(key, number);
        Some(number)
    }

    fn key(&self, number: u32) -> &str {
        &self.keys[number as usize]
    }
}

/// One programme waiting for the next staging transaction.
struct StagedRow {
    seq: u32,
    key: u32,
    start: i64,
    stop: Option<i64>,
    title: String,
    description: Option<String>,
    category: Option<String>,
}

/// The parse sink: resolves times, stages rows, keeps slots and channels.
struct StagingSink<'c, 'z, Tz: TimeZone> {
    conn: &'c Connection,
    policy: TimePolicy,
    local: &'z Tz,
    /// Programmes that ended by this instant are never stored (see
    /// `staged_row`).
    cutoff: i64,
    keys: FeedKeys,
    slots: Vec<Slot>,
    batch: Vec<StagedRow>,
}

impl<Tz: TimeZone> StagingSink<'_, '_, Tz> {
    fn flush(&mut self) -> Result<()> {
        if self.batch.is_empty() {
            return Ok(());
        }
        let tx = self.conn.unchecked_transaction().context(STAGE_FAILURE)?;
        {
            let mut insert = tx.prepare(STAGE_ROW).context(STAGE_FAILURE)?;
            for row in self.batch.drain(..) {
                insert
                    .execute(params![
                        row.key,
                        row.seq,
                        row.start,
                        row.stop,
                        row.title,
                        row.description,
                        row.category
                    ])
                    .context(STAGE_FAILURE)?;
            }
        }
        tx.commit().context(STAGE_FAILURE)
    }
}

/// Whether a slot's programme went to staging. One whose stop the feed gave
/// and that ended by the cutoff did not: `normalise` drops it as `Ended`
/// or for another reason (a kept programme's stop only ever moves earlier),
/// so only its slot is needed, to infer the stop of the one before it.
fn staged_row(slot: &Slot, cutoff: i64) -> bool {
    slot.stop == NO_STOP || slot.stop > cutoff
}

impl<Tz: TimeZone> ParseSink for StagingSink<'_, '_, Tz> {
    fn programme(&mut self, p: ParsedProgramme) -> Result<()> {
        // The parser skips programmes without a usable channel.
        let Some(key) = channel_key(&p.channel) else {
            return Ok(());
        };
        let key = self
            .keys
            .intern(key)
            .context("The EPG has more channels than can be counted")?;
        let start = self.policy.resolve_detailed(&p.start, self.local);
        let stop = p.stop.map(|stop| self.policy.resolve(&stop, self.local));
        let clump = p.clumpidx.map(|(index, _)| index);
        let slot = Slot::new(p.seq, key, start.at, stop, clump).with_start_in_gap(start.in_gap);
        self.slots.push(slot);
        if !staged_row(&slot, self.cutoff) {
            return Ok(());
        }
        self.batch.push(StagedRow {
            seq: p.seq,
            key,
            start: start.at,
            stop,
            title: p.title,
            description: p.description,
            category: p.category,
        });
        if self.batch.len() >= STAGING_BATCH {
            self.flush()?;
        }
        Ok(())
    }

    fn channel(&mut self, c: ParsedChannel) {
        let Some(number) = channel_key(&c.id).and_then(|key| self.keys.intern(key)) else {
            return;
        };
        // Two <channel> elements whose ids differ only in case share a key.
        let names = self.keys.names[number as usize].get_or_insert_with(Vec::new);
        for name in c.display_names {
            if !names.contains(&name) {
                names.push(name);
            }
        }
    }
}

/// A feed read into staging.
pub(crate) struct Staged {
    keys: FeedKeys,
    slots: Vec<Slot>,
    pub parse: ParseReport,
}

/// Parse a feed into staging, every time resolved with `policy`; `local`
/// is the zone `Interpret::LocalZone` reads in, and `now` decides which
/// programmes ended too long ago to stage.
pub(crate) fn stage<R: BufRead, Tz: TimeZone>(
    staging: &Staging,
    input: R,
    policy: TimePolicy,
    local: &Tz,
    now: i64,
) -> Result<Staged> {
    let mut sink = StagingSink {
        conn: staging.conn,
        policy,
        local,
        cutoff: now.saturating_sub(ENDED_GRACE_SECS),
        keys: FeedKeys::default(),
        slots: Vec::new(),
        batch: Vec::with_capacity(STAGING_BATCH),
    };
    let parse = parse_feed(input, &mut sink)?;
    sink.flush()?;
    Ok(Staged {
        keys: sink.keys,
        slots: sink.slots,
        parse,
    })
}

/// A staged feed with its verdicts written; what the swap needs.
pub(crate) struct Prepared {
    keys: FeedKeys,
    bounds: Vec<KeyBounds>,
    pub parse: ParseReport,
    pub normalise: NormaliseReport,
    /// Programmes marked to keep: the rows the swap inserts.
    pub kept: u32,
    pub normalise_time: Duration,
    pub mark_time: Duration,
}

impl Prepared {
    /// Channels with at least one programme to store.
    pub fn channels_with_programmes(&self) -> u32 {
        u32::try_from(self.bounds.len()).unwrap_or(u32::MAX)
    }
}

/// Normalise the staged programmes and write the verdicts to staging.
///
/// A feed with nothing left to store fails, and the stored guide is left as
/// it is: after a download with `EMPTY_GUIDE_MESSAGE` (an empty or
/// non-XMLTV body, or a stale feed whose programmes all ended a day ago),
/// for a re-read of the cached feed with `EMPTY_CACHE_MESSAGE`.
pub(crate) fn prepare(
    staging: &Staging,
    staged: Staged,
    now: i64,
    network: bool,
) -> Result<Prepared> {
    let Staged {
        keys,
        mut slots,
        parse,
    } = staged;
    let started = Instant::now();
    let (verdicts, bounds, normalise_report) = normalise(&mut slots, now);
    let normalise_time = started.elapsed();
    // At most one kept slot per programme, and programmes are numbered in u32.
    let kept = bounds.iter().map(|b| b.count).sum::<u32>();
    if kept == 0 {
        if network {
            bail!(EMPTY_GUIDE_MESSAGE);
        }
        bail!(EMPTY_CACHE_MESSAGE);
    }

    let started = Instant::now();
    let cutoff = now.saturating_sub(ENDED_GRACE_SECS);
    mark(staging.conn, &slots, &verdicts, cutoff).context(STAGE_FAILURE)?;
    Ok(Prepared {
        keys,
        bounds,
        parse,
        normalise: normalise_report,
        kept,
        normalise_time,
        mark_time: started.elapsed(),
    })
}

/// Write each verdict to its staged row: an inferred or trimmed stop, or
/// `keep = 0`. Two prepared statements, one row each; no `IN` lists.
/// Programmes that were never staged need no mark.
fn mark(
    conn: &Connection,
    slots: &[Slot],
    verdicts: &[Verdict],
    cutoff: i64,
) -> rusqlite::Result<()> {
    let tx = conn.unchecked_transaction()?;
    {
        let mut set_stop = tx.prepare(MARK_STOP)?;
        let mut drop_row = tx.prepare(MARK_DROPPED)?;
        for (slot, verdict) in slots.iter().zip(verdicts) {
            match verdict {
                Verdict::Keep => {}
                Verdict::KeepWithStop(stop) => {
                    set_stop.execute(params![slot.seq, stop])?;
                }
                // A dropped slot still has the stop the feed gave.
                Verdict::Drop(_) if staged_row(slot, cutoff) => {
                    drop_row.execute(params![slot.seq])?;
                }
                Verdict::Drop(_) => {}
            }
        }
    }
    tx.commit()
}

// ========== Swap ==========

/// What the swap checks and writes besides the programmes.
pub(crate) struct SwapRequest<'a> {
    pub source_id: i64,
    /// The URL the ingest fetched against, `None` for an Xtream source. The
    /// swap stores nothing when the source's URL is no longer this one.
    pub expected_url: Option<&'a str>,
    /// The policy the sink resolved times with, recorded as applied.
    pub policy: TimePolicy,
    pub scope: IngestScope,
    /// A download, whose result is recorded on the source and which
    /// advances `last_success_at`; otherwise a re-read of the cached feed.
    pub network: bool,
    pub now: i64,
}

/// How the swap ended.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Swapped {
    Committed {
        /// Rows inserted from this feed.
        stored: u32,
        /// Write transactions the swap took.
        transactions: u32,
        /// The longest of them, `BEGIN IMMEDIATE` to `COMMIT`: the longest
        /// another writer waited.
        hold: Duration,
    },
    /// The source changed under the ingest. Nothing was written, or, when
    /// it changed between two transactions of a large feed, nothing after.
    Abandoned(AbandonReason),
}

/// Why the source no longer is what the ingest started from: removed,
/// given another URL, or disabled. `None` when it still matches.
pub(crate) fn source_mismatch(
    conn: &Connection,
    source_id: i64,
    expected_url: Option<&str>,
) -> rusqlite::Result<Option<AbandonReason>> {
    Ok(match source_state(conn, source_id)? {
        None => Some(AbandonReason::SourceRemoved),
        Some(state) => state.mismatch(expected_url),
    })
}

struct SourceState {
    enabled: bool,
    url: Option<String>,
    last_success_at: Option<i64>,
    /// The policy the stored rows were read under; `None` before the first
    /// stored ingest and while a whole-source replace is half done.
    applied: Option<TimePolicy>,
}

impl SourceState {
    fn mismatch(&self, expected_url: Option<&str>) -> Option<AbandonReason> {
        if self.url.as_deref() != expected_url {
            Some(AbandonReason::UrlChanged)
        } else if !self.enabled {
            Some(AbandonReason::SourceDisabled)
        } else {
            None
        }
    }
}

fn source_state(conn: &Connection, source_id: i64) -> rusqlite::Result<Option<SourceState>> {
    conn.query_row(SOURCE_STATE, params![source_id], |r| {
        let interpret: Option<String> = r.get(3)?;
        let shift_minutes: Option<i32> = r.get(4)?;
        let applied = match (
            interpret.as_deref().and_then(Interpret::from_db),
            shift_minutes,
        ) {
            (Some(interpret), Some(shift_minutes)) => Some(TimePolicy {
                interpret,
                shift_minutes,
            }),
            _ => None,
        };
        Ok(SourceState {
            enabled: r.get(0)?,
            url: r.get(1)?,
            last_success_at: r.get(2)?,
            applied,
        })
    })
    .optional()
}

/// One `epg_channel` row of the source as it was before this transaction.
struct StoredChannel {
    id: i64,
    key: String,
    summary: Summary,
}

/// A channel's stored extent: `epg_channel.first_start/last_stop/programme_count`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct Summary {
    first_start: Option<i64>,
    last_stop: Option<i64>,
    count: u32,
}

impl Summary {
    fn of_new(bounds: Option<&KeyBounds>) -> Self {
        bounds.map_or_else(Summary::default, |b| Summary {
            first_start: Some(b.first_start),
            last_stop: Some(b.last_stop),
            count: b.count,
        })
    }
}

fn map_channel(r: &rusqlite::Row) -> rusqlite::Result<StoredChannel> {
    let count: i64 = r.get(4)?;
    Ok(StoredChannel {
        id: r.get(0)?,
        key: r.get(1)?,
        summary: Summary {
            first_start: r.get(2)?,
            last_stop: r.get(3)?,
            count: u32::try_from(count.max(0)).unwrap_or(u32::MAX),
        },
    })
}

fn changed(rows: usize) -> u32 {
    u32::try_from(rows).unwrap_or(u32::MAX)
}

/// Ranges of channel numbers, each with at most `max_rows` kept programmes
/// unless one channel alone has more.
fn plan_chunks(channels: usize, bounds: &[Option<&KeyBounds>], max_rows: u32) -> Vec<(u32, u32)> {
    let mut chunks = Vec::new();
    let (mut start, mut rows) = (0u32, 0u32);
    for knum in 0..channels as u32 {
        let count = bounds[knum as usize].map_or(0, |b| b.count);
        if knum > start && rows.saturating_add(count) > max_rows {
            chunks.push((start, knum));
            (start, rows) = (knum, 0);
        }
        rows = rows.saturating_add(count);
    }
    chunks.push((start, channels as u32));
    chunks
}

/// Replace the source's programmes with the staged ones.
///
/// Up to `SWAP_CHUNK_ROWS` kept programmes this is one write transaction on
/// the main database; a larger feed commits per range of channels, each
/// range complete in itself (the fallback the design names for the lock
/// budget). Every transaction first checks the source again: removed,
/// disabled or given another URL since the ingest started means it writes
/// nothing and the swap stops. Then, per channel in its range: the channel
/// and its names, the range the feed speaks for deleted (every row for
/// `WholeSource`), the staged rows inserted, rows that ended a day ago
/// pruned, the summary written. The last transaction also settles the
/// source's channels the feed did not list, and writes the source's status.
/// A failure, a duplicate start included, rolls back its transaction.
///
/// When the stored rows were read under another policy than this feed, or
/// under an unknown one, the swap replaces the whole source whatever
/// `req.scope` says, so rows of two policies never sit side by side. The
/// first transaction decides for all of them; a whole-source replace that
/// takes several transactions clears the applied policy in its first, so if
/// a later one fails, the next ingest replaces the whole source again.
///
/// `conn` should be an `IngestConnection`: foreign keys off, no automatic
/// checkpoint.
pub(crate) fn swap(conn: &Connection, prepared: &Prepared, req: &SwapRequest) -> Result<Swapped> {
    swap_in_chunks(conn, prepared, req, SWAP_CHUNK_ROWS)
}

fn swap_in_chunks(
    conn: &Connection,
    prepared: &Prepared,
    req: &SwapRequest,
    max_rows: u32,
) -> Result<Swapped> {
    let keys = &prepared.keys;
    let mut by_knum: Vec<Option<&KeyBounds>> = vec![None; keys.keys.len()];
    for b in &prepared.bounds {
        by_knum[b.key as usize] = Some(b);
    }
    let chunks = plan_chunks(keys.keys.len(), &by_knum, max_rows);

    let mut scope = req.scope;
    let (mut stored, mut hold) = (0u32, Duration::ZERO);
    for (n, &(from, to)) in chunks.iter().enumerate() {
        let tx = Transaction::new_unchecked(conn, TransactionBehavior::Immediate)?;
        // The write lock is held from here: `BEGIN IMMEDIATE` waited for it.
        let locked = Instant::now();
        // Dropping `tx` on these returns rolls back.
        let Some(state) = source_state(&tx, req.source_id)? else {
            return Ok(Swapped::Abandoned(AbandonReason::SourceRemoved));
        };
        if let Some(reason) = state.mismatch(req.expected_url) {
            return Ok(Swapped::Abandoned(reason));
        }
        if n == 0 {
            if state.applied != Some(req.policy) {
                scope = IngestScope::WholeSource;
            }
            if scope == IngestScope::WholeSource && chunks.len() > 1 {
                tx.execute(CLEAR_APPLIED, params![req.source_id])?;
            }
        }

        let channels = upsert_channels(&tx, req.source_id, keys, from, to)?;
        write_names(&tx, &channels, keys, from)?;
        let fresh = &by_knum[from as usize..to as usize];
        let complete = prepared.parse.complete;
        let survivors = delete_replaced(&tx, &channels, fresh, scope, complete)?;
        let inserted = insert_staged(&tx, &channels, fresh, from)?;
        settle(&tx, &channels, fresh, &survivors, req.now, complete)?;

        if n + 1 == chunks.len() {
            settle_unlisted(&tx, keys, req, scope)?;
            write_status(&tx, prepared, req, state.last_success_at)?;
        }
        tx.execute(UPDATE_COUNT, params![req.source_id])?;
        tx.commit()?;
        hold = hold.max(locked.elapsed());
        stored += inserted;
        checkpoint(conn);
    }

    Ok(Swapped::Committed {
        stored,
        transactions: u32::try_from(chunks.len()).unwrap_or(u32::MAX),
        hold,
    })
}

/// Create the range's channels in feed order, so new ids, and with them
/// the inserted rows, follow the primary key; return them as they were.
fn upsert_channels(
    tx: &Connection,
    source_id: i64,
    keys: &FeedKeys,
    from: u32,
    to: u32,
) -> rusqlite::Result<Vec<StoredChannel>> {
    let mut upsert = tx.prepare(UPSERT_CHANNEL)?;
    let mut select = tx.prepare(SELECT_CHANNEL)?;
    (from..to)
        .map(|knum| {
            let key = keys.key(knum);
            upsert.execute(params![source_id, key])?;
            select.query_row(params![source_id, key], map_channel)
        })
        .collect()
}

/// Replace the display names of every channel in the range the feed described.
fn write_names(
    tx: &Connection,
    channels: &[StoredChannel],
    keys: &FeedKeys,
    from: u32,
) -> rusqlite::Result<()> {
    let mut delete = tx.prepare(DELETE_NAMES)?;
    let mut insert = tx.prepare(INSERT_NAME)?;
    for (channel, names) in channels.iter().zip(&keys.names[from as usize..]) {
        let Some(names) = names else {
            continue;
        };
        delete.execute(params![channel.id])?;
        let mut position = 0;
        for name in names {
            if let Some(name_key) = name_key(name) {
                insert.execute(params![channel.id, position, name, name_key])?;
                position += 1;
            }
        }
    }
    Ok(())
}

/// Delete what the feed replaces; returns per channel how many earlier rows
/// survived, `None` when the stored count is behind the table and the
/// channel must be recounted.
fn delete_replaced(
    tx: &Connection,
    channels: &[StoredChannel],
    fresh: &[Option<&KeyBounds>],
    scope: IngestScope,
    complete: bool,
) -> rusqlite::Result<Vec<Option<u32>>> {
    let mut survivors = Vec::with_capacity(channels.len());
    match scope {
        IngestScope::WholeSource => {
            let mut delete = tx.prepare(DELETE_CHANNEL_ROWS)?;
            for c in channels {
                delete.execute(params![c.id])?;
                survivors.push(Some(0));
            }
        }
        IngestScope::Feed => {
            let mut from_first = tx.prepare(DELETE_FROM_FIRST_START)?;
            let mut window = tx.prepare(DELETE_WINDOW)?;
            for (c, new) in channels.iter().zip(fresh) {
                let removed = match new {
                    None => 0,
                    Some(b) if complete => from_first.execute(params![c.id, b.first_start])?,
                    // Rows past the point where the feed broke off stay.
                    Some(b) => window.execute(params![c.id, b.first_start, b.last_stop])?,
                };
                survivors.push(c.summary.count.checked_sub(changed(removed)));
            }
        }
    }
    Ok(survivors)
}

/// Insert each channel's kept rows from staging, with the channel id known,
/// and check the count against what `normalise` kept.
fn insert_staged(
    tx: &Connection,
    channels: &[StoredChannel],
    fresh: &[Option<&KeyBounds>],
    from: u32,
) -> Result<u32> {
    let mut insert = tx.prepare(INSERT_FROM_STAGING)?;
    let mut inserted = 0;
    for ((knum, c), new) in (from..).zip(channels).zip(fresh) {
        let Some(b) = new else {
            continue;
        };
        let rows = changed(insert.execute(params![c.id, knum])?);
        ensure!(
            rows == b.count,
            "The EPG store inserted {rows} programmes for a channel instead of {}",
            b.count
        );
        inserted += rows;
    }
    Ok(inserted)
}

/// Prune and write the summary of each channel. New rows never qualify for
/// the prune: `normalise` dropped them.
fn settle(
    tx: &Connection,
    channels: &[StoredChannel],
    fresh: &[Option<&KeyBounds>],
    survivors: &[Option<u32>],
    now: i64,
    complete: bool,
) -> rusqlite::Result<()> {
    let cutoff = now.saturating_sub(ENDED_GRACE_SECS);
    let mut prune = tx.prepare(PRUNE)?;
    let mut update = tx.prepare(UPDATE_SUMMARY)?;
    for ((c, new), survived) in channels.iter().zip(fresh).zip(survivors) {
        let summary = match *survived {
            Some(0) => Summary::of_new(*new),
            Some(left) => {
                let pruned = changed(prune.execute(params![c.id, cutoff])?);
                match left.checked_sub(pruned) {
                    Some(0) => Summary::of_new(*new),
                    Some(_) if pruned == 0 && new.is_none() => c.summary,
                    Some(left) => summary_with_survivors(tx, c, *new, left, complete)?,
                    None => recount(tx, c.id)?,
                }
            }
            None => {
                prune.execute(params![c.id, cutoff])?;
                recount(tx, c.id)?
            }
        };
        if summary != c.summary {
            update.execute(params![
                c.id,
                summary.first_start,
                summary.last_stop,
                summary.count
            ])?;
        }
    }
    Ok(())
}

/// The source's channels the feed did not list: all their rows go for
/// `WholeSource`; otherwise they stay until pruned.
fn settle_unlisted(
    tx: &Connection,
    keys: &FeedKeys,
    req: &SwapRequest,
    scope: IngestScope,
) -> rusqlite::Result<()> {
    let unlisted: Vec<StoredChannel> = tx
        .prepare(SELECT_CHANNELS)?
        .query_map(params![req.source_id], map_channel)?
        .filter(|c| {
            c.as_ref()
                .map_or(true, |c| !keys.index.contains_key(&c.key))
        })
        .collect::<rusqlite::Result<_>>()?;
    let fresh = vec![None; unlisted.len()];
    let survivors = delete_replaced(tx, &unlisted, &fresh, scope, true)?;
    settle(tx, &unlisted, &fresh, &survivors, req.now, true)
}

fn write_status(
    tx: &Connection,
    prepared: &Prepared,
    req: &SwapRequest,
    last_success_at: Option<i64>,
) -> rusqlite::Result<()> {
    let parse = &prepared.parse;
    let replacements = i64::try_from(parse.decode_replacements).unwrap_or(i64::MAX);
    if !req.network {
        tx.execute(
            UPDATE_CACHE_STATUS,
            params![
                req.source_id,
                parse.unknown_zone_count,
                parse.unknown_zone_sample,
                replacements,
                req.policy.interpret.as_str(),
                req.policy.shift_minutes,
            ],
        )?;
        return Ok(());
    }
    let result = if parse.complete {
        LastResult::Ok
    } else {
        LastResult::Partial
    };
    tx.execute(
        UPDATE_STATUS,
        params![
            req.source_id,
            result.as_db(),
            parse.unknown_zone_count,
            parse.unknown_zone_sample,
            replacements,
            req.policy.interpret.as_str(),
            req.policy.shift_minutes,
            success_after(last_success_at, result, true, req.now),
        ],
    )?;
    Ok(())
}

/// Copy the WAL back into the database after a swap transaction, on the
/// ingest's thread instead of inside `COMMIT` or another connection's next
/// write, and so the WAL grows to one transaction instead of the whole
/// feed. Passive: it waits for no reader, and no writer waits for it.
fn checkpoint(conn: &Connection) {
    if let Err(e) = conn.query_row("PRAGMA wal_checkpoint(PASSIVE)", [], |_| Ok(())) {
        warn!("EPG ingest: WAL checkpoint failed: {e}");
    }
}

/// The summary of a channel that keeps rows from before next to its new
/// ones (or instead of them), from primary-key seeks rather than a scan.
///
/// The earliest start is one seek. The latest stop: a channel without new
/// rows keeps its old one, because the row that ends last was not pruned
/// while any row survived. A complete feed's survivors all ended before its
/// first new start, so the new rows' last stop stands. After a partial feed,
/// rows past the break may end later; only those are read.
fn summary_with_survivors(
    tx: &Connection,
    c: &StoredChannel,
    new: Option<&KeyBounds>,
    left: u32,
    complete: bool,
) -> rusqlite::Result<Summary> {
    let last_stop = match new {
        None => match c.summary.last_stop {
            Some(stop) => stop,
            None => return recount(tx, c.id),
        },
        Some(b) if complete => b.last_stop,
        Some(b) => {
            let after_break: Option<i64> =
                tx.query_row(LAST_STOP_FROM, params![c.id, b.last_stop], |r| r.get(0))?;
            after_break.map_or(b.last_stop, |stop| stop.max(b.last_stop))
        }
    };
    let first_start: i64 = tx.query_row(FIRST_START, params![c.id], |r| r.get(0))?;
    Ok(Summary {
        first_start: Some(first_start),
        last_stop: Some(last_stop),
        count: left + new.map_or(0, |b| b.count),
    })
}

/// A channel's summary counted from its rows: only when the stored count
/// disagrees with what a delete removed, which a consistent store never sees.
fn recount(tx: &Connection, channel_id: i64) -> rusqlite::Result<Summary> {
    tx.query_row(RECOUNT, params![channel_id], |r| {
        let count: i64 = r.get(2)?;
        Ok(Summary {
            first_start: r.get(0)?,
            last_stop: r.get(1)?,
            count: u32::try_from(count).unwrap_or(u32::MAX),
        })
    })
}

// ========== The whole store ==========

/// What storing one feed did.
#[derive(Debug)]
pub(crate) struct StoreReport {
    pub parse: ParseReport,
    pub normalise: NormaliseReport,
    pub stored: u32,
    /// Channels with programmes in this feed.
    pub keys: u32,
    /// Decode, parse and staging.
    pub parse_time: Duration,
    pub normalise_time: Duration,
    /// Verdict marks plus the swap.
    pub store_time: Duration,
    /// Write transactions the swap took (more than one for a large feed).
    pub transactions: u32,
    /// The longest the swap held the database's write lock at once.
    pub lock_hold: Duration,
}

#[derive(Debug)]
pub(crate) enum Stored {
    Committed(Box<StoreReport>),
    Abandoned(AbandonReason),
}

/// Stage, normalise and swap one feed into the source `req` names, on the
/// ingest's own connection. Runs on a blocking thread; the caller holds the
/// EPG refresh lock.
pub(crate) fn store_feed<R: BufRead, Tz: TimeZone>(
    ingest: &IngestConnection,
    cache_dir: &Path,
    input: R,
    req: &SwapRequest,
    local: &Tz,
) -> Result<Stored> {
    let conn = ingest.conn();
    let staging = Staging::attach(conn, cache_dir)?;
    let started = Instant::now();
    let staged = stage(&staging, input, req.policy, local, req.now)?;
    let parse_time = started.elapsed();

    let prepared = prepare(&staging, staged, req.now, req.network)?;
    let started = Instant::now();
    let swapped = swap(conn, &prepared, req).context(STORE_FAILURE)?;
    let swap_time = started.elapsed();
    drop(staging);

    Ok(match swapped {
        Swapped::Abandoned(reason) => Stored::Abandoned(reason),
        Swapped::Committed {
            stored,
            transactions,
            hold,
        } => Stored::Committed(Box::new(StoreReport {
            transactions,
            keys: prepared.channels_with_programmes(),
            stored,
            parse_time,
            normalise_time: prepared.normalise_time,
            store_time: prepared.mark_time + swap_time,
            lock_hold: hold,
            parse: prepared.parse,
            normalise: prepared.normalise,
        })),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::epg::sources::{update_source, SourcePatch};
    use crate::epg::test_support::*;
    use crate::epg::{ingest, Fetch, IngestOutcome};
    use crate::epg_domain::policy::Interpret;
    use chrono::Utc;

    const URL: &str = "http://guide.example/epg.xml";

    fn source(f: &Fixture) -> i64 {
        add_manual(&f.conn(), URL)
    }

    async fn reingest(
        f: &Fixture,
        source_id: i64,
        scope: IngestScope,
        now: i64,
    ) -> Result<IngestOutcome, crate::error::AppError> {
        let outcome = ingest(&f.env(), source_id, Fetch::Cache, scope, now).await;
        assert_summaries_exact(&f.conn());
        outcome
    }

    fn staging_left(f: &Fixture) -> bool {
        staging_path(&f.dir.0).exists()
    }

    fn attached_anywhere(f: &Fixture) -> bool {
        // Both pooled connections at once, so each is checked.
        let (a, b) = (f.conn(), f.conn());
        is_attached(&a).unwrap() || is_attached(&b).unwrap()
    }

    #[tokio::test]
    async fn a_moved_start_leaves_no_old_row() {
        let f = Fixture::new("store");
        let s = source(&f);
        let first = Feed::new()
            .programme("svt1.se", NOW, NOW + H, "News")
            .programme("svt1.se", NOW + H, NOW + 2 * H, "Film");
        f.store(s, &first.xml(), NOW).await;

        // The provider moved both programmes by half an hour.
        let moved = Feed::new()
            .programme("svt1.se", NOW + H / 2, NOW + 3 * H / 2, "News")
            .programme("svt1.se", NOW + 3 * H / 2, NOW + 2 * H, "Film");
        f.store(s, &moved.xml(), NOW).await;

        assert_eq!(
            f.programmes(s),
            rows(&[
                ("svt1.se", NOW + H / 2, NOW + 3 * H / 2, "News"),
                ("svt1.se", NOW + 3 * H / 2, NOW + 2 * H, "Film"),
            ])
        );
    }

    #[tokio::test]
    async fn rows_before_a_channels_first_new_start_survive() {
        let f = Fixture::new("store");
        let s = source(&f);
        let first = Feed::new()
            .programme("svt1.se", NOW - 4 * H, NOW - 3 * H, "Morning")
            .programme("svt1.se", NOW - 3 * H, NOW - 2 * H, "Noon")
            .programme("svt1.se", NOW - 2 * H, NOW - H, "Afternoon")
            .programme("svt1.se", NOW - H, NOW, "Old evening");
        f.store(s, &first.xml(), NOW).await;

        let later = Feed::new()
            .programme("svt1.se", NOW - H, NOW, "Evening")
            .programme("svt1.se", NOW, NOW + H, "Night");
        let report = f.store(s, &later.xml(), NOW).await;

        assert_eq!(report.stored, 2);
        assert_eq!(
            f.programmes(s),
            rows(&[
                ("svt1.se", NOW - 4 * H, NOW - 3 * H, "Morning"),
                ("svt1.se", NOW - 3 * H, NOW - 2 * H, "Noon"),
                ("svt1.se", NOW - 2 * H, NOW - H, "Afternoon"),
                ("svt1.se", NOW - H, NOW, "Evening"),
                ("svt1.se", NOW, NOW + H, "Night"),
            ])
        );
        assert_eq!(f.status::<i64>(s, "programme_count"), 5);
    }

    #[tokio::test]
    async fn a_channel_missing_from_the_feed_survives_until_it_is_pruned() {
        let f = Fixture::new("store");
        let s = source(&f);
        let both = Feed::new()
            .programme("svt1.se", NOW, NOW + H, "One")
            .programme("svt2.se", NOW, NOW + H, "Two");
        f.store(s, &both.xml(), NOW).await;

        let one = Feed::new().programme("svt1.se", NOW, NOW + H, "One again");
        f.store(s, &one.xml(), NOW).await;
        assert_eq!(
            f.programmes(s),
            rows(&[
                ("svt1.se", NOW, NOW + H, "One again"),
                ("svt2.se", NOW, NOW + H, "Two"),
            ])
        );

        // A day and a second after both ended, the next feed prunes them.
        let later = NOW + H + ENDED_GRACE_SECS + 1;
        let next = Feed::new().programme("svt1.se", later, later + H, "Tomorrow");
        f.store(s, &next.xml(), later).await;
        assert_eq!(
            f.programmes(s),
            rows(&[("svt1.se", later, later + H, "Tomorrow")])
        );
        let svt2: (Option<i64>, Option<i64>, i64) = f
            .conn()
            .query_row(
                "SELECT first_start, last_stop, programme_count FROM epg_channel
                 WHERE source_id = ?1 AND key = 'svt2.se'",
                params![s],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(svt2, (None, None, 0));
    }

    #[tokio::test]
    async fn a_truncated_feed_after_a_full_one_keeps_the_rows_past_the_cut() {
        let f = Fixture::new("store");
        let s = source(&f);
        let full = Feed::new()
            .programme("svt1.se", NOW - 2 * H, NOW - H, "Before")
            .programme("svt1.se", NOW, NOW + H, "A")
            .programme("svt1.se", NOW + H, NOW + 2 * H, "B")
            .programme("svt1.se", NOW + 2 * H, NOW + 3 * H, "C")
            .programme("svt1.se", NOW + 3 * H, NOW + 5 * H, "D");
        f.store(s, &full.xml(), NOW).await;

        let cut = Feed::new()
            .programme("svt1.se", NOW, NOW + H, "A2")
            .programme("svt1.se", NOW + H, NOW + 2 * H, "B2");
        let report = f.store(s, &cut.truncated_xml(), NOW).await;

        assert!(!report.parse.complete);
        assert_eq!(
            f.programmes(s),
            rows(&[
                ("svt1.se", NOW - 2 * H, NOW - H, "Before"),
                ("svt1.se", NOW, NOW + H, "A2"),
                ("svt1.se", NOW + H, NOW + 2 * H, "B2"),
                ("svt1.se", NOW + 2 * H, NOW + 3 * H, "C"),
                ("svt1.se", NOW + 3 * H, NOW + 5 * H, "D"),
            ])
        );
    }

    #[tokio::test]
    async fn programmes_that_ended_over_a_day_ago_are_never_stored() {
        let f = Fixture::new("store");
        let s = source(&f);
        let feed = Feed::new()
            .programme("svt1.se", NOW - 26 * H, NOW - 25 * H, "Gone")
            .programme("svt1.se", NOW - 25 * H, NOW - 23 * H, "Still listed")
            .programme("svt1.se", NOW, NOW + H, "Now");

        let report = f.store(s, &feed.xml(), NOW).await;

        assert_eq!(report.normalise.ended_before_cutoff_dropped, 1);
        assert_eq!(
            f.programmes(s),
            rows(&[
                ("svt1.se", NOW - 25 * H, NOW - 23 * H, "Still listed"),
                ("svt1.se", NOW, NOW + H, "Now"),
            ])
        );
    }

    #[tokio::test]
    async fn a_failing_swap_rolls_back_and_keeps_the_previous_guide() {
        let f = Fixture::new("store");
        let s = source(&f);
        let first = Feed::new()
            .programme("svt1.se", NOW, NOW + H, "News")
            .programme("svt2.se", NOW, NOW + H, "Sport")
            .channel("svt1.se", &["SVT1"]);
        f.store(s, &first.xml(), NOW).await;
        let before = f.programmes(s);
        f.conn()
            .execute_batch(
                "CREATE TRIGGER fail_swap BEFORE INSERT ON epg_programme
                 WHEN NEW.title = 'Boom' BEGIN SELECT RAISE(ABORT, 'boom'); END;",
            )
            .unwrap();

        // The delete and the first insert run before the trigger fires.
        let failing = Feed::new()
            .channel("svt1.se", &["SVT 1 HD"])
            .programme("svt1.se", NOW, NOW + H, "News 2")
            .programme("svt2.se", NOW, NOW + H, "Boom");
        f.cache(s, &failing.xml());
        let err = reingest(&f, s, IngestScope::Feed, NOW).await.unwrap_err();

        assert_eq!(err.to_string(), "EPG error: Failed to store the EPG");
        assert_eq!(f.programmes(s), before);
        let names: Vec<String> = f
            .conn()
            .prepare("SELECT name FROM epg_channel_name")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert_eq!(names, ["SVT1"]);
        // A re-read of the cache leaves the provider's status alone.
        assert_eq!(f.status::<Option<String>>(s, "last_result"), None);
        assert_eq!(f.status::<Option<String>>(s, "last_error"), None);
        assert_eq!(f.status::<i64>(s, "programme_count"), 2);
    }

    #[tokio::test]
    async fn staging_is_gone_after_a_success_and_after_a_failure() {
        let f = Fixture::new("store");
        let s = source(&f);
        let feed = Feed::new().programme("svt1.se", NOW, NOW + H, "News");
        f.store(s, &feed.xml(), NOW).await;
        assert!(!staging_left(&f));
        assert!(!attached_anywhere(&f));

        f.cache(s, &Feed::new().xml());
        let err = reingest(&f, s, IngestScope::Feed, NOW).await.unwrap_err();
        assert_eq!(err.to_string(), format!("EPG error: {EMPTY_CACHE_MESSAGE}"));
        assert!(!staging_left(&f));
        assert!(!attached_anywhere(&f));

        // A leftover from a crashed ingest is replaced, not appended to.
        std::fs::write(staging_path(&f.dir.0), b"not a database").unwrap();
        f.store(s, &feed.xml(), NOW).await;
        assert!(!staging_left(&f));
    }

    #[test]
    fn a_connection_left_attached_is_detached_first() {
        let f = Fixture::new("store");
        let conn = f.conn();
        let staging = Staging::attach(&conn, &f.dir.0).unwrap();
        std::mem::forget(staging);
        assert!(is_attached(&conn).unwrap());

        let staging = Staging::attach(&conn, &f.dir.0).unwrap();
        drop(staging);
        assert!(!is_attached(&conn).unwrap());
        assert!(!staging_left(&f));
    }

    fn request(source_id: i64, scope: IngestScope) -> SwapRequest<'static> {
        SwapRequest {
            source_id,
            expected_url: Some(URL),
            policy: TimePolicy::default(),
            scope,
            network: true,
            now: NOW,
        }
    }

    fn prepared(staging: &Staging, feed: &Feed) -> Prepared {
        let xml = feed.xml();
        let staged = stage(staging, xml.as_bytes(), TimePolicy::default(), &Utc, NOW).unwrap();
        prepare(staging, staged, NOW, true).unwrap()
    }

    #[tokio::test]
    async fn a_duplicate_start_reaching_the_swap_fails_it() {
        let f = Fixture::new("store");
        let s = source(&f);
        let first = Feed::new().programme("svt1.se", NOW, NOW + H, "News");
        f.store(s, &first.xml(), NOW).await;
        let before = f.programmes(s);

        let ingest = f.ingest_connection();
        let conn = ingest.conn();
        let staging = Staging::attach(conn, &f.dir.0).unwrap();
        let next = Feed::new().programme("svt1.se", NOW, NOW + H, "News 2");
        let prepared = prepared(&staging, &next);
        // A second row at the same start, as a broken `normalise` would leave.
        conn.execute(
            "INSERT INTO ingest.epg_ingest (knum, seq, start, stop, title)
             VALUES (0, 99, ?1, ?2, 'Twin')",
            params![NOW, NOW + H],
        )
        .unwrap();

        let err = swap(conn, &prepared, &request(s, IngestScope::Feed)).unwrap_err();
        drop(staging);
        drop(ingest);

        assert!(
            format!("{err:#}").contains("UNIQUE constraint failed"),
            "{err:#}"
        );
        assert_eq!(f.programmes(s), before);
        assert_eq!(f.status::<Option<String>>(s, "last_result"), None);
        assert_summaries_exact(&f.conn());
    }

    #[tokio::test]
    async fn a_source_changed_before_the_swap_is_left_alone() {
        let f = Fixture::new("store");
        let next = Feed::new().programme("svt1.se", NOW, NOW + H, "News");
        type Change = fn(&Connection, &Path, i64);
        let changes: [(&str, Change, AbandonReason); 3] = [
            (
                "url",
                |conn, dir, id| {
                    let patch = SourcePatch {
                        url: Some("http://other.example/epg.xml".to_string()),
                        ..SourcePatch::default()
                    };
                    update_source(conn, dir, id, &patch).unwrap();
                },
                AbandonReason::UrlChanged,
            ),
            (
                "disabled",
                |conn, dir, id| {
                    let patch = SourcePatch {
                        enabled: Some(false),
                        ..SourcePatch::default()
                    };
                    update_source(conn, dir, id, &patch).unwrap();
                },
                AbandonReason::SourceDisabled,
            ),
            (
                "removed",
                |conn, dir, id| crate::epg::sources::remove_source(conn, dir, id).unwrap(),
                AbandonReason::SourceRemoved,
            ),
        ];
        for (what, change, reason) in changes {
            let conn = f.conn();
            let s = add_manual(&conn, &format!("{URL}?{what}"));
            let staging = Staging::attach(&conn, &f.dir.0).unwrap();
            let prepared = prepared(&staging, &next);
            change(&f.conn(), &f.dir.0, s);

            let mut req = request(s, IngestScope::Feed);
            let url = format!("{URL}?{what}");
            req.expected_url = Some(&url);
            let outcome = swap(&conn, &prepared, &req).unwrap();
            drop(staging);

            assert_eq!(outcome, Swapped::Abandoned(reason), "{what}");
            assert!(f.programmes(s).is_empty(), "{what}");
            let channels: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM epg_channel WHERE source_id = ?1",
                    params![s],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(channels, 0, "{what}");
            if reason != AbandonReason::SourceRemoved {
                assert_eq!(f.status::<Option<String>>(s, "last_result"), None, "{what}");
                assert_eq!(
                    f.status::<Option<String>>(s, "applied_interpret"),
                    None,
                    "{what}"
                );
            }
        }
    }

    #[tokio::test]
    async fn two_sources_with_one_key_do_not_collide() {
        let f = Fixture::new("store");
        let a = add_manual(&f.conn(), "http://a.example/epg.xml");
        let b = add_manual(&f.conn(), "http://b.example/epg.xml");
        let from_a = Feed::new().programme("SVT1.se", NOW, NOW + H, "From A");
        let from_b = Feed::new()
            .programme("svt1.se", NOW, NOW + H, "From B")
            .programme("svt1.se", NOW + H, NOW + 2 * H, "Later from B");

        f.store(a, &from_a.xml(), NOW).await;
        f.store(b, &from_b.xml(), NOW).await;
        f.store(a, &from_a.xml(), NOW).await;

        assert_eq!(
            f.programmes(a),
            rows(&[("svt1.se", NOW, NOW + H, "From A")])
        );
        assert_eq!(
            f.programmes(b),
            rows(&[
                ("svt1.se", NOW, NOW + H, "From B"),
                ("svt1.se", NOW + H, NOW + 2 * H, "Later from B"),
            ])
        );
        assert_eq!(f.status::<i64>(a, "programme_count"), 1);
        assert_eq!(f.status::<i64>(b, "programme_count"), 2);
    }

    /// Every row of the guide tables, for comparing two states.
    fn snapshot(conn: &Connection) -> Vec<String> {
        let mut out = Vec::new();
        for sql in [
            "SELECT channel_id, start, stop, title, description, category FROM epg_programme",
            "SELECT id, source_id, key, first_start, last_stop, programme_count FROM epg_channel",
            "SELECT channel_id, position, name, name_key FROM epg_channel_name",
            "SELECT id, last_result, last_error, programme_count, applied_interpret,
                    applied_shift_minutes, last_success_at FROM epg_source",
        ] {
            let mut stmt = conn.prepare(sql).unwrap();
            let columns = stmt.column_count();
            let mut rows = stmt.query([]).unwrap();
            while let Some(row) = rows.next().unwrap() {
                let values: Vec<String> = (0..columns)
                    .map(|i| format!("{:?}", row.get_ref(i).unwrap()))
                    .collect();
                out.push(values.join("|"));
            }
        }
        out
    }

    #[tokio::test]
    async fn the_same_feed_twice_leaves_the_same_tables() {
        let f = Fixture::new("store");
        let s = source(&f);
        let feed = Feed::new()
            .channel("svt1.se", &["SVT1", "SVT 1 HD"])
            .channel("tv4.se", &["TV4"])
            .programme("svt1.se", NOW - 2 * H, NOW - H, "Earlier")
            .programme("svt1.se", NOW - H, NOW + H, "Long")
            .programme("svt1.se", NOW, NOW + H / 2, "Nested")
            .programme("tv4.se", NOW, NOW + H, "Nyheterna");

        f.store(s, &feed.xml(), NOW).await;
        let once = snapshot(&f.conn());
        f.store(s, &feed.xml(), NOW).await;

        assert_eq!(snapshot(&f.conn()), once);
    }

    #[tokio::test]
    async fn summaries_follow_rows_kept_on_both_sides_of_a_partial_feed() {
        let f = Fixture::new("store");
        let s = source(&f);
        let full = Feed::new()
            .programme("svt1.se", NOW - 3 * H, NOW - 2 * H, "Early")
            .programme("svt1.se", NOW, NOW + 6 * H, "Marathon")
            .programme("svt1.se", NOW + 6 * H, NOW + 9 * H, "Late")
            .programme("tv4.se", NOW, NOW + H, "Other");
        f.store(s, &full.xml(), NOW).await;

        // Breaks off after one programme ending before "Late" starts.
        let cut = Feed::new().programme("svt1.se", NOW - H, NOW + H, "New");
        f.store(s, &cut.truncated_xml(), NOW).await;

        let svt1: (i64, i64, i64) = f
            .conn()
            .query_row(
                "SELECT first_start, last_stop, programme_count FROM epg_channel
                 WHERE source_id = ?1 AND key = 'svt1.se'",
                params![s],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(svt1, (NOW - 3 * H, NOW + 9 * H, 3));
        assert_eq!(f.status::<i64>(s, "programme_count"), 4);
    }

    #[tokio::test]
    async fn the_applied_policy_is_the_one_the_times_were_read_with() {
        let f = Fixture::new("store");
        let s = source(&f);
        f.set_shift(s, 60);
        let feed = Feed::new().programme("svt1.se", NOW, NOW + H, "News");

        let report = f.store(s, &feed.xml(), NOW).await;

        assert_eq!(report.policy.shift_minutes, 60);
        assert_eq!(
            f.programmes(s),
            rows(&[("svt1.se", NOW + H, NOW + 2 * H, "News")])
        );
        assert_eq!(
            f.status::<Option<String>>(s, "applied_interpret")
                .as_deref(),
            Some(Interpret::AsWritten.as_str())
        );
        assert_eq!(
            f.status::<Option<i64>>(s, "applied_shift_minutes"),
            Some(60)
        );
    }

    #[tokio::test]
    async fn a_policy_change_re_read_from_the_cache_replaces_every_row() {
        let f = Fixture::new("store");
        let s = source(&f);
        let feed = Feed::new()
            .programme("svt1.se", NOW, NOW + H, "News")
            .programme("svt1.se", NOW + H, NOW + 2 * H, "Film")
            .programme("tv4.se", NOW, NOW + H, "Nyheterna");
        f.store(s, &feed.xml(), NOW).await;
        let success: Option<i64> = f.status(s, "last_success_at");
        let attempt: Option<i64> = f.status(s, "last_attempt_at");

        // Two hours later: under a per-channel replace the old rows would
        // survive before the new first start.
        f.set_shift(s, 120);
        let outcome = reingest(&f, s, IngestScope::WholeSource, NOW)
            .await
            .unwrap();

        let IngestOutcome::Stored(report) = outcome else {
            panic!("not stored: {outcome:?}");
        };
        assert_eq!(report.scope, IngestScope::WholeSource);
        assert_eq!(
            f.programmes(s),
            rows(&[
                ("svt1.se", NOW + 2 * H, NOW + 3 * H, "News"),
                ("svt1.se", NOW + 3 * H, NOW + 4 * H, "Film"),
                ("tv4.se", NOW + 2 * H, NOW + 3 * H, "Nyheterna"),
            ])
        );
        assert_eq!(
            f.status::<Option<i64>>(s, "applied_shift_minutes"),
            Some(120)
        );
        assert_eq!(f.status::<Option<i64>>(s, "last_success_at"), success);
        assert_eq!(f.status::<Option<i64>>(s, "last_attempt_at"), attempt);
    }

    #[tokio::test]
    async fn a_stale_cache_with_nothing_left_keeps_the_guide_and_the_applied_policy() {
        let f = Fixture::new("store");
        let s = source(&f);
        let feed = Feed::new().programme("svt1.se", NOW, NOW + H, "News");
        f.store(s, &feed.xml(), NOW).await;

        f.set_shift(s, -60);
        let later = NOW + 3 * ENDED_GRACE_SECS;
        let err = reingest(&f, s, IngestScope::WholeSource, later)
            .await
            .unwrap_err();

        assert_eq!(err.to_string(), format!("EPG error: {EMPTY_CACHE_MESSAGE}"));
        assert_eq!(f.programmes(s), rows(&[("svt1.se", NOW, NOW + H, "News")]));
        assert_eq!(f.status::<Option<i64>>(s, "applied_shift_minutes"), Some(0));
    }

    #[tokio::test]
    async fn display_names_are_stored_per_channel_and_replaced() {
        let f = Fixture::new("store");
        let s = source(&f);
        let feed = Feed::new()
            .channel("SVT1.se", &["SVT1", "SVT 1 HD"])
            .channel("svt1.se", &["SVT1", "SVT_1"])
            .channel("radio.se", &["P1 Radio"])
            .programme("svt1.se", NOW, NOW + H, "News");
        f.store(s, &feed.xml(), NOW).await;

        let names = |f: &Fixture| -> Vec<(String, i64, String, String)> {
            f.conn()
                .prepare(
                    "SELECT c.key, n.position, n.name, n.name_key FROM epg_channel_name n
                     JOIN epg_channel c ON c.id = n.channel_id ORDER BY c.key, n.position",
                )
                .unwrap()
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
                .unwrap()
                .collect::<rusqlite::Result<_>>()
                .unwrap()
        };
        let expected = [
            ("radio.se", 0, "P1 Radio", "p1 radio"),
            ("svt1.se", 0, "SVT1", "svt1"),
            ("svt1.se", 1, "SVT 1 HD", "svt 1 hd"),
            ("svt1.se", 2, "SVT_1", "svt 1"),
        ];
        let expected: Vec<_> = expected
            .iter()
            .map(|(k, p, n, nk)| (k.to_string(), *p, n.to_string(), nk.to_string()))
            .collect();
        assert_eq!(names(&f), expected);
        // A described channel without programmes still gets its row.
        let radio: i64 = f
            .conn()
            .query_row(
                "SELECT programme_count FROM epg_channel WHERE key = 'radio.se'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(radio, 0);

        let renamed =
            Feed::new()
                .channel("svt1.se", &["SVT One"])
                .programme("svt1.se", NOW, NOW + H, "News");
        f.store(s, &renamed.xml(), NOW).await;
        let after = names(&f);
        assert_eq!(after[0], expected[0], "not described again, kept");
        assert_eq!(
            after[1..],
            [(
                "svt1.se".to_string(),
                0,
                "SVT One".to_string(),
                "svt one".to_string()
            )]
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
    fn the_swap_never_sorts_and_reaches_programmes_by_primary_key() {
        let f = Fixture::new("store");
        let conn = f.conn();
        let version: String = conn
            .query_row("SELECT sqlite_version()", [], |r| r.get(0))
            .unwrap();
        assert_eq!(version, "3.46.0", "plans pinned on the bundled SQLite");
        let _staging = Staging::attach(&conn, &f.dir.0).unwrap();

        for sql in [
            UPSERT_CHANNEL,
            SELECT_CHANNEL,
            SELECT_CHANNELS,
            DELETE_NAMES,
            INSERT_NAME,
            DELETE_CHANNEL_ROWS,
            DELETE_FROM_FIRST_START,
            DELETE_WINDOW,
            INSERT_FROM_STAGING,
            PRUNE,
            FIRST_START,
            LAST_STOP_FROM,
            RECOUNT,
            UPDATE_SUMMARY,
            SOURCE_STATE,
            UPDATE_COUNT,
            UPDATE_STATUS,
            UPDATE_CACHE_STATUS,
            CLEAR_APPLIED,
            MARK_STOP,
            MARK_DROPPED,
        ] {
            let lines = plan(&conn, sql);
            for line in &lines {
                assert!(!line.contains("TEMP B-TREE"), "{sql}\n{lines:?}");
                assert!(!line.contains("AUTOMATIC"), "{sql}\n{lines:?}");
                assert!(!line.starts_with("SCAN epg_programme"), "{sql}\n{lines:?}");
                assert!(!line.starts_with("SCAN epg_channel"), "{sql}\n{lines:?}");
                if line.contains("epg_programme") {
                    assert!(line.contains("USING PRIMARY KEY"), "{sql}\n{lines:?}");
                }
            }
        }

        for sql in [
            DELETE_CHANNEL_ROWS,
            DELETE_FROM_FIRST_START,
            DELETE_WINDOW,
            PRUNE,
        ] {
            let lines = plan(&conn, sql);
            assert!(
                lines
                    .iter()
                    .any(|l| l.starts_with("SEARCH epg_programme USING PRIMARY KEY")),
                "{sql}\n{lines:?}"
            );
        }
        assert_eq!(
            plan(&conn, INSERT_FROM_STAGING),
            ["SEARCH ingest.epg_ingest USING INDEX epg_ingest_knum (knum=?)"]
        );
    }

    #[test]
    fn chunks_hold_whole_channels_up_to_the_row_limit() {
        let bounds: Vec<KeyBounds> = [3, 0, 2, 5, 1]
            .iter()
            .enumerate()
            .map(|(key, &count)| KeyBounds {
                key: key as u32,
                first_start: 0,
                last_stop: 1,
                count,
            })
            .collect();
        let mut by_knum: Vec<Option<&KeyBounds>> = bounds.iter().map(Some).collect();
        // A described channel without programmes.
        by_knum[1] = None;

        assert_eq!(
            plan_chunks(5, &by_knum, 4),
            [(0, 2), (2, 3), (3, 4), (4, 5)]
        );
        assert_eq!(plan_chunks(5, &by_knum, 100), [(0, 5)]);
    }

    /// Store `first` as a whole, then swap `second` with chunks of at most
    /// `max_rows` programmes; returns the fixture and the transaction count.
    async fn swap_with_chunks(first: &Feed, second: &Feed, max_rows: u32) -> (Fixture, i64, u32) {
        let f = Fixture::new("store");
        let s = source(&f);
        f.store(s, &first.xml(), NOW).await;
        let ingest = f.ingest_connection();
        let staging = Staging::attach(ingest.conn(), &f.dir.0).unwrap();
        let prepared = prepared(&staging, second);
        let req = request(s, IngestScope::Feed);
        let outcome = swap_in_chunks(ingest.conn(), &prepared, &req, max_rows);
        drop(staging);
        drop(ingest);
        let Swapped::Committed { transactions, .. } = outcome.unwrap() else {
            panic!("abandoned");
        };
        assert_summaries_exact(&f.conn());
        (f, s, transactions)
    }

    #[tokio::test]
    async fn a_swap_in_several_transactions_leaves_what_one_transaction_does() {
        let first = Feed::new()
            .channel("gone.se", &["Gone"])
            .programme("gone.se", NOW - 3 * H, NOW - 2 * H, "Left over")
            .programme("svt1.se", NOW - 2 * H, NOW - H, "Survivor")
            .programme("svt1.se", NOW, NOW + H, "Old")
            .programme("tv4.se", NOW, NOW + 2 * H, "Old four");
        let second = Feed::new()
            .channel("svt1.se", &["SVT1"])
            .channel("radio.se", &["Radio"])
            .programme("tv4.se", NOW, NOW + H, "Four")
            .programme("svt1.se", NOW - H, NOW, "One")
            .programme("tv4.se", NOW + H, NOW + 2 * H, "Four later")
            .programme("svt1.se", NOW, NOW + H, "Two")
            .programme("kanal5.se", NOW, NOW + H, "Five");

        let (one, s1, once) = swap_with_chunks(&first, &second, SWAP_CHUNK_ROWS).await;
        let (many, s2, several) = swap_with_chunks(&first, &second, 2).await;

        assert_eq!(once, 1);
        assert_eq!(several, 3);
        assert_eq!(snapshot(&one.conn()), snapshot(&many.conn()));
        assert_eq!(one.programmes(s1), many.programmes(s2));
        assert_eq!(many.status::<i64>(s2, "programme_count"), 7);
    }

    fn shifted(minutes: i32) -> TimePolicy {
        TimePolicy {
            interpret: Interpret::AsWritten,
            shift_minutes: minutes,
        }
    }

    /// Stage and prepare `feed` read with `policy`, then swap it with at
    /// most `max_rows` programmes per transaction.
    fn swap_feed(f: &Fixture, req: &SwapRequest, feed: &Feed, max_rows: u32) -> Result<Swapped> {
        let ingest = f.ingest_connection();
        let staging = Staging::attach(ingest.conn(), &f.dir.0).unwrap();
        let xml = feed.xml();
        let staged = stage(&staging, xml.as_bytes(), req.policy, &Utc, req.now).unwrap();
        let prepared = prepare(&staging, staged, req.now, req.network).unwrap();
        swap_in_chunks(ingest.conn(), &prepared, req, max_rows)
    }

    fn add_trigger(f: &Fixture, sql: &str) {
        f.conn().execute_batch(sql).unwrap();
    }

    #[tokio::test]
    async fn rows_read_under_another_policy_are_all_replaced() {
        let f = Fixture::new("store");
        let s = source(&f);
        let feed = Feed::new()
            .programme("svt1.se", NOW, NOW + H, "News")
            .programme("svt1.se", NOW + H, NOW + 2 * H, "Film");
        f.store(s, &feed.xml(), NOW).await;

        // A policy set while a download ran: the next per-channel replace
        // would keep "News" at its old time, ending at the new first start.
        f.set_shift(s, 60);
        let report = f.store(s, &feed.xml(), NOW).await;

        assert_eq!(report.scope, IngestScope::Feed);
        assert_eq!(
            f.programmes(s),
            rows(&[
                ("svt1.se", NOW + H, NOW + 2 * H, "News"),
                ("svt1.se", NOW + 2 * H, NOW + 3 * H, "Film"),
            ])
        );
        assert_eq!(
            f.status::<Option<i64>>(s, "applied_shift_minutes"),
            Some(60)
        );
    }

    fn three_channels() -> Feed {
        let mut feed = Feed::new();
        for c in 1..=3 {
            let key = format!("c{c}.se");
            feed = feed
                .programme(&key, NOW, NOW + H, &format!("c{c} a"))
                .programme(&key, NOW + H, NOW + 2 * H, &format!("c{c} b"));
        }
        feed
    }

    #[tokio::test]
    async fn a_whole_source_replace_failing_half_way_is_finished_by_the_next_ingest() {
        for next_shift in [60, 0] {
            let f = Fixture::new("store");
            let s = source(&f);
            let feed = three_channels();
            f.store(s, &feed.xml(), NOW).await;
            add_trigger(
                &f,
                "CREATE TRIGGER fail_c3 BEFORE INSERT ON epg_programme
                 WHEN NEW.title = 'c3 a' BEGIN SELECT RAISE(ABORT, 'boom'); END;",
            );

            let req = SwapRequest {
                policy: shifted(60),
                ..request(s, IngestScope::WholeSource)
            };
            assert!(swap_feed(&f, &req, &feed, 2).is_err());

            // c1 is under the new policy, c3 under the old, and the source
            // says it does not know which.
            assert_eq!(f.status::<Option<i64>>(s, "applied_shift_minutes"), None);
            let progs = f.programmes(s);
            assert!(progs.contains(&("c1.se".into(), NOW + H, NOW + 2 * H, "c1 a".into())));
            assert!(progs.contains(&("c3.se".into(), NOW, NOW + H, "c3 a".into())));
            assert_summaries_exact(&f.conn());

            f.conn().execute_batch("DROP TRIGGER fail_c3").unwrap();
            f.set_shift(s, next_shift);
            f.store(s, &feed.xml(), NOW).await;

            let shift = i64::from(next_shift) * 60;
            let expected: Vec<_> = (1..=3)
                .flat_map(|c| {
                    [
                        (
                            format!("c{c}.se"),
                            NOW + shift,
                            NOW + H + shift,
                            format!("c{c} a"),
                        ),
                        (
                            format!("c{c}.se"),
                            NOW + H + shift,
                            NOW + 2 * H + shift,
                            format!("c{c} b"),
                        ),
                    ]
                })
                .collect();
            assert_eq!(f.programmes(s), expected, "next shift {next_shift}");
            assert_eq!(
                f.status::<Option<i64>>(s, "applied_shift_minutes"),
                Some(i64::from(next_shift))
            );
        }
    }

    #[tokio::test]
    async fn a_chunked_swap_stopped_between_transactions_leaves_exact_summaries() {
        let stops = [
            (
                "abandon",
                "CREATE TRIGGER stop_mid AFTER INSERT ON epg_programme
                 WHEN NEW.title = 'c1 a' BEGIN UPDATE epg_source SET enabled = 0; END;",
            ),
            (
                "failure",
                "CREATE TRIGGER stop_mid BEFORE INSERT ON epg_programme
                 WHEN NEW.title = 'c3 a' BEGIN SELECT RAISE(ABORT, 'boom'); END;",
            ),
        ];
        for scope in [IngestScope::Feed, IngestScope::WholeSource] {
            for (how, trigger) in stops {
                let f = Fixture::new("store");
                let s = source(&f);
                let old = Feed::new()
                    .programme("c1.se", NOW - 2 * H, NOW - H, "old 1")
                    .programme("c2.se", NOW, NOW + H, "old 2")
                    .programme("c3.se", NOW, NOW + 3 * H, "old 3")
                    .programme("c4.se", NOW, NOW + H, "old 4");
                f.store(s, &old.xml(), NOW).await;
                add_trigger(&f, trigger);

                let outcome = swap_feed(&f, &request(s, scope), &three_channels(), 2);

                match how {
                    "abandon" => assert_eq!(
                        outcome.unwrap(),
                        Swapped::Abandoned(AbandonReason::SourceDisabled),
                        "{scope:?}"
                    ),
                    _ => assert!(outcome.is_err(), "{scope:?}"),
                }
                // The first transaction committed, the rest did not run.
                let progs = f.programmes(s);
                assert!(
                    progs.contains(&("c1.se".into(), NOW, NOW + H, "c1 a".into())),
                    "{scope:?} {how}: {progs:?}"
                );
                assert!(
                    progs.contains(&("c3.se".into(), NOW, NOW + 3 * H, "old 3".into())),
                    "{scope:?} {how}: {progs:?}"
                );
                assert!(
                    progs.contains(&("c4.se".into(), NOW, NOW + H, "old 4".into())),
                    "{scope:?} {how}: {progs:?}"
                );
                assert_summaries_exact(&f.conn());
            }
        }
    }

    #[tokio::test]
    async fn a_feed_larger_than_one_staging_batch_is_stored_whole() {
        let f = Fixture::new("store");
        let s = source(&f);
        let mut feed = Feed::new();
        for c in 0..5 {
            for n in 0..500 {
                let start = NOW + n * H;
                feed = feed.programme(&format!("c{c}.se"), start, start + H, "Show");
            }
        }

        let report = f.store(s, &feed.xml(), NOW).await;

        assert_eq!(report.stored, 2_500);
        assert_eq!(f.programmes(s).len(), 2_500);
        assert_eq!(f.status::<i64>(s, "programme_count"), 2_500);
        // The ingest truncated the WAL on its way out: nobody was reading.
        let wal = std::fs::metadata(f.dir.0.join("app.db-wal")).map_or(0, |m| m.len());
        assert_eq!(wal, 0);
    }

    #[tokio::test]
    async fn programmes_that_ended_long_ago_are_not_staged() {
        let f = Fixture::new("store");
        let ingest = f.ingest_connection();
        let staging = Staging::attach(ingest.conn(), &f.dir.0).unwrap();
        let feed = Feed::new()
            .programme("svt1.se", NOW - 30 * H, NOW - 29 * H, "Gone")
            .programme("svt1.se", NOW - 25 * H, NOW - 24 * H, "Gone at the cutoff")
            .programme("svt1.se", NOW - 24 * H, NOW - 23 * H, "Kept")
            .programme("svt1.se", NOW, NOW + H, "Now");
        let xml = feed.xml();

        let staged = stage(&staging, xml.as_bytes(), TimePolicy::default(), &Utc, NOW).unwrap();
        let in_staging: i64 = ingest
            .conn()
            .query_row("SELECT COUNT(*) FROM ingest.epg_ingest", [], |r| r.get(0))
            .unwrap();
        let prepared = prepare(&staging, staged, NOW, true).unwrap();

        assert_eq!(in_staging, 2);
        assert_eq!(prepared.kept, 2);
        assert_eq!(prepared.normalise.ended_before_cutoff_dropped, 2);
    }

    #[tokio::test]
    async fn a_re_read_from_the_cache_leaves_the_providers_status_alone() {
        let f = Fixture::new("store");
        let s = source(&f);
        let feed = Feed::new().programme("svt1.se", NOW, NOW + H, "News");
        f.store(s, &feed.xml(), NOW).await;
        let provider = "The EPG server answered 500 Internal Server Error";
        f.conn()
            .execute(
                "UPDATE epg_source SET last_result = 'error', last_error = ?2,
                     last_success_at = ?3, last_attempt_at = ?4, unknown_zone_count = 5
                 WHERE id = ?1",
                params![s, provider, NOW - 7 * H, NOW - H],
            )
            .unwrap();
        let provider_status = |f: &Fixture| {
            (
                f.status::<Option<String>>(s, "last_result"),
                f.status::<Option<String>>(s, "last_error"),
                f.status::<Option<i64>>(s, "last_success_at"),
                f.status::<Option<i64>>(s, "last_attempt_at"),
            )
        };
        let before = provider_status(&f);

        f.set_shift(s, 30);
        let outcome = reingest(&f, s, IngestScope::WholeSource, NOW)
            .await
            .unwrap();
        assert!(matches!(outcome, IngestOutcome::Stored(_)), "{outcome:?}");
        assert_eq!(provider_status(&f), before);
        assert_eq!(
            f.status::<Option<i64>>(s, "applied_shift_minutes"),
            Some(30)
        );
        assert_eq!(f.status::<i64>(s, "unknown_zone_count"), 0);

        f.cache(s, &Feed::new().xml());
        let err = reingest(&f, s, IngestScope::WholeSource, NOW)
            .await
            .unwrap_err();
        assert_eq!(err.to_string(), format!("EPG error: {EMPTY_CACHE_MESSAGE}"));
        assert!(!EMPTY_CACHE_MESSAGE.contains("server"));
        assert_eq!(provider_status(&f), before);
    }

    /// Release benches over synthetic feeds, one process per test so peak
    /// RSS can be read with `/usr/bin/time -v`. Feeds are written once to
    /// `EPG_PERF_DIR` by `perf_make_feeds`, streamed so writing them costs
    /// no memory in the measured run; `perf_baseline` is the process
    /// without an ingest. See the A3 step of the EPG rewrite design.
    mod perf {
        use super::*;
        use crate::epg::sources::feed_path;
        use flate2::write::GzEncoder;
        use flate2::Compression;
        use std::io::Write;

        const DESCRIPTION: &str = "En berättelse om hösten i Göteborg där familjen Åström \
            möter nya utmaningar på jobbet och hemma. Med musik, väder och nyheter från \
            hela landet.";

        #[derive(Clone, Copy)]
        enum Variant {
            Plain,
            Gzip,
            Latin1,
            /// Plain, programmes ordered by time across channels instead of
            /// grouped per channel: the primary key sees them in random order.
            Interleaved,
        }

        fn perf_dir() -> Option<PathBuf> {
            let dir = std::env::var_os("EPG_PERF_DIR").map(PathBuf::from);
            if dir.is_none() {
                eprintln!("EPG_PERF_DIR is not set; skipped");
            }
            dir
        }

        fn feed_file(dir: &Path, channels: usize, variant: Variant) -> PathBuf {
            let name = match variant {
                Variant::Plain => "plain.xml",
                Variant::Gzip => "gzip.xml.gz",
                Variant::Latin1 => "latin1.xml",
                Variant::Interleaved => "interleaved.xml",
            };
            dir.join(format!("{}k-{name}", channels * 43 / 2000))
        }

        fn programmes_of(channel: usize) -> usize {
            21 + channel % 2
        }

        fn programme_xml(channel: usize, n: usize, start: i64) -> (String, i64) {
            let minutes = 30 + ((channel * 7 + n * 13) % 4) as i64 * 20;
            let stop = start + minutes * 60;
            let category = if n.is_multiple_of(3) {
                "Nyheter"
            } else {
                "Film"
            };
            let xml = format!(
                "<programme start=\"{}\" stop=\"{}\" channel=\"kanal{channel}.se\">\
                 <title>Måndagsmagasinet {n}: Ärliga öden på Kanal {channel}</title>\
                 <desc>{DESCRIPTION} Del {n}.</desc><category>{category}</category></programme>\n",
                xmltv_time(start),
                xmltv_time(stop)
            );
            (xml, stop)
        }

        /// Write a feed of `channels` channels with 21-22 programmes each from
        /// six hours before `NOW`, 145-character descriptions and Swedish
        /// letters in every title, and `<channel>` elements with 1-3 names.
        fn write_feed(path: &Path, channels: usize, variant: Variant) {
            let file = std::io::BufWriter::new(std::fs::File::create(path).unwrap());
            let mut out: Box<dyn Write> = match variant {
                Variant::Gzip => Box::new(GzEncoder::new(file, Compression::default())),
                _ => Box::new(file),
            };
            let mut write = |text: &str| {
                if matches!(variant, Variant::Latin1) {
                    let (bytes, _, unmappable) = encoding_rs::WINDOWS_1252.encode(text);
                    assert!(!unmappable);
                    out.write_all(&bytes).unwrap();
                } else {
                    out.write_all(text.as_bytes()).unwrap();
                }
            };
            let encoding = if matches!(variant, Variant::Latin1) {
                "ISO-8859-1"
            } else {
                "UTF-8"
            };
            write(&format!(
                "<?xml version=\"1.0\" encoding=\"{encoding}\"?>\n<tv generator-info-name=\"bench\">\n"
            ));
            for channel in 0..channels {
                let names = ["Kanal {i}", "Kanal {i} HD", "K{i} Sverige"];
                let mut xml = format!("<channel id=\"kanal{channel}.se\">");
                for name in names.iter().take(1 + channel % 3) {
                    xml.push_str(&format!(
                        "<display-name>{}</display-name>",
                        name.replace("{i}", &channel.to_string())
                    ));
                }
                xml.push_str("</channel>\n");
                write(&xml);
            }
            let first_start = |channel: usize| NOW - 6 * H + (channel % 4) as i64 * 900;
            if matches!(variant, Variant::Interleaved) {
                let mut next: Vec<i64> = (0..channels).map(first_start).collect();
                for n in 0..22 {
                    for (channel, start) in next.iter_mut().enumerate() {
                        if n < programmes_of(channel) {
                            let (xml, stop) = programme_xml(channel, n, *start);
                            write(&xml);
                            *start = stop;
                        }
                    }
                }
            } else {
                for channel in 0..channels {
                    let mut start = first_start(channel);
                    for n in 0..programmes_of(channel) {
                        let (xml, stop) = programme_xml(channel, n, start);
                        write(&xml);
                        start = stop;
                    }
                }
            }
            write("</tv>\n");
            drop(write);
            out.flush().unwrap();
        }

        #[test]
        #[ignore]
        fn perf_make_feeds() {
            let Some(dir) = perf_dir() else {
                return;
            };
            std::fs::create_dir_all(&dir).unwrap();
            for channels in [2_000, 20_000] {
                for variant in [
                    Variant::Plain,
                    Variant::Gzip,
                    Variant::Latin1,
                    Variant::Interleaved,
                ] {
                    let path = feed_file(&dir, channels, variant);
                    if !path.exists() {
                        write_feed(&path, channels, variant);
                    }
                    eprintln!(
                        "{} {} bytes",
                        path.display(),
                        std::fs::metadata(&path).unwrap().len()
                    );
                }
            }
        }

        fn file_mb(path: &Path) -> f64 {
            std::fs::metadata(path).map_or(0.0, |m| m.len() as f64 / 1e6)
        }

        fn line(label: &str, report: &crate::epg::IngestReport, wall: Duration) -> String {
            format!(
                "{label}: wall {wall:.3?} (parse+stage {:.3?}, normalise {:.3?}, \
                 mark+swap {:.3?}, lock held {:.3?} max over {} tx), stored {}, \
                 channels {}, replacements {}",
                report.elapsed.parse,
                report.elapsed.normalise,
                report.elapsed.store,
                report.lock_hold,
                report.transactions,
                report.stored,
                report.keys,
                report.parse.decode_replacements,
            )
        }

        /// Ingest `feed` twice through the cache path: into an empty
        /// database, then again over its own rows (the steady state).
        async fn bench(feed: &Path, expected: Option<u32>) {
            let f = Fixture::new("perf");
            let s = add_manual(&f.conn(), "http://bench.example/epg.xml");
            let db = f.dir.0.join("app.db");
            let wal = f.dir.0.join("app.db-wal");
            for (label, now) in [("first", NOW), ("again", NOW + 60)] {
                std::fs::copy(feed, feed_path(&f.dir.0, s)).unwrap();
                let (db_before, wal_before) = (file_mb(&db), file_mb(&wal));
                let started = Instant::now();
                let outcome = ingest(&f.env(), s, Fetch::Cache, IngestScope::Feed, now)
                    .await
                    .unwrap();
                let wall = started.elapsed();
                let IngestOutcome::Stored(report) = outcome else {
                    panic!("not stored: {outcome:?}");
                };
                if let Some(expected) = expected {
                    assert_eq!(report.stored, expected);
                }
                eprintln!(
                    "PERF {} {}; db {db_before:.1} -> {:.1} MB, wal {wal_before:.1} -> {:.1} MB",
                    feed.file_name().unwrap().to_string_lossy(),
                    line(label, &report, wall),
                    file_mb(&db),
                    file_mb(&wal),
                );
            }
        }

        async fn bench_variant(channels: usize, variant: Variant) {
            let Some(dir) = perf_dir() else {
                return;
            };
            let expected = (0..channels).map(programmes_of).sum::<usize>() as u32;
            bench(&feed_file(&dir, channels, variant), Some(expected)).await;
        }

        #[tokio::test]
        #[ignore]
        async fn perf_baseline() {
            let f = Fixture::new("perf");
            add_manual(&f.conn(), "http://bench.example/epg.xml");
        }

        #[tokio::test]
        #[ignore]
        async fn perf_43k_plain() {
            bench_variant(2_000, Variant::Plain).await;
        }

        #[tokio::test]
        #[ignore]
        async fn perf_43k_gzip() {
            bench_variant(2_000, Variant::Gzip).await;
        }

        #[tokio::test]
        #[ignore]
        async fn perf_43k_latin1() {
            bench_variant(2_000, Variant::Latin1).await;
        }

        #[tokio::test]
        #[ignore]
        async fn perf_43k_interleaved() {
            bench_variant(2_000, Variant::Interleaved).await;
        }

        #[tokio::test]
        #[ignore]
        async fn perf_430k_plain() {
            bench_variant(20_000, Variant::Plain).await;
        }

        #[tokio::test]
        #[ignore]
        async fn perf_430k_gzip() {
            bench_variant(20_000, Variant::Gzip).await;
        }

        #[tokio::test]
        #[ignore]
        async fn perf_430k_latin1() {
            bench_variant(20_000, Variant::Latin1).await;
        }

        #[tokio::test]
        #[ignore]
        async fn perf_430k_interleaved() {
            bench_variant(20_000, Variant::Interleaved).await;
        }

        /// The feed captured for the rewrite (see the EPG rewrite brief),
        /// ingested at the time it was captured. It holds provider data:
        /// only counts and timings are printed.
        #[tokio::test]
        #[ignore]
        async fn perf_real_feed() {
            let Some(path) = std::env::var_os("EPG_REAL_FEED") else {
                eprintln!("EPG_REAL_FEED is not set; skipped");
                return;
            };
            bench(Path::new(&path), None).await;
        }
    }
}
