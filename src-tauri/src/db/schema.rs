use rusqlite::{Connection, Result};

/// Initialize the database schema.
///
/// The one-time M3U series migration (`migrate_m3u_series`) runs at the end
/// of this function but is not allowed to fail startup: its guard key is
/// only written inside its own transaction, so a failure here leaves the
/// database exactly as it was and the migration retries on the next start.
/// The degraded state in the meantime — M3U series still shown as one card
/// per episode, the pre-2.8.0 behaviour — is strictly better than the app
/// refusing to start.
pub fn init_schema(conn: &Connection) -> Result<()> {
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

    // Migration: fallback logo chosen for a live channel (see db::logo_fallbacks)
    let _ = conn.execute("ALTER TABLE channels ADD COLUMN logo_override TEXT", []);

    // iptv-org fallback logos, keyed by normalized EPG id
    conn.execute(
        "CREATE TABLE IF NOT EXISTS logo_fallbacks (epg_key TEXT PRIMARY KEY, url TEXT NOT NULL) WITHOUT ROWID",
        [],
    )?;

    // Provider logo URLs that failed to load on screen
    conn.execute(
        "CREATE TABLE IF NOT EXISTS dead_logo_urls (
            url TEXT PRIMARY KEY,
            state TEXT NOT NULL CHECK (state IN ('suspect', 'dead')),
            marked_at TEXT NOT NULL,      -- RFC 3339
            launch_id INTEGER NOT NULL    -- the app launch that last marked it
        ) WITHOUT ROWID",
        [],
    )?;

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

    conn.execute(
        "CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )",
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

    create_epg_source_tables(conn)?;

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

    if let Err(e) = migrate_m3u_series(conn) {
        log::error!("M3U series migration failed, will retry next start: {}", e);
    }

    if let Err(e) = crate::epg::sources::sync_epg_sources(conn) {
        log::error!("EPG source sync failed, will retry next start: {}", e);
    }

    Ok(())
}

/// Tables of the per-source guide store (`epg::sources`, `epg::store`).
///
/// Named apart from the 3.1.x tables `epg_programs`/`epg_sources`: a 3.1.x
/// binary started on this database recreates those, ignores these, and its
/// index on `epg_programs` never meets a table without the columns it names.
/// Every statement is idempotent.
fn create_epg_source_tables(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS epg_source (
            -- AUTOINCREMENT: ids are never reused, cache files are named by id
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            -- NULL = applies to every profile
            playlist_id INTEGER REFERENCES playlists(id) ON DELETE CASCADE,
            origin TEXT NOT NULL CHECK (origin IN ('manual', 'xtream', 'm3u_header')),
            -- NULL for 'xtream': the URL is built from the playlist at fetch time
            url TEXT,
            enabled INTEGER NOT NULL DEFAULT 1,
            -- lower wins: manual 10, m3u_header 20, xtream 30
            priority INTEGER NOT NULL,
            -- configured policy; no CHECK so a later version can add values
            time_interpret TEXT NOT NULL DEFAULT 'as_written',
            time_shift_minutes INTEGER NOT NULL DEFAULT 0,
            -- policy the stored rows were produced under, written by the swap
            applied_interpret TEXT,
            applied_shift_minutes INTEGER,
            last_attempt_at INTEGER,          -- epoch seconds
            last_success_at INTEGER,          -- epoch seconds
            last_result TEXT CHECK (last_result IN ('ok', 'partial', 'error')),
            last_error TEXT,                  -- credential-free sentence
            programme_count INTEGER NOT NULL DEFAULT 0,
            unknown_zone_count INTEGER NOT NULL DEFAULT 0,
            unknown_zone_sample TEXT,
            decode_replacements INTEGER NOT NULL DEFAULT 0
        );
        -- NULLs are distinct in a UNIQUE constraint, and url is NULL for every
        -- xtream row and playlist_id for every global row, so the identity is
        -- an expression index.
        CREATE UNIQUE INDEX IF NOT EXISTS idx_epg_source_identity
            ON epg_source(COALESCE(playlist_id, 0), origin, COALESCE(url, ''));

        CREATE TABLE IF NOT EXISTS epg_channel (
            id INTEGER PRIMARY KEY,
            source_id INTEGER NOT NULL REFERENCES epg_source(id) ON DELETE CASCADE,
            key TEXT NOT NULL,                -- epg_domain::key::channel_key of the feed's id
            first_start INTEGER,              -- summaries of this channel's rows, UTC seconds
            last_stop INTEGER,
            programme_count INTEGER NOT NULL DEFAULT 0,
            UNIQUE (source_id, key)
        );
        CREATE INDEX IF NOT EXISTS idx_epg_channel_key ON epg_channel(key);

        CREATE TABLE IF NOT EXISTS epg_channel_name (
            channel_id INTEGER NOT NULL REFERENCES epg_channel(id) ON DELETE CASCADE,
            position INTEGER NOT NULL,
            name TEXT NOT NULL,               -- as the feed wrote it
            name_key TEXT NOT NULL,           -- epg_domain::key::name_key
            PRIMARY KEY (channel_id, position)
        ) WITHOUT ROWID;
        CREATE INDEX IF NOT EXISTS idx_epg_channel_name_key ON epg_channel_name(name_key);

        CREATE TABLE IF NOT EXISTS epg_programme (
            channel_id INTEGER NOT NULL REFERENCES epg_channel(id) ON DELETE CASCADE,
            start INTEGER NOT NULL,           -- UTC seconds, after the source's time policy
            stop INTEGER NOT NULL,
            title TEXT NOT NULL,
            description TEXT,
            category TEXT,
            PRIMARY KEY (channel_id, start)
        ) WITHOUT ROWID;",
    )
}

/// Drop the guide tables of 3.1.x and their indices. Not on the boot path:
/// the app runs it in the background after startup (`epg::sources::
/// boot_cleanup`), at every start, so a database that a 3.1.x binary
/// recreated them in is cleaned again. Their settings rows stay.
pub fn drop_legacy_epg_tables(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "DROP TABLE IF EXISTS epg_programs;
         DROP TABLE IF EXISTS epg_sources;",
    )
}

/// Settings key that records the one-time M3U series grouping migration.
pub const M3U_SERIES_GROUPED_KEY: &str = "m3u_series_grouped";

/// Before 2.8.0 every M3U series episode was its own `channels` row. Collapse
/// them into one row per series plus `series_episodes`, and turn rows in a
/// series group that are not episodes into live channels. Runs once, as a
/// single all-or-nothing transaction across every playlist: either every
/// playlist is migrated and the guard is set, or nothing changes and the
/// guard stays unset so the next startup retries cleanly.
pub fn migrate_m3u_series(conn: &Connection) -> Result<()> {
    if crate::db::queries::get_setting(conn, M3U_SERIES_GROUPED_KEY)?.is_some() {
        return Ok(());
    }

    let playlist_ids: Vec<i64> = conn
        .prepare("SELECT id FROM playlists WHERE xtream_username IS NULL")?
        .query_map([], |row| row.get(0))?
        .collect::<Result<Vec<_>>>()?;

    let tx = conn.unchecked_transaction()?;

    for playlist_id in playlist_ids {
        let rows: Vec<_> = crate::db::queries::get_channels(&tx, Some(playlist_id))?
            .into_iter()
            .filter(|c| c.content_type == "series")
            .collect();
        if rows.is_empty() {
            continue;
        }

        let grouped = crate::series_domain::group_series(rows);

        let mut reclassified = 0;
        for ch in &grouped.plain {
            if let Some(id) = ch.id {
                tx.execute(
                    "UPDATE channels SET content_type = 'live' WHERE id = ?1",
                    rusqlite::params![id],
                )?;
                reclassified += 1;
            }
        }

        for group in &grouped.series {
            for id in &group.source_ids {
                tx.execute("DELETE FROM channels WHERE id = ?1", rusqlite::params![id])?;
            }
        }
        let episodes =
            crate::db::mutations::insert_series_groups(&tx, playlist_id, &grouped.series)?;

        log::info!(
            "Migration: playlist {} grouped into {} series ({} episodes), {} rows reclassified as live",
            playlist_id,
            grouped.series.len(),
            episodes,
            reclassified
        );
    }

    crate::db::mutations::set_setting(&tx, M3U_SERIES_GROUPED_KEY, "1")?;
    tx.commit()?;
    Ok(())
}

/// Ensure active_profile_id setting exists (migration for existing users)
pub fn ensure_active_profile(conn: &Connection) -> Result<()> {
    // Check if active_profile_id already exists
    let existing = crate::db::queries::get_setting(conn, "active_profile_id")?;

    if existing.is_none() {
        // Get first playlist (oldest by created_at)
        let playlists = crate::db::queries::get_playlists(conn)?;

        if let Some(first_playlist) = playlists.first() {
            let playlist_id = first_playlist.id.unwrap().to_string();
            crate::db::mutations::set_setting(conn, "active_profile_id", &playlist_id)?;
            log::info!(
                "Migration: Set active profile to first playlist (ID: {})",
                playlist_id
            );
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::init_schema;
    use rusqlite::Connection;

    fn seed_null_live_channel(conn: &Connection, name: &str) {
        conn.execute(
            "INSERT OR IGNORE INTO playlists (id, name) VALUES (1, 'P')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO channels (playlist_id, name, url, content_type)
             VALUES (1, ?1, 'http://x/s', 'live')",
            [name],
        )
        .unwrap();
    }

    fn epg_id_of(conn: &Connection, name: &str) -> Option<String> {
        conn.query_row("SELECT epg_id FROM channels WHERE name = ?1", [name], |r| {
            r.get(0)
        })
        .unwrap()
    }

    /// The boot path no longer fills in ids from channel names: a NULL
    /// `epg_id` stays NULL, however often the schema is initialised.
    #[test]
    fn init_schema_leaves_channel_epg_ids_alone() {
        let conn = Connection::open_in_memory().unwrap();
        init_schema(&conn).unwrap();
        seed_null_live_channel(&conn, "SVT1 HD SE");

        init_schema(&conn).unwrap();

        assert_eq!(epg_id_of(&conn, "SVT1 HD SE"), None);
        assert_eq!(
            crate::db::queries::get_setting(&conn, "epg_ids_backfilled").unwrap(),
            None
        );
    }

    use super::{migrate_m3u_series, M3U_SERIES_GROUPED_KEY};
    use crate::db::queries;

    fn seed_pre_grouping_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
        conn.execute_batch(
            "CREATE TABLE playlists (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                url TEXT,
                file_path TEXT,
                last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                auto_refresh BOOLEAN DEFAULT 0,
                xtream_username TEXT,
                xtream_password TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE channels (
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
            );
            INSERT INTO playlists (id, name, url) VALUES (1, 'M3U', 'http://host/list.m3u');
            INSERT INTO playlists (id, name, url, xtream_username, xtream_password)
              VALUES (2, 'Xtream', 'http://x', 'u', 'p');
            -- M3U profile: two episodes (one favourite), one linear channel in a series group, one live row
            INSERT INTO channels (id, playlist_id, name, url, group_name, content_type, is_favorite, sort_order)
              VALUES (10, 1, 'Dark S01E01', 'http://host/d1.mkv', 'Series', 'series', 0, 5);
            INSERT INTO channels (id, playlist_id, name, url, group_name, content_type, is_favorite, sort_order)
              VALUES (11, 1, 'Dark S01E02', 'http://host/d2.mkv', 'Series', 'series', 1, 6);
            INSERT INTO channels (id, playlist_id, name, url, group_name, content_type, is_favorite, sort_order)
              VALUES (12, 1, 'Comedy Central', 'http://host/cc.m3u8', 'Series', 'series', 0, 7);
            INSERT INTO channels (id, playlist_id, name, url, group_name, content_type, is_favorite, sort_order)
              VALUES (13, 1, 'SVT1', 'http://host/svt1.m3u8', 'News', 'live', 0, 0);
            -- Xtream profile: a real series row that must not be touched
            INSERT INTO channels (id, playlist_id, name, url, group_name, content_type, is_favorite, sort_order)
              VALUES (20, 2, 'Dark', 'http://x/series/u/p/77.mp4', 'Drama', 'series', 0, 0);",
        )
        .unwrap();
        conn
    }

    #[test]
    fn init_schema_groups_existing_m3u_series_rows() {
        let conn = seed_pre_grouping_db();

        init_schema(&conn).unwrap();

        let m3u = queries::get_channels(&conn, Some(1)).unwrap();
        let series: Vec<_> = m3u.iter().filter(|c| c.content_type == "series").collect();
        assert_eq!(series.len(), 1, "two episode rows collapse into one series");
        assert_eq!(series[0].name, "Dark");
        assert!(
            series[0].is_favorite,
            "favourite carried over from an episode row"
        );
        assert_eq!(series[0].sort_order, 5);
        assert_eq!(series[0].url, "http://host/d1.mkv");

        let episodes = queries::get_series_episodes(&conn, series[0].id.unwrap()).unwrap();
        assert_eq!(episodes.len(), 2);
        assert_eq!(episodes[1].url, "http://host/d2.mkv");

        let cc = m3u.iter().find(|c| c.name == "Comedy Central").unwrap();
        assert_eq!(cc.content_type, "live", "no episode marker: linear channel");
        assert_eq!(cc.id, Some(12), "updated in place");

        assert!(m3u
            .iter()
            .any(|c| c.name == "SVT1" && c.content_type == "live"));
        assert!(
            m3u.iter().all(|c| c.id != Some(10) && c.id != Some(11)),
            "episode rows deleted"
        );
    }

    #[test]
    fn migration_leaves_xtream_profiles_alone() {
        let conn = seed_pre_grouping_db();

        init_schema(&conn).unwrap();

        let xtream = queries::get_channels(&conn, Some(2)).unwrap();
        assert_eq!(xtream.len(), 1);
        assert_eq!(xtream[0].id, Some(20));
        assert_eq!(xtream[0].content_type, "series");
        assert!(queries::get_series_episodes(&conn, 20).unwrap().is_empty());
    }

    #[test]
    fn an_older_database_gains_the_xtream_expiry_column() {
        // The column arrived after release, so every existing installation
        // reaches init_schema with a playlists table that lacks it.
        let conn = seed_pre_grouping_db();

        init_schema(&conn).unwrap();

        crate::db::mutations::set_xtream_expiry(
            &conn,
            2,
            Some("2027-03-12T00:00:00Z"),
            "2026-09-11T12:00:00Z",
        )
        .unwrap();
        let stored = crate::db::queries::get_xtream_expiry_cache(&conn, 2).unwrap();
        assert_eq!(stored.expires_at.as_deref(), Some("2027-03-12T00:00:00Z"));
        assert_eq!(stored.checked_at.as_deref(), Some("2026-09-11T12:00:00Z"));
    }

    #[test]
    fn migration_runs_once() {
        let conn = seed_pre_grouping_db();
        init_schema(&conn).unwrap();
        assert_eq!(
            queries::get_setting(&conn, M3U_SERIES_GROUPED_KEY)
                .unwrap()
                .as_deref(),
            Some("1")
        );
        let before: i64 = conn
            .query_row("SELECT COUNT(*) FROM channels", [], |r| r.get(0))
            .unwrap();

        // Simulate a row that would be regrouped if the migration ran again
        conn.execute(
            "INSERT INTO channels (playlist_id, name, url, group_name, content_type)
             VALUES (1, 'Late S01E01', 'http://host/late.mkv', 'Series', 'series')",
            [],
        )
        .unwrap();
        migrate_m3u_series(&conn).unwrap();

        let after: i64 = conn
            .query_row("SELECT COUNT(*) FROM channels", [], |r| r.get(0))
            .unwrap();
        assert_eq!(after, before + 1, "second run does not regroup");
    }

    #[test]
    fn fresh_database_marks_migration_done() {
        let conn = Connection::open_in_memory().unwrap();
        init_schema(&conn).unwrap();
        assert!(queries::get_setting(&conn, M3U_SERIES_GROUPED_KEY)
            .unwrap()
            .is_some());
    }
}

#[cfg(test)]
mod home_migration_tests {
    use super::*;

    /// A database from before 3.0.0 has tmdb_metadata without vote_count;
    /// init_schema must add it and stay idempotent.
    #[test]
    fn vote_count_is_added_to_a_pre_existing_tmdb_metadata_table() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute(
            "CREATE TABLE tmdb_metadata (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                normalized_title TEXT NOT NULL, year INTEGER NOT NULL, content_type TEXT NOT NULL,
                tmdb_id INTEGER, manual INTEGER NOT NULL DEFAULT 0, title TEXT, original_title TEXT,
                release_year INTEGER, rating REAL, poster_path TEXT, backdrop_path TEXT, overview TEXT,
                genre_ids TEXT, runtime_minutes INTEGER, genres TEXT, cast_json TEXT,
                trailer_youtube_key TEXT, searched_at TEXT NOT NULL, details_fetched_at TEXT,
                UNIQUE(normalized_title, year, content_type))",
            [],
        )
        .unwrap();
        init_schema(&conn).unwrap();
        init_schema(&conn).unwrap();
        let columns: Vec<String> = conn
            .prepare("PRAGMA table_info(tmdb_metadata)")
            .unwrap()
            .query_map([], |r| r.get::<_, String>(1))
            .unwrap()
            .map(|c| c.unwrap())
            .collect();
        assert!(columns.iter().any(|c| c == "vote_count"), "{columns:?}");
    }

    #[test]
    fn schema_adds_logo_override_to_an_existing_channels_table() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE playlists (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                url TEXT,
                file_path TEXT,
                last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                auto_refresh BOOLEAN DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE channels (
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
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );",
        )
        .unwrap();

        init_schema(&conn).unwrap();

        conn.prepare("SELECT logo_override FROM channels").unwrap();
        conn.prepare("SELECT epg_key, url FROM logo_fallbacks")
            .unwrap();
        conn.prepare("SELECT url, state, marked_at, launch_id FROM dead_logo_urls")
            .unwrap();
    }
}

#[cfg(test)]
mod epg_source_seed_tests {
    use super::init_schema;
    use crate::db::queries::get_setting;
    use crate::epg::sources::{
        ensure_xtream_source, legacy_xtream_epg_url, seed_epg_sources, EPG_SOURCES_SEEDED_KEY,
    };
    use rusqlite::types::Value;
    use rusqlite::{params, Connection};

    /// A database as 3.1.x leaves it: old EPG tables with rows, the single
    /// EPG URL in settings, an M3U and an Xtream profile with channels.
    fn v1_db(epg_url: &str) -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
        conn.execute_batch(
            "CREATE TABLE playlists (
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
            );
            CREATE TABLE channels (
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
                logo_override TEXT,
                FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE
            );
            CREATE TABLE settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE epg_programs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                channel_epg_id TEXT NOT NULL,
                title TEXT NOT NULL,
                description TEXT,
                start_time TIMESTAMP NOT NULL,
                end_time TIMESTAMP NOT NULL,
                category TEXT,
                icon TEXT
            );
            CREATE UNIQUE INDEX idx_epg_programs_unique ON epg_programs(channel_epg_id, start_time);
            CREATE TABLE epg_sources (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                url TEXT NOT NULL,
                last_fetched TIMESTAMP,
                auto_refresh BOOLEAN DEFAULT 1,
                refresh_interval_hours INTEGER DEFAULT 6,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            INSERT INTO playlists (id, name, url, created_at)
              VALUES (1, 'M3U', 'http://lists.example/list.m3u', '2026-01-01 10:00:00');
            INSERT INTO playlists (id, name, url, xtream_username, xtream_password, created_at)
              VALUES (2, 'Provider', 'http://provider.example:8080/', 'me@mail.se', 'p&ss',
                      '2026-02-01 10:00:00');
            INSERT INTO channels (id, playlist_id, name, url, epg_id, is_favorite, sort_order, created_at)
              VALUES (10, 1, 'SVT1', 'http://lists.example/svt1', 'SVT1.se', 1, 0, '2026-01-01 10:00:00');
            INSERT INTO channels (id, playlist_id, name, url, epg_id, is_favorite, sort_order, created_at)
              VALUES (20, 2, 'TV4', 'http://provider.example/tv4', 'tv4.se', 0, 1, '2026-02-01 10:00:00');
            INSERT INTO channels (id, playlist_id, name, url, epg_id, content_type, is_favorite, created_at)
              VALUES (21, 2, 'Dune', 'http://provider.example/m/1.mkv', NULL, 'vod', 1, '2026-02-01 10:00:00');
            INSERT INTO epg_programs (channel_epg_id, title, start_time, end_time)
              VALUES ('svt1.se', 'Rapport', '2026-10-20T18:00:00+00:00', '2026-10-20T18:30:00+00:00');
            INSERT INTO epg_programs (channel_epg_id, title, start_time, end_time)
              VALUES ('tv4.se', 'Nyheterna', '2026-10-20T19:00:00+00:00', '2026-10-20T19:30:00+00:00');
            INSERT INTO epg_sources (name, url) VALUES ('Old', 'http://old.example/epg.xml');",
        )
        .unwrap();
        let settings = [
            ("epg_url", epg_url),
            ("epg_last_fetched", "2026-10-20T12:00:00+00:00"),
            ("epg_last_attempt", "2026-10-20T12:00:00+00:00"),
            ("epg_programs_normalized", "1"),
            ("epg_ids_backfilled", "1"),
            ("m3u_series_grouped", "1"),
            ("active_profile_id", "2"),
        ];
        for (key, value) in settings {
            conn.execute(
                "INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, '2026-10-01 08:00:00')",
                params![key, value],
            )
            .unwrap();
        }
        conn
    }

    fn legacy_url() -> String {
        legacy_xtream_epg_url("http://provider.example:8080/", "me@mail.se", "p&ss")
    }

    /// Every row of `table`, in rowid order, restricted to `columns`.
    fn snapshot(conn: &Connection, table: &str, columns: &[String]) -> Vec<Vec<Value>> {
        let sql = format!("SELECT {} FROM {table} ORDER BY rowid", columns.join(", "));
        let mut stmt = conn.prepare(&sql).unwrap();
        stmt.query_map([], |row| {
            (0..columns.len())
                .map(|i| row.get::<_, Value>(i))
                .collect::<rusqlite::Result<Vec<_>>>()
        })
        .unwrap()
        .map(|r| r.unwrap())
        .collect()
    }

    fn columns(conn: &Connection, table: &str) -> Vec<String> {
        conn.prepare(&format!("PRAGMA table_info({table})"))
            .unwrap()
            .query_map([], |r| r.get::<_, String>(1))
            .unwrap()
            .map(|c| c.unwrap())
            .collect()
    }

    /// (origin, playlist_id, url, enabled, priority) of one source.
    type SourceRow = (String, Option<i64>, Option<String>, bool, i64);

    /// Every source, by id.
    fn sources(conn: &Connection) -> Vec<SourceRow> {
        conn.prepare(
            "SELECT origin, playlist_id, url, enabled, priority FROM epg_source ORDER BY id",
        )
        .unwrap()
        .query_map([], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
        })
        .unwrap()
        .map(|r| r.unwrap())
        .collect()
    }

    fn count(conn: &Connection, sql: &str) -> i64 {
        conn.query_row(sql, [], |r| r.get(0)).unwrap()
    }

    fn schema_objects(conn: &Connection) -> Vec<(String, String)> {
        conn.prepare("SELECT type, name FROM sqlite_master ORDER BY type, name")
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .map(|r| r.unwrap())
            .collect()
    }

    #[test]
    fn a_fresh_database_has_the_source_tables_indices_and_guard() {
        let conn = Connection::open_in_memory().unwrap();
        init_schema(&conn).unwrap();
        let objects = schema_objects(&conn);
        for (kind, name) in [
            ("table", "epg_source"),
            ("table", "epg_channel"),
            ("table", "epg_channel_name"),
            ("table", "epg_programme"),
            ("index", "idx_epg_source_identity"),
            ("index", "idx_epg_channel_key"),
            ("index", "idx_epg_channel_name_key"),
        ] {
            assert!(
                objects.contains(&(kind.to_string(), name.to_string())),
                "{kind} {name} missing"
            );
        }
        // Both clustered on their primary key.
        for table in ["epg_channel_name", "epg_programme"] {
            let sql: String = conn
                .query_row(
                    "SELECT sql FROM sqlite_master WHERE name = ?1",
                    [table],
                    |r| r.get(0),
                )
                .unwrap();
            assert!(sql.contains("WITHOUT ROWID"), "{table}");
        }
        // The 3.1.x guide tables are not created any more.
        assert!(objects
            .iter()
            .all(|(_, name)| !matches!(name.as_str(), "epg_programs" | "epg_sources")));
        assert_eq!(
            get_setting(&conn, EPG_SOURCES_SEEDED_KEY)
                .unwrap()
                .as_deref(),
            Some("1")
        );
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM epg_source"), 0);
    }

    #[test]
    fn the_legacy_provider_url_seeds_one_enabled_xtream_source() {
        let conn = v1_db(&legacy_url());
        init_schema(&conn).unwrap();
        assert_eq!(
            sources(&conn),
            [("xtream".to_string(), Some(2), None, true, 30)]
        );
    }

    #[test]
    fn a_custom_url_seeds_a_manual_source_and_disables_xtream() {
        let conn = v1_db(" https://epg.example/guide.xml.gz ");
        init_schema(&conn).unwrap();
        assert_eq!(
            sources(&conn),
            [
                ("xtream".to_string(), Some(2), None, false, 30),
                (
                    "manual".to_string(),
                    None,
                    Some("https://epg.example/guide.xml.gz".to_string()),
                    true,
                    10
                ),
            ]
        );
    }

    #[test]
    fn an_empty_url_seeds_only_xtream() {
        let conn = v1_db("  ");
        init_schema(&conn).unwrap();
        assert_eq!(
            sources(&conn),
            [("xtream".to_string(), Some(2), None, true, 30)]
        );
    }

    #[test]
    fn a_url_that_is_not_http_is_not_migrated_but_still_disables_xtream() {
        // 3.1.2 fetched neither this URL nor the provider's guide.
        for url in ["ftp://epg.example/guide.xml", "epg.example.com/guide.xml"] {
            let conn = v1_db(url);
            init_schema(&conn).unwrap();
            assert_eq!(
                sources(&conn),
                [("xtream".to_string(), Some(2), None, false, 30)],
                "{url}"
            );
        }
    }

    /// A second Xtream profile, beside playlist 2 of `v1_db`.
    fn add_second_xtream_profile(conn: &Connection, id: i64) {
        conn.execute(
            "INSERT INTO playlists (id, name, url, xtream_username, xtream_password)
             VALUES (?1, 'Second', 'http://other.example', 'u2', 'pw2')",
            params![id],
        )
        .unwrap();
    }

    #[test]
    fn the_legacy_url_of_the_second_xtream_profile_counts_as_legacy() {
        let conn = v1_db(&legacy_xtream_epg_url("http://other.example", "u2", "pw2"));
        add_second_xtream_profile(&conn, 3);
        init_schema(&conn).unwrap();
        assert_eq!(
            sources(&conn),
            [
                ("xtream".to_string(), Some(2), None, true, 30),
                ("xtream".to_string(), Some(3), None, true, 30),
            ]
        );
    }

    #[test]
    fn a_custom_url_disables_every_xtream_profile() {
        let conn = v1_db("https://epg.example/guide.xml");
        add_second_xtream_profile(&conn, 3);
        init_schema(&conn).unwrap();
        assert_eq!(
            sources(&conn),
            [
                ("xtream".to_string(), Some(2), None, false, 30),
                ("xtream".to_string(), Some(3), None, false, 30),
                (
                    "manual".to_string(),
                    None,
                    Some("https://epg.example/guide.xml".to_string()),
                    true,
                    10
                ),
            ]
        );
    }

    #[test]
    fn a_later_start_gives_a_new_xtream_profile_its_source() {
        // Seeded with the legacy URL, then an older version imported a
        // second Xtream profile on this database.
        let conn = v1_db(&legacy_url());
        init_schema(&conn).unwrap();
        conn.execute(
            "UPDATE epg_source SET enabled = 0 WHERE playlist_id = 2",
            [],
        )
        .unwrap();
        add_second_xtream_profile(&conn, 3);

        init_schema(&conn).unwrap();

        assert_eq!(
            sources(&conn),
            [
                ("xtream".to_string(), Some(2), None, false, 30),
                ("xtream".to_string(), Some(3), None, true, 30),
            ],
            "the new profile gets an enabled source, the disabled one stays disabled"
        );
    }

    #[test]
    fn a_new_xtream_profile_starts_disabled_beside_an_enabled_manual_source() {
        let conn = v1_db("https://epg.example/guide.xml");
        init_schema(&conn).unwrap();
        add_second_xtream_profile(&conn, 3);

        init_schema(&conn).unwrap();

        let third = sources(&conn).into_iter().find(|s| s.1 == Some(3)).unwrap();
        assert_eq!(third, ("xtream".to_string(), Some(3), None, false, 30));
    }

    #[test]
    fn a_custom_url_without_an_xtream_profile_seeds_only_the_manual_source() {
        let conn = v1_db("https://epg.example/guide.xml");
        conn.execute("DELETE FROM playlists WHERE id = 2", [])
            .unwrap();
        init_schema(&conn).unwrap();
        assert_eq!(
            sources(&conn),
            [(
                "manual".to_string(),
                None,
                Some("https://epg.example/guide.xml".to_string()),
                true,
                10
            )]
        );
    }

    #[test]
    fn the_upgrade_leaves_every_existing_row_byte_identical() {
        for epg_url in [legacy_url(), "https://epg.example/guide.xml".to_string()] {
            let conn = v1_db(&epg_url);
            let tables = [
                "settings",
                "playlists",
                "channels",
                "epg_programs",
                "epg_sources",
            ];
            let before: Vec<_> = tables
                .iter()
                .map(|t| {
                    let cols = columns(&conn, t);
                    let rows = snapshot(&conn, t, &cols);
                    (cols, rows)
                })
                .collect();

            init_schema(&conn).unwrap();

            for (table, (cols, rows)) in tables.iter().zip(&before) {
                let after = snapshot(&conn, table, cols);
                if *table == "settings" {
                    // The one new row is the guard; every old one is untouched.
                    let old: Vec<_> = after
                        .iter()
                        .filter(|r| r[0] != Value::Text(EPG_SOURCES_SEEDED_KEY.to_string()))
                        .cloned()
                        .collect();
                    assert_eq!(&old, rows, "{epg_url}: settings");
                    assert_eq!(after.len(), rows.len() + 1, "{epg_url}");
                } else {
                    assert_eq!(&after, rows, "{epg_url}: {table}");
                }
            }
        }
    }

    #[test]
    fn a_second_init_schema_adds_nothing() {
        let conn = v1_db("https://epg.example/guide.xml");
        init_schema(&conn).unwrap();
        let objects = schema_objects(&conn);
        let seeded = sources(&conn);
        let settings = snapshot(
            &conn,
            "settings",
            &["key".into(), "value".into(), "updated_at".into()],
        );

        init_schema(&conn).unwrap();

        assert_eq!(schema_objects(&conn), objects);
        assert_eq!(sources(&conn), seeded);
        assert_eq!(
            snapshot(
                &conn,
                "settings",
                &["key".into(), "value".into(), "updated_at".into()]
            ),
            settings
        );
    }

    #[test]
    fn seeding_twice_and_an_import_leave_one_xtream_source() {
        let conn = v1_db(&legacy_url());
        init_schema(&conn).unwrap();

        // Run the seed body again with the guard removed: the identity
        // index, not only the guard, keeps the source single.
        conn.execute(
            "DELETE FROM settings WHERE key = ?1",
            [EPG_SOURCES_SEEDED_KEY],
        )
        .unwrap();
        seed_epg_sources(&conn).unwrap();
        // An Xtream re-import into the seeded playlist.
        ensure_xtream_source(&conn, 2).unwrap();

        assert_eq!(
            count(
                &conn,
                "SELECT COUNT(*) FROM epg_source WHERE origin = 'xtream' AND playlist_id = 2"
            ),
            1
        );
    }

    #[test]
    fn the_identity_index_rejects_a_second_xtream_source() {
        let conn = v1_db(&legacy_url());
        init_schema(&conn).unwrap();
        let second = conn.execute(
            "INSERT INTO epg_source (playlist_id, origin, priority) VALUES (2, 'xtream', 30)",
            [],
        );
        assert!(second.is_err());
        let second = conn.execute(
            "INSERT INTO epg_source (playlist_id, origin, url, priority)
             VALUES (NULL, 'manual', 'http://a', 10), (NULL, 'manual', 'http://a', 10)",
            [],
        );
        assert!(second.is_err());
    }

    /// The old tables plus the new ones, and a trigger that rejects the
    /// manual insert, which the seed makes after the xtream insert.
    fn v1_db_with_failing_manual_insert() -> Connection {
        let conn = v1_db("https://epg.example/guide.xml");
        super::create_epg_source_tables(&conn).unwrap();
        conn.execute_batch(
            "CREATE TRIGGER fail_manual BEFORE INSERT ON epg_source
             WHEN NEW.origin = 'manual'
             BEGIN SELECT RAISE(ABORT, 'manual insert blocked'); END;",
        )
        .unwrap();
        conn
    }

    #[test]
    fn a_failing_seed_rolls_back_every_row_and_the_guard() {
        let conn = v1_db_with_failing_manual_insert();
        assert!(seed_epg_sources(&conn).is_err());
        assert_eq!(
            count(&conn, "SELECT COUNT(*) FROM epg_source"),
            0,
            "the xtream row written before the failure is rolled back"
        );
        assert!(get_setting(&conn, EPG_SOURCES_SEEDED_KEY)
            .unwrap()
            .is_none());
    }

    #[test]
    fn a_failing_seed_does_not_stop_startup_and_retries() {
        let conn = v1_db_with_failing_manual_insert();

        init_schema(&conn).unwrap();
        assert!(get_setting(&conn, EPG_SOURCES_SEEDED_KEY)
            .unwrap()
            .is_none());
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM epg_source"), 0);

        conn.execute_batch("DROP TRIGGER fail_manual;").unwrap();
        init_schema(&conn).unwrap();
        assert_eq!(
            sources(&conn),
            [
                ("xtream".to_string(), Some(2), None, false, 30),
                (
                    "manual".to_string(),
                    None,
                    Some("https://epg.example/guide.xml".to_string()),
                    true,
                    10
                ),
            ]
        );
        assert!(get_setting(&conn, EPG_SOURCES_SEEDED_KEY)
            .unwrap()
            .is_some());
    }

    #[test]
    fn the_drop_task_removes_the_old_tables_and_can_run_again() {
        let conn = v1_db(&legacy_url());
        init_schema(&conn).unwrap();
        let settings = snapshot(
            &conn,
            "settings",
            &["key".into(), "value".into(), "updated_at".into()],
        );

        super::drop_legacy_epg_tables(&conn).unwrap();

        let objects = schema_objects(&conn);
        for name in ["epg_programs", "epg_sources", "idx_epg_programs_unique"] {
            assert!(objects.iter().all(|(_, n)| n != name), "{name}");
        }
        super::drop_legacy_epg_tables(&conn).unwrap();
        init_schema(&conn).unwrap();
        assert_eq!(
            schema_objects(&conn),
            objects,
            "init_schema does not bring them back"
        );
        assert_eq!(
            snapshot(
                &conn,
                "settings",
                &["key".into(), "value".into(), "updated_at".into()]
            ),
            settings,
            "the old settings rows stay"
        );
    }

    // ========== Downgrade: the 3.1.2 binary started on this database ==========

    use crate::db::schema::ensure_active_profile;
    use crate::db::schema_v3_1::{
        init_schema_v3_1, EPG_IDS_BACKFILLED_KEY, EPG_PROGRAMS_NORMALIZED_KEY,
    };

    /// Every row of the guide tables of this version, in primary key order
    /// (two of them have no rowid).
    fn new_tables(conn: &Connection) -> Vec<Vec<Vec<Value>>> {
        [
            "epg_source",
            "epg_channel",
            "epg_channel_name",
            "epg_programme",
        ]
        .iter()
        .map(|t| {
            let cols = columns(conn, t);
            let sql = format!("SELECT {} FROM {t} ORDER BY 1, 2", cols.join(", "));
            let mut stmt = conn.prepare(&sql).unwrap();
            stmt.query_map([], |row| {
                (0..cols.len())
                    .map(|i| row.get::<_, Value>(i))
                    .collect::<rusqlite::Result<Vec<_>>>()
            })
            .unwrap()
            .map(|r| r.unwrap())
            .collect()
        })
        .collect()
    }

    /// One channel with a name and a programme, as an ingest stores them.
    fn add_guide_rows(conn: &Connection, source_id: i64) {
        conn.execute(
            "INSERT INTO epg_channel (source_id, key, first_start, last_stop, programme_count)
             VALUES (?1, 'tv4.se', 100, 200, 1)",
            params![source_id],
        )
        .unwrap();
        let channel = conn.last_insert_rowid();
        conn.execute(
            "INSERT INTO epg_channel_name (channel_id, position, name, name_key)
             VALUES (?1, 0, 'TV4', 'tv4')",
            params![channel],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO epg_programme (channel_id, start, stop, title) VALUES (?1, 100, 200, 'News')",
            params![channel],
        )
        .unwrap();
        conn.execute(
            "UPDATE epg_source SET programme_count = 1, last_success_at = 100,
                 last_attempt_at = 100, last_result = 'ok',
                 applied_interpret = 'as_written', applied_shift_minutes = 0
             WHERE id = ?1",
            params![source_id],
        )
        .unwrap();
    }

    fn has_setting(conn: &Connection, key: &str) -> bool {
        get_setting(conn, key).unwrap().is_some()
    }

    #[test]
    fn a_3_1_2_start_on_an_upgraded_database_succeeds_and_leaves_the_new_tables() {
        let conn = v1_db(&legacy_url());
        init_schema(&conn).unwrap();
        super::drop_legacy_epg_tables(&conn).unwrap();
        let source: i64 = conn
            .query_row("SELECT id FROM epg_source", [], |r| r.get(0))
            .unwrap();
        add_guide_rows(&conn, source);
        let guide = new_tables(&conn);
        let channel_columns = columns(&conn, "channels");
        let channels = snapshot(&conn, "channels", &channel_columns);

        init_schema_v3_1(&conn).unwrap();
        ensure_active_profile(&conn).unwrap();

        assert_eq!(new_tables(&conn), guide);
        assert_eq!(snapshot(&conn, "channels", &channel_columns), channels);
        for key in [
            EPG_PROGRAMS_NORMALIZED_KEY,
            EPG_IDS_BACKFILLED_KEY,
            EPG_SOURCES_SEEDED_KEY,
            super::M3U_SERIES_GROUPED_KEY,
        ] {
            assert!(has_setting(&conn, key), "{key}");
        }
        // 3.1.2 finds its URL and an empty table: it downloads again at its
        // first poll.
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM epg_programs"), 0);
        assert_eq!(get_setting(&conn, "epg_url").unwrap(), Some(legacy_url()));

        // Back on this version.
        init_schema(&conn).unwrap();
        super::drop_legacy_epg_tables(&conn).unwrap();
        assert_eq!(new_tables(&conn), guide);
        assert!(schema_objects(&conn)
            .iter()
            .all(|(_, name)| name != "epg_programs"));
    }

    fn live(name: &str, epg_id: Option<&str>) -> crate::db::models::Channel {
        crate::db::models::Channel {
            id: None,
            playlist_id: 0,
            name: name.to_string(),
            url: format!("http://provider.example/{name}"),
            logo: None,
            group_name: Some("News".to_string()),
            epg_id: epg_id.map(str::to_string),
            tvg_name: None,
            content_type: "live".to_string(),
            is_favorite: false,
            sort_order: 0,
            category_order: 0,
            created_at: None,
        }
    }

    #[test]
    fn a_3_1_2_start_on_a_database_this_version_created_succeeds() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
        init_schema(&conn).unwrap();
        ensure_active_profile(&conn).unwrap();
        let playlist = crate::playlist_domain::build_xtream_playlist(
            "Provider".to_string(),
            "http://provider.example:8080".to_string(),
            "john".to_string(),
            "secret".to_string(),
        )
        .unwrap();
        let channels = vec![live("SVT1 HD SE", None), live("TV4", Some("tv4.se"))];
        crate::commands::playlist::write_xtream_import(&conn, playlist, channels).unwrap();
        ensure_active_profile(&conn).unwrap();
        let provider_sources = sources(&conn);
        assert_eq!(provider_sources.len(), 1);

        init_schema_v3_1(&conn).unwrap();
        ensure_active_profile(&conn).unwrap();

        assert_eq!(sources(&conn), provider_sources);
        // Never a URL in settings: 3.1.2 shows an empty guide and fetches
        // nothing, but starts.
        assert_eq!(get_setting(&conn, "epg_url").unwrap(), None);
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM epg_programs"), 0);
        assert!(has_setting(&conn, EPG_PROGRAMS_NORMALIZED_KEY));
        assert!(has_setting(&conn, EPG_IDS_BACKFILLED_KEY));
        // Its backfill named the Swedish channel, as 3.1.2 always did.
        let backfilled: Option<String> = conn
            .query_row(
                "SELECT epg_id FROM channels WHERE name = 'SVT1 HD SE'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(backfilled.as_deref(), Some("SVT1.se"));

        // Back on this version.
        init_schema(&conn).unwrap();
        super::drop_legacy_epg_tables(&conn).unwrap();
        assert_eq!(sources(&conn), provider_sources);
    }
}
