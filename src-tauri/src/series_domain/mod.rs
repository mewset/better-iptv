//! Series domain business logic
//!
//! This module contains pure business logic for series/VOD operations.
//! Functions here are synchronous and do NOT include database operations.
//! Database operations remain in the commands layer.

use crate::error::AppError;
use serde::{Deserialize, Serialize};
use lazy_static::lazy_static;
use regex::Regex;

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
}
