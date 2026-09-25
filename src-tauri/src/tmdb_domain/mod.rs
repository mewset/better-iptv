//! Pure TMDB logic: title normalisation, match selection, key format,
//! staleness rules, genre names, image URLs. No I/O, no database.

use lazy_static::lazy_static;
use regex::Regex;

/// A provider title reduced to what TMDB can search for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Normalized {
    pub title: String,
    pub year: Option<i32>,
}

#[allow(dead_code)] // Consumed by the TMDB matcher and cache in later tasks
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
#[allow(dead_code)] // Consumed by the TMDB matcher and cache in later tasks
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
