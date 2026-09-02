use rusqlite::{Connection, Result};

/// Initialize the database schema
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
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )",
        [],
    )?;

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

    // Migration (2.8.0): older databases inserted a fresh copy of every future
    // programme on each EPG refresh, because `INSERT OR REPLACE` had no unique
    // key to conflict on. Collapse those duplicates before adding the key.
    conn.execute(
        "DELETE FROM epg_programs
         WHERE id NOT IN (
             SELECT MIN(id) FROM epg_programs GROUP BY channel_epg_id, start_time
         )",
        [],
    )?;

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

    // Create index for channel search (LIKE queries on name and group_name)
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

    // Settings table
    conn.execute(
        "CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )",
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

    migrate_m3u_series(conn)?;

    Ok(())
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
        let episodes = crate::db::mutations::insert_series_groups(&tx, playlist_id, &grouped.series)?;

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
            crate::db::mutations::set_setting(
                conn,
                "active_profile_id",
                &playlist_id
            )?;
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

    /// Databases created before 2.8.0 have no unique key on epg_programs and
    /// accumulated one copy of every future programme per EPG refresh.
    #[test]
    fn init_schema_collapses_duplicate_epg_rows_from_older_databases() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE epg_programs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                channel_epg_id TEXT NOT NULL,
                title TEXT NOT NULL,
                description TEXT,
                start_time TIMESTAMP NOT NULL,
                end_time TIMESTAMP NOT NULL,
                category TEXT,
                icon TEXT
            );
            INSERT INTO epg_programs (channel_epg_id, title, start_time, end_time)
              VALUES ('svt1.se', 'Rapport', '2026-09-02T18:00:00+00:00', '2026-09-02T18:30:00+00:00');
            INSERT INTO epg_programs (channel_epg_id, title, start_time, end_time)
              VALUES ('svt1.se', 'Rapport', '2026-09-02T18:00:00+00:00', '2026-09-02T18:30:00+00:00');
            INSERT INTO epg_programs (channel_epg_id, title, start_time, end_time)
              VALUES ('svt1.se', 'Aktuellt', '2026-09-02T21:00:00+00:00', '2026-09-02T21:30:00+00:00');",
        )
        .unwrap();

        init_schema(&conn).unwrap();

        let rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM epg_programs", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 2, "one Rapport row and one Aktuellt row survive");

        let index_exists: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master
                 WHERE type = 'index' AND name = 'idx_epg_programs_unique'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(index_exists, 1);
    }

    #[test]
    fn epg_programs_rejects_duplicate_channel_and_start_time() {
        let conn = Connection::open_in_memory().unwrap();
        init_schema(&conn).unwrap();

        let insert = "INSERT INTO epg_programs (channel_epg_id, title, start_time, end_time)
                      VALUES ('svt1.se', 'Rapport', '2026-09-02T18:00:00+00:00', '2026-09-02T18:30:00+00:00')";
        conn.execute(insert, []).unwrap();
        let second = conn.execute(insert, []);

        assert!(second.is_err(), "unique index must reject the duplicate");
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
        assert!(series[0].is_favorite, "favourite carried over from an episode row");
        assert_eq!(series[0].sort_order, 5);
        assert_eq!(series[0].url, "http://host/d1.mkv");

        let episodes = queries::get_series_episodes(&conn, series[0].id.unwrap()).unwrap();
        assert_eq!(episodes.len(), 2);
        assert_eq!(episodes[1].url, "http://host/d2.mkv");

        let cc = m3u.iter().find(|c| c.name == "Comedy Central").unwrap();
        assert_eq!(cc.content_type, "live", "no episode marker: linear channel");
        assert_eq!(cc.id, Some(12), "updated in place");

        assert!(m3u.iter().any(|c| c.name == "SVT1" && c.content_type == "live"));
        assert!(m3u.iter().all(|c| c.id != Some(10) && c.id != Some(11)), "episode rows deleted");
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
    fn migration_runs_once() {
        let conn = seed_pre_grouping_db();
        init_schema(&conn).unwrap();
        assert_eq!(
            queries::get_setting(&conn, M3U_SERIES_GROUPED_KEY).unwrap().as_deref(),
            Some("1")
        );
        let before: i64 = conn.query_row("SELECT COUNT(*) FROM channels", [], |r| r.get(0)).unwrap();

        // Simulate a row that would be regrouped if the migration ran again
        conn.execute(
            "INSERT INTO channels (playlist_id, name, url, group_name, content_type)
             VALUES (1, 'Late S01E01', 'http://host/late.mkv', 'Series', 'series')",
            [],
        )
        .unwrap();
        migrate_m3u_series(&conn).unwrap();

        let after: i64 = conn.query_row("SELECT COUNT(*) FROM channels", [], |r| r.get(0)).unwrap();
        assert_eq!(after, before + 1, "second run does not regroup");
    }

    #[test]
    fn fresh_database_marks_migration_done() {
        let conn = Connection::open_in_memory().unwrap();
        init_schema(&conn).unwrap();
        assert!(queries::get_setting(&conn, M3U_SERIES_GROUPED_KEY).unwrap().is_some());
    }
}
