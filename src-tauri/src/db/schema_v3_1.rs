//! The schema code of v3.1.2, for downgrade tests only.
//!
//! `init_schema_v3_1` is `init_schema` as v3.1.2 shipped it
//! (`git show v3.1.2:src-tauri/src/db/schema.rs`), with the helpers it calls
//! that this version deleted copied beside it: the EPG migrations, the id
//! backfill and the Swedish id rule. The M3U series migration and the
//! settings helpers are called in this version's form; neither changed since
//! v3.1.2. Running it on a database of this version shows what starting the
//! 3.1.2 binary on it does: `lib.rs` of v3.1.2 stops the app when it fails.

use rusqlite::{params, Connection, Result};

/// `init_schema` of v3.1.2.
pub fn init_schema_v3_1(conn: &Connection) -> Result<()> {
    // Playlists table
    conn.execute(
        "CREATE TABLE IF NOT EXISTS playlists (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            url TEXT,
            file_path TEXT,
            last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            auto_refresh BOOLEAN DEFAULT 0,
            xtream_username TEXT,
            xtream_password TEXT,
            xtream_exp_date TIMESTAMP,
            xtream_exp_checked_at TIMESTAMP,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )",
        [],
    )?;

    // Migration: Add Xtream subscription columns if they don't exist (for existing databases)
    let _ = conn.execute(
        "ALTER TABLE playlists ADD COLUMN xtream_exp_date TIMESTAMP",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE playlists ADD COLUMN xtream_exp_checked_at TIMESTAMP",
        [],
    );

    // Channels table
    conn.execute(
        "CREATE TABLE IF NOT EXISTS channels (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            playlist_id INTEGER NOT NULL,
            name TEXT NOT NULL,
            url TEXT NOT NULL,
            logo TEXT,
            group_name TEXT,
            epg_id TEXT,
            tvg_name TEXT,
            content_type TEXT DEFAULT 'live',
            is_favorite BOOLEAN DEFAULT 0,
            sort_order INTEGER DEFAULT 0,
            category_order INTEGER DEFAULT 0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE
        )",
        [],
    )?;

    // Migration: Add category_order column if it doesn't exist (for existing databases)
    let _ = conn.execute(
        "ALTER TABLE channels ADD COLUMN category_order INTEGER DEFAULT 0",
        [],
    );

    // Series episodes (M3U series are grouped at import; see series_domain::group_series)
    conn.execute(
        "CREATE TABLE IF NOT EXISTS series_episodes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            series_channel_id INTEGER NOT NULL,
            season INTEGER NOT NULL,
            episode INTEGER NOT NULL,
            title TEXT NOT NULL,
            url TEXT NOT NULL,
            logo TEXT,
            FOREIGN KEY (series_channel_id) REFERENCES channels(id) ON DELETE CASCADE
        )",
        [],
    )?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_series_episodes_channel
         ON series_episodes(series_channel_id, season, episode)",
        [],
    )?;

    // EPG Programs table
    conn.execute(
        "CREATE TABLE IF NOT EXISTS epg_programs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            channel_epg_id TEXT NOT NULL,
            title TEXT NOT NULL,
            description TEXT,
            start_time TIMESTAMP NOT NULL,
            end_time TIMESTAMP NOT NULL,
            category TEXT,
            icon TEXT
        )",
        [],
    )?;

    // Needed by migrate_epg_programs below, so it is created before it.
    conn.execute(
        "CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )",
        [],
    )?;

    // One-time EPG migrations: dedupe (2.8.0) must precede the unique index.
    migrate_epg_programs(conn)?;

    // One row per channel and start time; the EPG upsert conflicts on this.
    conn.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_epg_programs_unique
         ON epg_programs(channel_epg_id, start_time)",
        [],
    )?;

    // Create index for EPG lookups
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_channel_time
         ON epg_programs(channel_epg_id, start_time, end_time)",
        [],
    )?;

    // Retained but currently serves nothing: it was built for the LIKE queries of
    // the removed search_channels command. Dropping this statement would not
    // remove the index from existing databases, so retiring it is a separate
    // migration decision.
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_channel_search
         ON channels(name, group_name)",
        [],
    )?;

    // Index for playlist filtering (frequently used in WHERE playlist_id = ?)
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_channels_playlist_id
         ON channels(playlist_id)",
        [],
    )?;

    // Index for EPG lookups by channel EPG ID
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_channels_epg_id
         ON channels(epg_id)",
        [],
    )?;

    // Composite index for channel sorting (used in get_channels ORDER BY)
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_channels_sorting
         ON channels(playlist_id, sort_order, name)",
        [],
    )?;

    // Index for content type filtering (used in category queries and content type tabs)
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_channels_content_type
         ON channels(playlist_id, content_type)",
        [],
    )?;

    // Composite index for category queries with content type filter
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_channels_category
         ON channels(playlist_id, content_type, group_name, category_order)",
        [],
    )?;

    // Watch History table
    conn.execute(
        "CREATE TABLE IF NOT EXISTS watch_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            channel_id INTEGER NOT NULL,
            watched_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            duration_seconds INTEGER DEFAULT 0,
            FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE
        )",
        [],
    )?;

    // Index for watch history lookups by channel
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_watch_history_channel_id
         ON watch_history(channel_id)",
        [],
    )?;

    // EPG Sources table
    conn.execute(
        "CREATE TABLE IF NOT EXISTS epg_sources (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            url TEXT NOT NULL,
            last_fetched TIMESTAMP,
            auto_refresh BOOLEAN DEFAULT 1,
            refresh_interval_hours INTEGER DEFAULT 6,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )",
        [],
    )?;

    // TMDB metadata cache, keyed by normalised title, not channel id, so one
    // row serves every playlist and survives a playlist refresh. year = 0
    // when unknown (UNIQUE cannot compare NULLs). tmdb_id NULL = no match.
    conn.execute(
        "CREATE TABLE IF NOT EXISTS tmdb_metadata (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            normalized_title TEXT NOT NULL,
            year INTEGER NOT NULL,
            content_type TEXT NOT NULL,
            tmdb_id INTEGER,
            manual INTEGER NOT NULL DEFAULT 0,
            title TEXT,
            original_title TEXT,
            release_year INTEGER,
            rating REAL,
            vote_count INTEGER,
            poster_path TEXT,
            backdrop_path TEXT,
            overview TEXT,
            genre_ids TEXT,
            runtime_minutes INTEGER,
            genres TEXT,
            cast_json TEXT,
            trailer_youtube_key TEXT,
            searched_at TEXT NOT NULL,
            details_fetched_at TEXT,
            UNIQUE(normalized_title, year, content_type)
        )",
        [],
    )?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_tmdb_metadata_key
         ON tmdb_metadata(content_type, normalized_title, year)",
        [],
    )?;
    // Migration: vote_count arrived with the Home page (3.0.0). NULL means
    // "searched before the column existed"; Home's filter skips such rows
    // until the background scan re-searches them.
    let _ = conn.execute(
        "ALTER TABLE tmdb_metadata ADD COLUMN vote_count INTEGER",
        [],
    );
    conn.execute(
        "CREATE TABLE IF NOT EXISTS tmdb_episodes (
            tmdb_id INTEGER NOT NULL,
            season INTEGER NOT NULL,
            episode INTEGER NOT NULL,
            title TEXT,
            overview TEXT,
            still_path TEXT,
            runtime_minutes INTEGER,
            air_date TEXT,
            fetched_at TEXT NOT NULL,
            PRIMARY KEY (tmdb_id, season, episode)
        )",
        [],
    )?;

    if let Err(e) = crate::db::schema::migrate_m3u_series(conn) {
        log::error!("M3U series migration failed, will retry next start: {}", e);
    }

    if let Err(e) = backfill_channel_epg_ids(conn) {
        log::error!("EPG id backfill failed, will retry next start: {}", e);
    }

    Ok(())
}

/// Settings key that records the one-time EPG id backfill.
pub const EPG_IDS_BACKFILLED_KEY: &str = "epg_ids_backfilled";

/// Channels written before EPG ids were generated on write may have NULL ids.
/// Fill them once. `update_channel_epg_ids` has its own transaction and is
/// idempotent, so losing the key write only costs a repeat pass next start.
fn backfill_channel_epg_ids(conn: &Connection) -> Result<()> {
    if crate::db::queries::get_setting(conn, EPG_IDS_BACKFILLED_KEY)?.is_some() {
        return Ok(());
    }
    // The series migration turns some rows into live channels. Backfilling
    // before it has run would set the key and leave those rows without ids.
    if crate::db::queries::get_setting(conn, crate::db::schema::M3U_SERIES_GROUPED_KEY)?.is_none() {
        log::debug!("EPG id backfill deferred until the M3U series migration has run");
        return Ok(());
    }
    update_channel_epg_ids(conn)?;
    crate::db::mutations::set_setting(conn, EPG_IDS_BACKFILLED_KEY, "1")?;
    Ok(())
}

/// Settings key that records the one-time EPG migrations (dedupe and id lower-casing).
pub const EPG_PROGRAMS_NORMALIZED_KEY: &str = "epg_programs_normalized";

/// The EPG migrations below are full-table scans, so they run once and record
/// the guard in the same transaction. A failure rolls back and retries next
/// start (and fails `init_schema`, since the unique index needs the dedupe).
fn migrate_epg_programs(conn: &Connection) -> Result<()> {
    if crate::db::queries::get_setting(conn, EPG_PROGRAMS_NORMALIZED_KEY)?.is_some() {
        return Ok(());
    }

    let tx = conn.unchecked_transaction()?;

    // Migration (2.8.0): older databases inserted a fresh copy of every future
    // programme on each EPG refresh, because `INSERT OR REPLACE` had no unique
    // key to conflict on. Collapse those duplicates before adding the key.
    tx.execute(
        "DELETE FROM epg_programs
         WHERE id NOT IN (
             SELECT MIN(id) FROM epg_programs GROUP BY channel_epg_id, start_time
         )",
        [],
    )?;

    // The lower-casing below relies on this key: OR IGNORE only skips a row when
    // the unique index would reject it, so the index must exist first.
    tx.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_epg_programs_unique
         ON epg_programs(channel_epg_id, start_time)",
        [],
    )?;

    // Migration (3.0.0): EPG ids are stored normalised (`epg_domain::normalize_epg_id`,
    // ASCII lower-case like SQLite's lower()) so `SVT1.se` channels match a feed
    // that writes `svt1.se`. Lower-case older rows once; where both spellings exist
    // for one slot, OR IGNORE keeps the lower-case row and the DELETE drops the rest.
    tx.execute(
        "UPDATE OR IGNORE epg_programs SET channel_epg_id = lower(channel_epg_id)
         WHERE channel_epg_id <> lower(channel_epg_id)",
        [],
    )?;
    tx.execute(
        "DELETE FROM epg_programs WHERE channel_epg_id <> lower(channel_epg_id)",
        [],
    )?;

    crate::db::mutations::set_setting(&tx, EPG_PROGRAMS_NORMALIZED_KEY, "1")?;
    tx.commit()?;
    Ok(())
}

/// `mutations::update_channel_epg_ids` of v3.1.2.
fn update_channel_epg_ids(conn: &Connection) -> Result<usize> {
    let mut stmt = conn
        .prepare("SELECT id, name FROM channels WHERE content_type = 'live' AND epg_id IS NULL")?;
    let channels: Vec<(i64, String)> = stmt
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<Result<Vec<_>, _>>()?;
    drop(stmt);

    if channels.is_empty() {
        return Ok(0);
    }

    let tx = conn.unchecked_transaction()?;
    let mut updated_count = 0;
    {
        let mut update_stmt = tx.prepare_cached("UPDATE channels SET epg_id = ?1 WHERE id = ?2")?;
        for (id, name) in &channels {
            if let Some(epg_id) = generate_epg_id_swedish(name) {
                update_stmt.execute(params![epg_id, id])?;
                updated_count += 1;
            }
        }
    }
    tx.commit()?;
    Ok(updated_count)
}

/// `utils::generate_epg_id_swedish` of v3.1.2.
fn generate_epg_id_swedish(channel_name: &str) -> Option<String> {
    let is_swedish = channel_name.ends_with(" SE")
        || channel_name.ends_with(" FHD SE")
        || channel_name.ends_with(" HD SE")
        || channel_name.ends_with(" SD SE");
    if !is_swedish {
        return None;
    }
    let clean_name = channel_name
        .trim_end_matches(" SE")
        .trim_end_matches(" FHD")
        .trim_end_matches(" HD")
        .trim_end_matches(" SD")
        .trim();
    Some(format!("{}.se", clean_name))
}
