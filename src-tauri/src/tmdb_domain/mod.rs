//! Pure TMDB logic: title normalisation, match selection, key format,
//! staleness rules, genre names, image URLs. No I/O, no database.

use chrono::{DateTime, Duration, Utc};
use lazy_static::lazy_static;
use regex::Regex;

/// A provider title reduced to what TMDB can search for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Normalized {
    pub title: String,
    pub year: Option<i32>,
}

impl Normalized {
    /// Case-folded title: the first part of the cache key.
    pub fn cache_title(&self) -> String {
        self.title.to_lowercase()
    }

    /// The year part of the cache key. `UNIQUE` cannot treat two NULLs as
    /// equal, so an unknown year is stored as 0.
    pub fn cache_year(&self) -> i32 {
        self.year.unwrap_or(0)
    }
}

/// Release-name tokens that never belong to a title. Compared lower-cased.
const NOISE_TOKENS: &[&str] = &[
    "1080p",
    "2160p",
    "720p",
    "480p",
    "4k",
    "uhd",
    "hdr",
    "hdr10",
    "hevc",
    "h264",
    "h265",
    "x264",
    "x265",
    "web-dl",
    "webdl",
    "webrip",
    "bluray",
    "brrip",
    "bdrip",
    "hdtv",
    "dvdrip",
    "multi",
    "dubbed",
    "subbed",
    "remastered",
    "extended",
    "unrated",
    "proper",
    "repack",
    "fhd",
    "hd",
    "sd",
    "aac",
    "ac3",
    "dts",
    "10bit",
    "multisub",
];

lazy_static! {
    static ref DOTS: Regex = Regex::new(r"[._]+").unwrap();
    /// "SE|", "SE -", "EN:", "4K|", "[MULTI]" at the very start.
    static ref LEADING_TAG: Regex =
        Regex::new(r"^(?:\[[^\]]*\]|[A-Z]{2,4}\s*[|:\-]|\d[Kk]\s*\|)\s*").unwrap();
    static ref BRACKET_GROUP: Regex = Regex::new(r"\[[^\]]*\]").unwrap();
    static ref PAREN_GROUP: Regex = Regex::new(r"\(([^)]*)\)").unwrap();
    static ref SEASON_TAG: Regex = Regex::new(r"(?i)\bS\d{1,2}(?:E\d{1,3})?\b").unwrap();
    static ref YEAR_PAREN: Regex = Regex::new(r"[(\[]\s*((?:19|20)\d{2})\s*[)\]]").unwrap();
    static ref YEAR_TRAILING: Regex = Regex::new(r"(?:^|\s)((?:19|20)\d{2})\s*$").unwrap();
    static ref TRAILING_SEP: Regex = Regex::new(r"[\s\-:|]+$").unwrap();
    static ref WS: Regex = Regex::new(r"\s+").unwrap();
}

fn is_noise(word: &str) -> bool {
    let w = word.to_ascii_lowercase();
    NOISE_TOKENS.contains(&w.as_str())
}

fn plausible_year(year: i32, current_year: i32) -> bool {
    (1900..=current_year + 1).contains(&year)
}

/// Strip provider tags, release-name noise and a year from a channel name.
///
/// Known trade-off: an all-caps word of 2-4 letters followed by `|`, `:` or
/// `-` is read as a provider tag, so "MTV - Unplugged" becomes "Unplugged".
/// The manual re-match in the detail view covers such cases.
pub fn normalize_title(raw: &str, current_year: i32) -> Normalized {
    let mut s = DOTS.replace_all(raw.trim(), " ").into_owned();

    loop {
        let stripped = LEADING_TAG.replace(&s, "").into_owned();
        if stripped == s {
            break;
        }
        s = stripped;
    }

    // A bracketed year is the strongest signal; take it before bracket
    // groups are discarded.
    // A bracketed four-digit number is never part of the title; it only
    // counts as the year when plausible ("Future Film (2031)" keeps no year).
    let mut year: Option<i32> = None;
    if let Some(c) = YEAR_PAREN.captures(&s) {
        year = c[1]
            .parse::<i32>()
            .ok()
            .filter(|y| plausible_year(*y, current_year));
        s = YEAR_PAREN.replace(&s, " ").into_owned();
    }

    s = BRACKET_GROUP.replace_all(&s, " ").into_owned();
    // Parenthesised groups made only of noise ("(1080p HEVC)") go; others stay.
    s = PAREN_GROUP
        .replace_all(&s, |c: &regex::Captures| {
            let inner = c[1].trim();
            if !inner.is_empty() && inner.split_whitespace().all(is_noise) {
                " ".to_string()
            } else {
                c[0].to_string()
            }
        })
        .into_owned();
    s = SEASON_TAG.replace_all(&s, " ").into_owned();

    // Drop noise words, but never the first: "HD" or "Multi" can open a title.
    let kept: Vec<&str> = s
        .split_whitespace()
        .enumerate()
        .filter(|(i, w)| *i == 0 || !is_noise(w))
        .map(|(_, w)| w)
        .collect();
    s = kept.join(" ");

    if year.is_none() {
        if let Some(c) = YEAR_TRAILING.captures(&s) {
            let y: i32 = c[1].parse().unwrap_or(0);
            let rest = s[..c.get(0).unwrap().start()].trim().to_string();
            // "1917" alone is a title; "Blade Runner 2049" is not from 2049.
            if !rest.is_empty() && plausible_year(y, current_year) {
                year = Some(y);
                s = rest;
            }
        }
    }

    s = TRAILING_SEP.replace(&s, "").into_owned();
    s = WS.replace_all(&s, " ").trim().to_string();
    Normalized { title: s, year }
}

// ---------- matching ----------

/// One TMDB search hit, reduced to what matching needs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Candidate {
    pub id: i64,
    pub title: String,
    pub original_title: String,
    pub year: Option<i32>,
}

/// Minimum normalised similarity for a non-exact match.
pub const MATCH_THRESHOLD: f64 = 0.85;

/// Lower-case, letters/digits/spaces only, single-spaced.
fn fold(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut last_space = true;
    for ch in s.to_lowercase().chars() {
        if ch.is_alphanumeric() {
            out.push(ch);
            last_space = false;
        } else if !last_space {
            out.push(' ');
            last_space = true;
        }
    }
    out.trim_end().to_string()
}

fn levenshtein(a: &str, b: &str) -> usize {
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    let mut cur = vec![0; b.len() + 1];
    for (i, ca) in a.iter().enumerate() {
        cur[0] = i + 1;
        for (j, cb) in b.iter().enumerate() {
            let cost = usize::from(ca != cb);
            cur[j + 1] = (prev[j + 1] + 1).min(cur[j] + 1).min(prev[j] + cost);
        }
        std::mem::swap(&mut prev, &mut cur);
    }
    prev[b.len()]
}

/// 1.0 for identical folded strings, 0.0 for nothing in common.
pub fn similarity(a: &str, b: &str) -> f64 {
    let fa = fold(a);
    let fb = fold(b);
    let longest = fa.chars().count().max(fb.chars().count());
    if longest == 0 {
        return 1.0;
    }
    1.0 - levenshtein(&fa, &fb) as f64 / longest as f64
}

fn years_close(a: i32, b: i32) -> bool {
    (a - b).abs() <= 1
}

/// Choose the candidate for a normalised title, or `None` (store as no-match).
///
/// Order: exact title (or original title) with the same year; exact title
/// with the year off by one; exact title when the query has no year; then the
/// first candidate above `MATCH_THRESHOLD` whose year is compatible.
pub fn pick_match<'a>(query: &Normalized, candidates: &'a [Candidate]) -> Option<&'a Candidate> {
    let q = fold(&query.title);
    let exact = |c: &Candidate| fold(&c.title) == q || fold(&c.original_title) == q;

    match query.year {
        Some(y) => {
            if let Some(c) = candidates.iter().find(|c| exact(c) && c.year == Some(y)) {
                return Some(c);
            }
            if let Some(c) = candidates
                .iter()
                .find(|c| exact(c) && c.year.is_some_and(|cy| years_close(cy, y)))
            {
                return Some(c);
            }
        }
        None => {
            if let Some(c) = candidates.iter().find(|c| exact(c)) {
                return Some(c);
            }
        }
    }

    candidates.iter().find(|c| {
        let year_ok = match (query.year, c.year) {
            (Some(a), Some(b)) => years_close(a, b),
            (Some(_), None) => false,
            (None, _) => true,
        };
        year_ok
            && (similarity(&query.title, &c.title) >= MATCH_THRESHOLD
                || similarity(&query.title, &c.original_title) >= MATCH_THRESHOLD)
    })
}

// ---------- key format ----------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyKind {
    /// 32 hex characters: sent as the `api_key` query parameter.
    V3,
    /// Anything else (the JWT-shaped read access token): sent as a Bearer header.
    V4,
}

pub fn key_kind(key: &str) -> KeyKind {
    let k = key.trim();
    if k.len() == 32 && k.chars().all(|c| c.is_ascii_hexdigit()) {
        KeyKind::V3
    } else {
        KeyKind::V4
    }
}

// ---------- staleness ----------

pub const NO_MATCH_TTL_DAYS: i64 = 7;
pub const MATCH_TTL_DAYS: i64 = 30;

fn older_than(stamp: &str, now: DateTime<Utc>, days: i64) -> bool {
    match DateTime::parse_from_rfc3339(stamp) {
        Ok(t) => now - t.with_timezone(&Utc) >= Duration::days(days),
        Err(_) => true,
    }
}

/// Whether a cache row should be searched again.
pub fn search_is_stale(searched_at: &str, now: DateTime<Utc>, matched: bool, manual: bool) -> bool {
    if manual {
        return false;
    }
    let ttl = if matched {
        MATCH_TTL_DAYS
    } else {
        NO_MATCH_TTL_DAYS
    };
    older_than(searched_at, now, ttl)
}

/// Whether details (credits, runtime, trailer) should be fetched again.
pub fn details_are_stale(details_fetched_at: Option<&str>, now: DateTime<Utc>) -> bool {
    match details_fetched_at {
        Some(stamp) => older_than(stamp, now, MATCH_TTL_DAYS),
        None => true,
    }
}

// ---------- genres ----------

/// TMDB's fixed genre ids (movie and TV lists, unchanged for years).
pub fn genre_name(id: i32) -> Option<&'static str> {
    Some(match id {
        28 => "Action",
        12 => "Adventure",
        16 => "Animation",
        35 => "Comedy",
        80 => "Crime",
        99 => "Documentary",
        18 => "Drama",
        10751 => "Family",
        14 => "Fantasy",
        36 => "History",
        27 => "Horror",
        10402 => "Music",
        9648 => "Mystery",
        10749 => "Romance",
        878 => "Science Fiction",
        10770 => "TV Movie",
        53 => "Thriller",
        10752 => "War",
        37 => "Western",
        10759 => "Action & Adventure",
        10762 => "Kids",
        10763 => "News",
        10764 => "Reality",
        10765 => "Sci-Fi & Fantasy",
        10766 => "Soap",
        10767 => "Talk",
        10768 => "War & Politics",
        _ => return None,
    })
}

// ---------- images ----------

pub const IMAGE_BASE: &str = "https://image.tmdb.org/t/p/";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImageSize {
    CardPoster,
    DetailPoster,
    Backdrop,
    /// Cast photos and search-candidate thumbnails.
    Small,
}

impl ImageSize {
    fn segment(self) -> &'static str {
        match self {
            ImageSize::CardPoster => "w342",
            ImageSize::DetailPoster => "w780",
            ImageSize::Backdrop => "w1280",
            ImageSize::Small => "w185",
        }
    }
}

pub fn image_url(path: Option<&str>, size: ImageSize) -> Option<String> {
    let p = path?.trim();
    if p.is_empty() {
        return None;
    }
    Some(format!("{IMAGE_BASE}{}{}", size.segment(), p))
}

// ---------- key decision ----------

pub const SHARED_KEY_MAX_AGE_HOURS: i64 = 24;

/// The TMDB-related settings rows, as read from the database.
#[derive(Debug, Clone, Default)]
pub struct KeySettings {
    pub enabled: bool,
    pub user_key: Option<String>,
    pub shared_key: Option<String>,
    pub shared_fetched_at: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeySource {
    User,
    Shared,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KeyDecision {
    Disabled,
    Use {
        key: String,
        source: KeySource,
    },
    /// Fetch the shared key from the website; `stale` is the previous shared
    /// key to fall back on when the fetch fails.
    FetchShared {
        stale: Option<String>,
    },
}

/// Spec §1 steps 1-4, without the I/O.
pub fn decide_key(s: &KeySettings, now: DateTime<Utc>) -> KeyDecision {
    if !s.enabled {
        return KeyDecision::Disabled;
    }
    if let Some(user) = s
        .user_key
        .as_deref()
        .map(str::trim)
        .filter(|k| !k.is_empty())
    {
        return KeyDecision::Use {
            key: user.to_string(),
            source: KeySource::User,
        };
    }
    let shared = s
        .shared_key
        .as_deref()
        .map(str::trim)
        .filter(|k| !k.is_empty());
    let fresh = s.shared_fetched_at.as_deref().is_some_and(|at| {
        DateTime::parse_from_rfc3339(at)
            .map(|t| now - t.with_timezone(&Utc) < Duration::hours(SHARED_KEY_MAX_AGE_HOURS))
            .unwrap_or(false)
    });
    match (shared, fresh) {
        (Some(key), true) => KeyDecision::Use {
            key: key.to_string(),
            source: KeySource::Shared,
        },
        (stale, _) => KeyDecision::FetchShared {
            stale: stale.map(String::from),
        },
    }
}

#[cfg(test)]
mod normalize_tests {
    use super::*;

    /// Half real names from a local database, half synthetic release-name
    /// junk. (raw, expected title, expected year), current year 2026.
    const CORPUS: &[(&str, &str, Option<i32>)] = &[
        ("Arsenal (2017)", "Arsenal", Some(2017)),
        ("Skin", "Skin", None),
        ("Murder Mystery 2 (2023)", "Murder Mystery 2", Some(2023)),
        ("Breakfast at Tiffany's", "Breakfast at Tiffany's", None),
        (
            "Wallander 27 - The Troubled Man",
            "Wallander 27 - The Troubled Man",
            None,
        ),
        ("V/H/S/99", "V/H/S/99", None),
        ("Fritt Vilt III", "Fritt Vilt III", None),
        (
            "Prison Break: The Final Break (2009)",
            "Prison Break: The Final Break",
            Some(2009),
        ),
        ("180 (2026)", "180", Some(2026)),
        ("Pluto TV Cine Familia", "Pluto TV Cine Familia", None),
        ("Love is Blind: Sverige", "Love is Blind: Sverige", None),
        ("Mr. & Mrs. Smith", "Mr & Mrs Smith", None),
        ("Blade Runner 2049", "Blade Runner 2049", None),
        ("1917", "1917", None),
        ("2012", "2012", None),
        ("SE| Movie.Name.2023.1080p", "Movie Name", Some(2023)),
        ("[4K] Dune Part Two (2024) HDR", "Dune Part Two", Some(2024)),
        ("EN: The.Office.US.S01", "The Office US", None),
        ("4K| Avatar (2009) HEVC", "Avatar", Some(2009)),
        ("NO - Fritt Vilt III", "Fritt Vilt III", None),
        (
            "The.Matrix.1999.REMASTERED.1080p.BluRay.x264",
            "The Matrix",
            Some(1999),
        ),
        ("Oppenheimer 2023 (1080p HEVC)", "Oppenheimer", Some(2023)),
        ("HD Movie", "HD Movie", None),
        ("  Dog  ", "Dog", None),
        ("Kinda Pregnant - ", "Kinda Pregnant", None),
        ("Future Film (2031)", "Future Film", None),
    ];

    #[test]
    fn corpus_normalises_as_expected() {
        for (raw, title, year) in CORPUS {
            let n = normalize_title(raw, 2026);
            assert_eq!(n.title, *title, "title of {raw:?}");
            assert_eq!(n.year, *year, "year of {raw:?}");
        }
    }

    #[test]
    fn cache_key_parts_fold_case_and_default_the_year() {
        let n = normalize_title("Shutter Island", 2026);
        assert_eq!(n.cache_title(), "shutter island");
        assert_eq!(n.cache_year(), 0);
        assert_eq!(
            normalize_title("Shutter Island (2010)", 2026).cache_year(),
            2010
        );
    }
}

#[cfg(test)]
mod matching_tests {
    use super::*;
    use chrono::{TimeZone, Utc};

    fn cand(id: i64, title: &str, original: &str, year: Option<i32>) -> Candidate {
        Candidate {
            id,
            title: title.into(),
            original_title: original.into(),
            year,
        }
    }

    #[test]
    fn exact_title_and_year_wins_over_an_earlier_candidate() {
        let q = normalize_title("Fullt Hus (2020)", 2026);
        let cands = [
            cand(4313, "Huset fullt", "Full House", Some(1987)),
            cand(120487, "Fullt Hus", "Fullt Hus", Some(2020)),
        ];
        assert_eq!(pick_match(&q, &cands).map(|c| c.id), Some(120487));
    }

    #[test]
    fn original_title_counts_as_exact() {
        let q = normalize_title("Full House", 2026);
        let cands = [cand(4313, "Huset fullt", "Full House", Some(1987))];
        assert_eq!(pick_match(&q, &cands).map(|c| c.id), Some(4313));
    }

    #[test]
    fn year_off_by_one_still_matches_an_exact_title() {
        let q = normalize_title("Shutter Island (2009)", 2026);
        let cands = [cand(11324, "Shutter Island", "Shutter Island", Some(2010))];
        assert_eq!(pick_match(&q, &cands).map(|c| c.id), Some(11324));
    }

    #[test]
    fn a_year_that_is_far_off_blocks_a_fuzzy_match() {
        let q = normalize_title("Shutter Island (1999)", 2026);
        let cands = [cand(11324, "Shutter Island", "Shutter Island", Some(2010))];
        assert!(pick_match(&q, &cands).is_none());
    }

    #[test]
    fn close_spelling_matches_and_a_different_title_does_not() {
        let q = normalize_title("Shuter Island", 2026);
        let cands = [cand(11324, "Shutter Island", "Shutter Island", Some(2010))];
        assert_eq!(pick_match(&q, &cands).map(|c| c.id), Some(11324));
        let q2 = normalize_title("Treasure Island", 2026);
        assert!(pick_match(&q2, &cands).is_none());
    }

    #[test]
    fn similarity_is_symmetric_and_case_insensitive() {
        assert_eq!(similarity("Dune", "dune"), 1.0);
        assert!((similarity("kitten", "sitting") - similarity("sitting", "kitten")).abs() < 1e-9);
        assert!(similarity("kitten", "sitting") < MATCH_THRESHOLD);
    }

    #[test]
    fn key_kind_reads_a_32_hex_key_as_v3_and_anything_else_as_v4() {
        assert_eq!(key_kind("6de159d1ed9e031b4878b4efb9ffb5d1"), KeyKind::V3);
        assert_eq!(key_kind("eyJhbGciOiJIUzI1NiJ9.abc.def"), KeyKind::V4);
        assert_eq!(key_kind("6DE159D1ED9E031B4878B4EFB9FFB5D1"), KeyKind::V3);
    }

    fn day(d: u32) -> chrono::DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 9, d, 12, 0, 0).unwrap()
    }

    #[test]
    fn staleness_follows_the_ttls_and_manual_rows_never_re_search() {
        let searched = day(1).to_rfc3339();
        assert!(!search_is_stale(&searched, day(5), false, false));
        assert!(search_is_stale(&searched, day(9), false, false));
        assert!(!search_is_stale(&searched, day(20), true, false));
        assert!(search_is_stale(
            &searched,
            day(1) + chrono::Duration::days(31),
            true,
            false
        ));
        assert!(!search_is_stale(
            &searched,
            day(1) + chrono::Duration::days(400),
            true,
            true
        ));
        assert!(search_is_stale("not a date", day(1), true, false));
        assert!(details_are_stale(None, day(1)));
        assert!(!details_are_stale(Some(&searched), day(20)));
        assert!(details_are_stale(
            Some(&searched),
            day(1) + chrono::Duration::days(31)
        ));
    }

    #[test]
    fn genre_names_cover_movie_and_tv_ids() {
        assert_eq!(genre_name(18), Some("Drama"));
        assert_eq!(genre_name(10765), Some("Sci-Fi & Fantasy"));
        assert_eq!(genre_name(1), None);
    }

    #[test]
    fn image_urls_use_the_fixed_sizes() {
        assert_eq!(
            image_url(Some("/abc.jpg"), ImageSize::CardPoster).as_deref(),
            Some("https://image.tmdb.org/t/p/w342/abc.jpg")
        );
        assert!(image_url(Some("/abc.jpg"), ImageSize::Backdrop)
            .unwrap()
            .contains("/w1280/"));
        assert_eq!(image_url(None, ImageSize::Small), None);
        assert_eq!(image_url(Some(""), ImageSize::Small), None);
    }

    fn settings(
        enabled: bool,
        user: Option<&str>,
        shared: Option<&str>,
        at: Option<&str>,
    ) -> KeySettings {
        KeySettings {
            enabled,
            user_key: user.map(String::from),
            shared_key: shared.map(String::from),
            shared_fetched_at: at.map(String::from),
        }
    }

    #[test]
    fn key_decision_order_is_disabled_user_fresh_shared_then_fetch() {
        let now = day(10);
        let fresh = day(10).to_rfc3339();
        let old = day(1).to_rfc3339();
        assert!(matches!(
            decide_key(&settings(false, Some("u"), Some("s"), Some(&fresh)), now),
            KeyDecision::Disabled
        ));
        assert!(matches!(
            decide_key(&settings(true, Some("u"), Some("s"), Some(&fresh)), now),
            KeyDecision::Use {
                source: KeySource::User,
                ..
            }
        ));
        assert!(matches!(
            decide_key(&settings(true, Some("  "), Some("s"), Some(&fresh)), now),
            KeyDecision::Use {
                source: KeySource::Shared,
                ..
            }
        ));
        match decide_key(&settings(true, None, Some("s"), Some(&old)), now) {
            KeyDecision::FetchShared { stale } => assert_eq!(stale.as_deref(), Some("s")),
            other => panic!("expected FetchShared, got {other:?}"),
        }
        assert!(matches!(
            decide_key(&settings(true, None, None, None), now),
            KeyDecision::FetchShared { stale: None }
        ));
        assert!(matches!(
            decide_key(&settings(true, None, Some("s"), None), now),
            KeyDecision::FetchShared { .. }
        ));
    }
}
