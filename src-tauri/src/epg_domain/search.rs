//! Searching the guide's channels by name or key, for the picker that
//! matches a channel by hand.
//!
//! The query is compared twice: through `name_key` against each display
//! name's key, and through `channel_key` against the guide key, so "svt 1",
//! "SVT1_HD" and "svt1.se" all find what a person typing them means. A hit
//! that equals the query ranks before one that starts with it, which ranks
//! before one that only contains it. Within a rank the higher-precedence
//! source comes first, then the name, then the key, so the same guide gives
//! the same order every time.

use super::key::{channel_key, name_key};

/// At most this many hits per search.
pub const MAX_SEARCH_HITS: usize = 50;

/// The number of hits a request for `limit` gets: 1 to `MAX_SEARCH_HITS`.
pub fn clamp_search_limit(limit: u32) -> usize {
    (limit as usize).clamp(1, MAX_SEARCH_HITS)
}

/// A query as the two comparisons need it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SearchQuery {
    /// Compared with the display names' `name_key`.
    pub name: String,
    /// Compared with the guide keys.
    pub key: String,
}

impl SearchQuery {
    /// `None` for a query that is empty after trimming: nothing is searched.
    pub fn new(raw: &str) -> Option<Self> {
        Some(SearchQuery {
            name: name_key(raw)?,
            key: channel_key(raw)?,
        })
    }
}

/// One display name of a guide channel (or the channel alone, when the feed
/// names it nowhere) that the database found for the query.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Candidate {
    pub key: String,
    /// The display name as the feed wrote it.
    pub name: Option<String>,
    pub name_key: Option<String>,
    /// The name's position among the channel's display names.
    pub position: i64,
    pub source_id: i64,
    /// The source's `priority`: lower wins.
    pub priority: i32,
}

/// How closely `text` meets `query`: 0 equal, 1 starts with it, 2 contains
/// it; `None` when it does not contain it.
fn closeness(text: &str, query: &str) -> Option<u8> {
    if text == query {
        Some(0)
    } else if text.starts_with(query) {
        Some(1)
    } else if text.contains(query) {
        Some(2)
    } else {
        None
    }
}

/// The candidate's rank for the query; `None` when it does not match.
fn rank(query: &SearchQuery, candidate: &Candidate) -> Option<u8> {
    let by_name = candidate
        .name_key
        .as_deref()
        .and_then(|name| closeness(name, &query.name));
    let by_key = closeness(&candidate.key, &query.key);
    match (by_name, by_key) {
        (Some(a), Some(b)) => Some(a.min(b)),
        (a, b) => a.or(b),
    }
}

/// The best `limit` candidates, one per guide key, best first. For a key
/// several candidates reach (two names, two sources), the best ranked one
/// stands for it, so the name shown is the one that matched.
pub fn best_hits(query: &SearchQuery, candidates: Vec<Candidate>, limit: usize) -> Vec<Candidate> {
    let mut ranked: Vec<(u8, Candidate)> = candidates
        .into_iter()
        .filter_map(|c| rank(query, &c).map(|r| (r, c)))
        .collect();
    ranked.sort_by(|(ra, a), (rb, b)| {
        ra.cmp(rb)
            .then(a.priority.cmp(&b.priority))
            .then(a.source_id.cmp(&b.source_id))
            .then(a.name_key.cmp(&b.name_key))
            .then(a.key.cmp(&b.key))
            .then(a.position.cmp(&b.position))
    });
    let mut seen = std::collections::HashSet::new();
    ranked
        .into_iter()
        .map(|(_, c)| c)
        .filter(|c| seen.insert(c.key.clone()))
        .take(limit)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn named(key: &str, name: &str, source_id: i64, priority: i32) -> Candidate {
        Candidate {
            key: key.to_string(),
            name: Some(name.to_string()),
            name_key: name_key(name),
            position: 0,
            source_id,
            priority,
        }
    }

    fn unnamed(key: &str) -> Candidate {
        Candidate {
            key: key.to_string(),
            name: None,
            name_key: None,
            position: 0,
            source_id: 1,
            priority: 10,
        }
    }

    fn keys(hits: &[Candidate]) -> Vec<&str> {
        hits.iter().map(|h| h.key.as_str()).collect()
    }

    fn query(raw: &str) -> SearchQuery {
        SearchQuery::new(raw).unwrap()
    }

    #[test]
    fn the_limit_is_kept_between_one_and_fifty() {
        assert_eq!(clamp_search_limit(0), 1);
        assert_eq!(clamp_search_limit(20), 20);
        assert_eq!(clamp_search_limit(50), 50);
        assert_eq!(clamp_search_limit(5_000), MAX_SEARCH_HITS);
    }

    #[test]
    fn an_empty_query_searches_nothing() {
        assert_eq!(SearchQuery::new(""), None);
        assert_eq!(SearchQuery::new("   "), None);
        assert_eq!(SearchQuery::new(" _ "), None);
    }

    #[test]
    fn a_query_is_read_as_a_name_and_as_a_key() {
        assert_eq!(
            query("  SVT1_HD "),
            SearchQuery {
                name: "svt1 hd".to_string(),
                key: "svt1_hd".to_string()
            }
        );
    }

    #[test]
    fn equal_ranks_before_starts_with_before_contains() {
        let candidates = vec![
            named("svt1hd.se", "SVT1 HD", 1, 10),
            named("nyheter.se", "Kanal SVT1", 1, 10),
            named("svt1.se", "SVT1", 1, 10),
        ];
        let hits = best_hits(&query("svt1"), candidates, 50);
        assert_eq!(keys(&hits), ["svt1.se", "svt1hd.se", "nyheter.se"]);
    }

    #[test]
    fn a_key_matches_as_well_as_a_name() {
        let candidates = vec![named("svt1.se", "Ettan", 1, 10), unnamed("tv4.se")];
        assert_eq!(
            keys(&best_hits(&query("SVT1.SE"), candidates.clone(), 50)),
            ["svt1.se"]
        );
        assert_eq!(keys(&best_hits(&query("tv4"), candidates, 50)), ["tv4.se"]);
    }

    #[test]
    fn non_ascii_names_match_in_any_case() {
        let candidates = vec![
            named("ämne.se", "Kunskapskanalen Ämne", 1, 10),
            named("ostersund.se", "ÖSTERSUND TV", 1, 10),
        ];
        assert_eq!(
            keys(&best_hits(&query("ämne"), candidates.clone(), 50)),
            ["ämne.se"]
        );
        assert_eq!(
            keys(&best_hits(&query("östersund"), candidates, 50)),
            ["ostersund.se"]
        );
    }

    #[test]
    fn one_hit_per_key_named_by_the_name_that_matched_best() {
        let mut second = named("svt1.se", "SVT1", 1, 10);
        second.position = 1;
        let candidates = vec![
            named("svt1.se", "Sveriges Television 1", 1, 10),
            second,
            named("svt1.se", "SVT1", 2, 30),
        ];
        let hits = best_hits(&query("svt1"), candidates, 50);
        assert_eq!(hits.len(), 1);
        assert_eq!(
            (hits[0].name.as_deref(), hits[0].source_id),
            (Some("SVT1"), 1)
        );
    }

    #[test]
    fn within_a_rank_the_higher_priority_source_comes_first_then_the_name() {
        let candidates = vec![
            named("tv4.no", "TV4 Norge", 2, 30),
            named("tv4hd.se", "TV4 HD", 1, 10),
            named("tv4.dk", "TV4 Danmark", 1, 10),
        ];
        let hits = best_hits(&query("tv4"), candidates, 50);
        assert_eq!(keys(&hits), ["tv4.dk", "tv4hd.se", "tv4.no"]);
    }

    #[test]
    fn the_order_does_not_depend_on_the_order_the_rows_came_in() {
        let candidates = vec![
            named("b.se", "Kanal", 1, 10),
            named("a.se", "Kanal", 1, 10),
            named("c.se", "Kanal 2", 1, 10),
            named("d.se", "Min kanal", 1, 10),
        ];
        let forward = best_hits(&query("kanal"), candidates.clone(), 50);
        let mut reversed = candidates;
        reversed.reverse();
        let backward = best_hits(&query("kanal"), reversed, 50);
        assert_eq!(keys(&forward), ["a.se", "b.se", "c.se", "d.se"]);
        assert_eq!(forward, backward);
    }

    #[test]
    fn hits_stop_at_the_limit() {
        let candidates = (0..80)
            .map(|i| named(&format!("kanal{i:02}.se"), &format!("Kanal {i:02}"), 1, 10))
            .collect();
        let hits = best_hits(&query("kanal"), candidates, clamp_search_limit(500));
        assert_eq!(hits.len(), 50);
        assert_eq!(hits[0].key, "kanal00.se");
        assert_eq!(hits[49].key, "kanal49.se");
    }

    #[test]
    fn a_candidate_that_does_not_contain_the_query_is_dropped() {
        let hits = best_hits(&query("svt"), vec![named("tv4.se", "TV4", 1, 10)], 50);
        assert!(hits.is_empty());
    }
}
