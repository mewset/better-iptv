use rusqlite::{Connection, Result, Row, params};
use std::collections::HashMap;
use super::models::*;

// ========== Channel Query Helpers ==========

/// SQL columns for channel SELECT queries (in order)
const CHANNEL_SELECT_COLUMNS: &str =
    "id, playlist_id, name, url, logo, group_name, epg_id, tvg_name, content_type, is_favorite, sort_order, category_order, created_at";

/// Maps a database row to a Channel struct
fn map_channel_row(row: &Row) -> rusqlite::Result<Channel> {
    Ok(Channel {
        id: row.get(0)?,
        playlist_id: row.get(1)?,
        name: row.get(2)?,
        url: row.get(3)?,
        logo: row.get(4)?,
        group_name: row.get(5)?,
        epg_id: row.get(6)?,
        tvg_name: row.get(7)?,
        content_type: row.get(8)?,
        is_favorite: row.get(9)?,
        sort_order: row.get(10)?,
        category_order: row.get(11)?,
        created_at: row.get(12)?,
    })
}

// ========== Series Episode Query Helpers ==========

const SERIES_EPISODE_SELECT_COLUMNS: &str =
    "id, series_channel_id, season, episode, title, url, logo";

fn map_series_episode_row(row: &Row) -> rusqlite::Result<SeriesEpisode> {
    Ok(SeriesEpisode {
        id: row.get(0)?,
        series_channel_id: row.get(1)?,
        season: row.get(2)?,
        episode: row.get(3)?,
        title: row.get(4)?,
        url: row.get(5)?,
        logo: row.get(6)?,
    })
}

// ========== Playlist Query Helpers ==========

const PLAYLIST_SELECT_COLUMNS: &str =
    "id, name, url, file_path, last_updated, auto_refresh, xtream_username, xtream_password, created_at";

fn map_playlist_row(row: &Row) -> rusqlite::Result<Playlist> {
    Ok(Playlist {
        id: row.get(0)?,
        name: row.get(1)?,
        url: row.get(2)?,
        file_path: row.get(3)?,
        last_updated: row.get(4)?,
        auto_refresh: row.get(5)?,
        xtream_username: row.get(6)?,
        xtream_password: row.get(7)?,
        created_at: row.get(8)?,
    })
}

// ========== Playlist Queries ==========

pub fn get_playlists(conn: &Connection) -> Result<Vec<Playlist>> {
    let sql = format!(
        "SELECT {} FROM playlists ORDER BY created_at DESC",
        PLAYLIST_SELECT_COLUMNS
    );
    let mut stmt = conn.prepare(&sql)?;
    let playlists = stmt.query_map([], map_playlist_row)?
        .collect::<Result<Vec<_>>>()?;
    Ok(playlists)
}

/// Get a single playlist by ID
pub fn get_playlist_by_id(conn: &Connection, id: i64) -> Result<Option<Playlist>> {
    let sql = format!(
        "SELECT {} FROM playlists WHERE id = ?1",
        PLAYLIST_SELECT_COLUMNS
    );
    let mut stmt = conn.prepare(&sql)?;
    let mut rows = stmt.query_map(params![id], map_playlist_row)?;
    rows.next().transpose()
}

// ========== Channel Queries ==========

pub fn get_channels(conn: &Connection, playlist_id: Option<i64>) -> Result<Vec<Channel>> {
    if let Some(pid) = playlist_id {
        let sql = format!(
            "SELECT {} FROM channels WHERE playlist_id = ?1 ORDER BY sort_order, name",
            CHANNEL_SELECT_COLUMNS
        );
        let mut stmt = conn.prepare(&sql)?;
        let channels = stmt.query_map(params![pid], map_channel_row)?
            .collect::<Result<Vec<_>>>()?;
        Ok(channels)
    } else {
        let sql = format!(
            "SELECT {} FROM channels ORDER BY sort_order, name",
            CHANNEL_SELECT_COLUMNS
        );
        let mut stmt = conn.prepare(&sql)?;
        let channels = stmt.query_map([], map_channel_row)?
            .collect::<Result<Vec<_>>>()?;
        Ok(channels)
    }
}

pub fn search_channels(conn: &Connection, query: &str) -> Result<Vec<Channel>> {
    let search_pattern = format!("%{}%", query);
    let sql = format!(
        "SELECT {} FROM channels WHERE name LIKE ?1 OR group_name LIKE ?1 ORDER BY is_favorite DESC, name LIMIT 100",
        CHANNEL_SELECT_COLUMNS
    );
    let mut stmt = conn.prepare(&sql)?;

    let channels = stmt.query_map(params![search_pattern], map_channel_row)?
        .collect::<Result<Vec<_>>>()?;

    Ok(channels)
}

pub fn get_favorites(conn: &Connection) -> Result<Vec<Channel>> {
    let sql = format!(
        "SELECT {} FROM channels WHERE is_favorite = 1 ORDER BY name",
        CHANNEL_SELECT_COLUMNS
    );
    let mut stmt = conn.prepare(&sql)?;

    let channels = stmt.query_map([], map_channel_row)?
        .collect::<Result<Vec<_>>>()?;

    Ok(channels)
}

pub fn get_channel_by_id(conn: &Connection, id: i64) -> Result<Option<Channel>> {
    let sql = format!("SELECT {} FROM channels WHERE id = ?1", CHANNEL_SELECT_COLUMNS);
    let mut stmt = conn.prepare(&sql)?;
    let mut rows = stmt.query_map(params![id], map_channel_row)?;
    rows.next().transpose()
}

// ========== Series Episode Queries ==========

/// Episodes of one series row, ordered by season then episode.
pub fn get_series_episodes(conn: &Connection, series_channel_id: i64) -> Result<Vec<SeriesEpisode>> {
    let sql = format!(
        "SELECT {} FROM series_episodes WHERE series_channel_id = ?1 ORDER BY season, episode",
        SERIES_EPISODE_SELECT_COLUMNS
    );
    let mut stmt = conn.prepare(&sql)?;
    let episodes = stmt.query_map(params![series_channel_id], map_series_episode_row)?
        .collect::<Result<Vec<_>>>()?;
    Ok(episodes)
}

/// Episodes by id, in no particular order. Ids are bound as one JSON array so
/// long lists do not hit SQLite's bound-parameter limit.
pub fn get_series_episodes_by_ids(conn: &Connection, ids: &[i64]) -> Result<Vec<SeriesEpisode>> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let ids_json = format!(
        "[{}]",
        ids.iter().map(|id| id.to_string()).collect::<Vec<_>>().join(",")
    );
    let sql = format!(
        "SELECT {} FROM series_episodes WHERE id IN (SELECT value FROM json_each(?1))",
        SERIES_EPISODE_SELECT_COLUMNS
    );
    let mut stmt = conn.prepare(&sql)?;
    let episodes = stmt.query_map(params![ids_json], map_series_episode_row)?
        .collect::<Result<Vec<_>>>()?;
    Ok(episodes)
}

// ========== Settings Queries ==========

pub fn get_setting(conn: &Connection, key: &str) -> Result<Option<String>> {
    let mut stmt = conn.prepare("SELECT value FROM settings WHERE key = ?1")?;
    let mut rows = stmt.query(params![key])?;

    if let Some(row) = rows.next()? {
        Ok(Some(row.get(0)?))
    } else {
        Ok(None)
    }
}

/// Get multiple settings in a single query for efficiency
pub fn get_multiple_settings(conn: &Connection, keys: &[&str]) -> Result<HashMap<String, String>> {
    if keys.is_empty() {
        return Ok(HashMap::new());
    }

    let placeholders = keys.iter().map(|_| "?").collect::<Vec<_>>().join(",");
    let sql = format!("SELECT key, value FROM settings WHERE key IN ({})", placeholders);

    let mut stmt = conn.prepare(&sql)?;
    let result = stmt.query_map(rusqlite::params_from_iter(keys), |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?
    .collect::<Result<HashMap<_, _>, _>>()?;

    Ok(result)
}

// ========== EPG Queries ==========

/// Get the total count of EPG programs in the database
pub fn get_epg_program_count(conn: &Connection) -> Result<usize> {
    let count: i64 = conn.query_row("SELECT COUNT(*) FROM epg_programs", [], |row| row.get(0))?;
    Ok(count as usize)
}

// ========== Stale Playlist Queries ==========

/// Get playlists that have a URL and haven't been updated in the given number of days
pub fn get_stale_playlists(conn: &Connection, days: i64) -> Result<Vec<Playlist>> {
    let sql = format!(
        "SELECT {} FROM playlists
         WHERE url IS NOT NULL
           AND (last_updated IS NULL OR last_updated < datetime('now', ?1))
         ORDER BY created_at DESC",
        PLAYLIST_SELECT_COLUMNS
    );
    let modifier = format!("-{} days", days);
    let mut stmt = conn.prepare(&sql)?;
    let playlists = stmt.query_map(params![modifier], map_playlist_row)?
        .collect::<Result<Vec<_>>>()?;
    Ok(playlists)
}

// ========== Category Queries ==========

/// Get all unique category/group names for a playlist, optionally filtered by content type
/// Categories are ordered by their original provider order (category_order), not alphabetically
pub fn get_channel_groups(
    conn: &Connection,
    playlist_id: i64,
    content_type: Option<&str>,
) -> Result<Vec<String>> {
    // Use MIN(category_order) to get the order from provider
    // Group by group_name to get distinct values, order by the min category_order
    if let Some(ct) = content_type {
        let sql = "SELECT group_name, MIN(category_order) as cat_order FROM channels
                   WHERE playlist_id = ?1 AND group_name IS NOT NULL AND group_name != ''
                   AND content_type = ?2
                   GROUP BY group_name
                   ORDER BY cat_order, group_name";
        let mut stmt = conn.prepare(sql)?;
        let groups = stmt.query_map(params![playlist_id, ct], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<String>, _>>()?;
        Ok(groups)
    } else {
        let sql = "SELECT group_name, MIN(category_order) as cat_order FROM channels
                   WHERE playlist_id = ?1 AND group_name IS NOT NULL AND group_name != ''
                   GROUP BY group_name
                   ORDER BY cat_order, group_name";
        let mut stmt = conn.prepare(sql)?;
        let groups = stmt.query_map(params![playlist_id], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<String>, _>>()?;
        Ok(groups)
    }
}

// ========== Tests ==========

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_helpers::{setup_test_db, create_test_playlist, create_test_channel};
    use crate::db::mutations::{create_channel, toggle_favorite, set_setting};

    // ========== Playlist Tests ==========

    #[test]
    fn test_get_playlists_returns_all() {
        let conn = setup_test_db();
        create_test_playlist(&conn, "Playlist 1");
        create_test_playlist(&conn, "Playlist 2");

        let playlists = get_playlists(&conn).unwrap();
        assert_eq!(playlists.len(), 2);
    }

    // ========== Channel Tests ==========

    #[test]
    fn test_get_channels_by_playlist() {
        let conn = setup_test_db();
        let playlist1 = create_test_playlist(&conn, "Playlist 1");
        let playlist2 = create_test_playlist(&conn, "Playlist 2");

        create_test_channel(&conn, playlist1, "Channel 1");
        create_test_channel(&conn, playlist1, "Channel 2");
        create_test_channel(&conn, playlist2, "Channel 3");

        let channels1 = get_channels(&conn, Some(playlist1)).unwrap();
        let channels2 = get_channels(&conn, Some(playlist2)).unwrap();

        assert_eq!(channels1.len(), 2);
        assert_eq!(channels2.len(), 1);
    }

    #[test]
    fn test_search_channels() {
        let conn = setup_test_db();
        let playlist_id = create_test_playlist(&conn, "Test Playlist");

        create_test_channel(&conn, playlist_id, "SVT1 HD");
        create_test_channel(&conn, playlist_id, "SVT2 HD");
        create_test_channel(&conn, playlist_id, "TV4 HD");

        let results = search_channels(&conn, "SVT").unwrap();
        assert_eq!(results.len(), 2);

        let results = search_channels(&conn, "TV4").unwrap();
        assert_eq!(results.len(), 1);
    }

    #[test]
    fn test_search_channels_case_insensitive() {
        let conn = setup_test_db();
        let playlist_id = create_test_playlist(&conn, "Test Playlist");
        create_test_channel(&conn, playlist_id, "SVT1 HD");

        let results = search_channels(&conn, "svt").unwrap();
        assert_eq!(results.len(), 1);
    }

    #[test]
    fn test_get_favorites() {
        let conn = setup_test_db();
        let playlist_id = create_test_playlist(&conn, "Test Playlist");
        let channel1 = create_test_channel(&conn, playlist_id, "Channel 1");
        let _channel2 = create_test_channel(&conn, playlist_id, "Channel 2");

        toggle_favorite(&conn, channel1).unwrap();

        let favorites = get_favorites(&conn).unwrap();
        assert_eq!(favorites.len(), 1);
        assert_eq!(favorites[0].name, "Channel 1");
    }

    // ========== Settings Tests ==========

    #[test]
    fn test_get_set_setting() {
        let conn = setup_test_db();

        // Initially empty
        let value = get_setting(&conn, "theme").unwrap();
        assert!(value.is_none());

        // Set and get
        set_setting(&conn, "theme", "dark").unwrap();
        let value = get_setting(&conn, "theme").unwrap();
        assert_eq!(value, Some("dark".to_string()));
    }

    #[test]
    fn test_get_multiple_settings() {
        let conn = setup_test_db();

        set_setting(&conn, "theme", "dark").unwrap();
        set_setting(&conn, "volume", "80").unwrap();
        set_setting(&conn, "language", "sv").unwrap();

        let settings = get_multiple_settings(&conn, &["theme", "volume"]).unwrap();

        assert_eq!(settings.len(), 2);
        assert_eq!(settings.get("theme"), Some(&"dark".to_string()));
        assert_eq!(settings.get("volume"), Some(&"80".to_string()));
    }

    #[test]
    fn test_get_multiple_settings_empty() {
        let conn = setup_test_db();

        let settings = get_multiple_settings(&conn, &[]).unwrap();
        assert!(settings.is_empty());
    }

    // ========== Category Tests ==========

    #[test]
    fn test_get_channel_groups() {
        let conn = setup_test_db();
        let playlist_id = create_test_playlist(&conn, "Test Playlist");

        // Create channels with different groups - note category_order to test ordering
        let groups = [("Sweden", 0), ("Norway", 1), ("Denmark", 2)];
        for (i, (group, cat_order)) in groups.iter().enumerate() {
            let channel = Channel {
                id: None,
                playlist_id,
                name: format!("Channel {}", i),
                url: "http://example.com/stream.m3u8".to_string(),
                logo: None,
                group_name: Some(group.to_string()),
                epg_id: None,
                tvg_name: None,
                content_type: "live".to_string(),
                is_favorite: false,
                sort_order: i as i32,
                category_order: *cat_order,
                created_at: None,
            };
            create_channel(&conn, &channel).unwrap();
        }

        let result = get_channel_groups(&conn, playlist_id, None).unwrap();
        assert_eq!(result.len(), 3);
        // Check that order is preserved (Sweden first, then Norway, then Denmark)
        assert_eq!(result[0], "Sweden");
        assert_eq!(result[1], "Norway");
        assert_eq!(result[2], "Denmark");
    }

    #[test]
    fn test_get_channel_groups_by_content_type() {
        let conn = setup_test_db();
        let playlist_id = create_test_playlist(&conn, "Test Playlist");

        // Create live channel
        let live_channel = Channel {
            id: None,
            playlist_id,
            name: "Live Channel".to_string(),
            url: "http://example.com/live.m3u8".to_string(),
            logo: None,
            group_name: Some("Live Group".to_string()),
            epg_id: None,
            tvg_name: None,
            content_type: "live".to_string(),
            is_favorite: false,
            sort_order: 0,
            category_order: 0,
            created_at: None,
        };
        create_channel(&conn, &live_channel).unwrap();

        // Create VOD channel
        let vod_channel = Channel {
            id: None,
            playlist_id,
            name: "VOD Channel".to_string(),
            url: "http://example.com/vod.m3u8".to_string(),
            logo: None,
            group_name: Some("VOD Group".to_string()),
            epg_id: None,
            tvg_name: None,
            content_type: "vod".to_string(),
            is_favorite: false,
            sort_order: 1,
            category_order: 0,
            created_at: None,
        };
        create_channel(&conn, &vod_channel).unwrap();

        // Filter by live
        let live_groups = get_channel_groups(&conn, playlist_id, Some("live")).unwrap();
        assert_eq!(live_groups.len(), 1);
        assert_eq!(live_groups[0], "Live Group");

        // Filter by vod
        let vod_groups = get_channel_groups(&conn, playlist_id, Some("vod")).unwrap();
        assert_eq!(vod_groups.len(), 1);
        assert_eq!(vod_groups[0], "VOD Group");
    }
}
