//! Searching the stored guide's channels for the picker that matches a
//! channel by hand. The database finds every display name and key that
//! contains the query; `epg_domain::search` ranks them and keeps the best.
//!
//! Only guide channels that have programmes, in the enabled sources that
//! apply to the active profile, are searched: a channel matched to anything
//! else would show nothing.

use super::sources::list_sources;
use super::status::picker_label;
use crate::epg_domain::search::{clamp_search_limit, BestHits, CandidateRow, SearchQuery};
use crate::epg_domain::source::applies_to;
use rusqlite::types::Type;
use rusqlite::{params, Connection, Row};
use serde::Serialize;
use std::collections::HashMap;

/// One guide channel the search found.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct EpgChannelHit {
    /// The guide key a channel is matched to when this hit is chosen.
    pub key: String,
    /// The display name that matched best, as the feed wrote it; `None`
    /// for a channel the feed names nowhere.
    pub name: Option<String>,
    pub source_id: i64,
    /// See `status::picker_label`.
    pub source_label: String,
}

/// Every display name (or nameless channel) whose name key or guide key
/// contains the query. `instr` compares exactly, so neither `%` nor `_` in
/// a query means anything special, and both sides are already lower case.
const CANDIDATES: &str = "SELECT c.key, n.name, n.name_key, COALESCE(n.position, 0),
        s.id, s.priority
    FROM epg_channel c
    JOIN epg_source s ON s.id = c.source_id
    LEFT JOIN epg_channel_name n ON n.channel_id = c.id
    WHERE s.enabled = 1 AND (s.playlist_id IS NULL OR s.playlist_id = ?1)
      AND c.programme_count > 0
      AND (instr(c.key, ?2) > 0 OR instr(n.name_key, ?3) > 0)";

/// The text in column `idx`, borrowed from the row; `None` for NULL.
fn text_at<'r>(row: &'r Row<'_>, idx: usize) -> rusqlite::Result<Option<&'r str>> {
    row.get_ref(idx)?
        .as_str_or_null()
        .map_err(|e| rusqlite::Error::FromSqlConversionFailure(idx, Type::Text, Box::new(e)))
}

/// The guide channels of `profile`'s sources that `query` finds, best
/// first, at most `limit` (clamped to 1..=50). A query under two characters
/// (see `SearchQuery::new`) finds nothing.
pub fn search_channels(
    conn: &Connection,
    profile: Option<i64>,
    query: &str,
    limit: u32,
) -> rusqlite::Result<Vec<EpgChannelHit>> {
    let Some(query) = SearchQuery::new(query) else {
        return Ok(Vec::new());
    };
    let mut best = BestHits::new(&query, clamp_search_limit(limit));
    {
        let mut stmt = conn.prepare_cached(CANDIDATES)?;
        let mut rows = stmt.query(params![profile, query.key, query.name])?;
        while let Some(r) = rows.next()? {
            let key = text_at(r, 0)?
                .ok_or_else(|| rusqlite::Error::InvalidColumnType(0, "key".into(), Type::Null))?;
            best.offer(CandidateRow {
                key,
                name: text_at(r, 1)?,
                name_key: text_at(r, 2)?,
                position: r.get(3)?,
                source_id: r.get(4)?,
                priority: r.get(5)?,
            });
        }
    }
    let hits = best.into_hits();
    if hits.is_empty() {
        return Ok(Vec::new());
    }
    let labels: HashMap<i64, String> = list_sources(conn)?
        .iter()
        .filter(|s| applies_to(s.playlist_id, profile))
        .map(|s| (s.id, picker_label(s)))
        .collect();
    Ok(hits
        .into_iter()
        .map(|c| EpgChannelHit {
            source_label: labels.get(&c.source_id).cloned().unwrap_or_default(),
            key: c.key,
            name: c.name,
            source_id: c.source_id,
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_helpers::setup_test_db;
    use crate::epg::sources::ensure_xtream_source;
    use crate::epg_domain::key::name_key;

    /// A guide channel with programmes (or none) and its display names.
    fn guide_channel(conn: &Connection, source: i64, key: &str, names: &[&str], count: i64) {
        conn.execute(
            "INSERT INTO epg_channel (source_id, key, first_start, last_stop, programme_count)
             VALUES (?1, ?2, 100, 200, ?3)",
            params![source, key, count],
        )
        .unwrap();
        let channel = conn.last_insert_rowid();
        for (position, name) in names.iter().enumerate() {
            conn.execute(
                "INSERT INTO epg_channel_name (channel_id, position, name, name_key)
                 VALUES (?1, ?2, ?3, ?4)",
                params![channel, position as i64, name, name_key(name).unwrap()],
            )
            .unwrap();
        }
    }

    fn source(conn: &Connection, playlist_id: Option<i64>, origin: &str, priority: i32) -> i64 {
        let url = (origin != "xtream").then(|| format!("http://guide{priority}.example/epg.xml"));
        conn.execute(
            "INSERT INTO epg_source (playlist_id, origin, url, priority) VALUES (?1, ?2, ?3, ?4)",
            params![playlist_id, origin, url, priority],
        )
        .unwrap();
        conn.last_insert_rowid()
    }

    fn playlist(conn: &Connection, id: i64) {
        conn.execute(
            "INSERT INTO playlists (id, name, url, xtream_username, xtream_password)
             VALUES (?1, 'P', 'http://provider.example', 'john', 'secret')",
            params![id],
        )
        .unwrap();
    }

    fn found(hits: &[EpgChannelHit]) -> Vec<(&str, Option<&str>, &str)> {
        hits.iter()
            .map(|h| (h.key.as_str(), h.name.as_deref(), h.source_label.as_str()))
            .collect()
    }

    #[test]
    fn finds_names_and_keys_in_the_profiles_sources_with_programmes() {
        let conn = setup_test_db();
        playlist(&conn, 1);
        playlist(&conn, 2);
        let xtream = ensure_xtream_source(&conn, 1).unwrap();
        let manual = source(&conn, None, "manual", 10);
        let header = source(&conn, Some(1), "m3u_header", 20);
        let other = source(&conn, Some(2), "m3u_header", 20);
        let off = source(&conn, None, "manual", 5);
        conn.execute(
            "UPDATE epg_source SET enabled = 0 WHERE id = ?1",
            params![off],
        )
        .unwrap();
        guide_channel(&conn, xtream, "svt1.se", &["SVT1"], 5);
        guide_channel(&conn, manual, "svt1hd.se", &["SVT1 HD"], 5);
        guide_channel(&conn, header, "svt1.dk", &[], 5);
        guide_channel(&conn, manual, "svt1old.se", &["SVT1 Old"], 0);
        guide_channel(&conn, other, "svt1.no", &["SVT1 Norge"], 5);
        guide_channel(&conn, off, "svt1off.se", &["SVT1 Off"], 5);

        let hits = search_channels(&conn, Some(1), "svt1", 50).unwrap();

        assert_eq!(
            found(&hits),
            [
                ("svt1.se", Some("SVT1"), "Your provider's guide"),
                ("svt1hd.se", Some("SVT1 HD"), "guide10.example"),
                ("svt1.dk", None, "From the playlist"),
            ]
        );
        assert_eq!(hits[0].source_id, xtream);
        // Nothing of the other profile, a disabled source, or a channel
        // without programmes; a profile-less search sees the global ones.
        assert_eq!(
            found(&search_channels(&conn, None, "svt1", 50).unwrap()),
            [("svt1hd.se", Some("SVT1 HD"), "guide10.example")]
        );
    }

    #[test]
    fn an_empty_or_one_character_query_finds_nothing() {
        let conn = setup_test_db();
        let s = source(&conn, None, "manual", 10);
        guide_channel(&conn, s, "svt1.se", &["SVT1"], 5);
        assert!(search_channels(&conn, None, "", 50).unwrap().is_empty());
        assert!(search_channels(&conn, None, "  ", 50).unwrap().is_empty());
        assert!(search_channels(&conn, None, "s", 50).unwrap().is_empty());
        assert!(search_channels(&conn, None, " 1_ ", 50).unwrap().is_empty());
        assert_eq!(search_channels(&conn, None, "sv", 50).unwrap().len(), 1);
    }

    #[test]
    fn caps_at_fifty_hits_in_a_stable_order() {
        let conn = setup_test_db();
        let s = source(&conn, None, "manual", 10);
        for i in (0..120).rev() {
            guide_channel(
                &conn,
                s,
                &format!("kanal{i:03}.se"),
                &[&format!("Kanal {i:03}")],
                1,
            );
        }
        let hits = search_channels(&conn, None, "kanal", 500).unwrap();
        assert_eq!(hits.len(), 50);
        assert_eq!(hits[0].key, "kanal000.se");
        assert_eq!(hits[49].key, "kanal049.se");
        assert_eq!(search_channels(&conn, None, "kanal", 500).unwrap(), hits);
        assert_eq!(search_channels(&conn, None, "kanal", 0).unwrap().len(), 1);
    }

    #[test]
    fn non_ascii_and_like_wildcards_are_matched_as_written() {
        let conn = setup_test_db();
        let s = source(&conn, None, "manual", 10);
        guide_channel(&conn, s, "ämne.se", &["Kunskapskanalen Ämne"], 1);
        guide_channel(&conn, s, "sport_1.se", &["Sport 1"], 1);
        guide_channel(&conn, s, "sport21.se", &["Sport 21"], 1);
        guide_channel(&conn, s, "100.se", &["100% Musik"], 1);
        guide_channel(&conn, s, "1000.se", &["1000 Hits"], 1);

        let keys = |q: &str| -> Vec<String> {
            search_channels(&conn, None, q, 50)
                .unwrap()
                .into_iter()
                .map(|h| h.key)
                .collect()
        };
        assert_eq!(keys("ÄMNE"), ["ämne.se"]);
        assert_eq!(keys("sport_1"), ["sport_1.se"], "no LIKE wildcard");
        assert_eq!(keys("100%"), ["100.se"]);
    }
}
