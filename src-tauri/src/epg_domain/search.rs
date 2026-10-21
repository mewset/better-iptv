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
use std::cmp::Ordering;

/// At most this many hits per search.
pub const MAX_SEARCH_HITS: usize = 50;

/// A query shorter than this, in either of its two forms, searches nothing:
/// one character is in nearly every name of a large guide.
pub const MIN_QUERY_CHARS: usize = 2;

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
    /// `None` for a query that is empty after trimming, or shorter than
    /// `MIN_QUERY_CHARS` as a name or as a key: nothing is searched.
    pub fn new(raw: &str) -> Option<Self> {
        let query = SearchQuery {
            name: name_key(raw)?,
            key: channel_key(raw)?,
        };
        let long_enough = |form: &str| form.chars().count() >= MIN_QUERY_CHARS;
        (long_enough(&query.name) && long_enough(&query.key)).then_some(query)
    }
}

/// One display name of a guide channel (or the channel alone, when the feed
/// names it nowhere) that the search keeps.
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

/// A row the database found, borrowed from it, so a row the search does
/// not keep is never copied.
#[derive(Clone, Copy, Debug)]
pub struct CandidateRow<'a> {
    pub key: &'a str,
    pub name: Option<&'a str>,
    pub name_key: Option<&'a str>,
    pub position: i64,
    pub source_id: i64,
    pub priority: i32,
}

impl CandidateRow<'_> {
    fn to_candidate(self) -> Candidate {
        Candidate {
            key: self.key.to_string(),
            name: self.name.map(str::to_string),
            name_key: self.name_key.map(str::to_string),
            position: self.position,
            source_id: self.source_id,
            priority: self.priority,
        }
    }
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

/// The row's rank for the query; `None` when it does not match.
fn rank(query: &SearchQuery, row: &CandidateRow<'_>) -> Option<u8> {
    let by_name = row.name_key.and_then(|name| closeness(name, &query.name));
    let by_key = closeness(row.key, &query.key);
    match (by_name, by_key) {
        (Some(a), Some(b)) => Some(a.min(b)),
        (a, b) => a.or(b),
    }
}

/// The order hits are listed in: rank, source priority, source, name, key,
/// then the name's position.
type OrderKey<'a> = (u8, i32, i64, Option<&'a str>, &'a str, i64);

fn kept_order(rank: u8, c: &Candidate) -> OrderKey<'_> {
    (
        rank,
        c.priority,
        c.source_id,
        c.name_key.as_deref(),
        &c.key,
        c.position,
    )
}

fn row_order<'a>(rank: u8, row: &CandidateRow<'a>) -> OrderKey<'a> {
    (
        rank,
        row.priority,
        row.source_id,
        row.name_key,
        row.key,
        row.position,
    )
}

/// The best `limit` candidates offered so far, one per guide key, best
/// first. For a key several rows reach (two names, two sources), the best
/// ranked one stands for it, so the name shown is the one that matched; of
/// two rows that order the same, the first offered stays.
///
/// Only `limit` candidates are ever held: a row that would land past the
/// last kept one is dropped before anything is copied out of it.
#[derive(Debug)]
pub struct BestHits<'q> {
    query: &'q SearchQuery,
    limit: usize,
    kept: Vec<(u8, Candidate)>,
}

impl<'q> BestHits<'q> {
    pub fn new(query: &'q SearchQuery, limit: usize) -> Self {
        BestHits {
            query,
            limit,
            kept: Vec::with_capacity(limit),
        }
    }

    /// Considers one row the database found.
    pub fn offer(&mut self, row: CandidateRow<'_>) {
        let Some(rank) = rank(self.query, &row) else {
            return;
        };
        let order = row_order(rank, &row);
        // Everything before `at` orders before the row or the same.
        let at = self
            .kept
            .partition_point(|(r, c)| kept_order(*r, c).cmp(&order) != Ordering::Greater);
        if at >= self.limit {
            // At least `limit` keys order before it, its own among them if
            // it is kept already.
            return;
        }
        if let Some(same_key) = self.kept.iter().position(|(_, c)| c.key == row.key) {
            if same_key < at {
                return;
            }
            self.kept.remove(same_key);
        }
        self.kept.insert(at, (rank, row.to_candidate()));
        self.kept.truncate(self.limit);
    }

    pub fn into_hits(self) -> Vec<Candidate> {
        self.kept.into_iter().map(|(_, c)| c).collect()
    }
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

    fn row(c: &Candidate) -> CandidateRow<'_> {
        CandidateRow {
            key: &c.key,
            name: c.name.as_deref(),
            name_key: c.name_key.as_deref(),
            position: c.position,
            source_id: c.source_id,
            priority: c.priority,
        }
    }

    /// Offers the candidates in the order given, as the database would.
    fn best_hits(query: &SearchQuery, candidates: Vec<Candidate>, limit: usize) -> Vec<Candidate> {
        let mut best = BestHits::new(query, limit);
        for c in &candidates {
            best.offer(row(c));
        }
        best.into_hits()
    }

    /// The selection as a full stable sort of every match, then the first
    /// row per key: what `BestHits` must equal.
    fn sorted_hits(
        query: &SearchQuery,
        candidates: Vec<Candidate>,
        limit: usize,
    ) -> Vec<Candidate> {
        let mut ranked: Vec<(u8, Candidate)> = candidates
            .into_iter()
            .filter_map(|c| rank(query, &row(&c)).map(|r| (r, c)))
            .collect();
        ranked.sort_by(|(ra, a), (rb, b)| kept_order(*ra, a).cmp(&kept_order(*rb, b)));
        let mut seen = std::collections::HashSet::new();
        ranked
            .into_iter()
            .map(|(_, c)| c)
            .filter(|c| seen.insert(c.key.clone()))
            .take(limit)
            .collect()
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
    fn a_query_under_two_characters_searches_nothing() {
        assert_eq!(SearchQuery::new("s"), None);
        assert_eq!(SearchQuery::new("  Ä "), None);
        assert_eq!(
            SearchQuery::new("1_"),
            None,
            "one character once normalised"
        );
        assert_eq!(SearchQuery::new("_ _"), None);
        assert!(SearchQuery::new("tv").is_some());
        assert!(SearchQuery::new(" äm ").is_some());
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
    fn keeping_only_the_best_equals_sorting_everything() {
        // A deterministic mix: keys reached by several names and sources,
        // equal names in different sources, ties down to the position, and
        // rows that do not match at all, offered in a scrambled order.
        let names = [
            "Kanal",
            "Kanal 1",
            "Min kanal",
            "Kanalen HD",
            "Sport",
            "kanal",
        ];
        let mut candidates = Vec::new();
        let mut seed: u64 = 0x2545_f491_4f6c_dd1d;
        for i in 0..3_000u64 {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            let key = format!("k{:03}.se", seed % 400);
            let name = names[(seed >> 9) as usize % names.len()];
            let source_id = ((seed >> 17) % 4) as i64 + 1;
            let mut c = if (seed >> 23).is_multiple_of(7) {
                Candidate {
                    name: None,
                    name_key: None,
                    ..named(&key, name, source_id, 0)
                }
            } else {
                named(&key, name, source_id, 0)
            };
            c.priority = [10, 10, 20, 5][(source_id - 1) as usize];
            c.position = ((seed >> 29) % 3) as i64;
            if i.is_multiple_of(11) {
                c.key = format!("kanal{:02}.se", seed % 60);
            }
            candidates.push(c);
        }
        for raw in ["kanal", "kanal 1", "k1", "k00", "sport", "kanal0"] {
            let q = query(raw);
            for limit in [1, 7, 50] {
                assert_eq!(
                    best_hits(&q, candidates.clone(), limit),
                    sorted_hits(&q, candidates.clone(), limit),
                    "query {raw:?}, limit {limit}"
                );
            }
        }
    }

    #[test]
    fn a_candidate_that_does_not_contain_the_query_is_dropped() {
        let hits = best_hits(&query("svt"), vec![named("tv4.se", "TV4", 1, 10)], 50);
        assert!(hits.is_empty());
    }
}
