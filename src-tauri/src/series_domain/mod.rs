//! Series domain business logic
//!
//! This module contains pure business logic for series/VOD operations.
//! Functions here are synchronous and do NOT include database operations.
//! Database operations remain in the commands layer.

use crate::error::AppError;
use crate::db::models::{Channel, SeriesEpisode};
use crate::playlist::{Episode, EpisodeInfo, Season, SeriesInfo, SeriesMetadata};
use serde::{Deserialize, Serialize};
use lazy_static::lazy_static;
use regex::Regex;
use std::collections::{HashMap, BTreeMap};

/// Episode data recovered from an M3U row name such as `Breaking Bad S01 E02 - Pilot`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedEpisode {
    pub series_name: String,
    pub season: i32,
    pub episode: i32,
    pub title: String,
}

lazy_static! {
    // Bounded so `CBS1E5` does not yield S1E5.
    static ref SEASON_EPISODE_RE: Regex =
        Regex::new(r"(?i)\bS(\d{1,2})\s*E(\d{1,3})\b").unwrap();
    // Groups 1 and 4 are the boundary characters; `1080x720` must not yield 80x720.
    static ref NXN_RE: Regex =
        Regex::new(r"(?i)(^|[^\d])(\d{1,2})x(\d{1,3})([^\d]|$)").unwrap();
    static ref SEASON_WORD_RE: Regex =
        Regex::new(r"(?i)\bSeason\s*(\d+)\s*(?:Episode|Ep\.?)\s*(\d+)\b").unwrap();
}

/// Characters that may sit between a series name and the marker (`Show [S01E02]`).
const NAME_TRAILING: &[char] = &[' ', '-', ':', '.', '_', '|', '[', '('];
/// Characters that may sit between the marker and the title (`S01E02] - Pilot`).
/// Opening brackets are not here: `[HD]` after the marker is part of the title.
const TITLE_LEADING: &[char] = &[' ', '-', ':', '.', '_', '|', ']', ')'];

/// Parse season and episode out of an M3U row name.
///
/// Markers are tried in order: `S01E02`, `1x02`, `Season 1 Episode 2`. The
/// text before the marker is the series name; if it is empty the group name
/// is used instead (some exports put the show in `group-title`). Text after
/// the marker is the episode title, falling back to the whole name.
pub fn parse_episode_name(name: &str, group_name: Option<&str>) -> Option<ParsedEpisode> {
    // (start of marker, end of marker, season, episode)
    let (start, end, season, episode) = if let Some(c) = SEASON_EPISODE_RE.captures(name) {
        let m = c.get(0).unwrap();
        (m.start(), m.end(), c[1].parse::<i32>().ok()?, c[2].parse::<i32>().ok()?)
    } else if let Some(c) = NXN_RE.captures(name) {
        (
            c.get(2).unwrap().start(),
            c.get(3).unwrap().end(),
            c[2].parse::<i32>().ok()?,
            c[3].parse::<i32>().ok()?,
        )
    } else if let Some(c) = SEASON_WORD_RE.captures(name) {
        let m = c.get(0).unwrap();
        (m.start(), m.end(), c[1].parse::<i32>().ok()?, c[2].parse::<i32>().ok()?)
    } else {
        return None;
    };

    let before = name[..start].trim_end_matches(NAME_TRAILING).trim();
    let series_name = if before.is_empty() {
        group_name.map(str::trim).filter(|g| !g.is_empty())?.to_string()
    } else {
        before.to_string()
    };

    let after = name[end..].trim_start_matches(TITLE_LEADING).trim();
    let title = if after.is_empty() {
        name.trim().to_string()
    } else {
        after.to_string()
    };

    Some(ParsedEpisode {
        series_name,
        season,
        episode,
        title,
    })
}

/// One episode of an M3U series before it has a database id.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EpisodeInput {
    pub season: i32,
    pub episode: i32,
    pub title: String,
    pub url: String,
    pub logo: Option<String>,
}

/// A series row plus its episodes, ready for insertion.
#[derive(Debug, Clone)]
pub struct SeriesGroup {
    /// The `channels` row for the series (`id` is `None`, it is not stored yet).
    pub channel: Channel,
    /// Sorted by `(season, episode)`.
    pub episodes: Vec<EpisodeInput>,
    /// Ids of the rows that formed this group, when they came from the database.
    pub source_ids: Vec<i64>,
}

/// Output of [`group_series`].
#[derive(Debug, Clone, Default)]
pub struct GroupedChannels {
    /// Rows that are not series episodes (unparsable series rows are now `live`).
    pub plain: Vec<Channel>,
    pub series: Vec<SeriesGroup>,
}

/// Collapse M3U episode rows into one series per `(group_name, series name)`.
///
/// Rows whose `content_type` is not `series` pass through. Series rows whose
/// name has no episode marker are linear channels and become `live`.
pub fn group_series(channels: Vec<Channel>) -> GroupedChannels {
    let mut plain = Vec::new();
    let mut series: Vec<SeriesGroup> = Vec::new();
    let mut index: HashMap<(String, String), usize> = HashMap::new();

    for mut ch in channels {
        if ch.content_type != "series" {
            plain.push(ch);
            continue;
        }

        let parsed = match parse_episode_name(&ch.name, ch.group_name.as_deref()) {
            Some(p) => p,
            None => {
                ch.content_type = "live".to_string();
                plain.push(ch);
                continue;
            }
        };

        let key = (
            ch.group_name.clone().unwrap_or_default(),
            parsed.series_name.to_lowercase(),
        );
        let episode = EpisodeInput {
            season: parsed.season,
            episode: parsed.episode,
            title: parsed.title,
            url: ch.url.clone(),
            logo: ch.logo.clone(),
        };

        match index.get(&key) {
            Some(&i) => {
                let group = &mut series[i];
                let duplicate = group
                    .episodes
                    .iter()
                    .any(|e| e.season == episode.season && e.episode == episode.episode);
                if let Some(id) = ch.id {
                    group.source_ids.push(id);
                }
                group.channel.is_favorite |= ch.is_favorite;
                if ch.sort_order < group.channel.sort_order {
                    group.channel.sort_order = ch.sort_order;
                }
                if !duplicate {
                    group.episodes.push(episode);
                }
            }
            None => {
                index.insert(key, series.len());
                let source_ids = ch.id.into_iter().collect();
                let channel = Channel {
                    id: None,
                    name: parsed.series_name,
                    epg_id: None,
                    tvg_name: None,
                    ..ch
                };
                series.push(SeriesGroup {
                    channel,
                    episodes: vec![episode],
                    source_ids,
                });
            }
        }
    }

    for group in &mut series {
        group.episodes.sort_by_key(|e| (e.season, e.episode));
        if let Some(first) = group.episodes.first() {
            group.channel.url = first.url.clone();
            group.channel.logo = first
                .logo
                .clone()
                .or_else(|| group.episodes.iter().find_map(|e| e.logo.clone()));
        }
    }

    GroupedChannels { plain, series }
}

/// File extension of a URL's last path segment, lower-cased, without query
/// string. Empty when the segment has no dot.
fn url_extension(url: &str) -> String {
    let path = url.split(['?', '#']).next().unwrap_or("");
    let last = path.rsplit('/').next().unwrap_or("");
    match last.rfind('.') {
        Some(i) if i + 1 < last.len() => last[i + 1..].to_lowercase(),
        _ => String::new(),
    }
}

/// Shape stored M3U episodes like the Xtream `get_series_info` response so
/// the same `SeriesView` renders both.
pub fn build_series_info(channel: &Channel, episodes: &[SeriesEpisode]) -> SeriesInfo {
    let mut by_season: BTreeMap<i32, Vec<Episode>> = BTreeMap::new();
    for ep in episodes {
        by_season.entry(ep.season).or_default().push(Episode {
            id: ep.id.to_string(),
            episode_num: ep.episode,
            title: ep.title.clone(),
            container_extension: url_extension(&ep.url),
            season: ep.season,
            info: EpisodeInfo {
                plot: None,
                movie_image: ep.logo.clone(),
                release_date: None,
                duration: None,
                rating: None,
            },
        });
    }

    let seasons = by_season
        .iter()
        .map(|(number, eps)| Season {
            id: number.to_string(),
            name: format!("Season {}", number),
            season_number: number.to_string(),
            episode_count: eps.len() as i32,
            air_date: None,
            overview: None,
            cover: None,
        })
        .collect();

    let episodes = by_season
        .into_iter()
        .map(|(number, eps)| (number.to_string(), eps))
        .collect();

    SeriesInfo {
        seasons,
        info: SeriesMetadata {
            name: channel.name.clone(),
            cover: channel.logo.clone(),
            plot: None,
            cast: None,
            director: None,
            genre: None,
            release_date: None,
            rating: None,
            backdrop_path: None,
        },
        episodes,
    }
}

/// Arrange fetched episode rows in the order the caller asked for.
///
/// # Errors
/// `InvalidInput` when `ids` is empty or names an id that is not in `rows`.
pub fn order_episodes_by_ids(
    rows: Vec<SeriesEpisode>,
    ids: &[i64],
) -> Result<Vec<SeriesEpisode>, AppError> {
    if ids.is_empty() {
        return Err(AppError::InvalidInput("No episodes provided".to_string()));
    }
    let mut by_id: HashMap<i64, SeriesEpisode> = rows.into_iter().map(|r| (r.id, r)).collect();
    ids.iter()
        .map(|id| {
            by_id
                .remove(id)
                .ok_or_else(|| AppError::InvalidInput(format!("Unknown episode id {}", id)))
        })
        .collect()
}

/// Episode data for playlist playback
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlaylistEpisode {
    pub id: String,
    pub title: String,
    pub extension: String,
}

/// Validate episode list
///
/// # Errors
/// Returns `AppError::InvalidInput` if the episode list is empty
pub fn validate_episodes(episodes: &[PlaylistEpisode]) -> Result<(), AppError> {
    if episodes.is_empty() {
        return Err(AppError::InvalidInput("No episodes provided".to_string()));
    }
    Ok(())
}

/// Build episode URLs from server info and episodes
///
/// Constructs streaming URLs for each episode using the Xtream Codes API format:
/// `{server_url}/series/{username}/{password}/{episode_id}.{extension}`
///
/// # Arguments
/// * `server_url` - Base server URL (trailing slashes are stripped)
/// * `username` - Xtream Codes username
/// * `password` - Xtream Codes password
/// * `episodes` - List of episodes to generate URLs for
///
/// # Returns
/// Vector of formatted URLs, one per episode in the same order
pub fn build_episode_urls(
    server_url: &str,
    username: &str,
    password: &str,
    episodes: &[PlaylistEpisode],
) -> Vec<String> {
    episodes
        .iter()
        .map(|episode| {
            format!(
                "{}/series/{}/{}/{}.{}",
                server_url.trim_end_matches('/'),
                username,
                password,
                episode.id,
                episode.extension
            )
        })
        .collect()
}

/// Validate server URL format
///
/// Ensures the server URL is properly formatted and not empty
///
/// # Errors
/// Returns `AppError::InvalidInput` if URL is empty or invalid
pub fn validate_server_url(url: &str) -> Result<(), AppError> {
    if url.trim().is_empty() {
        return Err(AppError::InvalidInput(
            "Server URL cannot be empty".to_string(),
        ));
    }

    // Basic URL validation - must start with http:// or https://
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err(AppError::InvalidInput(
            "Server URL must start with http:// or https://".to_string(),
        ));
    }

    Ok(())
}

/// Validate Xtream credentials
///
/// Ensures username and password are not empty
///
/// # Errors
/// Returns `AppError::InvalidInput` if username or password is empty
pub fn validate_credentials(username: &str, password: &str) -> Result<(), AppError> {
    if username.trim().is_empty() {
        return Err(AppError::InvalidInput(
            "Username cannot be empty".to_string(),
        ));
    }

    if password.trim().is_empty() {
        return Err(AppError::InvalidInput(
            "Password cannot be empty".to_string(),
        ));
    }

    Ok(())
}

/// Extract first episode title from episode list
///
/// Used for window title when playing a series
///
/// # Arguments
/// * `episodes` - List of episodes
///
/// # Returns
/// Title of the first episode, or a default message if list is empty
#[allow(dead_code)]
pub fn get_first_episode_title(episodes: &[PlaylistEpisode]) -> String {
    episodes
        .first()
        .map(|ep| ep.title.clone())
        .unwrap_or_else(|| "Unknown Episode".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_validate_episodes_empty() {
        let result = validate_episodes(&[]);
        assert!(result.is_err());
        match result {
            Err(AppError::InvalidInput(msg)) => {
                assert_eq!(msg, "No episodes provided");
            }
            _ => panic!("Expected InvalidInput error"),
        }
    }

    #[test]
    fn test_validate_episodes_valid() {
        let episodes = vec![PlaylistEpisode {
            id: "123".to_string(),
            title: "Episode 1".to_string(),
            extension: "mkv".to_string(),
        }];
        assert!(validate_episodes(&episodes).is_ok());
    }

    #[test]
    fn test_build_episode_urls() {
        let episodes = vec![
            PlaylistEpisode {
                id: "123".to_string(),
                title: "Episode 1".to_string(),
                extension: "mkv".to_string(),
            },
            PlaylistEpisode {
                id: "456".to_string(),
                title: "Episode 2".to_string(),
                extension: "mp4".to_string(),
            },
        ];

        let urls = build_episode_urls("http://example.com", "user", "pass", &episodes);

        assert_eq!(urls.len(), 2);
        assert_eq!(urls[0], "http://example.com/series/user/pass/123.mkv");
        assert_eq!(urls[1], "http://example.com/series/user/pass/456.mp4");
    }

    #[test]
    fn test_build_episode_urls_trailing_slash() {
        let episodes = vec![PlaylistEpisode {
            id: "123".to_string(),
            title: "Episode 1".to_string(),
            extension: "mkv".to_string(),
        }];

        let urls = build_episode_urls("http://example.com/", "user", "pass", &episodes);

        assert_eq!(urls.len(), 1);
        assert_eq!(urls[0], "http://example.com/series/user/pass/123.mkv");
    }

    #[test]
    fn test_validate_server_url_empty() {
        assert!(validate_server_url("").is_err());
        assert!(validate_server_url("   ").is_err());
    }

    #[test]
    fn test_validate_server_url_no_protocol() {
        let result = validate_server_url("example.com");
        assert!(result.is_err());
        match result {
            Err(AppError::InvalidInput(msg)) => {
                assert!(msg.contains("http://"));
            }
            _ => panic!("Expected InvalidInput error"),
        }
    }

    #[test]
    fn test_validate_server_url_valid() {
        assert!(validate_server_url("http://example.com").is_ok());
        assert!(validate_server_url("https://example.com").is_ok());
    }

    #[test]
    fn test_validate_credentials_empty_username() {
        let result = validate_credentials("", "pass");
        assert!(result.is_err());
        match result {
            Err(AppError::InvalidInput(msg)) => {
                assert!(msg.contains("Username"));
            }
            _ => panic!("Expected InvalidInput error"),
        }
    }

    #[test]
    fn test_validate_credentials_empty_password() {
        let result = validate_credentials("user", "");
        assert!(result.is_err());
        match result {
            Err(AppError::InvalidInput(msg)) => {
                assert!(msg.contains("Password"));
            }
            _ => panic!("Expected InvalidInput error"),
        }
    }

    #[test]
    fn test_validate_credentials_valid() {
        assert!(validate_credentials("user", "pass").is_ok());
    }

    #[test]
    fn test_get_first_episode_title() {
        let episodes = vec![
            PlaylistEpisode {
                id: "1".to_string(),
                title: "First Episode".to_string(),
                extension: "mkv".to_string(),
            },
            PlaylistEpisode {
                id: "2".to_string(),
                title: "Second Episode".to_string(),
                extension: "mkv".to_string(),
            },
        ];

        assert_eq!(get_first_episode_title(&episodes), "First Episode");
    }

    #[test]
    fn test_get_first_episode_title_empty() {
        assert_eq!(get_first_episode_title(&[]), "Unknown Episode");
    }

    // ========== parse_episode_name ==========

    fn parsed(name: &str) -> ParsedEpisode {
        parse_episode_name(name, None).unwrap_or_else(|| panic!("expected '{}' to parse", name))
    }

    #[test]
    fn parses_s01e02() {
        let p = parsed("Breaking Bad S01E02");
        assert_eq!(p.series_name, "Breaking Bad");
        assert_eq!((p.season, p.episode), (1, 2));
        assert_eq!(p.title, "Breaking Bad S01E02", "no text after the marker: title is the full name");
    }

    #[test]
    fn parses_s01_space_e02_with_title() {
        let p = parsed("Breaking Bad S01 E02 - Pilot");
        assert_eq!(p.series_name, "Breaking Bad");
        assert_eq!((p.season, p.episode), (1, 2));
        assert_eq!(p.title, "Pilot");
    }

    #[test]
    fn parses_lowercase_s1e2() {
        let p = parsed("breaking bad s1e2");
        assert_eq!(p.series_name, "breaking bad");
        assert_eq!((p.season, p.episode), (1, 2));
    }

    #[test]
    fn parses_1x02() {
        let p = parsed("Breaking Bad 1x02");
        assert_eq!(p.series_name, "Breaking Bad");
        assert_eq!((p.season, p.episode), (1, 2));
    }

    #[test]
    fn parses_dash_1x02_with_title() {
        let p = parsed("Breaking Bad - 1x02 Pilot");
        assert_eq!(p.series_name, "Breaking Bad");
        assert_eq!((p.season, p.episode), (1, 2));
        assert_eq!(p.title, "Pilot");
    }

    #[test]
    fn parses_season_word_episode_word() {
        let p = parsed("Breaking Bad Season 1 Episode 2");
        assert_eq!(p.series_name, "Breaking Bad");
        assert_eq!((p.season, p.episode), (1, 2));
    }

    #[test]
    fn parses_season_word_ep_dot() {
        let p = parsed("Breaking Bad Season 1 Ep. 2");
        assert_eq!(p.series_name, "Breaking Bad");
        assert_eq!((p.season, p.episode), (1, 2));
    }

    #[test]
    fn keeps_year_in_series_name() {
        assert_eq!(parsed("Breaking Bad (2008) S01E02").series_name, "Breaking Bad (2008)");
    }

    #[test]
    fn trims_colon_separator() {
        assert_eq!(parsed("Breaking Bad: S01E02").series_name, "Breaking Bad");
    }

    #[test]
    fn parses_dot_separated_name() {
        let p = parsed("Breaking Bad.S01E02.Pilot");
        assert_eq!(p.series_name, "Breaking Bad");
        assert_eq!(p.title, "Pilot");
    }

    #[test]
    fn keeps_quality_tag_in_title() {
        let p = parsed("Breaking Bad S01E02 [HD]");
        assert_eq!(p.series_name, "Breaking Bad");
        assert_eq!(p.title, "[HD]");
    }

    #[test]
    fn marker_inside_brackets() {
        let p = parsed("Show [S01E02]");
        assert_eq!(p.series_name, "Show");
        assert_eq!((p.season, p.episode), (1, 2));
    }

    #[test]
    fn marker_inside_parentheses() {
        let p = parsed("Show (1x02)");
        assert_eq!(p.series_name, "Show");
        assert_eq!((p.season, p.episode), (1, 2));
    }

    #[test]
    fn marker_followed_by_extension() {
        let p = parsed("Show S01E02.mkv");
        assert_eq!(p.series_name, "Show");
        assert_eq!((p.season, p.episode), (1, 2));
    }

    #[test]
    fn rejects_channel_names() {
        for name in [
            "Game Show Network",
            "Series 7 News",
            "Comedy Central",
            "Sport 1080x720",
            "CBS1E5",
            "Season Finale Special",
            "Episode",
            "Sky Sports 1",
            "10x Fitness",
        ] {
            assert!(parse_episode_name(name, None).is_none(), "'{}' must not parse", name);
        }
    }

    #[test]
    fn empty_series_name_falls_back_to_group() {
        let p = parse_episode_name("S01E02", Some("Breaking Bad")).unwrap();
        assert_eq!(p.series_name, "Breaking Bad");
        assert_eq!((p.season, p.episode), (1, 2));
    }

    #[test]
    fn empty_series_name_without_group_does_not_parse() {
        assert!(parse_episode_name("S01E02", None).is_none());
        assert!(parse_episode_name("S01E02", Some("  ")).is_none());
    }

    #[test]
    fn season_episode_marker_wins_over_nxn() {
        let p = parsed("Show 1x02 S03E04");
        assert_eq!((p.season, p.episode), (3, 4));
        assert_eq!(p.series_name, "Show 1x02");
    }

    // ========== group_series ==========

    fn row(id: Option<i64>, name: &str, group: &str, content_type: &str, sort: i32) -> Channel {
        Channel {
            id,
            playlist_id: 0,
            name: name.to_string(),
            url: format!("http://host/{}.mkv", name.replace(' ', "_")),
            logo: Some(format!("http://logo/{}.png", sort)),
            group_name: Some(group.to_string()),
            epg_id: None,
            tvg_name: None,
            content_type: content_type.to_string(),
            is_favorite: false,
            sort_order: sort,
            category_order: 0,
            created_at: None,
        }
    }

    #[test]
    fn groups_two_series_across_seasons() {
        let g = group_series(vec![
            row(None, "Breaking Bad S01E01", "Series", "series", 0),
            row(None, "Breaking Bad S01E02", "Series", "series", 1),
            row(None, "Breaking Bad S02E01", "Series", "series", 2),
            row(None, "Dark S01E01", "Series", "series", 3),
        ]);
        assert!(g.plain.is_empty());
        assert_eq!(g.series.len(), 2);
        assert_eq!(g.series[0].channel.name, "Breaking Bad");
        assert_eq!(g.series[0].episodes.len(), 3);
        assert_eq!(g.series[1].channel.name, "Dark");
        assert_eq!(g.series[1].episodes.len(), 1);
    }

    #[test]
    fn series_row_takes_first_episode_url_logo_and_lowest_sort_order() {
        // Listed out of order on purpose
        let g = group_series(vec![
            row(None, "Dark S02E01", "Series", "series", 7),
            row(None, "Dark S01E01", "Series", "series", 9),
        ]);
        let s = &g.series[0];
        assert_eq!(s.channel.url, "http://host/Dark_S01E01.mkv");
        assert_eq!(s.channel.logo.as_deref(), Some("http://logo/9.png"));
        assert_eq!(s.channel.sort_order, 7);
        assert_eq!(s.channel.content_type, "series");
        assert_eq!(s.channel.group_name.as_deref(), Some("Series"));
        assert!(s.channel.epg_id.is_none());
        assert_eq!(
            s.episodes.iter().map(|e| (e.season, e.episode)).collect::<Vec<_>>(),
            vec![(1, 1), (2, 1)]
        );
    }

    #[test]
    fn unparsable_series_rows_become_live() {
        let g = group_series(vec![
            row(None, "Game Show Network", "Series", "series", 0),
            row(None, "Comedy Central", "Series", "series", 1),
        ]);
        assert!(g.series.is_empty());
        assert_eq!(g.plain.len(), 2);
        assert!(g.plain.iter().all(|c| c.content_type == "live"));
    }

    #[test]
    fn non_series_rows_pass_through_untouched() {
        let g = group_series(vec![
            row(None, "SVT1", "News", "live", 0),
            row(None, "Inception S01E01", "Movies", "vod", 1),
        ]);
        assert!(g.series.is_empty());
        assert_eq!(g.plain.len(), 2);
        assert_eq!(g.plain[0].content_type, "live");
        assert_eq!(g.plain[1].content_type, "vod");
        assert_eq!(g.plain[1].name, "Inception S01E01");
    }

    #[test]
    fn duplicate_episode_keeps_first_occurrence() {
        let g = group_series(vec![
            row(None, "Dark S01E01 [HD]", "Series", "series", 0),
            row(None, "Dark S01E01 [SD]", "Series", "series", 1),
        ]);
        assert_eq!(g.series[0].episodes.len(), 1);
        assert_eq!(g.series[0].episodes[0].url, "http://host/Dark_S01E01_[HD].mkv");
    }

    #[test]
    fn grouping_key_is_case_insensitive_and_per_group() {
        let g = group_series(vec![
            row(None, "dark S01E01", "Series", "series", 0),
            row(None, "Dark S01E02", "Series", "series", 1),
            row(None, "Dark S01E01", "Series DE", "series", 2),
        ]);
        assert_eq!(g.series.len(), 2, "same group merges, different group splits");
        assert_eq!(g.series[0].episodes.len(), 2);
        assert_eq!(g.series[0].channel.name, "dark", "first spelling wins");
    }

    #[test]
    fn keeps_source_ids_and_favourite_flag() {
        let mut fav = row(Some(11), "Dark S01E02", "Series", "series", 1);
        fav.is_favorite = true;
        let g = group_series(vec![row(Some(10), "Dark S01E01", "Series", "series", 0), fav]);
        assert_eq!(g.series[0].source_ids, vec![10, 11]);
        assert!(g.series[0].channel.is_favorite);
        assert!(g.series[0].channel.id.is_none(), "the series row is new");
    }

    #[test]
    fn plain_rows_keep_their_ids() {
        let g = group_series(vec![row(Some(5), "Comedy Central", "Series", "series", 0)]);
        assert_eq!(g.plain[0].id, Some(5));
    }

    // ========== build_series_info ==========

    fn stored(id: i64, season: i32, episode: i32, url: &str) -> SeriesEpisode {
        SeriesEpisode {
            id,
            series_channel_id: 1,
            season,
            episode,
            title: format!("Ep {}", id),
            url: url.to_string(),
            logo: Some(format!("http://logo/{}.png", id)),
        }
    }

    #[test]
    fn build_series_info_maps_rows_to_seasons_and_episodes() {
        let mut channel = row(Some(1), "Dark", "Series", "series", 0);
        channel.logo = Some("http://logo/cover.png".to_string());
        let rows = vec![
            stored(10, 1, 1, "http://host/a.mkv"),
            stored(11, 1, 2, "http://host/b.MP4?token=x"),
            stored(12, 2, 1, "http://host/c"),
        ];

        let info = build_series_info(&channel, &rows);

        assert_eq!(info.info.name, "Dark");
        assert_eq!(info.info.cover.as_deref(), Some("http://logo/cover.png"));
        assert!(info.info.plot.is_none());

        assert_eq!(info.seasons.len(), 2);
        assert_eq!(info.seasons[0].season_number, "1");
        assert_eq!(info.seasons[0].name, "Season 1");
        assert_eq!(info.seasons[0].episode_count, 2);
        assert_eq!(info.seasons[1].id, "2");

        let s1 = &info.episodes["1"];
        assert_eq!(s1.len(), 2);
        assert_eq!(s1[0].id, "10");
        assert_eq!(s1[0].episode_num, 1);
        assert_eq!(s1[0].season, 1);
        assert_eq!(s1[0].container_extension, "mkv");
        assert_eq!(s1[0].info.movie_image.as_deref(), Some("http://logo/10.png"));
        assert_eq!(s1[1].container_extension, "mp4", "lower-cased, query string dropped");

        let s2 = &info.episodes["2"];
        assert_eq!(s2[0].container_extension, "", "no extension in URL");
    }

    #[test]
    fn build_series_info_with_no_episodes_has_no_seasons() {
        let channel = row(Some(1), "Dark", "Series", "series", 0);
        let info = build_series_info(&channel, &[]);
        assert!(info.seasons.is_empty());
        assert!(info.episodes.is_empty());
    }

    // ========== order_episodes_by_ids ==========

    #[test]
    fn order_episodes_by_ids_follows_requested_order() {
        let rows = vec![stored(1, 1, 1, "a"), stored(2, 1, 2, "b"), stored(3, 1, 3, "c")];
        let ordered = order_episodes_by_ids(rows, &[3, 1]).unwrap();
        assert_eq!(ordered.iter().map(|e| e.id).collect::<Vec<_>>(), vec![3, 1]);
    }

    #[test]
    fn order_episodes_by_ids_rejects_empty() {
        assert!(matches!(order_episodes_by_ids(vec![], &[]), Err(AppError::InvalidInput(_))));
    }

    #[test]
    fn order_episodes_by_ids_rejects_unknown_id() {
        let rows = vec![stored(1, 1, 1, "a")];
        let err = order_episodes_by_ids(rows, &[1, 42]).unwrap_err();
        match err {
            AppError::InvalidInput(msg) => assert!(msg.contains("42"), "{}", msg),
            other => panic!("expected InvalidInput, got {:?}", other),
        }
    }
}
