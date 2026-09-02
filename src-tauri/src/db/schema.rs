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
}
