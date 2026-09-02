use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Playlist {
    pub id: Option<i64>,
    pub name: String,
    pub url: Option<String>,
    pub file_path: Option<String>,
    pub last_updated: Option<String>,
    pub auto_refresh: bool,
    pub xtream_username: Option<String>,
    pub xtream_password: Option<String>,
    pub created_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Channel {
    pub id: Option<i64>,
    pub playlist_id: i64,
    pub name: String,
    pub url: String,
    pub logo: Option<String>,
    pub group_name: Option<String>,
    pub epg_id: Option<String>,
    pub tvg_name: Option<String>,
    pub content_type: String, // "live", "vod", "series"
    pub is_favorite: bool,
    pub sort_order: i32,
    pub category_order: i32, // Order from provider's category list
    pub created_at: Option<String>,
}

/// Result of a merge-based playlist refresh
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MergeResult {
    pub added: usize,
    pub updated: usize,
    pub removed: usize,
    pub total: usize,
}

/// One episode of an M3U series, stored in `series_episodes`.
/// Xtream series fetch their episodes from the provider API instead.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SeriesEpisode {
    pub id: i64,
    pub series_channel_id: i64,
    pub season: i32,
    pub episode: i32,
    pub title: String,
    pub url: String,
    pub logo: Option<String>,
}
