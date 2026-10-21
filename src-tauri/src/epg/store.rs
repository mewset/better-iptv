//! Storing a feed: staging, normalisation and the swap into the guide tables.
//!
//! The parse sink corrects each programme's times with the source's policy,
//! writes the programme to a staging table in a separate database file
//! (`<cache_dir>/ingest.db`, attached for one ingest) in short transactions,
//! and keeps only a 32-byte `Slot` per programme in memory. `normalise`
//! decides per programme from those slots, the verdicts are written back to
//! staging, and one transaction on the main database then replaces the
//! source's programmes with an `INSERT … SELECT` from staging.
//!
//! Stored rows are never updated in place. For each channel in the feed the
//! rows that reach past its first new start are deleted before the new rows
//! go in, so a programme whose start moved leaves nothing behind, and the
//! primary key turns two rows at one start into a failed swap instead of a
//! duplicate. Rows that ended before a channel's first new start, and
//! channels the feed no longer lists, stay until they ended a day ago.
//!
//! Staging and main are separate databases, and a transaction is atomic per
//! database in WAL mode, not across them. Staging is disposable: the swap
//! only reads it, and the file is deleted when the ingest ends.

use super::parse::{parse_feed, ParseSink, ParsedChannel, ParsedProgramme};
use super::sources::{remove_if_present, staging_path};
use super::{AbandonReason, IngestScope, EMPTY_GUIDE_MESSAGE};
use crate::epg_domain::key::{channel_key, name_key};
use crate::epg_domain::normalize::{normalise, KeyBounds, Slot, Verdict, ENDED_GRACE_SECS};
use crate::epg_domain::policy::TimePolicy;
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

const STAGE_FAILURE: &str = "Failed to stage the EPG";
const STORE_FAILURE: &str = "Failed to store the EPG";

/// Journal off and no syncs: the file is deleted after every ingest and
/// rebuilt from the feed, so a crash costs nothing worth protecting.
const STAGING_SETUP: &str = "PRAGMA ingest.journal_mode = OFF;
    PRAGMA ingest.synchronous = OFF;
    CREATE TABLE IF NOT EXISTS ingest.epg_ingest (
        seq INTEGER PRIMARY KEY,
        key TEXT NOT NULL,
        start INTEGER NOT NULL,
        stop INTEGER,                     -- NULL until a verdict infers it
        keep INTEGER NOT NULL DEFAULT 1,  -- 0 = dropped by its verdict
        title TEXT NOT NULL,
        description TEXT,
        category TEXT
    );
    DELETE FROM ingest.epg_ingest;";

const STAGE_ROW: &str = "INSERT INTO ingest.epg_ingest
    (seq, key, start, stop, title, description, category) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)";
const MARK_STOP: &str = "UPDATE ingest.epg_ingest SET stop = ?2 WHERE seq = ?1";
const MARK_DROPPED: &str = "UPDATE ingest.epg_ingest SET keep = 0 WHERE seq = ?1";

// The swap's statements, named so the query-plan test checks each one.
const UPSERT_CHANNEL: &str = "INSERT OR IGNORE INTO epg_channel (source_id, key) VALUES (?1, ?2)";
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
/// Staging drives the join (`CROSS JOIN` fixes the order) and is read in
/// feed order. No `ORDER BY`: under `temp_store = memory` a sorter over the
/// whole feed would sit in RAM.
const INSERT_FROM_STAGING: &str = "INSERT INTO epg_programme
        (channel_id, start, stop, title, description, category)
    SELECT c.id, i.start, i.stop, i.title, i.description, i.category
    FROM ingest.epg_ingest i CROSS JOIN epg_channel c
    WHERE c.source_id = ?1 AND c.key = i.key AND i.keep = 1";
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
const SOURCE_STATE: &str = "SELECT enabled, url, last_success_at FROM epg_source WHERE id = ?1";
const UPDATE_STATUS: &str = "UPDATE epg_source SET last_result = ?2, last_error = NULL,
        programme_count = ?3, unknown_zone_count = ?4, unknown_zone_sample = ?5,
        decode_replacements = ?6, applied_interpret = ?7, applied_shift_minutes = ?8,
        last_success_at = ?9
    WHERE id = ?1";

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
        // A pooled connection keeps an attachment whose detach failed.
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
            // The next attach detaches it; the file stays until then.
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
/// `Slot::key` and `KeyBounds::key` are these numbers.
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
                        row.seq,
                        self.keys.key(row.key),
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
        self.slots
            .push(Slot::new(p.seq, key, start.at, stop, clump).with_start_in_gap(start.in_gap));
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
/// is the zone `Interpret::LocalZone` reads in.
pub(crate) fn stage<R: BufRead, Tz: TimeZone>(
    staging: &Staging,
    input: R,
    policy: TimePolicy,
    local: &Tz,
) -> Result<Staged> {
    let mut sink = StagingSink {
        conn: staging.conn,
        policy,
        local,
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
/// A feed with nothing left to store fails with `EMPTY_GUIDE_MESSAGE`: an
/// empty or non-XMLTV body, or a stale feed whose programmes all ended a day
/// ago. The stored guide is then left as it is.
pub(crate) fn prepare(staging: &Staging, staged: Staged, now: i64) -> Result<Prepared> {
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
        bail!(EMPTY_GUIDE_MESSAGE);
    }

    let started = Instant::now();
    mark(staging.conn, &slots, &verdicts).context(STAGE_FAILURE)?;
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
fn mark(conn: &Connection, slots: &[Slot], verdicts: &[Verdict]) -> rusqlite::Result<()> {
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
                Verdict::Drop(_) => {
                    drop_row.execute(params![slot.seq])?;
                }
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
    /// A network fetch advances `last_success_at`; a cache re-ingest does not.
    pub network: bool,
    pub now: i64,
}

/// How the swap ended.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Swapped {
    Committed {
        /// Rows inserted from this feed.
        stored: u32,
        /// The source's rows after the swap, kept older rows included.
        programme_count: u32,
        /// From `BEGIN IMMEDIATE` to `COMMIT`: how long other writers waited.
        hold: Duration,
    },
    /// The source changed under the ingest; nothing was written.
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
        Ok(SourceState {
            enabled: r.get(0)?,
            url: r.get(1)?,
            last_success_at: r.get(2)?,
        })
    })
    .optional()
}

/// One `epg_channel` row of the source as it was before the swap.
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

fn load_channels(tx: &Connection, source_id: i64) -> rusqlite::Result<Vec<StoredChannel>> {
    tx.prepare(SELECT_CHANNELS)?
        .query_map(params![source_id], |r| {
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
        })?
        .collect()
}

/// Replace the display names of every channel the feed described.
fn write_names(
    tx: &Connection,
    channels: &[StoredChannel],
    by_key: &HashMap<&str, usize>,
    keys: &FeedKeys,
) -> Result<()> {
    let mut delete = tx.prepare(DELETE_NAMES)?;
    let mut insert = tx.prepare(INSERT_NAME)?;
    for (key, names) in keys.keys.iter().zip(&keys.names) {
        let Some(names) = names else {
            continue;
        };
        let channel = channel_for(channels, by_key, key)?;
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

fn channel_for<'a>(
    channels: &'a [StoredChannel],
    by_key: &HashMap<&str, usize>,
    key: &str,
) -> Result<&'a StoredChannel> {
    by_key
        .get(key)
        .map(|&i| &channels[i])
        .context("A guide channel was not created before its programmes")
}

fn changed(rows: usize) -> u32 {
    u32::try_from(rows).unwrap_or(u32::MAX)
}

/// Replace the source's programmes with the staged ones, in one write
/// transaction on the main database.
///
/// First the source is checked again: removed, disabled or given another URL
/// since the ingest started means nothing is written. Then: channels and
/// their names, the range the feed speaks for deleted per channel (the whole
/// source for `WholeSource`), the staged rows inserted, rows that ended a
/// day ago pruned, each channel's summary and the source's status written.
/// Any failure, a primary-key conflict included, rolls all of it back.
pub(crate) fn swap(conn: &Connection, prepared: &Prepared, req: &SwapRequest) -> Result<Swapped> {
    let tx = Transaction::new_unchecked(conn, TransactionBehavior::Immediate)?;
    // The write lock is held from here: `BEGIN IMMEDIATE` waited for it.
    let locked = Instant::now();
    // Checked once at COMMIT; scoped to this transaction.
    tx.execute_batch("PRAGMA defer_foreign_keys = ON")?;

    // Dropping `tx` on these returns rolls back.
    let Some(state) = source_state(&tx, req.source_id)? else {
        return Ok(Swapped::Abandoned(AbandonReason::SourceRemoved));
    };
    if let Some(reason) = state.mismatch(req.expected_url) {
        return Ok(Swapped::Abandoned(reason));
    }

    // Channels in feed order, so new ids, and with them the inserted rows,
    // mostly follow the primary key.
    {
        let mut upsert = tx.prepare(UPSERT_CHANNEL)?;
        for key in &prepared.keys.keys {
            upsert.execute(params![req.source_id, key])?;
        }
    }
    let channels = load_channels(&tx, req.source_id)?;
    let by_key: HashMap<&str, usize> = channels
        .iter()
        .enumerate()
        .map(|(i, c)| (c.key.as_str(), i))
        .collect();
    write_names(&tx, &channels, &by_key, &prepared.keys)?;

    let mut fresh: Vec<Option<&KeyBounds>> = vec![None; channels.len()];
    for b in &prepared.bounds {
        let key = prepared.keys.key(b.key);
        let i = by_key
            .get(key)
            .copied()
            .context("A guide channel was not created before its programmes")?;
        fresh[i] = Some(b);
    }

    let complete = prepared.parse.complete;
    // Rows from before that survive the delete, per channel; `None` when the
    // stored count is behind the table and the channel must be recounted.
    let mut survivors: Vec<Option<u32>> = Vec::with_capacity(channels.len());
    match req.scope {
        IngestScope::WholeSource => {
            let mut delete = tx.prepare(DELETE_CHANNEL_ROWS)?;
            for c in &channels {
                delete.execute(params![c.id])?;
                survivors.push(Some(0));
            }
        }
        IngestScope::Feed => {
            let mut from_first = tx.prepare(DELETE_FROM_FIRST_START)?;
            let mut window = tx.prepare(DELETE_WINDOW)?;
            for (c, new) in channels.iter().zip(&fresh) {
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

    let inserted = tx.execute(INSERT_FROM_STAGING, params![req.source_id])?;
    ensure!(
        changed(inserted) == prepared.kept,
        "The EPG store inserted {inserted} programmes instead of {}",
        prepared.kept
    );

    let cutoff = req.now.saturating_sub(ENDED_GRACE_SECS);
    let mut prune = tx.prepare(PRUNE)?;
    let mut update = tx.prepare(UPDATE_SUMMARY)?;
    let mut programme_count: u32 = 0;
    for ((c, new), survived) in channels.iter().zip(&fresh).zip(&survivors) {
        // New rows never qualify for the prune: `normalise` dropped them.
        let summary = match *survived {
            Some(0) => Summary::of_new(*new),
            Some(left) => {
                let pruned = changed(prune.execute(params![c.id, cutoff])?);
                match left.checked_sub(pruned) {
                    Some(0) => Summary::of_new(*new),
                    Some(_) if pruned == 0 && new.is_none() => c.summary,
                    Some(left) => summary_with_survivors(&tx, c, *new, left, complete)?,
                    None => recount(&tx, c.id)?,
                }
            }
            None => {
                prune.execute(params![c.id, cutoff])?;
                recount(&tx, c.id)?
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
        programme_count = programme_count.saturating_add(summary.count);
    }
    drop((prune, update));

    let result = if complete {
        LastResult::Ok
    } else {
        LastResult::Partial
    };
    let parse = &prepared.parse;
    tx.execute(
        UPDATE_STATUS,
        params![
            req.source_id,
            result.as_db(),
            programme_count,
            parse.unknown_zone_count,
            parse.unknown_zone_sample,
            i64::try_from(parse.decode_replacements).unwrap_or(i64::MAX),
            req.policy.interpret.as_str(),
            req.policy.shift_minutes,
            success_after(state.last_success_at, result, req.network, req.now),
        ],
    )?;
    tx.commit()?;

    Ok(Swapped::Committed {
        stored: prepared.kept,
        programme_count,
        hold: locked.elapsed(),
    })
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
    /// How long the swap held the database's write lock.
    pub lock_hold: Duration,
}

#[derive(Debug)]
pub(crate) enum Stored {
    Committed(Box<StoreReport>),
    Abandoned(AbandonReason),
}

/// Stage, normalise and swap one feed into the source `req` names. Runs on
/// a blocking thread; the caller holds the EPG refresh lock.
pub(crate) fn store_feed<R: BufRead, Tz: TimeZone>(
    conn: &Connection,
    cache_dir: &Path,
    input: R,
    req: &SwapRequest,
    local: &Tz,
) -> Result<Stored> {
    let staging = Staging::attach(conn, cache_dir)?;
    let started = Instant::now();
    let staged = stage(&staging, input, req.policy, local)?;
    let parse_time = started.elapsed();

    let prepared = prepare(&staging, staged, req.now)?;
    let started = Instant::now();
    let swapped = swap(conn, &prepared, req).context(STORE_FAILURE)?;
    let swap_time = started.elapsed();
    drop(staging);

    Ok(match swapped {
        Swapped::Abandoned(reason) => Stored::Abandoned(reason),
        Swapped::Committed { stored, hold, .. } => Stored::Committed(Box::new(StoreReport {
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
        assert_eq!(
            f.status::<Option<String>>(s, "last_result").as_deref(),
            Some("partial")
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
        assert_eq!(
            f.status::<Option<String>>(s, "last_result").as_deref(),
            Some("error")
        );
        assert_eq!(
            f.status::<Option<String>>(s, "last_error").as_deref(),
            Some("Failed to store the EPG")
        );
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
        assert_eq!(err.to_string(), format!("EPG error: {EMPTY_GUIDE_MESSAGE}"));
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
        let staged = stage(staging, xml.as_bytes(), TimePolicy::default(), &Utc).unwrap();
        prepare(staging, staged, NOW).unwrap()
    }

    #[tokio::test]
    async fn a_duplicate_start_reaching_the_swap_fails_it() {
        let f = Fixture::new("store");
        let s = source(&f);
        let first = Feed::new().programme("svt1.se", NOW, NOW + H, "News");
        f.store(s, &first.xml(), NOW).await;
        let before = f.programmes(s);

        let conn = f.conn();
        let staging = Staging::attach(&conn, &f.dir.0).unwrap();
        let next = Feed::new().programme("svt1.se", NOW, NOW + H, "News 2");
        let prepared = prepared(&staging, &next);
        // A second row at the same start, as a broken `normalise` would leave.
        conn.execute(
            "INSERT INTO ingest.epg_ingest (seq, key, start, stop, title)
             VALUES (99, 'svt1.se', ?1, ?2, 'Twin')",
            params![NOW, NOW + H],
        )
        .unwrap();

        let err = swap(&conn, &prepared, &request(s, IngestScope::Feed)).unwrap_err();
        drop(staging);

        assert!(
            format!("{err:#}").contains("UNIQUE constraint failed"),
            "{err:#}"
        );
        assert_eq!(f.programmes(s), before);
        assert_eq!(
            f.status::<Option<String>>(s, "last_result").as_deref(),
            Some("ok")
        );
        assert_summaries_exact(&conn);
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

        assert_eq!(err.to_string(), format!("EPG error: {EMPTY_GUIDE_MESSAGE}"));
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
            UPDATE_STATUS,
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
        let insert = plan(&conn, INSERT_FROM_STAGING);
        assert_eq!(insert.len(), 2, "{insert:?}");
        assert!(insert[0].starts_with("SCAN i"), "{insert:?}");
        assert!(
            insert[1].starts_with("SEARCH c USING COVERING INDEX"),
            "{insert:?}"
        );
    }
}
