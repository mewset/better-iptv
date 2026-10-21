use super::models::*;
use rusqlite::{params, Connection, OptionalExtension, Result, Row};
use serde_json;
use std::collections::HashMap;

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
    let playlists = stmt
        .query_map([], map_playlist_row)?
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

/// Read what is remembered about a playlist's Xtream subscription
///
/// Both fields empty covers every case the caller treats alike: the playlist
/// has never been checked, it is not an Xtream playlist, or it is gone.
pub fn get_xtream_expiry_cache(conn: &Connection, playlist_id: i64) -> Result<XtreamExpiryCache> {
    let row = conn
        .query_row(
            "SELECT xtream_exp_date, xtream_exp_checked_at FROM playlists WHERE id = ?1",
            [playlist_id],
            |row| {
                Ok(XtreamExpiryCache {
                    expires_at: row.get(0)?,
                    checked_at: row.get(1)?,
                })
            },
        )
        .optional()?;

    Ok(row.unwrap_or(XtreamExpiryCache {
        expires_at: None,
        checked_at: None,
    }))
}

pub fn get_channels(conn: &Connection, playlist_id: Option<i64>) -> Result<Vec<Channel>> {
    if let Some(pid) = playlist_id {
        let sql = format!(
            "SELECT {} FROM channels WHERE playlist_id = ?1 ORDER BY sort_order, name",
            CHANNEL_SELECT_COLUMNS
        );
        let mut stmt = conn.prepare(&sql)?;
        let channels = stmt
            .query_map(params![pid], map_channel_row)?
            .collect::<Result<Vec<_>>>()?;
        Ok(channels)
    } else {
        let sql = format!(
            "SELECT {} FROM channels ORDER BY sort_order, name",
            CHANNEL_SELECT_COLUMNS
        );
        let mut stmt = conn.prepare(&sql)?;
        let channels = stmt
            .query_map([], map_channel_row)?
            .collect::<Result<Vec<_>>>()?;
        Ok(channels)
    }
}

const SUMMARY_COLUMNS: &str =
    "id, name, COALESCE(logo_override, logo), group_name, epg_id, content_type, is_favorite, created_at";

fn map_summary_row(row: &Row) -> rusqlite::Result<ChannelSummary> {
    Ok(ChannelSummary {
        id: row.get(0)?,
        name: row.get(1)?,
        logo: row.get(2)?,
        group_name: row.get(3)?,
        epg_id: row.get(4)?,
        content_type: row.get(5)?,
        is_favorite: row.get(6)?,
        created_at: row.get(7)?,
    })
}

/// The channel list as the frontend reads it: only the `ChannelSummary`
/// columns, so the stream URLs are never read. Same rows and ORDER BY as
/// `get_channels`, mapped exactly as `ChannelSummary::from(Channel)` does.
pub fn get_channel_summaries(
    conn: &Connection,
    playlist_id: Option<i64>,
    content_types: Option<&[String]>,
) -> Result<Vec<ChannelSummary>> {
    let mut conditions: Vec<String> = Vec::new();
    let mut values: Vec<rusqlite::types::Value> = Vec::new();
    if let Some(pid) = playlist_id {
        values.push(pid.into());
        conditions.push(format!("playlist_id = ?{}", values.len()));
    }
    if let Some(types) = content_types {
        let placeholders: Vec<String> = types
            .iter()
            .map(|t| {
                values.push(t.clone().into());
                format!("?{}", values.len())
            })
            .collect();
        conditions.push(format!("content_type IN ({})", placeholders.join(", ")));
    }
    let where_clause = if conditions.is_empty() {
        String::new()
    } else {
        format!(" WHERE {}", conditions.join(" AND "))
    };
    let sql =
        format!("SELECT {SUMMARY_COLUMNS} FROM channels{where_clause} ORDER BY sort_order, name");
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(rusqlite::params_from_iter(values), map_summary_row)?;
    rows.collect()
}

/// The summaries of the given channel ids, keyed by id. Ids that no longer
/// exist are absent from the map. No query for an empty slice.
pub fn get_channel_summaries_by_ids(
    conn: &Connection,
    ids: &[i64],
) -> Result<HashMap<i64, ChannelSummary>> {
    let mut out = HashMap::with_capacity(ids.len());
    // SQLite's variable limit is 32766 on current builds; stay well under it.
    for chunk in ids.chunks(500) {
        let placeholders = vec!["?"; chunk.len()].join(", ");
        let sql = format!("SELECT {SUMMARY_COLUMNS} FROM channels WHERE id IN ({placeholders})");
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(rusqlite::params_from_iter(chunk), map_summary_row)?;
        for row in rows {
            let summary = row?;
            out.insert(summary.id, summary);
        }
    }
    Ok(out)
}

/// The vod and series rows of a playlist, with only the columns the Home
/// rows and pick use. Order is irrelevant: the lowest id wins a shared title.
pub fn get_library_channels(conn: &Connection, playlist_id: i64) -> Result<Vec<LibraryChannel>> {
    let mut stmt = conn.prepare(
        "SELECT id, name, content_type FROM channels \
         WHERE playlist_id = ?1 AND content_type IN ('vod', 'series')",
    )?;
    let rows = stmt.query_map(params![playlist_id], |row| {
        Ok(LibraryChannel {
            id: row.get(0)?,
            name: row.get(1)?,
            content_type: row.get(2)?,
        })
    })?;
    rows.collect()
}

pub fn get_channel_by_id(conn: &Connection, id: i64) -> Result<Option<Channel>> {
    let sql = format!(
        "SELECT {} FROM channels WHERE id = ?1",
        CHANNEL_SELECT_COLUMNS
    );
    let mut stmt = conn.prepare(&sql)?;
    let mut rows = stmt.query_map(params![id], map_channel_row)?;
    rows.next().transpose()
}

// ========== Series Episode Queries ==========

/// Episodes of one series row, ordered by season then episode.
pub fn get_series_episodes(
    conn: &Connection,
    series_channel_id: i64,
) -> Result<Vec<SeriesEpisode>> {
    let sql = format!(
        "SELECT {} FROM series_episodes WHERE series_channel_id = ?1 ORDER BY season, episode",
        SERIES_EPISODE_SELECT_COLUMNS
    );
    let mut stmt = conn.prepare(&sql)?;
    let episodes = stmt
        .query_map(params![series_channel_id], map_series_episode_row)?
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
        ids.iter()
            .map(|id| id.to_string())
            .collect::<Vec<_>>()
            .join(",")
    );
    let sql = format!(
        "SELECT {} FROM series_episodes WHERE id IN (SELECT value FROM json_each(?1))",
        SERIES_EPISODE_SELECT_COLUMNS
    );
    let mut stmt = conn.prepare(&sql)?;
    let episodes = stmt
        .query_map(params![ids_json], map_series_episode_row)?
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
    let sql = format!(
        "SELECT key, value FROM settings WHERE key IN ({})",
        placeholders
    );

    let mut stmt = conn.prepare(&sql)?;
    let result = stmt
        .query_map(rusqlite::params_from_iter(keys), |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<Result<HashMap<_, _>, _>>()?;

    Ok(result)
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
    let playlists = stmt
        .query_map(params![modifier], map_playlist_row)?
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
        let groups = stmt
            .query_map(params![playlist_id, ct], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<String>, _>>()?;
        Ok(groups)
    } else {
        let sql = "SELECT group_name, MIN(category_order) as cat_order FROM channels
                   WHERE playlist_id = ?1 AND group_name IS NOT NULL AND group_name != ''
                   GROUP BY group_name
                   ORDER BY cat_order, group_name";
        let mut stmt = conn.prepare(sql)?;
        let groups = stmt
            .query_map(params![playlist_id], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<String>, _>>()?;
        Ok(groups)
    }
}

// ========== Channel Count Queries ==========

/// Channel count per playlist, for the profile cards. A playlist with no
/// channels is simply absent from the map rather than mapped to 0.
pub fn get_playlist_channel_counts(conn: &Connection) -> Result<HashMap<i64, i64>> {
    let mut stmt =
        conn.prepare("SELECT playlist_id, COUNT(*) FROM channels GROUP BY playlist_id")?;
    let counts = stmt
        .query_map([], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)))?
        .collect::<Result<HashMap<_, _>>>()?;
    Ok(counts)
}

// ========== TMDB cache ==========

/// Channels for a set of ids, in no particular order; unknown ids are skipped.
pub fn get_channels_by_ids(conn: &Connection, ids: &[i64]) -> Result<Vec<Channel>> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let placeholders = ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
    let sql = format!(
        "SELECT {} FROM channels WHERE id IN ({})",
        CHANNEL_SELECT_COLUMNS, placeholders
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt
        .query_map(rusqlite::params_from_iter(ids), map_channel_row)?
        .collect::<Result<Vec<_>>>()?;
    Ok(rows)
}

const TMDB_SELECT_COLUMNS: &str = "normalized_title, year, content_type, tmdb_id, manual, title, \
    original_title, release_year, rating, poster_path, backdrop_path, overview, genre_ids, \
    runtime_minutes, genres, cast_json, trailer_youtube_key, searched_at, details_fetched_at, \
    vote_count";

fn map_tmdb_row(row: &rusqlite::Row) -> Result<TmdbRow> {
    Ok(TmdbRow {
        key: TmdbKey {
            title: row.get(0)?,
            year: row.get(1)?,
            content_type: row.get(2)?,
        },
        tmdb_id: row.get(3)?,
        manual: row.get::<_, i64>(4)? != 0,
        title: row.get(5)?,
        original_title: row.get(6)?,
        release_year: row.get(7)?,
        rating: row.get(8)?,
        poster_path: row.get(9)?,
        backdrop_path: row.get(10)?,
        overview: row.get(11)?,
        genre_ids: row.get(12)?,
        runtime_minutes: row.get(13)?,
        genres: row.get(14)?,
        cast_json: row.get(15)?,
        trailer_youtube_key: row.get(16)?,
        searched_at: row.get(17)?,
        details_fetched_at: row.get(18)?,
        vote_count: row.get(19)?,
    })
}

pub fn get_tmdb_row(conn: &Connection, key: &TmdbKey) -> Result<Option<TmdbRow>> {
    let sql = format!(
        "SELECT {} FROM tmdb_metadata WHERE normalized_title = ?1 AND year = ?2 AND content_type = ?3",
        TMDB_SELECT_COLUMNS
    );
    let mut stmt = conn.prepare_cached(&sql)?;
    let mut rows = stmt.query_map(params![key.title, key.year, key.content_type], map_tmdb_row)?;
    rows.next().transpose()
}

pub fn get_tmdb_episodes(
    conn: &Connection,
    tmdb_id: i64,
    season: i32,
) -> Result<Vec<TmdbEpisodeRow>> {
    let mut stmt = conn.prepare_cached(
        "SELECT tmdb_id, season, episode, title, overview, still_path, runtime_minutes, air_date, fetched_at
         FROM tmdb_episodes WHERE tmdb_id = ?1 AND season = ?2 ORDER BY episode",
    )?;
    let rows = stmt
        .query_map(params![tmdb_id, season], |row| {
            Ok(TmdbEpisodeRow {
                tmdb_id: row.get(0)?,
                season: row.get(1)?,
                episode: row.get(2)?,
                title: row.get(3)?,
                overview: row.get(4)?,
                still_path: row.get(5)?,
                runtime_minutes: row.get(6)?,
                air_date: row.get(7)?,
                fetched_at: row.get(8)?,
            })
        })?
        .collect::<Result<Vec<_>>>()?;
    Ok(rows)
}

/// Home's fixed filter. Rating is TMDB's 0–10 vote average.
pub const HOME_MIN_RATING: f64 = 4.0;
pub const HOME_MIN_VOTES: i64 = 50;

/// Every matched title with a backdrop, released in `min_year` or later,
/// rated above `HOME_MIN_RATING` by more than `HOME_MIN_VOTES` voters. Rows
/// without a vote count (searched before 3.0.0) are out until re-searched.
/// A genre list that fails to parse becomes empty, so the row is never picked.
pub fn get_tmdb_home_candidates(
    conn: &Connection,
    min_year: i32,
) -> Result<Vec<TmdbHomeCandidate>> {
    let mut stmt = conn.prepare_cached(
        "SELECT normalized_title, year, content_type, tmdb_id, title, release_year, rating,
                poster_path, backdrop_path, overview, genre_ids, vote_count
         FROM tmdb_metadata
         WHERE tmdb_id IS NOT NULL AND backdrop_path IS NOT NULL
           AND release_year >= ?1 AND rating > ?2 AND vote_count > ?3",
    )?;
    let rows = stmt
        .query_map(params![min_year, HOME_MIN_RATING, HOME_MIN_VOTES], |row| {
            let genre_json: Option<String> = row.get(10)?;
            Ok(TmdbHomeCandidate {
                key: TmdbKey {
                    title: row.get(0)?,
                    year: row.get(1)?,
                    content_type: row.get(2)?,
                },
                tmdb_id: row.get(3)?,
                title: row.get::<_, Option<String>>(4)?.unwrap_or_default(),
                release_year: row.get(5)?,
                rating: row.get(6)?,
                vote_count: row.get(11)?,
                poster_path: row.get(7)?,
                backdrop_path: row.get(8)?,
                overview: row.get(9)?,
                genre_ids: genre_json
                    .as_deref()
                    .and_then(|j| serde_json::from_str(j).ok())
                    .unwrap_or_default(),
            })
        })?
        .collect::<Result<Vec<_>>>()?;
    Ok(rows)
}

// ========== Tests ==========

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::models::{TmdbKey, TmdbRow};
    use crate::db::mutations::{create_channel, set_setting, upsert_tmdb_search};
    use crate::db::test_helpers::{create_test_channel, create_test_playlist, setup_test_db};

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

    /// Two playlists with mixed content types and sort orders 0..2.
    fn seed_summary_fixture(conn: &Connection) -> (i64, i64) {
        let p1 = create_test_playlist(conn, "Playlist 1");
        let p2 = create_test_playlist(conn, "Playlist 2");

        let rows = [
            (
                p1,
                "Live A",
                "live",
                Some("http://l/a.png"),
                Some("News"),
                Some("a.epg"),
            ),
            (p1, "Movie B", "vod", None, None, None),
            (p1, "Series C", "series", Some("http://l/c.png"), None, None),
            (p2, "Live D", "live", None, Some("Sport"), Some("d.epg")),
            (
                p2,
                "Movie E",
                "vod",
                Some("http://l/e.png"),
                Some("Drama"),
                None,
            ),
        ];
        for (i, (pid, name, ct, logo, group, epg)) in rows.iter().enumerate() {
            let ch = Channel {
                id: None,
                playlist_id: *pid,
                name: name.to_string(),
                url: format!("http://example.com/{name}.m3u8"),
                logo: logo.map(String::from),
                group_name: group.map(String::from),
                epg_id: epg.map(String::from),
                tvg_name: None,
                content_type: ct.to_string(),
                is_favorite: i % 2 == 0,
                sort_order: (i % 3) as i32,
                category_order: 0,
                created_at: None,
            };
            create_channel(conn, &ch).unwrap();
        }
        (p1, p2)
    }

    #[test]
    fn channel_summaries_without_filter_unchanged() {
        let conn = setup_test_db();
        let (p1, p2) = seed_summary_fixture(&conn);

        for scope in [Some(p1), Some(p2), None] {
            let expected: Vec<ChannelSummary> = get_channels(&conn, scope)
                .unwrap()
                .into_iter()
                .map(ChannelSummary::from)
                .collect();
            let actual = get_channel_summaries(&conn, scope, None).unwrap();
            assert!(!actual.is_empty());
            assert_eq!(actual, expected);
            assert_eq!(
                serde_json::to_vec(&actual).unwrap(),
                serde_json::to_vec(&expected).unwrap()
            );
        }
    }

    #[test]
    fn channel_summaries_filter_by_type_keeps_order() {
        let conn = setup_test_db();
        let (p1, p2) = seed_summary_fixture(&conn);

        let filters: [Vec<String>; 2] = [
            vec!["live".to_string()],
            vec!["vod".to_string(), "series".to_string()],
        ];
        for scope in [Some(p1), Some(p2), None] {
            let all = get_channel_summaries(&conn, scope, None).unwrap();
            for filter in &filters {
                let expected: Vec<ChannelSummary> = all
                    .iter()
                    .filter(|c| filter.contains(&c.content_type))
                    .cloned()
                    .collect();
                let actual = get_channel_summaries(&conn, scope, Some(filter)).unwrap();
                assert!(!actual.is_empty());
                assert_eq!(actual, expected);
            }
        }
    }

    #[test]
    fn summaries_by_ids_returns_only_requested() {
        let conn = setup_test_db();
        seed_summary_fixture(&conn);
        let all = get_channel_summaries(&conn, None, None).unwrap();
        assert!(all.len() >= 5);
        let wanted: Vec<i64> = all.iter().take(5).step_by(2).map(|c| c.id).collect();
        assert_eq!(wanted.len(), 3);

        let map = get_channel_summaries_by_ids(&conn, &wanted).unwrap();
        assert_eq!(map.len(), 3);
        for id in &wanted {
            let expected = all.iter().find(|c| c.id == *id).unwrap();
            assert_eq!(&map[id], expected);
        }
        assert!(get_channel_summaries_by_ids(&conn, &[]).unwrap().is_empty());
        assert!(get_channel_summaries_by_ids(&conn, &[999_999])
            .unwrap()
            .is_empty());
    }

    #[test]
    fn library_channels_exclude_live_and_other_playlists() {
        let conn = setup_test_db();
        let p1 = create_test_playlist(&conn, "Playlist 1");
        let p2 = create_test_playlist(&conn, "Playlist 2");
        let mut ids = HashMap::new();
        for (pid, name, ct) in [
            (p1, "Live A", "live"),
            (p1, "Movie B", "vod"),
            (p1, "Series C", "series"),
            (p2, "Live D", "live"),
            (p2, "Movie E", "vod"),
            (p2, "Series F", "series"),
        ] {
            let ch = Channel {
                id: None,
                playlist_id: pid,
                name: name.to_string(),
                url: "http://x".to_string(),
                logo: None,
                group_name: None,
                epg_id: None,
                tvg_name: None,
                content_type: ct.to_string(),
                is_favorite: false,
                sort_order: 0,
                category_order: 0,
                created_at: None,
            };
            ids.insert(name, create_channel(&conn, &ch).unwrap());
        }
        let mut got = get_library_channels(&conn, p1).unwrap();
        got.sort_by_key(|c| c.id);
        assert_eq!(
            got,
            vec![
                LibraryChannel {
                    id: ids["Movie B"],
                    name: "Movie B".into(),
                    content_type: "vod".into()
                },
                LibraryChannel {
                    id: ids["Series C"],
                    name: "Series C".into(),
                    content_type: "series".into()
                },
            ]
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

    // ========== Channel Count Tests ==========

    #[test]
    fn test_get_playlist_channel_counts() {
        let conn = setup_test_db();
        let playlist1 = create_test_playlist(&conn, "Playlist 1");
        let playlist2 = create_test_playlist(&conn, "Playlist 2");
        let playlist3 = create_test_playlist(&conn, "Empty Playlist");

        create_test_channel(&conn, playlist1, "Channel 1");
        create_test_channel(&conn, playlist1, "Channel 2");
        create_test_channel(&conn, playlist1, "Channel 3");
        create_test_channel(&conn, playlist2, "Channel 4");

        let counts = get_playlist_channel_counts(&conn).unwrap();

        assert_eq!(counts.get(&playlist1), Some(&3));
        assert_eq!(counts.get(&playlist2), Some(&1));
        assert_eq!(counts.get(&playlist3), None);
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

    // ========== TMDB Tests ==========

    fn home_row(
        title: &str,
        year: i32,
        rating: Option<f64>,
        votes: Option<i64>,
        backdrop: Option<&str>,
        tmdb_id: Option<i64>,
    ) -> TmdbRow {
        TmdbRow {
            key: TmdbKey {
                title: title.into(),
                year,
                content_type: "vod".into(),
            },
            tmdb_id,
            manual: false,
            title: Some(title.into()),
            original_title: None,
            release_year: Some(year),
            rating,
            vote_count: votes,
            poster_path: None,
            backdrop_path: backdrop.map(String::from),
            overview: Some("plot".into()),
            genre_ids: Some("[28,53]".into()),
            runtime_minutes: None,
            genres: None,
            cast_json: None,
            trailer_youtube_key: None,
            searched_at: "2026-09-26T12:00:00+00:00".into(),
            details_fetched_at: None,
        }
    }

    #[test]
    fn home_candidates_apply_every_filter_edge() {
        let conn = setup_test_db();
        let rows = [
            home_row("in", 2010, Some(4.1), Some(51), Some("/b.jpg"), Some(1)),
            home_row(
                "year edge in",
                2006,
                Some(9.0),
                Some(500),
                Some("/b.jpg"),
                Some(2),
            ),
            home_row(
                "rating exactly 4",
                2010,
                Some(4.0),
                Some(500),
                Some("/b.jpg"),
                Some(3),
            ),
            home_row(
                "votes exactly 50",
                2010,
                Some(9.0),
                Some(50),
                Some("/b.jpg"),
                Some(4),
            ),
            home_row(
                "too old",
                2005,
                Some(9.0),
                Some(500),
                Some("/b.jpg"),
                Some(5),
            ),
            home_row("no backdrop", 2010, Some(9.0), Some(500), None, Some(6)),
            home_row("no match", 2010, Some(9.0), Some(500), Some("/b.jpg"), None),
            home_row(
                "pre 3.0 row",
                2010,
                Some(9.0),
                None,
                Some("/b.jpg"),
                Some(8),
            ),
        ];
        for r in &rows {
            upsert_tmdb_search(&conn, r).unwrap();
        }
        let mut got: Vec<i64> = get_tmdb_home_candidates(&conn, 2006)
            .unwrap()
            .into_iter()
            .map(|c| c.tmdb_id)
            .collect();
        got.sort_unstable();
        assert_eq!(got, vec![1, 2]);

        let first = get_tmdb_home_candidates(&conn, 2006)
            .unwrap()
            .into_iter()
            .find(|c| c.tmdb_id == 1)
            .unwrap();
        assert_eq!(first.genre_ids, vec![28, 53]);
        assert_eq!(first.backdrop_path, "/b.jpg");
        assert_eq!(first.vote_count, Some(51));
        assert_eq!(first.key.content_type, "vod");
    }
}
