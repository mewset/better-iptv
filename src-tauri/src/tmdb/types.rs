//! Serde shapes for the TMDB v3 responses this app reads, and the unified
//! structs the rest of the backend works with. Unknown fields are ignored.

use crate::tmdb_domain::Candidate;
use serde::Deserialize;

fn year_of(date: Option<&str>) -> Option<i32> {
    date.and_then(|d| d.get(0..4)).and_then(|y| y.parse().ok())
}

fn rating_of(average: f64, count: i64) -> Option<f64> {
    if count > 0 && average > 0.0 {
        Some(average)
    } else {
        None
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct SearchHit {
    pub id: i64,
    pub title: String,
    pub original_title: String,
    pub year: Option<i32>,
    pub rating: Option<f64>,
    pub poster_path: Option<String>,
    pub backdrop_path: Option<String>,
    pub overview: Option<String>,
    pub genre_ids: Vec<i32>,
}

impl SearchHit {
    pub fn to_candidate(&self) -> Candidate {
        Candidate {
            id: self.id,
            title: self.title.clone(),
            original_title: self.original_title.clone(),
            year: self.year,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct CastEntry {
    pub name: String,
    pub character: Option<String>,
    pub profile_path: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Details {
    pub id: i64,
    pub title: String,
    pub original_title: String,
    pub year: Option<i32>,
    pub rating: Option<f64>,
    pub poster_path: Option<String>,
    pub backdrop_path: Option<String>,
    pub overview: Option<String>,
    pub runtime_minutes: Option<i32>,
    pub genres: Vec<String>,
    pub genre_ids: Vec<i32>,
    pub cast: Vec<CastEntry>,
    pub trailer_youtube_key: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SeasonEpisode {
    pub episode: i32,
    pub title: Option<String>,
    pub overview: Option<String>,
    pub still_path: Option<String>,
    pub runtime_minutes: Option<i32>,
    pub air_date: Option<String>,
}

/// Cast entries kept per title; the detail view shows one scrolling row.
pub const MAX_CAST: usize = 12;

// ----- raw shapes -----

#[derive(Deserialize)]
struct SearchResponse<T> {
    results: Vec<T>,
}

#[derive(Deserialize)]
struct MovieHit {
    id: i64,
    title: String,
    #[serde(default)]
    original_title: String,
    release_date: Option<String>,
    #[serde(default)]
    vote_average: f64,
    #[serde(default)]
    vote_count: i64,
    poster_path: Option<String>,
    backdrop_path: Option<String>,
    overview: Option<String>,
    #[serde(default)]
    genre_ids: Vec<i32>,
}

#[derive(Deserialize)]
struct TvHit {
    id: i64,
    name: String,
    #[serde(default)]
    original_name: String,
    first_air_date: Option<String>,
    #[serde(default)]
    vote_average: f64,
    #[serde(default)]
    vote_count: i64,
    poster_path: Option<String>,
    backdrop_path: Option<String>,
    overview: Option<String>,
    #[serde(default)]
    genre_ids: Vec<i32>,
}

#[derive(Deserialize)]
struct Genre {
    id: i32,
    name: String,
}

#[derive(Deserialize)]
struct CastMember {
    name: String,
    character: Option<String>,
    profile_path: Option<String>,
    #[serde(default)]
    order: i32,
}

#[derive(Deserialize, Default)]
struct Credits {
    #[serde(default)]
    cast: Vec<CastMember>,
}

#[derive(Deserialize)]
struct Video {
    site: String,
    #[serde(rename = "type")]
    kind: String,
    key: String,
    #[serde(default)]
    official: bool,
}

#[derive(Deserialize, Default)]
struct Videos {
    #[serde(default)]
    results: Vec<Video>,
}

#[derive(Deserialize)]
struct MovieDetails {
    id: i64,
    title: String,
    #[serde(default)]
    original_title: String,
    release_date: Option<String>,
    runtime: Option<i32>,
    #[serde(default)]
    genres: Vec<Genre>,
    overview: Option<String>,
    poster_path: Option<String>,
    backdrop_path: Option<String>,
    #[serde(default)]
    vote_average: f64,
    #[serde(default)]
    vote_count: i64,
    #[serde(default)]
    credits: Credits,
    #[serde(default)]
    videos: Videos,
}

#[derive(Deserialize)]
struct TvDetails {
    id: i64,
    name: String,
    #[serde(default)]
    original_name: String,
    first_air_date: Option<String>,
    #[serde(default)]
    episode_run_time: Vec<i32>,
    #[serde(default)]
    genres: Vec<Genre>,
    overview: Option<String>,
    poster_path: Option<String>,
    backdrop_path: Option<String>,
    #[serde(default)]
    vote_average: f64,
    #[serde(default)]
    vote_count: i64,
    #[serde(default)]
    credits: Credits,
    #[serde(default)]
    videos: Videos,
}

#[derive(Deserialize)]
struct SeasonResponse {
    #[serde(default)]
    episodes: Vec<RawEpisode>,
}

#[derive(Deserialize)]
struct RawEpisode {
    episode_number: i32,
    name: Option<String>,
    overview: Option<String>,
    still_path: Option<String>,
    runtime: Option<i32>,
    air_date: Option<String>,
}

#[derive(Deserialize)]
struct ErrorBody {
    status_code: i32,
    status_message: String,
}

fn non_empty(s: Option<String>) -> Option<String> {
    s.filter(|v| !v.trim().is_empty())
}

fn cast_of(mut credits: Credits) -> Vec<CastEntry> {
    credits.cast.sort_by_key(|c| c.order);
    credits
        .cast
        .into_iter()
        .take(MAX_CAST)
        .map(|c| CastEntry {
            name: c.name,
            character: non_empty(c.character),
            profile_path: c.profile_path,
        })
        .collect()
}

/// The first official YouTube trailer, else any YouTube trailer.
fn trailer_of(videos: &Videos) -> Option<String> {
    let trailers = videos
        .results
        .iter()
        .filter(|v| v.site == "YouTube" && v.kind == "Trailer");
    trailers
        .clone()
        .find(|v| v.official)
        .or_else(|| trailers.clone().next())
        .map(|v| v.key.clone())
}

pub fn parse_movie_search(json: &str) -> Result<Vec<SearchHit>, serde_json::Error> {
    let r: SearchResponse<MovieHit> = serde_json::from_str(json)?;
    Ok(r.results
        .into_iter()
        .map(|h| SearchHit {
            id: h.id,
            year: year_of(h.release_date.as_deref()),
            rating: rating_of(h.vote_average, h.vote_count),
            title: h.title,
            original_title: h.original_title,
            poster_path: h.poster_path,
            backdrop_path: h.backdrop_path,
            overview: non_empty(h.overview),
            genre_ids: h.genre_ids,
        })
        .collect())
}

pub fn parse_tv_search(json: &str) -> Result<Vec<SearchHit>, serde_json::Error> {
    let r: SearchResponse<TvHit> = serde_json::from_str(json)?;
    Ok(r.results
        .into_iter()
        .map(|h| SearchHit {
            id: h.id,
            year: year_of(h.first_air_date.as_deref()),
            rating: rating_of(h.vote_average, h.vote_count),
            title: h.name,
            original_title: h.original_name,
            poster_path: h.poster_path,
            backdrop_path: h.backdrop_path,
            overview: non_empty(h.overview),
            genre_ids: h.genre_ids,
        })
        .collect())
}

pub fn parse_movie_details(json: &str) -> Result<Details, serde_json::Error> {
    let d: MovieDetails = serde_json::from_str(json)?;
    Ok(Details {
        id: d.id,
        year: year_of(d.release_date.as_deref()),
        rating: rating_of(d.vote_average, d.vote_count),
        title: d.title,
        original_title: d.original_title,
        poster_path: d.poster_path,
        backdrop_path: d.backdrop_path,
        overview: non_empty(d.overview),
        runtime_minutes: d.runtime.filter(|r| *r > 0),
        genre_ids: d.genres.iter().map(|g| g.id).collect(),
        genres: d.genres.into_iter().map(|g| g.name).collect(),
        trailer_youtube_key: trailer_of(&d.videos),
        cast: cast_of(d.credits),
    })
}

pub fn parse_tv_details(json: &str) -> Result<Details, serde_json::Error> {
    let d: TvDetails = serde_json::from_str(json)?;
    Ok(Details {
        id: d.id,
        year: year_of(d.first_air_date.as_deref()),
        rating: rating_of(d.vote_average, d.vote_count),
        title: d.name,
        original_title: d.original_name,
        poster_path: d.poster_path,
        backdrop_path: d.backdrop_path,
        overview: non_empty(d.overview),
        runtime_minutes: d.episode_run_time.first().copied().filter(|r| *r > 0),
        genre_ids: d.genres.iter().map(|g| g.id).collect(),
        genres: d.genres.into_iter().map(|g| g.name).collect(),
        trailer_youtube_key: trailer_of(&d.videos),
        cast: cast_of(d.credits),
    })
}

pub fn parse_season(json: &str) -> Result<Vec<SeasonEpisode>, serde_json::Error> {
    let r: SeasonResponse = serde_json::from_str(json)?;
    Ok(r.episodes
        .into_iter()
        .map(|e| SeasonEpisode {
            episode: e.episode_number,
            title: non_empty(e.name),
            overview: non_empty(e.overview),
            still_path: e.still_path,
            runtime_minutes: e.runtime.filter(|r| *r > 0),
            air_date: e.air_date,
        })
        .collect())
}

/// `(status_code, status_message)` from a TMDB error body, if it is one.
#[allow(dead_code)] // No caller in the plan yet; only the fixture test uses it
pub fn parse_error_body(json: &str) -> Option<(i32, String)> {
    serde_json::from_str::<ErrorBody>(json)
        .ok()
        .map(|e| (e.status_code, e.status_message))
}

#[cfg(test)]
mod tests {
    use super::*;

    const SEARCH_MOVIE: &str =
        include_str!("../../tests/fixtures/tmdb/search_movie_shutter_island.json");
    const SEARCH_TV: &str = include_str!("../../tests/fixtures/tmdb/search_tv_fullt_hus.json");
    const SEARCH_EMPTY: &str =
        include_str!("../../tests/fixtures/tmdb/search_movie_no_results.json");
    const MOVIE: &str = include_str!("../../tests/fixtures/tmdb/movie_11324_details.json");
    const TV: &str = include_str!("../../tests/fixtures/tmdb/tv_120487_details.json");
    const SEASON: &str = include_str!("../../tests/fixtures/tmdb/tv_120487_season_1.json");
    const AUTH_ERR: &str = include_str!("../../tests/fixtures/tmdb/auth_invalid_key.json");

    #[test]
    fn movie_search_hit_carries_everything_a_card_needs() {
        let hits = parse_movie_search(SEARCH_MOVIE).unwrap();
        let hit = &hits[0];
        assert_eq!(hit.id, 11324);
        assert_eq!(hit.title, "Shutter Island");
        assert_eq!(hit.year, Some(2010));
        assert!(hit.rating.unwrap() > 8.0);
        assert_eq!(
            hit.poster_path.as_deref(),
            Some("/nrmXQ0zcZUL8jFLrakWc90IR8z9.jpg")
        );
        assert!(hit.backdrop_path.is_some());
        assert_eq!(hit.genre_ids, vec![18, 53, 9648]);
        assert_eq!(hit.to_candidate().year, Some(2010));
    }

    #[test]
    fn tv_search_maps_name_and_first_air_date() {
        let hits = parse_tv_search(SEARCH_TV).unwrap();
        let fullt_hus = hits.iter().find(|h| h.id == 120487).unwrap();
        assert_eq!(fullt_hus.title, "Fullt Hus");
        assert_eq!(fullt_hus.year, Some(2020));
        let full_house = hits.iter().find(|h| h.id == 4313).unwrap();
        assert_eq!(full_house.original_title, "Full House");
    }

    #[test]
    fn empty_search_is_an_empty_vec() {
        assert!(parse_movie_search(SEARCH_EMPTY).unwrap().is_empty());
    }

    #[test]
    fn movie_details_pick_genres_cast_and_the_official_trailer() {
        let d = parse_movie_details(MOVIE).unwrap();
        assert_eq!(d.runtime_minutes, Some(138));
        assert_eq!(d.genres[0], "Drama");
        assert_eq!(d.cast[0].name, "Leonardo DiCaprio");
        assert_eq!(d.cast[0].character.as_deref(), Some("Teddy Daniels"));
        assert!(d.cast.len() <= 12);
        // The fixture's first YouTube videos are Clips; the trailer must be a Trailer.
        assert_eq!(d.trailer_youtube_key.as_deref(), Some("qdPw9x9h5CY"));
        assert_eq!(d.year, Some(2010));
    }

    #[test]
    fn tv_details_use_episode_run_time_for_runtime() {
        let d = parse_tv_details(TV).unwrap();
        assert_eq!(d.title, "Fullt Hus");
        assert_eq!(d.runtime_minutes, Some(22));
        assert_eq!(d.year, Some(2020));
    }

    #[test]
    fn season_episodes_keep_number_title_and_runtime() {
        let eps = parse_season(SEASON).unwrap();
        assert_eq!(eps[0].episode, 1);
        assert_eq!(
            eps[0].title.as_deref(),
            Some("Karin och Henke tvingas flytta hem")
        );
        assert_eq!(eps[0].runtime_minutes, Some(22));
        assert_eq!(eps[0].still_path, None);
    }

    #[test]
    fn a_rating_with_no_votes_is_absent() {
        let json = r#"{"results":[{"id":1,"title":"X","original_title":"X","vote_average":0.0,"vote_count":0,"genre_ids":[]}]}"#;
        let hits = parse_movie_search(json).unwrap();
        assert_eq!(hits[0].rating, None);
        assert_eq!(hits[0].year, None);
    }

    #[test]
    fn error_body_exposes_status_code_and_message() {
        let (code, msg) = parse_error_body(AUTH_ERR).unwrap();
        assert_eq!(code, 7);
        assert!(msg.contains("Invalid API key"));
        assert!(parse_error_body("not json").is_none());
    }
}
