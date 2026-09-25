//! TMDB IPC commands. Orchestration only; logic is in `tmdb_domain`,
//! HTTP in `tmdb`, persistence in `db`.

use crate::commands::with_db;
use crate::db::models::{Channel, TmdbKey, TmdbRow};
use crate::db::queries;
use crate::error::AppError;
use crate::state::AppState;
use crate::tmdb::enrich::{claim_key, EnrichJob};
use crate::tmdb::keys::{read_key_settings, read_language};
use crate::tmdb::{Kind, TmdbClient};
use crate::tmdb_domain::{
    genre_name, image_url, normalize_title, search_is_stale, ImageSize, Normalized,
};
use chrono::{Datelike, Utc};
use log::debug;
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
    let (enabled, jobs, cards) = with_db(&state.pool, move |conn| {
        let enabled = read_key_settings(conn)?.enabled;
        let channels = queries::get_channels_by_ids(conn, &channel_ids)?;
        let now = Utc::now();
        let mut cards = Vec::new();
        let mut pending = Vec::new();
        for job in group_jobs(&channels) {
            match queries::get_tmdb_row(conn, &job.key)? {
                Some(row)
                    if !search_is_stale(
                        &row.searched_at,
                        now,
                        row.tmdb_id.is_some(),
                        row.manual,
                    ) =>
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
        Ok((enabled, pending, cards))
    })
    .await?;

    if enabled {
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
    }
    Ok(cards)
}

#[tauri::command]
pub async fn get_tmdb_status(state: State<'_, AppState>) -> Result<TmdbStatus, AppError> {
    let (settings, language) = with_db(&state.pool, |conn| {
        Ok((read_key_settings(conn)?, read_language(conn)?))
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
}
