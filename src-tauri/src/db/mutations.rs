use super::models::*;
use crate::series_domain::{EpisodeInput, SeriesGroup};
use crate::utils::generate_epg_id_swedish;
use log::{debug, warn};
use rusqlite::{params, Connection, Result};
use std::time::Instant;

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

/// Store what the provider last reported about a playlist's subscription
///
/// A `None` date clears the stored one, so an account that stops reporting a
/// date stops showing one rather than keeping the value it had. `checked_at`
/// is written either way, since a check that found no date still happened and
/// still counts against asking again.
pub fn set_xtream_expiry(
    conn: &Connection,
    playlist_id: i64,
    exp_date: Option<&str>,
    checked_at: &str,
) -> Result<()> {
    conn.execute(
        "UPDATE playlists SET xtream_exp_date = ?1, xtream_exp_checked_at = ?2 WHERE id = ?3",
        rusqlite::params![exp_date, checked_at, playlist_id],
    )?;
    Ok(())
}

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

/// Insert many channels with a cached prepared statement. Does not open a
/// transaction of its own — wrap the call (and any surrounding work that
/// must commit atomically with it) in the caller's own
/// `conn.unchecked_transaction()` for atomic, batched commits. Passing a
/// `Transaction` here works via `Deref<Target = Connection>`.
pub fn create_channels_batch(conn: &Connection, channels: &[Channel]) -> Result<()> {
    let start = Instant::now();

    {
        let mut stmt = conn.prepare_cached(
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

    debug!(
        "create_channels_batch: {} channels in {:?}",
        channels.len(),
        start.elapsed()
    );
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

/// Delete a setting only if it currently holds `value`. Returns whether a row
/// was removed, so a caller can tell a match from a stale compare.
pub fn delete_setting_if_value(conn: &Connection, key: &str, value: &str) -> Result<bool> {
    let removed = conn.execute(
        "DELETE FROM settings WHERE key = ?1 AND value = ?2",
        params![key, value],
    )?;
    Ok(removed > 0)
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

/// Extract a match key from an Xtream-style URL.
/// Pattern: /{live|movie|series}/user/pass/{stream_id}.{ext}
///
/// Panels number live streams, movies and series independently, so the
/// same id can name one of each. The key carries the content segment as
/// well as the id to keep them apart; an unknown segment falls back to
/// the bare id so unusual URL shapes still match by number.
fn extract_stream_key_from_url(url: &str) -> Option<String> {
    let mut parts = url.rsplit('/');
    let file = parts.next()?;
    let id: i64 = file.split('.').next()?.parse().ok()?;
    let kind = parts
        .nth(2)
        .filter(|k| matches!(*k, "live" | "movie" | "series"))
        .unwrap_or("");
    Some(format!("{}:{}", kind, id))
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
            if let Some(key) = extract_stream_key_from_url(&ch.url) {
                lookup.insert(format!("sid:{}", key), (ch.id, ch.is_favorite));
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
                extract_stream_key_from_url(&ch.url)
                    .and_then(|key| lookup.get(&format!("sid:{}", key)))
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

    // 4. Delete the pre-existing rows this refresh did not match.
    //
    // Deleting by an explicit stale list rather than by `id NOT IN matched`:
    // the inverse match also caught every row step 3 had just inserted, since
    // those are in this playlist and cannot be in `matched_ids`, so a refresh
    // that dropped one stale channel also deleted every channel it had added.
    let stale_ids: Vec<i64> = existing
        .iter()
        .map(|ch| ch.id)
        .filter(|id| !matched_ids.contains(id))
        .collect();
    let removed = stale_ids.len();

    if removed > 0 {
        // The ids go as one JSON array instead of one bound parameter each.
        // An `IN (?, ?, ...)` list trips SQLite's SQLITE_MAX_VARIABLE_NUMBER
        // (32766) once a refresh drops that many channels, failing the whole
        // refresh with a raw SQL error. These ids come straight from the
        // `channels.id` column, so formatting the array by hand always yields
        // valid JSON.
        let ids_json = format!(
            "[{}]",
            stale_ids
                .iter()
                .map(|id| id.to_string())
                .collect::<Vec<_>>()
                .join(",")
        );

        tx.execute(
            "DELETE FROM channels WHERE playlist_id = ?1
             AND id IN (SELECT value FROM json_each(?2))",
            params![playlist_id, ids_json],
        )?;
    }

    tx.commit()?;

    let total = added + updated;
    debug!(
        "merge_channels: added={}, updated={}, removed={} in {:?}",
        added,
        updated,
        removed,
        start.elapsed()
    );
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
    debug!(
        "replace_series_episodes: {} episodes for playlist {}",
        written, playlist_id
    );
    Ok(written)
}

// ========== EPG Mutations ==========

/// Update EPG IDs for all Swedish channels based on their names
/// Uses a transaction with prepared statement for batch efficiency
pub fn update_channel_epg_ids(conn: &Connection) -> Result<usize> {
    // Get all live channels without EPG IDs
    let mut stmt = conn
        .prepare("SELECT id, name FROM channels WHERE content_type = 'live' AND epg_id IS NULL")?;
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

// ========== TMDB cache ==========

/// Write the search-level columns. A `manual` row is left exactly as it is:
/// the user's choice outranks any automatic match.
/// Detail columns survive a re-search that finds the same id; a different id
/// clears them, so the details of the old match are never shown as fresh.
pub fn upsert_tmdb_search(conn: &Connection, row: &TmdbRow) -> Result<()> {
    conn.execute(
        "INSERT INTO tmdb_metadata (normalized_title, year, content_type, tmdb_id, manual, title,
             original_title, release_year, rating, poster_path, backdrop_path, overview, genre_ids,
             searched_at)
         VALUES (?1, ?2, ?3, ?4, 0, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
         ON CONFLICT(normalized_title, year, content_type) DO UPDATE SET
             tmdb_id = excluded.tmdb_id, title = excluded.title,
             original_title = excluded.original_title, release_year = excluded.release_year,
             rating = excluded.rating, poster_path = excluded.poster_path,
             backdrop_path = excluded.backdrop_path, overview = excluded.overview,
             genre_ids = excluded.genre_ids, searched_at = excluded.searched_at,
             runtime_minutes = CASE WHEN excluded.tmdb_id IS tmdb_metadata.tmdb_id
                 THEN tmdb_metadata.runtime_minutes ELSE NULL END,
             genres = CASE WHEN excluded.tmdb_id IS tmdb_metadata.tmdb_id
                 THEN tmdb_metadata.genres ELSE NULL END,
             cast_json = CASE WHEN excluded.tmdb_id IS tmdb_metadata.tmdb_id
                 THEN tmdb_metadata.cast_json ELSE NULL END,
             trailer_youtube_key = CASE WHEN excluded.tmdb_id IS tmdb_metadata.tmdb_id
                 THEN tmdb_metadata.trailer_youtube_key ELSE NULL END,
             details_fetched_at = CASE WHEN excluded.tmdb_id IS tmdb_metadata.tmdb_id
                 THEN tmdb_metadata.details_fetched_at ELSE NULL END
         WHERE tmdb_metadata.manual = 0",
        params![
            row.key.title,
            row.key.year,
            row.key.content_type,
            row.tmdb_id,
            row.title,
            row.original_title,
            row.release_year,
            row.rating,
            row.poster_path,
            row.backdrop_path,
            row.overview,
            row.genre_ids,
            row.searched_at,
        ],
    )?;
    Ok(())
}

/// Write every column. Keeps `manual` as stored (details are fetched for
/// manual picks too).
pub fn upsert_tmdb_details(conn: &Connection, row: &TmdbRow) -> Result<()> {
    conn.execute(
        "INSERT INTO tmdb_metadata (normalized_title, year, content_type, tmdb_id, manual, title,
             original_title, release_year, rating, poster_path, backdrop_path, overview, genre_ids,
             runtime_minutes, genres, cast_json, trailer_youtube_key, searched_at, details_fetched_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19)
         ON CONFLICT(normalized_title, year, content_type) DO UPDATE SET
             tmdb_id = excluded.tmdb_id, title = excluded.title,
             original_title = excluded.original_title, release_year = excluded.release_year,
             rating = excluded.rating, poster_path = excluded.poster_path,
             backdrop_path = excluded.backdrop_path, overview = excluded.overview,
             genre_ids = excluded.genre_ids, runtime_minutes = excluded.runtime_minutes,
             genres = excluded.genres, cast_json = excluded.cast_json,
             trailer_youtube_key = excluded.trailer_youtube_key,
             searched_at = excluded.searched_at, details_fetched_at = excluded.details_fetched_at",
        params![
            row.key.title, row.key.year, row.key.content_type, row.tmdb_id, row.manual as i64,
            row.title, row.original_title, row.release_year, row.rating, row.poster_path,
            row.backdrop_path, row.overview, row.genre_ids, row.runtime_minutes, row.genres,
            row.cast_json, row.trailer_youtube_key, row.searched_at, row.details_fetched_at,
        ],
    )?;
    Ok(())
}

/// Record the user's choice: a TMDB id, or `None` for "not on TMDB". Detail
/// columns are cleared so the next open fetches them for the new id.
pub fn set_tmdb_manual(
    conn: &Connection,
    key: &TmdbKey,
    tmdb_id: Option<i64>,
    now: &str,
) -> Result<()> {
    conn.execute(
        "INSERT INTO tmdb_metadata (normalized_title, year, content_type, tmdb_id, manual, searched_at)
         VALUES (?1, ?2, ?3, ?4, 1, ?5)
         ON CONFLICT(normalized_title, year, content_type) DO UPDATE SET
             tmdb_id = excluded.tmdb_id, manual = 1, searched_at = excluded.searched_at,
             title = NULL, original_title = NULL, release_year = NULL, rating = NULL,
             poster_path = NULL, backdrop_path = NULL, overview = NULL, genre_ids = NULL,
             runtime_minutes = NULL, genres = NULL, cast_json = NULL,
             trailer_youtube_key = NULL, details_fetched_at = NULL",
        params![key.title, key.year, key.content_type, tmdb_id, now],
    )?;
    Ok(())
}

pub fn upsert_tmdb_episodes(conn: &Connection, episodes: &[TmdbEpisodeRow]) -> Result<()> {
    let mut stmt = conn.prepare_cached(
        "INSERT INTO tmdb_episodes (tmdb_id, season, episode, title, overview, still_path,
             runtime_minutes, air_date, fetched_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT(tmdb_id, season, episode) DO UPDATE SET
             title = excluded.title, overview = excluded.overview, still_path = excluded.still_path,
             runtime_minutes = excluded.runtime_minutes, air_date = excluded.air_date,
             fetched_at = excluded.fetched_at",
    )?;
    for e in episodes {
        stmt.execute(params![
            e.tmdb_id,
            e.season,
            e.episode,
            e.title,
            e.overview,
            e.still_path,
            e.runtime_minutes,
            e.air_date,
            e.fetched_at,
        ])?;
    }
    Ok(())
}

/// Empty both cache tables; returns the number of rows removed.
pub fn delete_tmdb_cache(conn: &Connection) -> Result<usize> {
    let a = conn.execute("DELETE FROM tmdb_metadata", [])?;
    let b = conn.execute("DELETE FROM tmdb_episodes", [])?;
    Ok(a + b)
}

// ========== Tests ==========

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::queries::*;
    use crate::db::test_helpers::{create_test_channel, create_test_playlist, setup_test_db};

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

    // ========== Xtream Expiry Tests ==========

    #[test]
    fn the_cached_expiry_starts_empty_and_survives_a_write() {
        let conn = setup_test_db();
        let id = create_test_playlist(&conn, "Provider");

        let empty = get_xtream_expiry_cache(&conn, id).unwrap();
        assert_eq!(empty.expires_at, None);
        assert_eq!(empty.checked_at, None);

        set_xtream_expiry(
            &conn,
            id,
            Some("2027-03-12T00:00:00+00:00"),
            "2026-09-11T12:00:00+00:00",
        )
        .unwrap();

        let stored = get_xtream_expiry_cache(&conn, id).unwrap();
        assert_eq!(
            stored.expires_at.as_deref(),
            Some("2027-03-12T00:00:00+00:00")
        );
        assert_eq!(
            stored.checked_at.as_deref(),
            Some("2026-09-11T12:00:00+00:00")
        );
    }

    #[test]
    fn an_account_that_stopped_reporting_an_expiry_clears_the_date_but_records_the_check() {
        // A lifetime upgrade turns a date into no date. Keeping the old one
        // would leave the user looking at an expiry that no longer applies,
        // and losing the timestamp would make the profile ask on every visit.
        let conn = setup_test_db();
        let id = create_test_playlist(&conn, "Provider");
        set_xtream_expiry(
            &conn,
            id,
            Some("2027-03-12T00:00:00+00:00"),
            "2026-09-11T12:00:00+00:00",
        )
        .unwrap();

        set_xtream_expiry(&conn, id, None, "2026-09-11T13:00:00+00:00").unwrap();

        let stored = get_xtream_expiry_cache(&conn, id).unwrap();
        assert_eq!(stored.expires_at, None);
        assert_eq!(
            stored.checked_at.as_deref(),
            Some("2026-09-11T13:00:00+00:00")
        );
    }

    #[test]
    fn the_cached_expiry_is_kept_per_playlist() {
        let conn = setup_test_db();
        let first = create_test_playlist(&conn, "Provider A");
        let second = create_test_playlist(&conn, "Provider B");

        set_xtream_expiry(
            &conn,
            first,
            Some("2027-03-12T00:00:00+00:00"),
            "2026-09-11T12:00:00+00:00",
        )
        .unwrap();

        let other = get_xtream_expiry_cache(&conn, second).unwrap();
        assert_eq!(other.expires_at, None);
        assert_eq!(other.checked_at, None);
    }

    #[test]
    fn reading_the_expiry_of_a_playlist_that_does_not_exist_is_not_an_error() {
        let conn = setup_test_db();
        let missing = get_xtream_expiry_cache(&conn, 4242).unwrap();
        assert_eq!(missing.expires_at, None);
        assert_eq!(missing.checked_at, None);
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

        let tx = conn.unchecked_transaction().unwrap();
        create_channels_batch(&tx, &channels).unwrap();
        tx.commit().unwrap();

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
        let tx = conn.unchecked_transaction().unwrap();
        create_channels_batch(&tx, &existing).unwrap();
        tx.commit().unwrap();

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

    /// Since the prune deletes an explicit stale list, the array that has to
    /// dodge SQLITE_MAX_VARIABLE_NUMBER carries the ids being DROPPED, not the
    /// ids being kept. The test above drops one row, so it exercises an array
    /// of one id and would pass against a bound-parameter `IN (?, ?, ...)`
    /// list. This one drops more than 32766 rows in a single refresh, which
    /// is what an `IN (?, ?, ...)` regression cannot survive.
    #[test]
    fn test_merge_channels_prunes_more_stale_rows_than_sqlite_variable_limit() {
        let conn = setup_test_db();
        let playlist_id = create_test_playlist(&conn, "Huge Playlist");

        // Above SQLITE_MAX_VARIABLE_NUMBER (32766).
        const DROP_COUNT: i32 = 33_000;
        let existing: Vec<Channel> = (0..DROP_COUNT + 1)
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
        let tx = conn.unchecked_transaction().unwrap();
        create_channels_batch(&tx, &existing).unwrap();
        tx.commit().unwrap();

        // The refresh keeps only the last channel and adds one new one, so
        // the prune has to delete 33 000 stale rows in one statement.
        let mut refreshed = vec![existing[DROP_COUNT as usize].clone()];
        refreshed.push(Channel {
            id: None,
            playlist_id,
            name: "Brand New".to_string(),
            url: "http://example.com/brand-new.m3u8".to_string(),
            logo: None,
            group_name: Some("Huge Group".to_string()),
            epg_id: None,
            tvg_name: None,
            content_type: "live".to_string(),
            is_favorite: false,
            sort_order: 0,
            category_order: 0,
            created_at: None,
        });
        let result = merge_channels(&conn, playlist_id, &refreshed, false).unwrap();

        assert_eq!(result.removed, DROP_COUNT as usize);
        assert_eq!(result.added, 1);
        assert_eq!(result.updated, 1);
        assert_eq!(get_channels(&conn, Some(playlist_id)).unwrap().len(), 2);
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

    #[test]
    fn delete_setting_if_value_only_removes_a_matching_row() {
        let conn = setup_test_db();
        set_setting(&conn, "tmdb_shared_key", "K").unwrap();

        assert!(!delete_setting_if_value(&conn, "tmdb_shared_key", "L").unwrap());
        assert_eq!(
            get_setting(&conn, "tmdb_shared_key").unwrap().as_deref(),
            Some("K")
        );

        assert!(delete_setting_if_value(&conn, "tmdb_shared_key", "K").unwrap());
        assert_eq!(get_setting(&conn, "tmdb_shared_key").unwrap(), None);

        // Nothing left to delete.
        assert!(!delete_setting_if_value(&conn, "tmdb_shared_key", "K").unwrap());
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

    fn series_group(
        playlist_id: i64,
        name: &str,
        group: &str,
        episodes: &[(i32, i32)],
    ) -> crate::series_domain::SeriesGroup {
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

        let inserted = insert_series_groups(
            &conn,
            pid,
            &[series_group(
                pid,
                "Dark",
                "Series",
                &[(1, 1), (1, 2), (2, 1)],
            )],
        )
        .unwrap();
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
        insert_series_groups(
            &conn,
            pid,
            &[series_group(pid, "Dark", "Series", &[(1, 1)])],
        )
        .unwrap();
        let series_id = get_channels(&conn, Some(pid)).unwrap()[0].id.unwrap();

        conn.execute("DELETE FROM channels WHERE id = ?1", params![series_id])
            .unwrap();

        assert!(get_series_episodes(&conn, series_id).unwrap().is_empty());
    }

    #[test]
    fn get_series_episodes_by_ids_returns_only_requested_rows() {
        let conn = setup_test_db();
        let pid = create_test_playlist(&conn, "M3U");
        insert_series_groups(
            &conn,
            pid,
            &[series_group(
                pid,
                "Dark",
                "Series",
                &[(1, 1), (1, 2), (1, 3)],
            )],
        )
        .unwrap();
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

    fn xtream_channel(playlist_id: i64, name: &str, kind: &str, id: i64) -> Channel {
        let (segment, ext, content_type) = match kind {
            "live" => ("live", "m3u8", "live"),
            "vod" => ("movie", "mp4", "vod"),
            _ => ("series", "mp4", "series"),
        };
        Channel {
            id: None,
            playlist_id,
            name: name.to_string(),
            url: format!("http://x/{}/u/p/{}.{}", segment, id, ext),
            logo: None,
            group_name: None,
            epg_id: None,
            tvg_name: None,
            content_type: content_type.to_string(),
            is_favorite: false,
            sort_order: 0,
            category_order: 0,
            created_at: None,
        }
    }

    fn m3u_channel(playlist_id: i64, name: &str, group: &str) -> Channel {
        Channel {
            id: None,
            playlist_id,
            name: name.to_string(),
            url: format!("http://m3u.test/{}.m3u8", name.replace(' ', "_")),
            logo: None,
            group_name: Some(group.to_string()),
            epg_id: None,
            tvg_name: None,
            content_type: "live".to_string(),
            is_favorite: false,
            sort_order: 0,
            category_order: 0,
            created_at: None,
        }
    }

    #[test]
    fn merge_channels_xtream_ids_do_not_collide_across_content_types() {
        // Xtream panels number live streams, movies and series independently,
        // so a live channel and a movie can share the id 500.
        let conn = setup_test_db();
        let pid = create_test_playlist(&conn, "Xtream");
        let live_id = create_channel(&conn, &xtream_channel(pid, "TV4", "live", 500)).unwrap();
        create_channel(&conn, &xtream_channel(pid, "Heat", "vod", 500)).unwrap();
        toggle_favorite(&conn, live_id).unwrap();

        let fresh = vec![
            xtream_channel(pid, "TV4", "live", 500),
            xtream_channel(pid, "Heat", "vod", 500),
        ];
        let result = merge_channels(&conn, pid, &fresh, true).unwrap();

        assert_eq!((result.added, result.updated, result.removed), (0, 2, 0));
        let channels = get_channels(&conn, Some(pid)).unwrap();
        assert_eq!(channels.len(), 2, "both rows survive the refresh");
        let live = get_channel_by_id(&conn, live_id).unwrap().unwrap();
        assert!(live.is_favorite, "favourite stays on the live channel");
        assert!(
            live.url.contains("/live/"),
            "live row keeps its live URL, got {}",
            live.url
        );
        assert_eq!(live.content_type, "live");
    }

    #[test]
    fn refresh_keeps_new_channels_when_it_also_removes_a_stale_one() {
        // The stale-row cleanup used to delete by inverse match, which also
        // caught every row inserted moments earlier in the same transaction.
        let conn = setup_test_db();
        let pid = create_test_playlist(&conn, "Xtream");
        create_channel(&conn, &xtream_channel(pid, "Keep", "live", 1)).unwrap();
        create_channel(&conn, &xtream_channel(pid, "Gone", "live", 2)).unwrap();

        let fresh = vec![
            xtream_channel(pid, "Keep", "live", 1),
            xtream_channel(pid, "New A", "live", 3),
            xtream_channel(pid, "New B", "live", 4),
        ];
        let result = merge_channels(&conn, pid, &fresh, true).unwrap();

        let mut names: Vec<String> = get_channels(&conn, Some(pid))
            .unwrap()
            .into_iter()
            .map(|c| c.name)
            .collect();
        names.sort();
        assert_eq!(names, vec!["Keep", "New A", "New B"]);
        assert_eq!(result.added, 2);
        assert_eq!(result.updated, 1);
        assert_eq!(result.removed, 1);
    }

    #[test]
    fn m3u_refresh_keeps_new_channels_when_it_also_removes_a_stale_one() {
        // Steps 3 and 4 are shared; only the lookup key differs, so the M3U
        // path had the identical hole.
        let conn = setup_test_db();
        let pid = create_test_playlist(&conn, "M3U");
        create_channel(&conn, &m3u_channel(pid, "Keep", "News")).unwrap();
        create_channel(&conn, &m3u_channel(pid, "Gone", "News")).unwrap();

        let fresh = vec![
            m3u_channel(pid, "Keep", "News"),
            m3u_channel(pid, "New A", "News"),
        ];
        let result = merge_channels(&conn, pid, &fresh, false).unwrap();

        let mut names: Vec<String> = get_channels(&conn, Some(pid))
            .unwrap()
            .into_iter()
            .map(|c| c.name)
            .collect();
        names.sort();
        assert_eq!(names, vec!["Keep", "New A"]);
        assert_eq!(result.removed, 1);
    }

    #[test]
    fn refresh_that_matches_nothing_replaces_rather_than_empties_the_playlist() {
        // The matched_ids.is_empty() branch deleted the whole playlist,
        // including the rows step 3 had just inserted.
        let conn = setup_test_db();
        let pid = create_test_playlist(&conn, "M3U");
        create_channel(&conn, &m3u_channel(pid, "Old A", "News")).unwrap();
        create_channel(&conn, &m3u_channel(pid, "Old B", "News")).unwrap();

        let fresh = vec![
            m3u_channel(pid, "Fresh A", "News"),
            m3u_channel(pid, "Fresh B", "News"),
        ];
        let result = merge_channels(&conn, pid, &fresh, false).unwrap();

        let mut names: Vec<String> = get_channels(&conn, Some(pid))
            .unwrap()
            .into_iter()
            .map(|c| c.name)
            .collect();
        names.sort();
        assert_eq!(names, vec!["Fresh A", "Fresh B"]);
        assert_eq!(result.added, 2);
        assert_eq!(result.removed, 2);
    }

    #[test]
    fn merge_channels_updates_content_type_of_matched_row() {
        let conn = setup_test_db();
        let pid = create_test_playlist(&conn, "M3U");
        let live_id = create_test_channel(&conn, pid, "Dark");
        conn.execute(
            "UPDATE channels SET group_name = 'Series' WHERE id = ?1",
            params![live_id],
        )
        .unwrap();

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
        insert_series_groups(
            &conn,
            pid,
            &[series_group(pid, "Dark", "Series", &[(1, 1), (1, 2)])],
        )
        .unwrap();
        let series_id = get_channels(&conn, Some(pid)).unwrap()[0].id.unwrap();
        toggle_favorite(&conn, series_id).unwrap();

        // Provider now lists S01E02 and a new S01E03; S01E01 is gone.
        let fresh = series_group(pid, "Dark", "Series", &[(1, 2), (1, 3)]);
        let merged =
            merge_channels(&conn, pid, std::slice::from_ref(&fresh.channel), false).unwrap();
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

        let written = replace_series_episodes(
            &conn,
            pid,
            &[series_group(pid, "Ghost", "Series", &[(1, 1)])],
        )
        .unwrap();

        assert_eq!(written, 0);
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM series_episodes", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn replace_series_episodes_only_touches_the_given_playlist() {
        let conn = setup_test_db();
        let a = create_test_playlist(&conn, "A");
        let b = create_test_playlist(&conn, "B");
        insert_series_groups(&conn, a, &[series_group(a, "Dark", "Series", &[(1, 1)])]).unwrap();
        insert_series_groups(
            &conn,
            b,
            &[series_group(b, "Dark", "Series", &[(1, 1), (1, 2)])],
        )
        .unwrap();
        let b_series = get_channels(&conn, Some(b)).unwrap()[0].id.unwrap();

        replace_series_episodes(&conn, a, &[series_group(a, "Dark", "Series", &[(2, 1)])]).unwrap();

        assert_eq!(get_series_episodes(&conn, b_series).unwrap().len(), 2);
    }

    /// Proves the shape a playlist import must use to be atomic: run
    /// `create_playlist`, `create_channels_batch` and `insert_series_groups`
    /// inside one `unchecked_transaction`, then let the transaction drop
    /// without a commit. Nothing any of the three calls wrote should survive.
    #[test]
    fn dropping_the_import_transaction_without_commit_persists_nothing() {
        let conn = setup_test_db();

        {
            let tx = conn.unchecked_transaction().unwrap();

            let playlist = Playlist {
                id: None,
                name: "Uncommitted".to_string(),
                url: Some("http://example.com/playlist.m3u".to_string()),
                file_path: None,
                last_updated: None,
                auto_refresh: false,
                xtream_username: None,
                xtream_password: None,
                created_at: None,
            };
            let playlist_id = create_playlist(&tx, &playlist).unwrap();

            let plain_channel = Channel {
                id: None,
                playlist_id,
                name: "Plain Channel".to_string(),
                url: "http://example.com/stream.m3u8".to_string(),
                logo: None,
                group_name: Some("News".to_string()),
                epg_id: None,
                tvg_name: None,
                content_type: "live".to_string(),
                is_favorite: false,
                sort_order: 0,
                category_order: 0,
                created_at: None,
            };
            create_channels_batch(&tx, std::slice::from_ref(&plain_channel)).unwrap();

            insert_series_groups(
                &tx,
                playlist_id,
                &[series_group(playlist_id, "Dark", "Series", &[(1, 1)])],
            )
            .unwrap();

            // `tx` drops here without `commit()`, rolling everything back.
        }

        assert!(
            get_playlists(&conn).unwrap().is_empty(),
            "playlist must not survive an uncommitted transaction"
        );
        assert!(
            get_channels(&conn, None).unwrap().is_empty(),
            "channels must not survive an uncommitted transaction"
        );
        let episode_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM series_episodes", [], |r| r.get(0))
            .unwrap();
        assert_eq!(
            episode_count, 0,
            "episodes must not survive an uncommitted transaction"
        );
    }

    /// The refresh seam the `content_type` column in `merge_channels`'s UPDATE
    /// exists for: a `live` row that only matches a fresh `series` row by
    /// name (different `group_name`) still gets picked up by the name-only
    /// fallback, and `replace_series_episodes` finds the same row afterwards.
    #[test]
    fn merge_channels_name_only_fallback_then_replace_series_episodes_finds_the_row() {
        let conn = setup_test_db();
        let pid = create_test_playlist(&conn, "M3U");
        let live_id = create_test_channel(&conn, pid, "Dark");
        conn.execute(
            "UPDATE channels SET group_name = 'News' WHERE id = ?1",
            params![live_id],
        )
        .unwrap();

        let fresh = series_group(pid, "Dark", "Series", &[(1, 1)]);
        let result =
            merge_channels(&conn, pid, std::slice::from_ref(&fresh.channel), false).unwrap();

        assert_eq!((result.added, result.updated, result.removed), (0, 1, 0));
        let row = get_channel_by_id(&conn, live_id).unwrap().unwrap();
        assert_eq!(row.content_type, "series");
        assert_eq!(row.group_name.as_deref(), Some("Series"));

        let written = replace_series_episodes(&conn, pid, &[fresh]).unwrap();
        assert_eq!(written, 1);
        assert_eq!(get_series_episodes(&conn, live_id).unwrap().len(), 1);
    }
}

#[cfg(test)]
mod tmdb_tests {
    use crate::db::mutations::*;
    use crate::db::queries;
    use crate::db::test_helpers::*;

    fn key() -> TmdbKey {
        TmdbKey {
            title: "shutter island".into(),
            year: 2010,
            content_type: "vod".into(),
        }
    }

    fn row(tmdb_id: Option<i64>) -> TmdbRow {
        TmdbRow {
            key: key(),
            tmdb_id,
            manual: false,
            title: tmdb_id.map(|_| "Shutter Island".to_string()),
            original_title: None,
            release_year: Some(2010),
            rating: Some(8.2),
            poster_path: Some("/p.jpg".into()),
            backdrop_path: None,
            overview: Some("A marshal.".into()),
            genre_ids: Some("[18,53]".into()),
            runtime_minutes: None,
            genres: None,
            cast_json: None,
            trailer_youtube_key: None,
            searched_at: "2026-09-25T12:00:00+00:00".into(),
            details_fetched_at: None,
        }
    }

    #[test]
    fn search_upsert_round_trips_and_updates_in_place() {
        let conn = setup_test_db();
        upsert_tmdb_search(&conn, &row(Some(11324))).unwrap();
        let got = queries::get_tmdb_row(&conn, &key()).unwrap().unwrap();
        assert_eq!(got.tmdb_id, Some(11324));
        assert_eq!(got.rating, Some(8.2));
        assert!(got.details_fetched_at.is_none());

        let mut again = row(Some(11324));
        again.rating = Some(8.3);
        again.searched_at = "2026-09-26T12:00:00+00:00".into();
        upsert_tmdb_search(&conn, &again).unwrap();
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM tmdb_metadata", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 1);
        assert_eq!(
            queries::get_tmdb_row(&conn, &key())
                .unwrap()
                .unwrap()
                .rating,
            Some(8.3)
        );
    }

    #[test]
    fn a_no_match_row_is_stored_with_a_null_id() {
        let conn = setup_test_db();
        upsert_tmdb_search(&conn, &row(None)).unwrap();
        let got = queries::get_tmdb_row(&conn, &key()).unwrap().unwrap();
        assert_eq!(got.tmdb_id, None);
        assert!(!got.manual);
    }

    #[test]
    fn details_upsert_fills_the_detail_columns() {
        let conn = setup_test_db();
        upsert_tmdb_search(&conn, &row(Some(11324))).unwrap();
        let mut full = row(Some(11324));
        full.runtime_minutes = Some(138);
        full.genres = Some("[\"Drama\",\"Thriller\"]".into());
        full.cast_json = Some("[{\"name\":\"Leonardo DiCaprio\"}]".into());
        full.trailer_youtube_key = Some("qdPw9x9h5CY".into());
        full.details_fetched_at = Some("2026-09-25T13:00:00+00:00".into());
        upsert_tmdb_details(&conn, &full).unwrap();
        let got = queries::get_tmdb_row(&conn, &key()).unwrap().unwrap();
        assert_eq!(got.runtime_minutes, Some(138));
        assert_eq!(
            got.details_fetched_at.as_deref(),
            Some("2026-09-25T13:00:00+00:00")
        );
        assert_eq!(got.trailer_youtube_key.as_deref(), Some("qdPw9x9h5CY"));
    }

    #[test]
    fn re_search_keeps_details_for_the_same_id_and_clears_them_for_a_new_one() {
        let conn = setup_test_db();
        upsert_tmdb_search(&conn, &row(Some(11324))).unwrap();
        let mut full = row(Some(11324));
        full.runtime_minutes = Some(138);
        full.genres = Some("[\"Drama\"]".into());
        full.cast_json = Some("[{\"name\":\"Leonardo DiCaprio\"}]".into());
        full.trailer_youtube_key = Some("qdPw9x9h5CY".into());
        full.details_fetched_at = Some("2026-09-25T13:00:00+00:00".into());
        upsert_tmdb_details(&conn, &full).unwrap();

        let mut same = row(Some(11324));
        same.searched_at = "2026-10-25T12:00:00+00:00".into();
        upsert_tmdb_search(&conn, &same).unwrap();
        let kept = queries::get_tmdb_row(&conn, &key()).unwrap().unwrap();
        assert_eq!(kept.runtime_minutes, Some(138));
        assert_eq!(kept.genres.as_deref(), Some("[\"Drama\"]"));
        assert!(kept.cast_json.is_some());
        assert_eq!(kept.trailer_youtube_key.as_deref(), Some("qdPw9x9h5CY"));
        assert_eq!(
            kept.details_fetched_at.as_deref(),
            Some("2026-09-25T13:00:00+00:00")
        );

        let mut other = row(Some(999));
        other.title = Some("Other Film".into());
        other.rating = Some(5.5);
        upsert_tmdb_search(&conn, &other).unwrap();
        let got = queries::get_tmdb_row(&conn, &key()).unwrap().unwrap();
        assert_eq!(got.tmdb_id, Some(999));
        assert_eq!(got.title.as_deref(), Some("Other Film"));
        assert_eq!(got.rating, Some(5.5));
        assert_eq!(got.runtime_minutes, None);
        assert_eq!(got.genres, None);
        assert_eq!(got.cast_json, None);
        assert_eq!(got.trailer_youtube_key, None);
        assert_eq!(got.details_fetched_at, None);
    }

    #[test]
    fn manual_choice_survives_an_automatic_search_upsert() {
        let conn = setup_test_db();
        upsert_tmdb_search(&conn, &row(Some(11324))).unwrap();
        set_tmdb_manual(&conn, &key(), None, "2026-09-25T14:00:00+00:00").unwrap();
        let got = queries::get_tmdb_row(&conn, &key()).unwrap().unwrap();
        assert!(got.manual);
        assert_eq!(got.tmdb_id, None);
        assert!(got.details_fetched_at.is_none());

        upsert_tmdb_search(&conn, &row(Some(11324))).unwrap();
        let after = queries::get_tmdb_row(&conn, &key()).unwrap().unwrap();
        assert!(
            after.manual,
            "automatic search must not clear the manual flag"
        );
        assert_eq!(
            after.tmdb_id, None,
            "automatic search must not replace a manual choice"
        );

        // A manual pick of a different id is allowed and keeps manual = 1.
        set_tmdb_manual(&conn, &key(), Some(999), "2026-09-25T15:00:00+00:00").unwrap();
        let picked = queries::get_tmdb_row(&conn, &key()).unwrap().unwrap();
        assert_eq!(picked.tmdb_id, Some(999));
        assert!(picked.manual);
    }

    #[test]
    fn manual_on_a_missing_row_creates_it() {
        let conn = setup_test_db();
        set_tmdb_manual(&conn, &key(), Some(11324), "2026-09-25T14:00:00+00:00").unwrap();
        let got = queries::get_tmdb_row(&conn, &key()).unwrap().unwrap();
        assert_eq!(got.tmdb_id, Some(11324));
        assert!(got.manual);
    }

    #[test]
    fn episodes_upsert_and_read_back_in_order() {
        let conn = setup_test_db();
        let ep = |n: i32| TmdbEpisodeRow {
            tmdb_id: 120487,
            season: 1,
            episode: n,
            title: Some(format!("Ep {n}")),
            overview: None,
            still_path: None,
            runtime_minutes: Some(22),
            air_date: Some("2020-08-02".into()),
            fetched_at: "2026-09-25T12:00:00+00:00".into(),
        };
        upsert_tmdb_episodes(&conn, &[ep(2), ep(1)]).unwrap();
        upsert_tmdb_episodes(&conn, &[ep(1)]).unwrap();
        let got = queries::get_tmdb_episodes(&conn, 120487, 1).unwrap();
        assert_eq!(
            got.iter().map(|e| e.episode).collect::<Vec<_>>(),
            vec![1, 2]
        );
        assert!(queries::get_tmdb_episodes(&conn, 120487, 2)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn clearing_the_cache_empties_both_tables() {
        let conn = setup_test_db();
        upsert_tmdb_search(&conn, &row(Some(11324))).unwrap();
        upsert_tmdb_episodes(
            &conn,
            &[TmdbEpisodeRow {
                tmdb_id: 1,
                season: 1,
                episode: 1,
                title: None,
                overview: None,
                still_path: None,
                runtime_minutes: None,
                air_date: None,
                fetched_at: "2026-09-25T12:00:00+00:00".into(),
            }],
        )
        .unwrap();
        assert_eq!(delete_tmdb_cache(&conn).unwrap(), 2);
        assert!(queries::get_tmdb_row(&conn, &key()).unwrap().is_none());
    }

    #[test]
    fn channels_by_ids_returns_only_existing_rows() {
        let conn = setup_test_db();
        let pl = create_test_playlist(&conn, "P");
        let a = create_test_channel(&conn, pl, "A");
        let b = create_test_channel(&conn, pl, "B");
        let got = queries::get_channels_by_ids(&conn, &[b, a, 9999]).unwrap();
        let mut names: Vec<_> = got.iter().map(|c| c.name.as_str()).collect();
        names.sort();
        assert_eq!(names, vec!["A", "B"]);
        assert!(queries::get_channels_by_ids(&conn, &[]).unwrap().is_empty());
    }
}
