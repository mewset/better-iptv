//! TMDB IPC commands. Orchestration only; logic is in `tmdb_domain`,
//! HTTP in `tmdb`, persistence in `db`.

use crate::commands::with_db;
use crate::db::models::{Channel, TmdbEpisodeRow, TmdbKey, TmdbRow};
use crate::db::{mutations, queries};
use crate::error::AppError;
use crate::state::AppState;
use crate::tmdb::enrich::{claim_key, search_and_store, EnrichJob};
use crate::tmdb::keys::{
    handle_unauthorized, read_key_settings, read_language, resolve_key, TMDB_BACKGROUND_ENRICH_KEY,
};
use crate::tmdb::session::BackgroundProgress;
use crate::tmdb::types::Details;
use crate::tmdb::{Kind, TmdbClient, TmdbError};
use crate::tmdb_domain::{
    details_are_stale, genre_name, image_url, normalize_title, search_is_stale, ImageSize,
    Normalized,
};
use chrono::{Datelike, Utc};
use log::debug;
use rusqlite::Connection;
use serde::Serialize;
use std::collections::HashMap;
use tauri::State;

/// Upper bound on ids per `get_tmdb_cards` call; a visible page is far fewer.
const MAX_CARD_BATCH: usize = 120;

#[derive(Debug, Clone, Serialize)]
pub struct TmdbCard {
    pub channel_id: i64,
    pub tmdb_id: i64,
    pub title: String,
    pub year: Option<i32>,
    pub rating: Option<f64>,
    pub poster_url: Option<String>,
    pub backdrop_url: Option<String>,
    pub genres: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct TmdbStatus {
    pub enabled: bool,
    pub has_user_key: bool,
    pub has_shared_key: bool,
    pub user_key_rejected: bool,
    pub shared_key_rejected: bool,
    pub language: String,
    /// The `tmdb_background_enrich` setting.
    pub background_enrich: bool,
    /// Where the library scan stands; `None` until one ran this session.
    pub background_progress: Option<BackgroundProgress>,
}

/// Cache key, search query and TMDB kind for a channel; `None` for live TV.
pub fn cache_key_for(channel: &Channel) -> Option<(TmdbKey, Normalized, Kind)> {
    let kind = Kind::from_content_type(&channel.content_type)?;
    let query = normalize_title(&channel.name, Utc::now().year());
    if query.title.is_empty() {
        return None;
    }
    let key = TmdbKey {
        title: query.cache_title(),
        year: query.cache_year(),
        content_type: channel.content_type.clone(),
    };
    Some((key, query, kind))
}

/// Genre names: the detail list when fetched, else the search hit's ids.
pub fn genres_of(row: &TmdbRow) -> Vec<String> {
    if let Some(names) = row
        .genres
        .as_deref()
        .and_then(|j| serde_json::from_str::<Vec<String>>(j).ok())
    {
        if !names.is_empty() {
            return names;
        }
    }
    row.genre_ids
        .as_deref()
        .and_then(|j| serde_json::from_str::<Vec<i32>>(j).ok())
        .unwrap_or_default()
        .into_iter()
        .filter_map(genre_name)
        .map(String::from)
        .collect()
}

pub fn card_from_row(channel_id: i64, row: &TmdbRow) -> Option<TmdbCard> {
    let tmdb_id = row.tmdb_id?;
    Some(TmdbCard {
        channel_id,
        tmdb_id,
        title: row.title.clone().unwrap_or_default(),
        year: row.release_year,
        rating: row.rating,
        poster_url: image_url(row.poster_path.as_deref(), ImageSize::CardPoster),
        backdrop_url: image_url(row.backdrop_path.as_deref(), ImageSize::Backdrop),
        genres: genres_of(row),
    })
}

/// One job per distinct cache key, carrying every channel that shares it.
pub fn group_jobs(channels: &[Channel]) -> Vec<EnrichJob> {
    let mut by_key: HashMap<TmdbKey, EnrichJob> = HashMap::new();
    let mut order: Vec<TmdbKey> = Vec::new();
    for channel in channels {
        let Some(id) = channel.id else { continue };
        let Some((key, query, kind)) = cache_key_for(channel) else {
            continue;
        };
        match by_key.get_mut(&key) {
            Some(job) => job.channel_ids.push(id),
            None => {
                order.push(key.clone());
                by_key.insert(
                    key.clone(),
                    EnrichJob {
                        key,
                        query,
                        kind,
                        channel_ids: vec![id],
                        generation: 0,
                    },
                );
            }
        }
    }
    order
        .into_iter()
        .filter_map(|k| by_key.remove(&k))
        .collect()
}

/// Cached cards for the given channels; titles without a fresh row are
/// queued for the worker, which emits `tmdb-card` per finished title.
#[tauri::command]
pub async fn get_tmdb_cards(
    state: State<'_, AppState>,
    channel_ids: Vec<i64>,
) -> Result<Vec<TmdbCard>, AppError> {
    if channel_ids.len() > MAX_CARD_BATCH {
        return Err(AppError::InvalidInput(format!(
            "At most {MAX_CARD_BATCH} channels per request"
        )));
    }
    if channel_ids.is_empty() {
        return Ok(Vec::new());
    }
    let (jobs, cards) = with_db(&state.pool, move |conn| cached_cards(conn, &channel_ids)).await?;

    let mut queued = 0;
    for job in jobs {
        if state.tmdb.try_claim(&claim_key(&job.key)) {
            state.tmdb.enqueue(job);
            queued += 1;
        }
    }
    debug!(
        "get_tmdb_cards -> {} cached, {} queued",
        cards.len(),
        queued
    );
    Ok(cards)
}

/// The database half of `get_tmdb_cards`: fresh cached cards plus the jobs
/// still to search. Both are empty while the feature is off, so the grid
/// shows provider data only and nothing is queued.
pub fn cached_cards(
    conn: &Connection,
    channel_ids: &[i64],
) -> Result<(Vec<EnrichJob>, Vec<TmdbCard>), AppError> {
    if !read_key_settings(conn)?.enabled {
        return Ok((Vec::new(), Vec::new()));
    }
    let channels = queries::get_channels_by_ids(conn, channel_ids)?;
    let now = Utc::now();
    let mut cards = Vec::new();
    let mut pending = Vec::new();
    for job in group_jobs(&channels) {
        match queries::get_tmdb_row(conn, &job.key)? {
            Some(row)
                if !search_is_stale(&row.searched_at, now, row.tmdb_id.is_some(), row.manual) =>
            {
                if row.tmdb_id.is_some() {
                    cards.extend(
                        job.channel_ids
                            .iter()
                            .filter_map(|id| card_from_row(*id, &row)),
                    );
                }
            }
            _ => pending.push(job),
        }
    }
    Ok((pending, cards))
}

/// The `tmdb_enabled` setting. Off means every command answers as if no
/// TMDB data existed, cached rows included.
async fn feature_enabled(state: &State<'_, AppState>) -> Result<bool, AppError> {
    with_db(&state.pool, |conn| Ok(read_key_settings(conn)?.enabled)).await
}

#[tauri::command]
pub async fn get_tmdb_status(state: State<'_, AppState>) -> Result<TmdbStatus, AppError> {
    let (settings, language, background_enrich) = with_db(&state.pool, |conn| {
        Ok((
            read_key_settings(conn)?,
            read_language(conn)?,
            queries::get_setting(conn, TMDB_BACKGROUND_ENRICH_KEY)?.is_some_and(|v| v == "1"),
        ))
    })
    .await?;
    Ok(TmdbStatus {
        enabled: settings.enabled,
        has_user_key: settings
            .user_key
            .as_deref()
            .is_some_and(|k| !k.trim().is_empty()),
        has_shared_key: settings
            .shared_key
            .as_deref()
            .is_some_and(|k| !k.trim().is_empty()),
        user_key_rejected: state.tmdb.user_key_rejected(),
        shared_key_rejected: state.tmdb.shared_key_rejected(),
        language,
        background_enrich,
        background_progress: state.tmdb.background_progress(),
    })
}

/// Validate a key the user typed. The error string is shown as-is.
#[tauri::command]
pub async fn check_tmdb_key(key: String) -> Result<(), String> {
    if key.trim().is_empty() {
        return Err("Enter a key first".to_string());
    }
    TmdbClient::new(&key)
        .check()
        .await
        .map_err(|e| e.to_string())
}

#[derive(Debug, Clone, Serialize, serde::Deserialize)]
pub struct TmdbCastMember {
    pub name: String,
    pub character: Option<String>,
    pub photo_url: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct TmdbDetails {
    /// A key resolved and the feature is on; false means "provider data only".
    pub available: bool,
    pub matched: bool,
    pub manual: bool,
    pub tmdb_id: Option<i64>,
    pub title: Option<String>,
    pub original_title: Option<String>,
    pub year: Option<i32>,
    pub rating: Option<f64>,
    pub poster_url: Option<String>,
    pub backdrop_url: Option<String>,
    pub overview: Option<String>,
    pub runtime_minutes: Option<i32>,
    pub genres: Vec<String>,
    pub cast: Vec<TmdbCastMember>,
    pub trailer_url: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct TmdbEpisode {
    pub season: i32,
    pub episode: i32,
    pub title: Option<String>,
    pub overview: Option<String>,
    pub still_url: Option<String>,
    pub runtime_minutes: Option<i32>,
    pub air_date: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct TmdbCandidate {
    pub tmdb_id: i64,
    pub title: String,
    pub original_title: String,
    pub year: Option<i32>,
    pub poster_url: Option<String>,
    pub overview: Option<String>,
}

/// Stored cast JSON shape (`cast_json` column).
#[derive(Debug, Clone, Serialize, serde::Deserialize)]
struct StoredCast {
    name: String,
    character: Option<String>,
    profile_path: Option<String>,
}

pub fn provider_only_details(available: bool, manual: bool) -> TmdbDetails {
    TmdbDetails {
        available,
        matched: false,
        manual,
        tmdb_id: None,
        title: None,
        original_title: None,
        year: None,
        rating: None,
        poster_url: None,
        backdrop_url: None,
        overview: None,
        runtime_minutes: None,
        genres: Vec::new(),
        cast: Vec::new(),
        trailer_url: None,
    }
}

pub fn details_from_row(available: bool, row: &TmdbRow) -> TmdbDetails {
    let Some(tmdb_id) = row.tmdb_id else {
        return provider_only_details(available, row.manual);
    };
    let cast = row
        .cast_json
        .as_deref()
        .and_then(|j| serde_json::from_str::<Vec<StoredCast>>(j).ok())
        .unwrap_or_default()
        .into_iter()
        .map(|c| TmdbCastMember {
            name: c.name,
            character: c.character,
            photo_url: image_url(c.profile_path.as_deref(), ImageSize::Small),
        })
        .collect();
    TmdbDetails {
        available,
        matched: true,
        manual: row.manual,
        tmdb_id: Some(tmdb_id),
        title: row.title.clone(),
        original_title: row.original_title.clone(),
        year: row.release_year,
        rating: row.rating,
        poster_url: image_url(row.poster_path.as_deref(), ImageSize::DetailPoster),
        backdrop_url: image_url(row.backdrop_path.as_deref(), ImageSize::Backdrop),
        overview: row.overview.clone(),
        runtime_minutes: row.runtime_minutes,
        genres: genres_of(row),
        cast,
        trailer_url: row
            .trailer_youtube_key
            .as_deref()
            .map(|k| format!("https://www.youtube.com/watch?v={k}")),
    }
}

fn row_with_details(key: &TmdbKey, manual: bool, d: &Details, searched_at: String) -> TmdbRow {
    let cast: Vec<StoredCast> = d
        .cast
        .iter()
        .map(|c| StoredCast {
            name: c.name.clone(),
            character: c.character.clone(),
            profile_path: c.profile_path.clone(),
        })
        .collect();
    TmdbRow {
        key: key.clone(),
        tmdb_id: Some(d.id),
        manual,
        title: Some(d.title.clone()),
        original_title: Some(d.original_title.clone()),
        release_year: d.year,
        rating: d.rating,
        vote_count: Some(d.vote_count),
        poster_path: d.poster_path.clone(),
        backdrop_path: d.backdrop_path.clone(),
        overview: d.overview.clone(),
        genre_ids: Some(serde_json::to_string(&d.genre_ids).unwrap_or_else(|_| "[]".into())),
        runtime_minutes: d.runtime_minutes,
        genres: Some(serde_json::to_string(&d.genres).unwrap_or_else(|_| "[]".into())),
        cast_json: Some(serde_json::to_string(&cast).unwrap_or_else(|_| "[]".into())),
        trailer_youtube_key: d.trailer_youtube_key.clone(),
        searched_at,
        details_fetched_at: Some(Utc::now().to_rfc3339()),
    }
}

async fn load_channel(state: &State<'_, AppState>, channel_id: i64) -> Result<Channel, AppError> {
    with_db(&state.pool, move |conn| {
        queries::get_channel_by_id(conn, channel_id)?.ok_or(AppError::ChannelNotFound(channel_id))
    })
    .await
}

/// Fetch details for `tmdb_id` and store them. `Ok(None)` when no key
/// resolves or TMDB failed; the cached row (if any) is then what callers show.
async fn fetch_and_store_details(
    state: &State<'_, AppState>,
    key: &TmdbKey,
    kind: Kind,
    tmdb_id: i64,
    manual: bool,
    searched_at: String,
) -> Result<Option<TmdbRow>, AppError> {
    let Some(resolved) = resolve_key(&state.pool, &state.tmdb).await? else {
        return Ok(None);
    };
    let lang = with_db(&state.pool, |conn| Ok(read_language(conn)?)).await?;
    match TmdbClient::new(&resolved.key)
        .details(kind, tmdb_id, &lang)
        .await
    {
        Ok(d) => {
            let row = row_with_details(key, manual, &d, searched_at);
            let stored = row.clone();
            with_db(&state.pool, move |conn| {
                Ok(mutations::upsert_tmdb_details(conn, &stored)?)
            })
            .await?;
            Ok(Some(row))
        }
        Err(TmdbError::Unauthorized) => {
            handle_unauthorized(&state.pool, &state.tmdb, &resolved).await?;
            Ok(None)
        }
        Err(e) => {
            debug!("TMDB details for {tmdb_id} failed: {e}");
            Ok(None)
        }
    }
}

#[tauri::command]
pub async fn get_tmdb_details(
    state: State<'_, AppState>,
    channel_id: i64,
) -> Result<TmdbDetails, AppError> {
    if !feature_enabled(&state).await? {
        return Ok(provider_only_details(false, false));
    }
    let channel = load_channel(&state, channel_id).await?;
    let Some((key, query, kind)) = cache_key_for(&channel) else {
        return Ok(provider_only_details(false, false));
    };
    let available = resolve_key(&state.pool, &state.tmdb).await?.is_some();
    let key_for_read = key.clone();
    let mut row = with_db(&state.pool, move |conn| {
        Ok(queries::get_tmdb_row(conn, &key_for_read)?)
    })
    .await?;
    let now = Utc::now();

    let needs_search = match &row {
        Some(r) => search_is_stale(&r.searched_at, now, r.tmdb_id.is_some(), r.manual),
        None => true,
    };
    if available && needs_search {
        if let Some(fresh) = search_and_store(&state.pool, &state.tmdb, &key, &query, kind).await? {
            row = Some(fresh);
        }
    }

    let Some(current) = row else {
        return Ok(provider_only_details(available, false));
    };
    let Some(tmdb_id) = current.tmdb_id else {
        return Ok(provider_only_details(available, current.manual));
    };
    if available && details_are_stale(current.details_fetched_at.as_deref(), now) {
        if let Some(full) = fetch_and_store_details(
            &state,
            &key,
            kind,
            tmdb_id,
            current.manual,
            current.searched_at.clone(),
        )
        .await?
        {
            return Ok(details_from_row(true, &full));
        }
    }
    Ok(details_from_row(available, &current))
}

#[tauri::command]
pub async fn get_tmdb_season(
    state: State<'_, AppState>,
    channel_id: i64,
    season: i32,
) -> Result<Vec<TmdbEpisode>, AppError> {
    let channel = load_channel(&state, channel_id).await?;
    if Kind::from_content_type(&channel.content_type) != Some(Kind::Tv) {
        return Err(AppError::InvalidInput(format!(
            "Channel {channel_id} is not a series"
        )));
    }
    if !feature_enabled(&state).await? {
        return Ok(Vec::new());
    }
    let Some((key, _, _)) = cache_key_for(&channel) else {
        return Ok(Vec::new());
    };
    let key_for_read = key.clone();
    let tmdb_id = with_db(&state.pool, move |conn| {
        Ok(queries::get_tmdb_row(conn, &key_for_read)?.and_then(|r| r.tmdb_id))
    })
    .await?;
    let Some(tmdb_id) = tmdb_id else {
        return Ok(Vec::new());
    };
    let cached = with_db(&state.pool, move |conn| {
        Ok(queries::get_tmdb_episodes(conn, tmdb_id, season)?)
    })
    .await?;
    let fresh = cached
        .first()
        .is_some_and(|e| !details_are_stale(Some(&e.fetched_at), Utc::now()));
    let rows = if fresh {
        cached
    } else if let Some(resolved) = resolve_key(&state.pool, &state.tmdb).await? {
        let lang = with_db(&state.pool, |conn| Ok(read_language(conn)?)).await?;
        match TmdbClient::new(&resolved.key)
            .season(tmdb_id, season, &lang)
            .await
        {
            Ok(eps) => {
                let now = Utc::now().to_rfc3339();
                let rows: Vec<TmdbEpisodeRow> = eps
                    .into_iter()
                    .map(|e| TmdbEpisodeRow {
                        tmdb_id,
                        season,
                        episode: e.episode,
                        title: e.title,
                        overview: e.overview,
                        still_path: e.still_path,
                        runtime_minutes: e.runtime_minutes,
                        air_date: e.air_date,
                        fetched_at: now.clone(),
                    })
                    .collect();
                let stored = rows.clone();
                with_db(&state.pool, move |conn| {
                    Ok(mutations::upsert_tmdb_episodes(conn, &stored)?)
                })
                .await?;
                rows
            }
            Err(TmdbError::Unauthorized) => {
                handle_unauthorized(&state.pool, &state.tmdb, &resolved).await?;
                cached
            }
            Err(e) => {
                debug!("TMDB season {season} of {tmdb_id} failed: {e}");
                cached
            }
        }
    } else {
        cached
    };
    Ok(rows
        .into_iter()
        .map(|e| TmdbEpisode {
            season: e.season,
            episode: e.episode,
            title: e.title,
            overview: e.overview,
            still_url: image_url(e.still_path.as_deref(), ImageSize::CardPoster),
            runtime_minutes: e.runtime_minutes,
            air_date: e.air_date,
        })
        .collect())
}

const MAX_CANDIDATES: usize = 10;

#[tauri::command]
pub async fn search_tmdb(
    state: State<'_, AppState>,
    query: String,
    content_type: String,
) -> Result<Vec<TmdbCandidate>, AppError> {
    let Some(kind) = Kind::from_content_type(&content_type) else {
        return Err(AppError::InvalidInput(
            "content_type must be vod or series".into(),
        ));
    };
    let q = query.trim();
    if q.is_empty() {
        return Ok(Vec::new());
    }
    let Some(resolved) = resolve_key(&state.pool, &state.tmdb).await? else {
        return Ok(Vec::new());
    };
    let lang = with_db(&state.pool, |conn| Ok(read_language(conn)?)).await?;
    let hits = match TmdbClient::new(&resolved.key)
        .search(kind, q, None, &lang)
        .await
    {
        Ok(h) => h,
        Err(TmdbError::Unauthorized) => {
            handle_unauthorized(&state.pool, &state.tmdb, &resolved).await?;
            return Ok(Vec::new());
        }
        Err(e) => return Err(AppError::Http(e.to_string())),
    };
    Ok(hits
        .into_iter()
        .take(MAX_CANDIDATES)
        .map(|h| TmdbCandidate {
            tmdb_id: h.id,
            title: h.title,
            original_title: h.original_title,
            year: h.year,
            poster_url: image_url(h.poster_path.as_deref(), ImageSize::Small),
            overview: h.overview,
        })
        .collect())
}

/// The user picked a title (or "Not on TMDB"). Stored as manual; details
/// are fetched right away so the view can render them.
#[tauri::command]
pub async fn set_tmdb_match(
    state: State<'_, AppState>,
    channel_id: i64,
    tmdb_id: Option<i64>,
) -> Result<TmdbDetails, AppError> {
    let channel = load_channel(&state, channel_id).await?;
    let Some((key, _, kind)) = cache_key_for(&channel) else {
        return Err(AppError::InvalidInput(format!(
            "Channel {channel_id} is not a movie or series"
        )));
    };
    let now = Utc::now().to_rfc3339();
    let key_for_write = key.clone();
    let stamp = now.clone();
    with_db(&state.pool, move |conn| {
        Ok(mutations::set_tmdb_manual(
            conn,
            &key_for_write,
            tmdb_id,
            &stamp,
        )?)
    })
    .await?;
    let Some(id) = tmdb_id else {
        return Ok(provider_only_details(true, true));
    };
    match fetch_and_store_details(&state, &key, kind, id, true, now).await? {
        Some(row) => Ok(details_from_row(true, &row)),
        None => {
            let key_for_read = key.clone();
            let row = with_db(&state.pool, move |conn| {
                Ok(queries::get_tmdb_row(conn, &key_for_read)?)
            })
            .await?;
            Ok(row
                .map(|r| details_from_row(false, &r))
                .unwrap_or_else(|| provider_only_details(false, true)))
        }
    }
}

#[tauri::command]
pub async fn delete_tmdb_cache(state: State<'_, AppState>) -> Result<usize, AppError> {
    let n = with_db(&state.pool, |conn| Ok(mutations::delete_tmdb_cache(conn)?)).await?;
    log::info!("TMDB cache cleared ({n} rows)");
    Ok(n)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::models::{Channel, TmdbKey, TmdbRow};

    fn channel(id: i64, name: &str, content_type: &str) -> Channel {
        Channel {
            id: Some(id),
            playlist_id: 1,
            name: name.into(),
            url: "http://x".into(),
            logo: None,
            group_name: None,
            epg_id: None,
            tvg_name: None,
            content_type: content_type.into(),
            is_favorite: false,
            sort_order: 0,
            category_order: 0,
            created_at: None,
        }
    }

    #[test]
    fn cache_key_normalises_and_skips_live_channels() {
        let (key, query, kind) =
            cache_key_for(&channel(1, "SE| Shutter.Island.2010.1080p", "vod")).unwrap();
        assert_eq!(
            key,
            TmdbKey {
                title: "shutter island".into(),
                year: 2010,
                content_type: "vod".into()
            }
        );
        assert_eq!(query.title, "Shutter Island");
        assert_eq!(kind, Kind::Movie);
        assert!(cache_key_for(&channel(2, "SVT1", "live")).is_none());
        assert_eq!(
            cache_key_for(&channel(3, "Fullt Hus", "series")).unwrap().2,
            Kind::Tv
        );
    }

    #[test]
    fn card_uses_detail_genres_when_present_else_the_id_table() {
        let mut row = TmdbRow {
            key: TmdbKey {
                title: "x".into(),
                year: 0,
                content_type: "vod".into(),
            },
            tmdb_id: Some(11324),
            manual: false,
            title: Some("Shutter Island".into()),
            original_title: None,
            release_year: Some(2010),
            rating: Some(8.2),
            vote_count: None,
            poster_path: Some("/p.jpg".into()),
            backdrop_path: Some("/b.jpg".into()),
            overview: None,
            genre_ids: Some("[18,53]".into()),
            runtime_minutes: None,
            genres: None,
            cast_json: None,
            trailer_youtube_key: None,
            searched_at: "2026-09-25T12:00:00+00:00".into(),
            details_fetched_at: None,
        };
        let card = card_from_row(7, &row).unwrap();
        assert_eq!(card.channel_id, 7);
        assert_eq!(card.genres, vec!["Drama", "Thriller"]);
        assert_eq!(
            card.poster_url.as_deref(),
            Some("https://image.tmdb.org/t/p/w342/p.jpg")
        );
        assert_eq!(
            card.backdrop_url.as_deref(),
            Some("https://image.tmdb.org/t/p/w1280/b.jpg")
        );
        row.genres = Some("[\"Drama\",\"Mystery\"]".into());
        assert_eq!(
            card_from_row(7, &row).unwrap().genres,
            vec!["Drama", "Mystery"]
        );
        row.tmdb_id = None;
        assert!(card_from_row(7, &row).is_none());
    }

    #[test]
    fn duplicate_titles_share_one_job_with_both_channel_ids() {
        let channels = vec![
            channel(1, "Dune (2021)", "vod"),
            channel(2, "DUNE (2021)", "vod"),
            channel(3, "Skin", "vod"),
        ];
        let jobs = group_jobs(&channels);
        assert_eq!(jobs.len(), 2);
        let dune = jobs.iter().find(|j| j.key.title == "dune").unwrap();
        assert_eq!(dune.channel_ids, vec![1, 2]);
    }

    #[test]
    fn cached_cards_are_withheld_while_the_feature_is_off() {
        let pool = r2d2::Pool::builder()
            .max_size(1)
            .build(r2d2_sqlite::SqliteConnectionManager::memory())
            .unwrap();
        let conn = pool.get().unwrap();
        crate::db::schema::init_schema(&conn).unwrap();
        let playlist_id = crate::db::test_helpers::create_test_playlist(&conn, "p");
        let mut movie = channel(0, "Shutter Island (2010)", "vod");
        movie.id = None;
        movie.playlist_id = playlist_id;
        let id = mutations::create_channel(&conn, &movie).unwrap();
        movie.id = Some(id);
        let (key, _, _) = cache_key_for(&movie).unwrap();
        mutations::upsert_tmdb_search(
            &conn,
            &TmdbRow {
                key,
                tmdb_id: Some(11324),
                manual: false,
                title: Some("Shutter Island".into()),
                original_title: None,
                release_year: Some(2010),
                rating: Some(8.2),
                vote_count: None,
                poster_path: Some("/p.jpg".into()),
                backdrop_path: None,
                overview: None,
                genre_ids: Some("[18]".into()),
                runtime_minutes: None,
                genres: None,
                cast_json: None,
                trailer_youtube_key: None,
                searched_at: Utc::now().to_rfc3339(),
                details_fetched_at: None,
            },
        )
        .unwrap();

        mutations::set_setting(&conn, "tmdb_enabled", "0").unwrap();
        let (jobs, cards) = cached_cards(&conn, &[id]).unwrap();
        assert!(jobs.is_empty(), "nothing is queued while off");
        assert!(cards.is_empty(), "cached matches are withheld while off");

        mutations::set_setting(&conn, "tmdb_enabled", "1").unwrap();
        let (jobs, cards) = cached_cards(&conn, &[id]).unwrap();
        assert!(jobs.is_empty(), "a fresh row needs no search");
        assert_eq!(cards.len(), 1);
        assert_eq!(cards[0].channel_id, id);
        assert_eq!(cards[0].tmdb_id, 11324);
        assert_eq!(cards[0].genres, vec!["Drama"]);
    }

    #[test]
    fn details_from_a_row_map_cast_and_trailer() {
        let row = TmdbRow {
            key: TmdbKey {
                title: "x".into(),
                year: 0,
                content_type: "vod".into(),
            },
            tmdb_id: Some(11324),
            manual: true,
            title: Some("Shutter Island".into()),
            original_title: Some("Shutter Island".into()),
            release_year: Some(2010),
            rating: Some(8.2),
            vote_count: None,
            poster_path: Some("/p.jpg".into()),
            backdrop_path: None,
            overview: Some("A marshal.".into()),
            genre_ids: None,
            runtime_minutes: Some(138),
            genres: Some("[\"Drama\"]".into()),
            cast_json: Some(
                r#"[{"name":"Leonardo DiCaprio","character":"Teddy Daniels","profile_path":"/l.jpg"}]"#
                    .into(),
            ),
            trailer_youtube_key: Some("qdPw9x9h5CY".into()),
            searched_at: "2026-09-25T12:00:00+00:00".into(),
            details_fetched_at: Some("2026-09-25T12:00:00+00:00".into()),
        };
        let d = details_from_row(true, &row);
        assert!(d.available && d.matched && d.manual);
        assert_eq!(
            d.poster_url.as_deref(),
            Some("https://image.tmdb.org/t/p/w780/p.jpg")
        );
        assert_eq!(
            d.cast[0].photo_url.as_deref(),
            Some("https://image.tmdb.org/t/p/w185/l.jpg")
        );
        assert_eq!(
            d.trailer_url.as_deref(),
            Some("https://www.youtube.com/watch?v=qdPw9x9h5CY")
        );
        assert_eq!(d.runtime_minutes, Some(138));
    }

    #[test]
    fn provider_only_details_are_explicit_about_why() {
        let d = provider_only_details(false, false);
        assert!(!d.available && !d.matched && !d.manual);
        let manual_no = provider_only_details(true, true);
        assert!(manual_no.available && !manual_no.matched && manual_no.manual);
    }
}
