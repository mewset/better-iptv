//! Background enrichment: one search per queued title, result written to
//! the cache and pushed to the frontend as a `tmdb-card` event.

use crate::commands::tmdb::{card_from_row, TmdbCard};
use crate::commands::with_db;
use crate::db::models::{TmdbKey, TmdbRow};
use crate::db::{mutations, queries};
use crate::error::AppError;
use crate::state::AppState;
use crate::tmdb::keys::{handle_unauthorized, read_language, resolve_key};
use crate::tmdb::session::TmdbSession;
use crate::tmdb::{Kind, TmdbClient, TmdbError};
use crate::tmdb_domain::{pick_match, Normalized};
use chrono::Utc;
use log::{debug, warn};
use r2d2::Pool;
use r2d2_sqlite::SqliteConnectionManager;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

#[derive(Debug, Clone)]
pub struct EnrichJob {
    pub key: TmdbKey,
    pub query: Normalized,
    pub kind: Kind,
    pub channel_ids: Vec<i64>,
}

#[derive(Serialize, Clone)]
struct CardEvent {
    channel_ids: Vec<i64>,
    card: TmdbCard,
}

pub const CARD_EVENT: &str = "tmdb-card";

/// The in-flight key string, shared by the command and the worker.
pub fn claim_key(key: &TmdbKey) -> String {
    format!("{}|{}|{}", key.content_type, key.title, key.year)
}

/// Search TMDB for one title and write the result (match or no-match).
/// Returns the stored row, or `None` when no key resolves or the request
/// failed (nothing is written then, so the next visit retries).
pub async fn search_and_store(
    pool: &Pool<SqliteConnectionManager>,
    session: &TmdbSession,
    key: &TmdbKey,
    query: &Normalized,
    kind: Kind,
) -> Result<Option<TmdbRow>, AppError> {
    let Some(resolved) = resolve_key(pool, session).await? else {
        return Ok(None);
    };
    let lang = with_db(pool, |conn| Ok(read_language(conn)?)).await?;
    let client = TmdbClient::new(&resolved.key);
    let hits = match client.search(kind, &query.title, query.year, &lang).await {
        Ok(hits) => hits,
        Err(TmdbError::Unauthorized) => {
            handle_unauthorized(pool, session, resolved.source).await?;
            return Ok(None);
        }
        Err(e) => {
            debug!("TMDB search for {:?} failed: {e}", query.title);
            return Ok(None);
        }
    };
    let candidates: Vec<_> = hits.iter().map(|h| h.to_candidate()).collect();
    let chosen = pick_match(query, &candidates).map(|c| c.id);
    let hit = chosen.and_then(|id| hits.iter().find(|h| h.id == id));
    let row = TmdbRow {
        key: key.clone(),
        tmdb_id: hit.map(|h| h.id),
        manual: false,
        title: hit.map(|h| h.title.clone()),
        original_title: hit.map(|h| h.original_title.clone()),
        release_year: hit.and_then(|h| h.year),
        rating: hit.and_then(|h| h.rating),
        poster_path: hit.and_then(|h| h.poster_path.clone()),
        backdrop_path: hit.and_then(|h| h.backdrop_path.clone()),
        overview: hit.and_then(|h| h.overview.clone()),
        genre_ids: hit.map(|h| serde_json::to_string(&h.genre_ids).unwrap_or_else(|_| "[]".into())),
        runtime_minutes: None,
        genres: None,
        cast_json: None,
        trailer_youtube_key: None,
        searched_at: Utc::now().to_rfc3339(),
        details_fetched_at: None,
    };
    let key_for_read = key.clone();
    let final_row = with_db(pool, move |conn| {
        mutations::upsert_tmdb_search(conn, &row)?;
        // A manual row ignores the upsert; read back what is actually stored.
        Ok(queries::get_tmdb_row(conn, &key_for_read)?)
    })
    .await?;
    Ok(final_row)
}

/// Start the worker on Tauri's runtime. Called once from `lib.rs` setup.
pub fn spawn_worker(app: AppHandle) {
    let state = app.state::<AppState>();
    let Some(mut rx) = state.tmdb.take_receiver() else {
        warn!("TMDB worker already started");
        return;
    };
    let pool = state.pool.clone();
    let session = state.tmdb.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(job) = rx.recv().await {
            let app = app.clone();
            let pool = pool.clone();
            let session = session.clone();
            // The client's semaphore bounds real concurrency at 4.
            tauri::async_runtime::spawn(async move {
                let claim = claim_key(&job.key);
                let result =
                    search_and_store(&pool, &session, &job.key, &job.query, job.kind).await;
                session.release(&claim);
                match result {
                    Ok(Some(row)) => {
                        if let Some(card) = card_from_row(job.channel_ids[0], &row) {
                            let event = CardEvent {
                                channel_ids: job.channel_ids,
                                card,
                            };
                            if let Err(e) = app.emit(CARD_EVENT, event) {
                                warn!("TMDB: failed to emit {CARD_EVENT}: {e}");
                            }
                        }
                    }
                    Ok(None) => {}
                    Err(e) => warn!("TMDB enrichment failed for {:?}: {e}", job.query.title),
                }
            });
        }
    });
}
