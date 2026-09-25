//! TMDB HTTP client. Four requests in flight at most across the whole app,
//! one retry on 429, both key formats. Pure logic lives in `tmdb_domain`.

pub mod keys;
pub mod session;
pub mod types;

use crate::http;
use crate::tmdb_domain::{key_kind, KeyKind};
use lazy_static::lazy_static;
use log::debug;
use std::time::Duration;
use tokio::sync::Semaphore;
use types::{Details, SearchHit, SeasonEpisode};

pub const API_BASE: &str = "https://api.themoviedb.org/3";
pub const FALLBACK_LANGUAGE: &str = "en-US";
#[allow(dead_code)] // Read inside the lazy_static initialiser, which the lint does not see
const MAX_IN_FLIGHT: usize = 4;
const DEFAULT_RETRY_AFTER_SECS: u64 = 2;
/// The sleep holds one of the four permits, so a huge Retry-After is capped.
const MAX_RETRY_AFTER_SECS: u64 = 30;

lazy_static! {
    static ref PERMITS: Semaphore = Semaphore::new(MAX_IN_FLIGHT);
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Movie,
    Tv,
}

impl Kind {
    #[allow(dead_code)] // Called by the enrichment queue in Task 7
    pub fn from_content_type(content_type: &str) -> Option<Kind> {
        match content_type {
            "vod" => Some(Kind::Movie),
            "series" => Some(Kind::Tv),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TmdbError {
    /// 401: the key was rejected.
    Unauthorized,
    /// 429 even after the one retry.
    RateLimited,
    /// Any other HTTP failure, including the network.
    Http(String),
    Decode(String),
}

impl std::fmt::Display for TmdbError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TmdbError::Unauthorized => write!(f, "TMDB rejected the API key"),
            TmdbError::RateLimited => write!(f, "TMDB rate limit reached"),
            TmdbError::Http(e) => write!(f, "TMDB request failed: {e}"),
            TmdbError::Decode(e) => write!(f, "TMDB response was unreadable: {e}"),
        }
    }
}

/// `include_video_language` for a details request: the UI language's
/// two-letter code, then English, then untagged videos. Without it TMDB
/// returns only videos tagged with `language`, which for most locales is none.
fn video_languages(lang: &str) -> String {
    let primary = lang
        .split('-')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    if primary.is_empty() || primary == "en" {
        "en,null".to_string()
    } else {
        format!("{primary},en,null")
    }
}

/// One of the two fixture-tested detail parsers in `types`.
type DetailsParser = fn(&str) -> Result<Details, serde_json::Error>;

#[derive(Debug, Clone)]
pub struct TmdbClient {
    key: String,
    kind: KeyKind,
}

impl TmdbClient {
    #[allow(dead_code)] // Called by the enrichment queue in Task 7
    pub fn new(key: &str) -> Self {
        let key = key.trim().to_string();
        Self {
            kind: key_kind(&key),
            key,
        }
    }

    /// GET a v3 path with query parameters; returns the body text on 2xx.
    async fn get_text(&self, path: &str, query: &[(&str, String)]) -> Result<String, TmdbError> {
        let _permit = PERMITS
            .acquire()
            .await
            .map_err(|e| TmdbError::Http(e.to_string()))?;
        let url = format!("{API_BASE}{path}");
        let mut attempt = 0;
        loop {
            attempt += 1;
            let mut req = http::get_http_client().get(&url).query(query);
            req = match self.kind {
                KeyKind::V3 => req.query(&[("api_key", self.key.as_str())]),
                KeyKind::V4 => req.bearer_auth(&self.key),
            };
            let resp = req
                .send()
                .await
                .map_err(|e| TmdbError::Http(e.to_string()))?;
            let status = resp.status();
            if status.as_u16() == 429 {
                if attempt >= 2 {
                    return Err(TmdbError::RateLimited);
                }
                let wait = resp
                    .headers()
                    .get("retry-after")
                    .and_then(|v| v.to_str().ok())
                    .and_then(|v| v.parse::<u64>().ok())
                    .unwrap_or(DEFAULT_RETRY_AFTER_SECS)
                    .min(MAX_RETRY_AFTER_SECS);
                debug!("TMDB 429 on {path}, retrying after {wait}s");
                tokio::time::sleep(Duration::from_secs(wait)).await;
                continue;
            }
            if status.as_u16() == 401 {
                return Err(TmdbError::Unauthorized);
            }
            if !status.is_success() {
                return Err(TmdbError::Http(format!("HTTP {status} on {path}")));
            }
            return resp
                .text()
                .await
                .map_err(|e| TmdbError::Http(e.to_string()));
        }
    }

    #[allow(dead_code)] // Called by the enrichment queue in Task 7
    pub async fn search(
        &self,
        kind: Kind,
        title: &str,
        year: Option<i32>,
        lang: &str,
    ) -> Result<Vec<SearchHit>, TmdbError> {
        let mut query = vec![
            ("query", title.to_string()),
            ("language", lang.to_string()),
            ("include_adult", "false".to_string()),
            ("page", "1".to_string()),
        ];
        let path = match kind {
            Kind::Movie => {
                if let Some(y) = year {
                    query.push(("year", y.to_string()));
                }
                "/search/movie"
            }
            Kind::Tv => {
                if let Some(y) = year {
                    query.push(("first_air_date_year", y.to_string()));
                }
                "/search/tv"
            }
        };
        let body = self.get_text(path, &query).await?;
        let parsed = match kind {
            Kind::Movie => types::parse_movie_search(&body),
            Kind::Tv => types::parse_tv_search(&body),
        };
        parsed.map_err(|e| TmdbError::Decode(e.to_string()))
    }

    /// Details with credits and videos. An empty localised overview is
    /// filled from `en-US` with a second request.
    #[allow(dead_code)] // Called by the enrichment queue in Task 7
    pub async fn details(&self, kind: Kind, id: i64, lang: &str) -> Result<Details, TmdbError> {
        let mut d = self.details_in(kind, id, lang).await?;
        if d.overview.is_none() && lang != FALLBACK_LANGUAGE {
            if let Ok(en) = self.details_in(kind, id, FALLBACK_LANGUAGE).await {
                d.overview = en.overview;
                if d.title.trim().is_empty() {
                    d.title = en.title;
                }
            }
        }
        Ok(d)
    }

    async fn details_in(&self, kind: Kind, id: i64, lang: &str) -> Result<Details, TmdbError> {
        let query = [
            ("language", lang.to_string()),
            ("append_to_response", "credits,videos".to_string()),
            ("include_video_language", video_languages(lang)),
        ];
        let (path, parse): (String, DetailsParser) = match kind {
            Kind::Movie => (format!("/movie/{id}"), types::parse_movie_details),
            Kind::Tv => (format!("/tv/{id}"), types::parse_tv_details),
        };
        let body = self.get_text(&path, &query).await?;
        parse(&body).map_err(|e| TmdbError::Decode(e.to_string()))
    }

    #[allow(dead_code)] // Called by the TMDB commands in Task 8
    pub async fn season(
        &self,
        tv_id: i64,
        season: i32,
        lang: &str,
    ) -> Result<Vec<SeasonEpisode>, TmdbError> {
        let body = self
            .get_text(
                &format!("/tv/{tv_id}/season/{season}"),
                &[("language", lang.to_string())],
            )
            .await?;
        types::parse_season(&body).map_err(|e| TmdbError::Decode(e.to_string()))
    }

    /// Validate the key. `Err(Unauthorized)` for a rejected key.
    #[allow(dead_code)] // Called by the TMDB commands in Task 8
    pub async fn check(&self) -> Result<(), TmdbError> {
        self.get_text("/authentication", &[]).await.map(|_| ())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn video_languages_put_the_ui_language_first_then_english_then_untagged() {
        assert_eq!(video_languages("sv-SE"), "sv,en,null");
        assert_eq!(video_languages("de"), "de,en,null");
    }

    #[test]
    fn video_languages_do_not_repeat_english() {
        assert_eq!(video_languages("en-US"), "en,null");
        assert_eq!(video_languages("en-GB"), "en,null");
        assert_eq!(video_languages(""), "en,null");
    }
}

#[cfg(test)]
mod live_tests {
    //! Real API calls. Run with:
    //! `set -a; . ~/.config/better-iptv-dev/tmdb.env; set +a; cargo test tmdb::live -- --ignored`
    use super::*;

    fn key() -> String {
        std::env::var("TMDB_API_KEY").expect("TMDB_API_KEY not set")
    }

    #[tokio::test]
    #[ignore]
    async fn search_finds_shutter_island() {
        let hits = TmdbClient::new(&key())
            .search(Kind::Movie, "Shutter Island", Some(2010), "en-US")
            .await
            .unwrap();
        assert_eq!(hits[0].id, 11324);
    }

    #[tokio::test]
    #[ignore]
    async fn details_have_credits_and_a_trailer() {
        let d = TmdbClient::new(&key())
            .details(Kind::Movie, 11324, "sv-SE")
            .await
            .unwrap();
        assert!(!d.cast.is_empty());
        assert!(d.trailer_youtube_key.is_some());
        assert!(d.overview.is_some());
    }

    #[tokio::test]
    #[ignore]
    async fn a_bogus_key_is_unauthorized() {
        let err = TmdbClient::new("deadbeefdeadbeefdeadbeefdeadbeef")
            .check()
            .await
            .unwrap_err();
        assert_eq!(err, TmdbError::Unauthorized);
    }

    #[tokio::test]
    #[ignore]
    async fn the_read_token_works_as_bearer() {
        let token = std::env::var("TMDB_READ_TOKEN").expect("TMDB_READ_TOKEN not set");
        TmdbClient::new(&token).check().await.unwrap();
    }
}
