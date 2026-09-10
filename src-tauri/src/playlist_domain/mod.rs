//! Playlist business logic domain module
//!
//! This module contains business logic for playlist operations, separated from
//! database operations and Tauri command handlers. Functions here focus on:
//! - Input validation
//! - Data transformation
//! - Business rule enforcement
//! - Type construction
//!
//! Database operations remain in the commands layer or db module.

use crate::db::models::{Channel, Playlist};
use crate::error::AppError;
use crate::playlist::XtreamCredentials;

// ========== Validation Functions ==========

/// Validate playlist name
///
/// # Rules
/// - Cannot be empty or whitespace-only
///
/// # Errors
/// Returns `AppError::InvalidInput` if validation fails
pub fn validate_playlist_name(name: &str) -> Result<(), AppError> {
    if name.trim().is_empty() {
        return Err(AppError::InvalidInput(
            "Playlist name cannot be empty".to_string(),
        ));
    }
    Ok(())
}

/// Validate playlist source (URL or file path)
///
/// # Rules
/// - Cannot be empty or whitespace-only
///
/// # Errors
/// Returns `AppError::InvalidInput` if validation fails
pub fn validate_playlist_source(source: &str) -> Result<(), AppError> {
    if source.trim().is_empty() {
        return Err(AppError::InvalidInput(
            "Playlist source cannot be empty".to_string(),
        ));
    }
    Ok(())
}

/// Reject a refresh that produced no channels.
///
/// A provider answering with an HTML error page under HTTP 200, an expired
/// subscription, or a truncated response all parse to an empty channel list.
/// `merge_channels` would then find every stored row unmatched and delete the
/// playlist's entire contents, favourites included, while reporting success.
///
/// A provider that has genuinely removed every channel is not a case worth
/// supporting: the user can delete the playlist themselves.
///
/// # Errors
/// Returns `AppError::EmptyRefresh` when `channel_count` is zero.
pub fn validate_refresh_not_empty(channel_count: usize) -> Result<(), AppError> {
    if channel_count == 0 {
        return Err(AppError::EmptyRefresh(
            "The provider returned no channels, so the playlist was kept unchanged. \
             Check the playlist URL or your subscription and try again."
                .to_string(),
        ));
    }
    Ok(())
}

/// Validate Xtream credentials
///
/// # Rules
/// - Server URL cannot be empty
/// - Username cannot be empty
/// - Password can be empty (some providers allow it)
///
/// # Errors
/// Returns `AppError::InvalidInput` if validation fails
pub fn validate_xtream_credentials(server_url: &str, username: &str) -> Result<(), AppError> {
    if server_url.trim().is_empty() {
        return Err(AppError::InvalidInput(
            "Server URL cannot be empty".to_string(),
        ));
    }
    if username.trim().is_empty() {
        return Err(AppError::InvalidInput(
            "Username cannot be empty".to_string(),
        ));
    }
    Ok(())
}

// ========== Playlist Construction Functions ==========

/// Build playlist struct from M3U source (URL or file path)
///
/// Determines whether the source is a URL or file path and constructs
/// the appropriate Playlist struct.
///
/// # Arguments
/// * `name` - Playlist name (will be validated)
/// * `source` - URL or file path (will be validated)
///
/// # Errors
/// Returns `AppError::InvalidInput` if validation fails
pub fn build_m3u_playlist(name: String, source: String) -> Result<Playlist, AppError> {
    validate_playlist_name(&name)?;
    validate_playlist_source(&source)?;

    let (url, file_path) = if source.starts_with("http://") || source.starts_with("https://") {
        (Some(source), None)
    } else {
        (None, Some(source))
    };

    Ok(Playlist {
        id: None,
        name,
        url,
        file_path,
        last_updated: None,
        auto_refresh: false,
        xtream_username: None,
        xtream_password: None,
        created_at: None,
    })
}

/// Build playlist struct from Xtream Codes credentials
///
/// # Arguments
/// * `name` - Playlist name (will be validated)
/// * `server_url` - Xtream server URL (will be validated)
/// * `username` - Xtream username (will be validated)
/// * `password` - Xtream password
///
/// # Errors
/// Returns `AppError::InvalidInput` if validation fails
pub fn build_xtream_playlist(
    name: String,
    server_url: String,
    username: String,
    password: String,
) -> Result<Playlist, AppError> {
    validate_playlist_name(&name)?;
    validate_xtream_credentials(&server_url, &username)?;

    Ok(Playlist {
        id: None,
        name,
        url: Some(server_url),
        file_path: None,
        last_updated: None,
        auto_refresh: false,
        xtream_username: Some(username),
        xtream_password: Some(password),
        created_at: None,
    })
}

/// Build XtreamCredentials from playlist
///
/// Extracts Xtream credentials from a playlist struct.
///
/// # Arguments
/// * `playlist` - Playlist with Xtream credentials
///
/// # Errors
/// Returns `AppError::InvalidInput` if playlist doesn't have Xtream credentials
#[allow(dead_code)]
pub fn extract_xtream_credentials(playlist: &Playlist) -> Result<XtreamCredentials, AppError> {
    let server_url = playlist
        .url
        .as_ref()
        .ok_or_else(|| AppError::InvalidInput("Playlist has no URL".to_string()))?
        .clone();

    let username = playlist
        .xtream_username
        .as_ref()
        .ok_or_else(|| AppError::InvalidInput("Playlist has no Xtream username".to_string()))?
        .clone();

    let password = playlist
        .xtream_password
        .as_ref()
        .unwrap_or(&String::new())
        .clone();

    Ok(XtreamCredentials {
        server_url,
        username,
        password,
    })
}

// ========== Channel Processing Functions ==========

/// Assign playlist ID to channels
///
/// Takes a list of channels and assigns the given playlist_id to all of them.
/// This is used after creating a playlist to associate channels with it.
///
/// # Arguments
/// * `channels` - Channels to assign playlist_id to
/// * `playlist_id` - The playlist ID to assign
///
/// # Returns
/// New vector of channels with playlist_id set
pub fn assign_playlist_id_to_channels(channels: Vec<Channel>, playlist_id: i64) -> Vec<Channel> {
    channels
        .into_iter()
        .map(|mut c| {
            c.playlist_id = playlist_id;
            c
        })
        .collect()
}

/// Split channels into batches for efficient database insertion
///
/// # Arguments
/// * `channels` - Channels to split
/// * `batch_size` - Size of each batch
///
/// # Returns
/// Vector of channel batches
pub fn batch_channels(channels: Vec<Channel>, batch_size: usize) -> Vec<Vec<Channel>> {
    channels
        .chunks(batch_size)
        .map(|chunk| chunk.to_vec())
        .collect()
}

// ========== Constants ==========

/// Default batch size for channel insertion (1000 channels per transaction)
pub const DEFAULT_BATCH_SIZE: usize = 1000;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refresh_with_channels_is_accepted() {
        assert!(validate_refresh_not_empty(1).is_ok());
        assert!(validate_refresh_not_empty(12_089).is_ok());
    }

    #[test]
    fn refresh_that_produced_nothing_is_refused() {
        // A provider answering with an HTML error page under HTTP 200 parses
        // to zero channels. Letting that through would make every stored row
        // stale and empty the playlist.
        let err = validate_refresh_not_empty(0).unwrap_err();
        assert!(
            matches!(err, AppError::EmptyRefresh(_)),
            "unexpected error: {err:?}"
        );
    }

    #[test]
    fn the_refusal_explains_that_channels_were_kept() {
        // The message reaches the user through the refresh dialog, so it has
        // to say the playlist is intact rather than just that something failed.
        let message = validate_refresh_not_empty(0).unwrap_err().to_string();
        assert!(
            message.contains("kept") || message.contains("unchanged"),
            "message does not reassure the user: {message}"
        );
    }

    #[test]
    fn test_validate_playlist_name_valid() {
        assert!(validate_playlist_name("My Playlist").is_ok());
    }

    #[test]
    fn test_validate_playlist_name_empty() {
        assert!(validate_playlist_name("").is_err());
        assert!(validate_playlist_name("   ").is_err());
    }

    #[test]
    fn test_validate_playlist_source_valid() {
        assert!(validate_playlist_source("http://example.com/playlist.m3u").is_ok());
        assert!(validate_playlist_source("/path/to/playlist.m3u").is_ok());
    }

    #[test]
    fn test_validate_playlist_source_empty() {
        assert!(validate_playlist_source("").is_err());
    }

    #[test]
    fn test_validate_xtream_credentials_valid() {
        assert!(validate_xtream_credentials("http://example.com", "user").is_ok());
    }

    #[test]
    fn test_validate_xtream_credentials_empty_url() {
        assert!(validate_xtream_credentials("", "user").is_err());
    }

    #[test]
    fn test_validate_xtream_credentials_empty_username() {
        assert!(validate_xtream_credentials("http://example.com", "").is_err());
    }

    #[test]
    fn test_build_m3u_playlist_url() {
        let result = build_m3u_playlist(
            "Test Playlist".to_string(),
            "http://example.com/playlist.m3u".to_string(),
        );
        assert!(result.is_ok());

        let playlist = result.unwrap();
        assert_eq!(playlist.name, "Test Playlist");
        assert_eq!(
            playlist.url,
            Some("http://example.com/playlist.m3u".to_string())
        );
        assert_eq!(playlist.file_path, None);
    }

    #[test]
    fn test_build_m3u_playlist_file() {
        let result = build_m3u_playlist(
            "Test Playlist".to_string(),
            "/path/to/playlist.m3u".to_string(),
        );
        assert!(result.is_ok());

        let playlist = result.unwrap();
        assert_eq!(playlist.name, "Test Playlist");
        assert_eq!(playlist.url, None);
        assert_eq!(
            playlist.file_path,
            Some("/path/to/playlist.m3u".to_string())
        );
    }

    #[test]
    fn test_build_xtream_playlist() {
        let result = build_xtream_playlist(
            "Xtream Playlist".to_string(),
            "http://xtream.example.com".to_string(),
            "user123".to_string(),
            "pass456".to_string(),
        );
        assert!(result.is_ok());

        let playlist = result.unwrap();
        assert_eq!(playlist.name, "Xtream Playlist");
        assert_eq!(playlist.url, Some("http://xtream.example.com".to_string()));
        assert_eq!(playlist.xtream_username, Some("user123".to_string()));
        assert_eq!(playlist.xtream_password, Some("pass456".to_string()));
    }

    #[test]
    fn test_extract_xtream_credentials() {
        let playlist = Playlist {
            id: Some(1),
            name: "Test".to_string(),
            url: Some("http://example.com".to_string()),
            file_path: None,
            last_updated: None,
            auto_refresh: false,
            xtream_username: Some("user".to_string()),
            xtream_password: Some("pass".to_string()),
            created_at: None,
        };

        let result = extract_xtream_credentials(&playlist);
        assert!(result.is_ok());

        let creds = result.unwrap();
        assert_eq!(creds.server_url, "http://example.com");
        assert_eq!(creds.username, "user");
        assert_eq!(creds.password, "pass");
    }

    #[test]
    fn test_assign_playlist_id_to_channels() {
        let channels = vec![
            Channel {
                id: None,
                playlist_id: 0,
                name: "Channel 1".to_string(),
                url: "http://example.com/1".to_string(),
                logo: None,
                group_name: None,
                epg_id: None,
                tvg_name: None,
                content_type: "live".to_string(),
                is_favorite: false,
                sort_order: 0,
                category_order: 0,
                created_at: None,
            },
            Channel {
                id: None,
                playlist_id: 0,
                name: "Channel 2".to_string(),
                url: "http://example.com/2".to_string(),
                logo: None,
                group_name: None,
                epg_id: None,
                tvg_name: None,
                content_type: "live".to_string(),
                is_favorite: false,
                sort_order: 0,
                category_order: 0,
                created_at: None,
            },
        ];

        let result = assign_playlist_id_to_channels(channels, 42);
        assert_eq!(result.len(), 2);
        assert_eq!(result[0].playlist_id, 42);
        assert_eq!(result[1].playlist_id, 42);
    }

    #[test]
    fn test_batch_channels() {
        let channels: Vec<Channel> = (0..2500)
            .map(|i| Channel {
                id: None,
                playlist_id: 1,
                name: format!("Channel {}", i),
                url: format!("http://example.com/{}", i),
                logo: None,
                group_name: None,
                epg_id: None,
                tvg_name: None,
                content_type: "live".to_string(),
                is_favorite: false,
                sort_order: i,
                category_order: 0,
                created_at: None,
            })
            .collect();

        let batches = batch_channels(channels, 1000);
        assert_eq!(batches.len(), 3);
        assert_eq!(batches[0].len(), 1000);
        assert_eq!(batches[1].len(), 1000);
        assert_eq!(batches[2].len(), 500);
    }
}
