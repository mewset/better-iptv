use rusqlite::{Connection, Result, params};
use log::{debug, warn};
use std::time::Instant;
use super::models::*;
use crate::utils::generate_epg_id_swedish;
use crate::series_domain::{EpisodeInput, SeriesGroup};

// ========== Playlist Mutations ==========

pub fn create_playlist(conn: &Connection, playlist: &Playlist) -> Result<i64> {
    conn.execute(
        "INSERT INTO playlists (name, url, file_path, auto_refresh, xtream_username, xtream_password)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            playlist.name,
            playlist.url,
            playlist.file_path,
            playlist.auto_refresh,
            playlist.xtream_username,
            playlist.xtream_password
        ],
    )?;
    Ok(conn.last_insert_rowid())
}

pub fn delete_playlist(conn: &Connection, id: i64) -> Result<()> {
    conn.execute("DELETE FROM playlists WHERE id = ?1", params![id])?;
    Ok(())
}

pub fn rename_playlist(conn: &Connection, playlist_id: i64, new_name: &str) -> Result<()> {
    conn.execute(
        "UPDATE playlists SET name = ?1 WHERE id = ?2",
        params![new_name, playlist_id],
    )?;
    Ok(())
}

// ========== Channel Mutations ==========

pub fn create_channel(conn: &Connection, channel: &Channel) -> Result<i64> {
    conn.execute(
        "INSERT INTO channels (playlist_id, name, url, logo, group_name, epg_id, tvg_name, content_type, is_favorite, sort_order, category_order)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        params![
            channel.playlist_id,
            channel.name,
            channel.url,
            channel.logo,
            channel.group_name,
            channel.epg_id,
            channel.tvg_name,
            channel.content_type,
            channel.is_favorite,
            channel.sort_order,
            channel.category_order
        ],
    )?;
    Ok(conn.last_insert_rowid())
}

pub fn create_channels_batch(conn: &Connection, channels: &[Channel]) -> Result<()> {
    let start = Instant::now();
    let tx = conn.unchecked_transaction()?;

    {
        let mut stmt = tx.prepare_cached(
            "INSERT INTO channels (playlist_id, name, url, logo, group_name, epg_id, tvg_name, content_type, sort_order, category_order)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)"
        )?;

        for channel in channels {
            stmt.execute(params![
                channel.playlist_id,
                channel.name,
                channel.url,
                channel.logo,
                channel.group_name,
                channel.epg_id,
                channel.tvg_name,
                channel.content_type,
                channel.sort_order,
                channel.category_order
            ])?;
        }
    }

    tx.commit()?;
    debug!("create_channels_batch: {} channels in {:?}", channels.len(), start.elapsed());
    Ok(())
}

// ========== Series Episode Mutations ==========

/// Insert the episodes of one series row. Runs in the caller's transaction, if any.
pub fn insert_series_episodes(
    conn: &Connection,
    series_channel_id: i64,
    episodes: &[EpisodeInput],
) -> Result<()> {
    let mut stmt = conn.prepare_cached(
        "INSERT INTO series_episodes (series_channel_id, season, episode, title, url, logo)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
    )?;
    for ep in episodes {
        stmt.execute(params![
            series_channel_id,
            ep.season,
            ep.episode,
            ep.title,
            ep.url,
            ep.logo
        ])?;
    }
    Ok(())
}

/// Insert one `channels` row per group plus its episodes. Returns the number
/// of episodes written. Does not open a transaction so callers can wrap it.
pub fn insert_series_groups(
    conn: &Connection,
    playlist_id: i64,
    groups: &[SeriesGroup],
) -> Result<usize> {
    let mut inserted = 0;
    for group in groups {
        let channel = Channel {
            playlist_id,
            ..group.channel.clone()
        };
        let series_id = create_channel(conn, &channel)?;
        insert_series_episodes(conn, series_id, &group.episodes)?;
        inserted += group.episodes.len();
    }
    Ok(inserted)
}

pub fn toggle_favorite(conn: &Connection, channel_id: i64) -> Result<()> {
    conn.execute(
        "UPDATE channels SET is_favorite = NOT is_favorite WHERE id = ?1",
        params![channel_id],
    )?;
    Ok(())
}

// ========== Settings Mutations ==========

pub fn set_setting(conn: &Connection, key: &str, value: &str) -> Result<()> {
    conn.execute(
        "INSERT OR REPLACE INTO settings (key, value, updated_at)
         VALUES (?1, ?2, CURRENT_TIMESTAMP)",
        params![key, value],
    )?;
    Ok(())
}

/// Delete a setting by key
pub fn delete_setting(conn: &Connection, key: &str) -> Result<()> {
    conn.execute("DELETE FROM settings WHERE key = ?1", params![key])?;
    Ok(())
}

// ========== Playlist Refresh Mutations ==========

/// Update the last_updated timestamp of a playlist to now
pub fn update_playlist_last_updated(conn: &Connection, id: i64) -> Result<()> {
    conn.execute(
        "UPDATE playlists SET last_updated = datetime('now') WHERE id = ?1",
        params![id],
    )?;
    Ok(())
}

/// Extract stream_id from an Xtream-style URL.
/// Pattern: /{live|movie|series}/user/pass/{stream_id}.{ext}
fn extract_stream_id_from_url(url: &str) -> Option<i64> {
    let path = url.rsplit('/').next()?;
    let id_str = path.split('.').next()?;
    id_str.parse::<i64>().ok()
}

/// Merge new channels into an existing playlist, preserving favorites.
///
/// - If `match_by_stream_id` is true (Xtream), channels are matched by stream_id extracted from URL.
/// - Otherwise (M3U), channels are matched by `(name, group_name)` with `name`-only fallback.
/// - `content_type` is refreshed on matched rows too, so a channel that
///   changes type between refreshes (e.g. live -> series) picks up the change.
///
/// Returns counts of added, updated, and removed channels.
pub fn merge_channels(
    conn: &Connection,
    playlist_id: i64,
    new_channels: &[Channel],
    match_by_stream_id: bool,
) -> Result<MergeResult> {
    use std::collections::HashMap;
    use std::collections::HashSet;

    let start = Instant::now();
    let tx = conn.unchecked_transaction()?;

    // 1. Load existing channels for this playlist
    let mut stmt = tx.prepare(
        "SELECT id, name, url, group_name, is_favorite FROM channels WHERE playlist_id = ?1",
    )?;

    struct ExistingChannel {
        id: i64,
        name: String,
        url: String,
        group_name: Option<String>,
        is_favorite: bool,
    }

    let existing: Vec<ExistingChannel> = stmt
        .query_map(params![playlist_id], |row| {
            Ok(ExistingChannel {
                id: row.get(0)?,
                name: row.get(1)?,
                url: row.get(2)?,
                group_name: row.get(3)?,
                is_favorite: row.get(4)?,
            })
        })?
        .collect::<Result<Vec<_>>>()?;
    drop(stmt);

    // 2. Build lookup map from existing channels
    // Maps a match key -> (db_id, is_favorite)
    let mut lookup: HashMap<String, (i64, bool)> = HashMap::new();

    if match_by_stream_id {
        for ch in &existing {
            if let Some(sid) = extract_stream_id_from_url(&ch.url) {
                lookup.insert(format!("sid:{}", sid), (ch.id, ch.is_favorite));
            }
        }
    } else {
        // M3U: primary key = (name, group_name), fallback = name only
        // Insert name-only first so (name, group_name) wins if both exist
        for ch in &existing {
            lookup.insert(format!("name:{}", ch.name), (ch.id, ch.is_favorite));
        }
        for ch in &existing {
            let key = format!(
                "namegroup:{}|{}",
                ch.name,
                ch.group_name.as_deref().unwrap_or("")
            );
            lookup.insert(key, (ch.id, ch.is_favorite));
        }
    }

    // 3. Process new channels
    let mut matched_ids: HashSet<i64> = HashSet::new();
    let mut added: usize = 0;
    let mut updated: usize = 0;

    {
        let mut update_stmt = tx.prepare_cached(
            "UPDATE channels SET url=?1, logo=?2, group_name=?3, epg_id=?4, tvg_name=?5, sort_order=?6, category_order=?7, content_type=?8 WHERE id=?9",
        )?;

        let mut insert_stmt = tx.prepare_cached(
            "INSERT INTO channels (playlist_id, name, url, logo, group_name, epg_id, tvg_name, content_type, is_favorite, sort_order, category_order)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        )?;

        for ch in new_channels {
            // Try to find a match
            let matched = if match_by_stream_id {
                extract_stream_id_from_url(&ch.url)
                    .and_then(|sid| lookup.get(&format!("sid:{}", sid)))
            } else {
                // Try (name, group_name) first, then name only
                let key = format!(
                    "namegroup:{}|{}",
                    ch.name,
                    ch.group_name.as_deref().unwrap_or("")
                );
                lookup
                    .get(&key)
                    .or_else(|| lookup.get(&format!("name:{}", ch.name)))
            };

            if let Some(&(db_id, _is_favorite)) = matched {
                // Update existing channel (preserve is_favorite)
                update_stmt.execute(params![
                    ch.url,
                    ch.logo,
                    ch.group_name,
                    ch.epg_id,
                    ch.tvg_name,
                    ch.sort_order,
                    ch.category_order,
                    ch.content_type,
                    db_id,
                ])?;
                matched_ids.insert(db_id);
                updated += 1;
            } else {
                // Insert new channel
                insert_stmt.execute(params![
                    playlist_id,
                    ch.name,
                    ch.url,
                    ch.logo,
                    ch.group_name,
                    ch.epg_id,
                    ch.tvg_name,
                    ch.content_type,
                    false, // new channels start unfavorited
                    ch.sort_order,
                    ch.category_order,
                ])?;
                added += 1;
            }
        }
    }

    // 4. Delete unmatched old channels
    let removed = existing.len() - matched_ids.len();
    if removed > 0 {
        if matched_ids.is_empty() {
            tx.execute(
                "DELETE FROM channels WHERE playlist_id = ?1",
                params![playlist_id],
            )?;
        } else {
            // Pass the ids to keep as one JSON array instead of one bound
            // parameter each. A `NOT IN (?, ?, ...)` list trips SQLite's
            // SQLITE_MAX_VARIABLE_NUMBER (32766) once a playlist keeps that
            // many channels, failing the whole refresh with a raw SQL error.
            // These ids come straight from the `channels.id` column, so
            // formatting the array by hand always yields valid JSON.
            let ids_json = format!(
                "[{}]",
                matched_ids
                    .iter()
                    .map(|id| id.to_string())
                    .collect::<Vec<_>>()
                    .join(",")
            );

            tx.execute(
                "DELETE FROM channels WHERE playlist_id = ?1
                 AND id NOT IN (SELECT value FROM json_each(?2))",
                params![playlist_id, ids_json],
            )?;
        }
    }

    tx.commit()?;

    let total = added + updated;
    debug!("merge_channels: added={}, updated={}, removed={} in {:?}", added, updated, removed, start.elapsed());
    Ok(MergeResult {
        added,
        updated,
        removed,
        total,
    })
}

/// Replace every M3U series episode of a playlist with the freshly parsed
/// set. Episodes carry no user state, so a wholesale swap is safer than a
/// merge. Groups are matched to series rows on `(name, group_name)`, the same
/// key `merge_channels` uses for M3U rows. Returns the number written.
pub fn replace_series_episodes(
    conn: &Connection,
    playlist_id: i64,
    groups: &[SeriesGroup],
) -> Result<usize> {
    use std::collections::HashMap;

    let tx = conn.unchecked_transaction()?;

    tx.execute(
        "DELETE FROM series_episodes
         WHERE series_channel_id IN (SELECT id FROM channels WHERE playlist_id = ?1)",
        params![playlist_id],
    )?;

    let mut lookup: HashMap<(String, String), i64> = HashMap::new();
    {
        let mut stmt = tx.prepare(
            "SELECT id, name, group_name FROM channels
             WHERE playlist_id = ?1 AND content_type = 'series'",
        )?;
        let rows = stmt.query_map(params![playlist_id], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
            ))
        })?;
        for row in rows {
            let (id, name, group) = row?;
            lookup.insert((name, group.unwrap_or_default()), id);
        }
    }

    let mut written = 0;
    for group in groups {
        let key = (
            group.channel.name.clone(),
            group.channel.group_name.clone().unwrap_or_default(),
        );
        match lookup.get(&key) {
            Some(&series_id) => {
                insert_series_episodes(&tx, series_id, &group.episodes)?;
                written += group.episodes.len();
            }
            None => warn!(
                "replace_series_episodes: no series row for '{}' in group '{}'",
                key.0, key.1
            ),
        }
    }

    tx.commit()?;
    debug!("replace_series_episodes: {} episodes for playlist {}", written, playlist_id);
    Ok(written)
}

// ========== EPG Mutations ==========

/// Update EPG IDs for all Swedish channels based on their names
/// Uses a transaction with prepared statement for batch efficiency
pub fn update_channel_epg_ids(conn: &Connection) -> Result<usize> {
    // Get all live channels without EPG IDs
    let mut stmt = conn.prepare(
        "SELECT id, name FROM channels WHERE content_type = 'live' AND epg_id IS NULL"
    )?;
    let channels: Vec<(i64, String)> = stmt
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<Result<Vec<_>, _>>()?;
    drop(stmt); // Explicitly drop to release borrow

    if channels.is_empty() {
        return Ok(0);
    }

    // Batch update using transaction for ~100-1000x performance improvement
    let tx = conn.unchecked_transaction()?;
    let mut updated_count = 0;

    {
        let mut update_stmt = tx.prepare_cached(
            "UPDATE channels SET epg_id = ?1 WHERE id = ?2"
        )?;

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

// ========== Tests ==========

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_helpers::{setup_test_db, create_test_playlist, create_test_channel};
    use crate::db::queries::*;

    // ========== Playlist Tests ==========

    #[test]
    fn test_create_playlist_returns_id() {
        let conn = setup_test_db();
        let id = create_test_playlist(&conn, "Test Playlist");
        assert!(id > 0);
    }

    #[test]
    fn test_create_multiple_playlists() {
        let conn = setup_test_db();
        let id1 = create_test_playlist(&conn, "Playlist 1");
        let id2 = create_test_playlist(&conn, "Playlist 2");
        assert_ne!(id1, id2);
    }

    #[test]
    fn test_delete_playlist() {
        let conn = setup_test_db();
        let id = create_test_playlist(&conn, "To Delete");

        delete_playlist(&conn, id).unwrap();

        let playlists = get_playlists(&conn).unwrap();
        assert!(playlists.is_empty());
    }

    #[test]
    fn test_rename_playlist() {
        let conn = setup_test_db();
        let id = create_test_playlist(&conn, "Old Name");

        rename_playlist(&conn, id, "New Name").unwrap();

        let playlists = get_playlists(&conn).unwrap();
        assert_eq!(playlists[0].name, "New Name");
    }

    // ========== Channel Tests ==========

    #[test]
    fn test_create_channel() {
        let conn = setup_test_db();
        let playlist_id = create_test_playlist(&conn, "Test Playlist");
        let channel_id = create_test_channel(&conn, playlist_id, "Test Channel");

        assert!(channel_id > 0);
    }

    #[test]
    fn test_toggle_favorite() {
        let conn = setup_test_db();
        let playlist_id = create_test_playlist(&conn, "Test Playlist");
        let channel_id = create_test_channel(&conn, playlist_id, "Test Channel");

        // Initially not favorite
        let channels = get_channels(&conn, Some(playlist_id)).unwrap();
        assert!(!channels[0].is_favorite);

        // Toggle to favorite
        toggle_favorite(&conn, channel_id).unwrap();
        let channels = get_channels(&conn, Some(playlist_id)).unwrap();
        assert!(channels[0].is_favorite);

        // Toggle back
        toggle_favorite(&conn, channel_id).unwrap();
        let channels = get_channels(&conn, Some(playlist_id)).unwrap();
        assert!(!channels[0].is_favorite);
    }

    #[test]
    fn test_batch_create_channels() {
        let conn = setup_test_db();
        let playlist_id = create_test_playlist(&conn, "Test Playlist");

        let channels: Vec<Channel> = (0..100)
            .map(|i| Channel {
                id: None,
                playlist_id,
                name: format!("Channel {}", i),
                url: format!("http://example.com/stream{}.m3u8", i),
                logo: None,
                group_name: Some("Batch Test".to_string()),
                epg_id: None,
                tvg_name: None,
                content_type: "live".to_string(),
                is_favorite: false,
                sort_order: i,
                category_order: 0,
                created_at: None,
            })
            .collect();

        create_channels_batch(&conn, &channels).unwrap();

        let stored = get_channels(&conn, Some(playlist_id)).unwrap();
        assert_eq!(stored.len(), 100);
    }

    /// Regression test for the channel-prune step of a playlist refresh.
    ///
    /// The prune used to build `id NOT IN (?, ?, ...)` with one bound parameter
    /// per kept channel. That works until the keep-set reaches SQLite's
    /// SQLITE_MAX_VARIABLE_NUMBER (32766), at which point a refresh fails with
    /// "variable number must be between ?1 and ?32766" — reachable on real IPTV
    /// playlists, which routinely carry tens of thousands of entries once VOD is
    /// included. The count here must stay above that limit for this test to mean
    /// anything: at 1500 it passes against the buggy implementation too.
    #[test]
    fn test_merge_channels_prunes_playlist_larger_than_sqlite_variable_limit() {
        let conn = setup_test_db();
        let playlist_id = create_test_playlist(&conn, "Huge Playlist");

        // Above SQLITE_MAX_VARIABLE_NUMBER (32766).
        const KEEP_COUNT: i32 = 33_000;
        let existing: Vec<Channel> = (0..KEEP_COUNT + 1)
            .map(|i| Channel {
                id: None,
                playlist_id,
                name: format!("Channel {}", i),
                url: format!("http://example.com/stream{}.m3u8", i),
                logo: None,
                group_name: Some("Huge Group".to_string()),
                epg_id: None,
                tvg_name: None,
                content_type: "live".to_string(),
                is_favorite: false,
                sort_order: i,
                category_order: 0,
                created_at: None,
            })
            .collect();
        create_channels_batch(&conn, &existing).unwrap();

        // The refresh matches every channel but the last, so the prune has to
        // delete exactly one stale row while keeping 33 000.
        let refreshed: Vec<Channel> = existing[..KEEP_COUNT as usize].to_vec();
        let result = merge_channels(&conn, playlist_id, &refreshed, false).unwrap();

        assert_eq!(result.removed, 1);
        assert_eq!(result.updated, KEEP_COUNT as usize);
        assert_eq!(
            get_channels(&conn, Some(playlist_id)).unwrap().len(),
            KEEP_COUNT as usize
        );
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
    fn test_update_setting() {
        let conn = setup_test_db();

        set_setting(&conn, "theme", "light").unwrap();
        set_setting(&conn, "theme", "dark").unwrap();

        let value = get_setting(&conn, "theme").unwrap();
        assert_eq!(value, Some("dark".to_string()));
    }

    // ========== Cascade Delete Tests ==========

    #[test]
    fn test_delete_playlist_cascades_to_channels() {
        let conn = setup_test_db();
        let playlist_id = create_test_playlist(&conn, "Test Playlist");
        create_test_channel(&conn, playlist_id, "Channel 1");
        create_test_channel(&conn, playlist_id, "Channel 2");

        // Verify channels exist
        let channels = get_channels(&conn, Some(playlist_id)).unwrap();
        assert_eq!(channels.len(), 2);

        // Delete playlist
        delete_playlist(&conn, playlist_id).unwrap();

        // Verify channels are deleted
        let all_channels = get_channels(&conn, None).unwrap();
        assert!(all_channels.is_empty());
    }

    // ========== Series episodes ==========

    fn series_group(playlist_id: i64, name: &str, group: &str, episodes: &[(i32, i32)]) -> crate::series_domain::SeriesGroup {
        use crate::series_domain::{EpisodeInput, SeriesGroup};
        SeriesGroup {
            channel: Channel {
                id: None,
                playlist_id,
                name: name.to_string(),
                url: format!("http://host/{}-s1e1.mkv", name),
                logo: Some("http://logo/cover.png".to_string()),
                group_name: Some(group.to_string()),
                epg_id: None,
                tvg_name: None,
                content_type: "series".to_string(),
                is_favorite: false,
                sort_order: 0,
                category_order: 0,
                created_at: None,
            },
            episodes: episodes
                .iter()
                .map(|&(s, e)| EpisodeInput {
                    season: s,
                    episode: e,
                    title: format!("{} S{:02}E{:02}", name, s, e),
                    url: format!("http://host/{}-s{}e{}.mkv", name, s, e),
                    logo: None,
                })
                .collect(),
            source_ids: vec![],
        }
    }

    #[test]
    fn insert_series_groups_creates_series_row_and_episodes() {
        let conn = setup_test_db();
        let pid = create_test_playlist(&conn, "M3U");

        let inserted = insert_series_groups(&conn, pid, &[series_group(pid, "Dark", "Series", &[(1, 1), (1, 2), (2, 1)])]).unwrap();
        assert_eq!(inserted, 3);

        let channels = get_channels(&conn, Some(pid)).unwrap();
        assert_eq!(channels.len(), 1);
        assert_eq!(channels[0].content_type, "series");
        let series_id = channels[0].id.unwrap();

        let episodes = get_series_episodes(&conn, series_id).unwrap();
        assert_eq!(episodes.len(), 3);
        assert_eq!((episodes[0].season, episodes[0].episode), (1, 1));
        assert_eq!((episodes[2].season, episodes[2].episode), (2, 1));
        assert_eq!(episodes[1].url, "http://host/Dark-s1e2.mkv");
    }

    #[test]
    fn create_channel_persists_is_favorite() {
        let conn = setup_test_db();
        let pid = create_test_playlist(&conn, "M3U");
        let mut group = series_group(pid, "Dark", "Series", &[(1, 1)]);
        group.channel.is_favorite = true;

        insert_series_groups(&conn, pid, &[group]).unwrap();

        let channels = get_channels(&conn, Some(pid)).unwrap();
        assert!(channels[0].is_favorite);
    }

    #[test]
    fn deleting_series_channel_cascades_to_episodes() {
        let conn = setup_test_db();
        let pid = create_test_playlist(&conn, "M3U");
        insert_series_groups(&conn, pid, &[series_group(pid, "Dark", "Series", &[(1, 1)])]).unwrap();
        let series_id = get_channels(&conn, Some(pid)).unwrap()[0].id.unwrap();

        conn.execute("DELETE FROM channels WHERE id = ?1", params![series_id]).unwrap();

        assert!(get_series_episodes(&conn, series_id).unwrap().is_empty());
    }

    #[test]
    fn get_series_episodes_by_ids_returns_only_requested_rows() {
        let conn = setup_test_db();
        let pid = create_test_playlist(&conn, "M3U");
        insert_series_groups(&conn, pid, &[series_group(pid, "Dark", "Series", &[(1, 1), (1, 2), (1, 3)])]).unwrap();
        let series_id = get_channels(&conn, Some(pid)).unwrap()[0].id.unwrap();
        let all = get_series_episodes(&conn, series_id).unwrap();

        let some = get_series_episodes_by_ids(&conn, &[all[2].id, all[0].id]).unwrap();

        let mut ids: Vec<i64> = some.iter().map(|e| e.id).collect();
        ids.sort();
        assert_eq!(ids, vec![all[0].id, all[2].id]);
    }

    #[test]
    fn get_channel_by_id_returns_none_for_unknown() {
        let conn = setup_test_db();
        assert!(get_channel_by_id(&conn, 999).unwrap().is_none());
    }

    #[test]
    fn merge_channels_updates_content_type_of_matched_row() {
        let conn = setup_test_db();
        let pid = create_test_playlist(&conn, "M3U");
        let live_id = create_test_channel(&conn, pid, "Dark");
        conn.execute("UPDATE channels SET group_name = 'Series' WHERE id = ?1", params![live_id]).unwrap();

        let fresh = series_group(pid, "Dark", "Series", &[(1, 1)]).channel;
        let result = merge_channels(&conn, pid, &[fresh], false).unwrap();

        assert_eq!((result.added, result.updated, result.removed), (0, 1, 0));
        let row = get_channel_by_id(&conn, live_id).unwrap().unwrap();
        assert_eq!(row.content_type, "series");
    }

    #[test]
    fn replace_series_episodes_swaps_episode_set_and_keeps_favourite() {
        let conn = setup_test_db();
        let pid = create_test_playlist(&conn, "M3U");
        insert_series_groups(&conn, pid, &[series_group(pid, "Dark", "Series", &[(1, 1), (1, 2)])]).unwrap();
        let series_id = get_channels(&conn, Some(pid)).unwrap()[0].id.unwrap();
        toggle_favorite(&conn, series_id).unwrap();

        // Provider now lists S01E02 and a new S01E03; S01E01 is gone.
        let fresh = series_group(pid, "Dark", "Series", &[(1, 2), (1, 3)]);
        let merged = merge_channels(&conn, pid, std::slice::from_ref(&fresh.channel), false).unwrap();
        assert_eq!((merged.added, merged.updated, merged.removed), (0, 1, 0));

        let written = replace_series_episodes(&conn, pid, &[fresh]).unwrap();
        assert_eq!(written, 2);

        let channels = get_channels(&conn, Some(pid)).unwrap();
        assert_eq!(channels.len(), 1);
        assert_eq!(channels[0].id, Some(series_id), "series row survives merge");
        assert!(channels[0].is_favorite);

        let episodes = get_series_episodes(&conn, series_id).unwrap();
        assert_eq!(
            episodes.iter().map(|e| e.episode).collect::<Vec<_>>(),
            vec![2, 3]
        );
    }

    #[test]
    fn replace_series_episodes_skips_group_without_series_row() {
        let conn = setup_test_db();
        let pid = create_test_playlist(&conn, "M3U");

        let written = replace_series_episodes(&conn, pid, &[series_group(pid, "Ghost", "Series", &[(1, 1)])]).unwrap();

        assert_eq!(written, 0);
        let count: i64 = conn.query_row("SELECT COUNT(*) FROM series_episodes", [], |r| r.get(0)).unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn replace_series_episodes_only_touches_the_given_playlist() {
        let conn = setup_test_db();
        let a = create_test_playlist(&conn, "A");
        let b = create_test_playlist(&conn, "B");
        insert_series_groups(&conn, a, &[series_group(a, "Dark", "Series", &[(1, 1)])]).unwrap();
        insert_series_groups(&conn, b, &[series_group(b, "Dark", "Series", &[(1, 1), (1, 2)])]).unwrap();
        let b_series = get_channels(&conn, Some(b)).unwrap()[0].id.unwrap();

        replace_series_episodes(&conn, a, &[series_group(a, "Dark", "Series", &[(2, 1)])]).unwrap();

        assert_eq!(get_series_episodes(&conn, b_series).unwrap().len(), 2);
    }
}
