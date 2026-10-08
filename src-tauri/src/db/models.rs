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

/// What the database remembers about a playlist's Xtream subscription
///
/// `expires_at` is RFC 3339, or `None` for an account with no expiry date or
/// one never successfully read. `checked_at` is when the provider was last
/// asked, which is what keeps a profile from asking on every visit.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct XtreamExpiryCache {
    pub expires_at: Option<String>,
    pub checked_at: Option<String>,
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

/// A channel as the frontend lists it: what cards, filters and the hero
/// read, nothing more. The stream URL stays in the backend (for Xtream it
/// carries the account's username and password; play goes by id), and
/// absent optional fields are left out of the JSON. On a 26,049-channel
/// playlist this is about 44 % less than serializing `Channel`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ChannelSummary {
    pub id: i64,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub logo: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub epg_id: Option<String>,
    pub content_type: String,
    pub is_favorite: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
}

impl From<Channel> for ChannelSummary {
    fn from(c: Channel) -> Self {
        Self {
            // Every row read from the database has its id.
            id: c.id.unwrap_or_default(),
            name: c.name,
            logo: c.logo,
            group_name: c.group_name,
            epg_id: c.epg_id,
            content_type: c.content_type,
            is_favorite: c.is_favorite,
            created_at: c.created_at,
        }
    }
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

/// Cache key of a TMDB row: normalised, lower-cased title; 0 for an unknown year.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct TmdbKey {
    pub title: String,
    pub year: i32,
    pub content_type: String,
}

/// One `tmdb_metadata` row. `tmdb_id == None` means "searched, no match".
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TmdbRow {
    pub key: TmdbKey,
    pub tmdb_id: Option<i64>,
    pub manual: bool,
    pub title: Option<String>,
    pub original_title: Option<String>,
    pub release_year: Option<i32>,
    pub rating: Option<f64>,
    /// TMDB vote count; `None` for rows searched before 3.0.0 or no-match rows.
    pub vote_count: Option<i64>,
    pub poster_path: Option<String>,
    pub backdrop_path: Option<String>,
    pub overview: Option<String>,
    /// JSON int array from the search hit.
    pub genre_ids: Option<String>,
    pub runtime_minutes: Option<i32>,
    /// JSON string array, details only.
    pub genres: Option<String>,
    /// JSON `[{name, character, profile_path}]`, details only.
    pub cast_json: Option<String>,
    pub trailer_youtube_key: Option<String>,
    pub searched_at: String,
    pub details_fetched_at: Option<String>,
}

/// One `tmdb_episodes` row.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TmdbEpisodeRow {
    pub tmdb_id: i64,
    pub season: i32,
    pub episode: i32,
    pub title: Option<String>,
    pub overview: Option<String>,
    pub still_path: Option<String>,
    pub runtime_minutes: Option<i32>,
    pub air_date: Option<String>,
    pub fetched_at: String,
}

/// A cached title that passes the Home page's fixed filter
/// (`queries::get_tmdb_home_candidates`). Only what a slide needs.
#[derive(Debug, Clone, PartialEq)]
pub struct TmdbHomeCandidate {
    pub key: TmdbKey,
    pub tmdb_id: i64,
    pub title: String,
    pub release_year: Option<i32>,
    pub rating: Option<f64>,
    pub vote_count: Option<i64>,
    pub poster_path: Option<String>,
    pub backdrop_path: String,
    pub overview: Option<String>,
    pub genre_ids: Vec<i32>,
}

#[cfg(test)]
mod channel_summary_tests {
    use super::{Channel, ChannelSummary};

    fn channel(logo: Option<&str>) -> Channel {
        Channel {
            id: Some(7),
            playlist_id: 3,
            name: "SVT1".into(),
            url: "http://p.example/live/alice/s3cret/7.ts".into(),
            logo: logo.map(Into::into),
            group_name: Some("Sweden".into()),
            epg_id: Some("svt1.se".into()),
            tvg_name: None,
            content_type: "live".into(),
            is_favorite: true,
            sort_order: 4,
            category_order: 2,
            created_at: Some("2026-09-01 10:00:00".into()),
        }
    }

    #[test]
    fn leaves_out_the_url_and_fields_the_frontend_never_reads() {
        let json =
            serde_json::to_value(ChannelSummary::from(channel(Some("http://l/1.png")))).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "id": 7,
                "name": "SVT1",
                "logo": "http://l/1.png",
                "group_name": "Sweden",
                "epg_id": "svt1.se",
                "content_type": "live",
                "is_favorite": true,
                "created_at": "2026-09-01 10:00:00"
            })
        );
        assert!(!json.to_string().contains("s3cret"));
    }

    #[test]
    fn leaves_out_absent_optional_fields() {
        let json = serde_json::to_value(ChannelSummary::from(channel(None))).unwrap();
        assert!(json.get("logo").is_none(), "{json}");
    }
}
