//! Channel domain - Business logic for channel operations
//!
//! This module contains pure business logic functions for channel-related operations.
//! Functions here are synchronous and do NOT perform database operations.

use crate::db::models::Channel;
use crate::error::AppError;

/// Valid content types for channels
const VALID_CONTENT_TYPES: &[&str] = &["live", "vod", "series"];

/// Maximum allowed search query length
const MAX_SEARCH_QUERY_LENGTH: usize = 100;

/// Minimum allowed search query length
const MIN_SEARCH_QUERY_LENGTH: usize = 1;

// ========== Validation Functions ==========

/// Validate search query
///
/// Ensures the search query is not empty, not too long, and contains valid characters.
///
/// # Arguments
/// * `query` - The search query string
///
/// # Errors
/// Returns `AppError::InvalidInput` if:
/// - Query is empty or only whitespace
/// - Query exceeds maximum length
///
/// # Examples
/// ```ignore
/// use better_ip_tv::channel_domain::validate_search_query;
///
/// assert!(validate_search_query("BBC").is_ok());
/// assert!(validate_search_query("").is_err());
/// ```ignore
pub fn validate_search_query(query: &str) -> Result<(), AppError> {
    let trimmed = query.trim();

    if trimmed.is_empty() {
        return Err(AppError::InvalidInput(
            "Search query cannot be empty".to_string(),
        ));
    }

    if trimmed.len() < MIN_SEARCH_QUERY_LENGTH {
        return Err(AppError::InvalidInput(format!(
            "Search query must be at least {} character(s)",
            MIN_SEARCH_QUERY_LENGTH
        )));
    }

    if query.len() > MAX_SEARCH_QUERY_LENGTH {
        return Err(AppError::InvalidInput(format!(
            "Search query too long (max {} characters)",
            MAX_SEARCH_QUERY_LENGTH
        )));
    }

    Ok(())
}

/// Validate content type
///
/// Ensures the content type is one of the valid types: "live", "vod", or "series".
///
/// # Arguments
/// * `content_type` - The content type to validate
///
/// # Errors
/// Returns `AppError::InvalidInput` if content type is not valid
///
/// # Examples
/// ```ignore
/// use better_ip_tv::channel_domain::validate_content_type;
///
/// assert!(validate_content_type("live").is_ok());
/// assert!(validate_content_type("invalid").is_err());
/// ```ignore
pub fn validate_content_type(content_type: &str) -> Result<(), AppError> {
    if !VALID_CONTENT_TYPES.contains(&content_type) {
        return Err(AppError::InvalidInput(format!(
            "Invalid content type '{}'. Must be one of: {}",
            content_type,
            VALID_CONTENT_TYPES.join(", ")
        )));
    }
    Ok(())
}

/// Validate channel ID
///
/// Ensures the channel ID is positive.
///
/// # Arguments
/// * `channel_id` - The channel ID to validate
///
/// # Errors
/// Returns `AppError::InvalidInput` if channel ID is not positive
pub fn validate_channel_id(channel_id: i64) -> Result<(), AppError> {
    if channel_id <= 0 {
        return Err(AppError::InvalidInput(
            "Channel ID must be positive".to_string(),
        ));
    }
    Ok(())
}

/// Validate playlist ID
///
/// Ensures the playlist ID is positive.
///
/// # Arguments
/// * `playlist_id` - The playlist ID to validate
///
/// # Errors
/// Returns `AppError::InvalidInput` if playlist ID is not positive
pub fn validate_playlist_id(playlist_id: i64) -> Result<(), AppError> {
    if playlist_id <= 0 {
        return Err(AppError::InvalidInput(
            "Playlist ID must be positive".to_string(),
        ));
    }
    Ok(())
}

// ========== Filtering Functions ==========

/// Filter channels by content type
///
/// Returns only channels matching the specified content type.
///
/// # Arguments
/// * `channels` - Vector of channels to filter
/// * `content_type` - Content type to filter by ("live", "vod", or "series")
///
/// # Examples
/// ```ignore
/// use better_ip_tv::channel_domain::filter_by_content_type;
/// use better_ip_tv::db::models::Channel;
///
/// let channels = vec![
///     Channel { content_type: "live".to_string(), ..Default::default() },
///     Channel { content_type: "vod".to_string(), ..Default::default() },
/// ];
///
/// let live_channels = filter_by_content_type(channels, "live");
/// assert_eq!(live_channels.len(), 1);
/// ```ignore
#[allow(dead_code)]
pub fn filter_by_content_type(channels: Vec<Channel>, content_type: &str) -> Vec<Channel> {
    channels
        .into_iter()
        .filter(|c| c.content_type == content_type)
        .collect()
}

/// Filter channels by group name
///
/// Returns only channels matching the specified group name.
///
/// # Arguments
/// * `channels` - Vector of channels to filter
/// * `group_name` - Group name to filter by
#[allow(dead_code)]
pub fn filter_by_group(channels: Vec<Channel>, group_name: &str) -> Vec<Channel> {
    channels
        .into_iter()
        .filter(|c| c.group_name.as_deref() == Some(group_name))
        .collect()
}

/// Filter channels by favorite status
///
/// Returns only channels marked as favorites.
///
/// # Arguments
/// * `channels` - Vector of channels to filter
#[allow(dead_code)]
pub fn filter_favorites(channels: Vec<Channel>) -> Vec<Channel> {
    channels
        .into_iter()
        .filter(|c| c.is_favorite)
        .collect()
}

/// Filter channels by playlist ID
///
/// Returns only channels belonging to the specified playlist.
///
/// # Arguments
/// * `channels` - Vector of channels to filter
/// * `playlist_id` - Playlist ID to filter by
#[allow(dead_code)]
pub fn filter_by_playlist(channels: Vec<Channel>, playlist_id: i64) -> Vec<Channel> {
    channels
        .into_iter()
        .filter(|c| c.playlist_id == playlist_id)
        .collect()
}

// ========== Transformation Functions ==========

/// Sort channels by name (case-insensitive)
///
/// Sorts channels alphabetically by name, ignoring case.
///
/// # Arguments
/// * `channels` - Vector of channels to sort (consumed and returned sorted)
#[allow(dead_code)]
pub fn sort_by_name(mut channels: Vec<Channel>) -> Vec<Channel> {
    channels.sort_by_key(|c| c.name.to_lowercase());
    channels
}

/// Sort channels by sort order
///
/// Sorts channels by their `sort_order` field (ascending).
///
/// # Arguments
/// * `channels` - Vector of channels to sort (consumed and returned sorted)
#[allow(dead_code)]
pub fn sort_by_order(mut channels: Vec<Channel>) -> Vec<Channel> {
    channels.sort_by_key(|c| c.sort_order);
    channels
}

/// Sort channels by category order
///
/// Sorts channels by their `category_order` field (ascending).
///
/// # Arguments
/// * `channels` - Vector of channels to sort (consumed and returned sorted)
#[allow(dead_code)]
pub fn sort_by_category_order(mut channels: Vec<Channel>) -> Vec<Channel> {
    channels.sort_by_key(|c| c.category_order);
    channels
}

// ========== Query Helpers ==========

/// Normalize search query for case-insensitive matching
///
/// Trims whitespace and converts to lowercase.
///
/// # Arguments
/// * `query` - The search query to normalize
#[allow(dead_code)]
pub fn normalize_search_query(query: &str) -> String {
    query.trim().to_lowercase()
}

/// Check if channel matches search query
///
/// Performs case-insensitive matching against channel name and group name.
///
/// # Arguments
/// * `channel` - The channel to check
/// * `query` - The normalized search query (lowercase)
#[allow(dead_code)]
pub fn matches_search_query(channel: &Channel, query: &str) -> bool {
    let name_matches = channel.name.to_lowercase().contains(query);
    let group_matches = channel
        .group_name
        .as_ref()
        .map(|g| g.to_lowercase().contains(query))
        .unwrap_or(false);

    name_matches || group_matches
}

/// Extract unique group names from channels
///
/// Returns a sorted list of unique group names (excluding None values).
///
/// # Arguments
/// * `channels` - Vector of channels to extract groups from
#[allow(dead_code)]
pub fn extract_unique_groups(channels: &[Channel]) -> Vec<String> {
    let mut groups: Vec<String> = channels
        .iter()
        .filter_map(|c| c.group_name.clone())
        .collect();

    groups.sort();
    groups.dedup();
    groups
}

// ========== Channel State Helpers ==========

/// Toggle favorite status of a channel
///
/// Returns the new favorite state (opposite of current).
///
/// # Arguments
/// * `current_favorite` - Current favorite status
#[allow(dead_code)]
pub fn toggle_favorite_state(current_favorite: bool) -> bool {
    !current_favorite
}

/// Check if channel has EPG data
///
/// Returns true if channel has an EPG ID configured.
///
/// # Arguments
/// * `channel` - The channel to check
#[allow(dead_code)]
pub fn has_epg_data(channel: &Channel) -> bool {
    channel.epg_id.is_some() || channel.tvg_name.is_some()
}

/// Get EPG identifier for channel
///
/// Returns the EPG ID, falling back to TVG name if EPG ID is not set.
///
/// # Arguments
/// * `channel` - The channel to get EPG identifier for
#[allow(dead_code)]
pub fn get_epg_identifier(channel: &Channel) -> Option<&str> {
    channel
        .epg_id
        .as_deref()
        .or(channel.tvg_name.as_deref())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mock_channel(name: &str, content_type: &str, is_favorite: bool) -> Channel {
        Channel {
            id: Some(1),
            playlist_id: 1,
            name: name.to_string(),
            url: "http://example.com".to_string(),
            logo: None,
            group_name: None,
            epg_id: None,
            tvg_name: None,
            content_type: content_type.to_string(),
            is_favorite,
            sort_order: 0,
            category_order: 0,
            created_at: None,
        }
    }

    #[test]
    fn test_validate_search_query() {
        assert!(validate_search_query("BBC").is_ok());
        assert!(validate_search_query("  valid  ").is_ok());
        assert!(validate_search_query("").is_err());
        assert!(validate_search_query("   ").is_err());
        assert!(validate_search_query(&"a".repeat(101)).is_err());
    }

    #[test]
    fn test_validate_content_type() {
        assert!(validate_content_type("live").is_ok());
        assert!(validate_content_type("vod").is_ok());
        assert!(validate_content_type("series").is_ok());
        assert!(validate_content_type("invalid").is_err());
        assert!(validate_content_type("LIVE").is_err());
    }

    #[test]
    fn test_validate_channel_id() {
        assert!(validate_channel_id(1).is_ok());
        assert!(validate_channel_id(999).is_ok());
        assert!(validate_channel_id(0).is_err());
        assert!(validate_channel_id(-1).is_err());
    }

    #[test]
    fn test_filter_by_content_type() {
        let channels = vec![
            mock_channel("Live 1", "live", false),
            mock_channel("Movie 1", "vod", false),
            mock_channel("Live 2", "live", false),
        ];

        let live_channels = filter_by_content_type(channels, "live");
        assert_eq!(live_channels.len(), 2);
        assert!(live_channels.iter().all(|c| c.content_type == "live"));
    }

    #[test]
    fn test_filter_favorites() {
        let channels = vec![
            mock_channel("Chan 1", "live", true),
            mock_channel("Chan 2", "live", false),
            mock_channel("Chan 3", "live", true),
        ];

        let favorites = filter_favorites(channels);
        assert_eq!(favorites.len(), 2);
        assert!(favorites.iter().all(|c| c.is_favorite));
    }

    #[test]
    fn test_normalize_search_query() {
        assert_eq!(normalize_search_query("  BBC  "), "bbc");
        assert_eq!(normalize_search_query("Test"), "test");
    }

    #[test]
    fn test_matches_search_query() {
        let channel = mock_channel("BBC News", "live", false);
        assert!(matches_search_query(&channel, "bbc"));
        assert!(matches_search_query(&channel, "news"));
        assert!(!matches_search_query(&channel, "cnn"));
    }

    #[test]
    fn test_toggle_favorite_state() {
        assert!(!toggle_favorite_state(true));
        assert!(toggle_favorite_state(false));
    }

    #[test]
    fn test_has_epg_data() {
        let mut channel = mock_channel("Test", "live", false);
        assert!(!has_epg_data(&channel));

        channel.epg_id = Some("epg123".to_string());
        assert!(has_epg_data(&channel));
    }

    #[test]
    fn test_get_epg_identifier() {
        let mut channel = mock_channel("Test", "live", false);
        assert_eq!(get_epg_identifier(&channel), None);

        channel.tvg_name = Some("tvg123".to_string());
        assert_eq!(get_epg_identifier(&channel), Some("tvg123"));

        channel.epg_id = Some("epg123".to_string());
        assert_eq!(get_epg_identifier(&channel), Some("epg123"));
    }

    #[test]
    fn test_sort_by_name() {
        let channels = vec![
            mock_channel("Zebra", "live", false),
            mock_channel("Apple", "live", false),
            mock_channel("banana", "live", false),
        ];

        let sorted = sort_by_name(channels);
        assert_eq!(sorted[0].name, "Apple");
        assert_eq!(sorted[1].name, "banana");
        assert_eq!(sorted[2].name, "Zebra");
    }

    #[test]
    fn test_extract_unique_groups() {
        let channels = vec![
            Channel {
                group_name: Some("News".to_string()),
                ..mock_channel("Ch1", "live", false)
            },
            Channel {
                group_name: Some("Sports".to_string()),
                ..mock_channel("Ch2", "live", false)
            },
            Channel {
                group_name: Some("News".to_string()),
                ..mock_channel("Ch3", "live", false)
            },
            Channel {
                group_name: None,
                ..mock_channel("Ch4", "live", false)
            },
        ];

        let groups = extract_unique_groups(&channels);
        assert_eq!(groups.len(), 2);
        assert_eq!(groups[0], "News");
        assert_eq!(groups[1], "Sports");
    }
}
