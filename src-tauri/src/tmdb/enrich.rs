//! Enrichment worker: one search per queued title, result written to the
//! cache and pushed to the frontend as a `tmdb-card` event. Two queues feed
//! it: the visible rows (foreground, served first) and the opt-in library
//! scan (background, paced so it never crowds the foreground out).

use crate::commands::tmdb::{card_from_row, TmdbCard};
use crate::commands::with_db;
use crate::db::models::{TmdbKey, TmdbRow};
use crate::db::{mutations, queries};
use crate::error::AppError;
use crate::state::AppState;
use crate::tmdb::keys::{handle_unauthorized, read_language, resolve_key};
use crate::tmdb::session::{generation_is_stale, is_stale_job, BackgroundProgress, TmdbSession};
use crate::tmdb::{Kind, TmdbClient, TmdbError};
use crate::tmdb_domain::{pick_match, Normalized};
use chrono::Utc;
use log::{debug, warn};
use r2d2::Pool;
use r2d2_sqlite::SqliteConnectionManager;
use serde::Serialize;
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tokio::time::Instant;

#[derive(Debug, Clone)]
pub struct EnrichJob {
    pub key: TmdbKey,
    pub query: Normalized,
    pub kind: Kind,
    pub channel_ids: Vec<i64>,
    /// 0 for a foreground job; the scan generation for a background one.
    pub generation: u64,
}

#[derive(Serialize, Clone)]
struct CardEvent {
    channel_ids: Vec<i64>,
    card: TmdbCard,
}

pub const CARD_EVENT: &str = "tmdb-card";
pub const BACKGROUND_PROGRESS_EVENT: &str = "tmdb-background-progress";

/// Background jobs start at most this often (five per second), so the
/// library scan stays gentle on TMDB and on the four shared permits.
pub const BACKGROUND_MIN_INTERVAL: Duration = Duration::from_millis(200);

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
            handle_unauthorized(pool, session, &resolved).await?;
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

fn emit_progress(app: &AppHandle, progress: BackgroundProgress) {
    if let Err(e) = app.emit(BACKGROUND_PROGRESS_EVENT, progress) {
        warn!("TMDB: failed to emit {BACKGROUND_PROGRESS_EVENT}: {e}");
    }
}

/// Search one job, release its claim, and push the card to the frontend.
async fn run_job(
    app: &AppHandle,
    pool: &Pool<SqliteConnectionManager>,
    session: &TmdbSession,
    job: EnrichJob,
) {
    let claim = claim_key(&job.key);
    let result = search_and_store(pool, session, &job.key, &job.query, job.kind).await;
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
}

/// A background job: the search, then exactly one progress event, unless
/// the scan was cancelled while the search ran.
async fn run_background_job(
    app: &AppHandle,
    pool: &Pool<SqliteConnectionManager>,
    session: &TmdbSession,
    job: EnrichJob,
) {
    let generation = job.generation;
    run_job(app, pool, session, job).await;
    if generation_is_stale(generation, session.current_generation()) {
        return;
    }
    let (done, total) = session.note_background_done();
    emit_progress(
        app,
        BackgroundProgress {
            done,
            total,
            running: done < total,
        },
    );
}

/// Start the worker on Tauri's runtime. Called once from `lib.rs` setup.
///
/// The loop is biased to the foreground queue: a background job is only
/// taken while the foreground queue is empty and `BACKGROUND_MIN_INTERVAL`
/// has passed since the previous background job started. Both kinds run on
/// their own task, so the loop keeps dispatching; the client's semaphore
/// bounds real concurrency at four.
pub fn spawn_worker(app: AppHandle) {
    let state = app.state::<AppState>();
    let (Some(mut rx), Some(mut bg_rx)) = (
        state.tmdb.take_receiver(),
        state.tmdb.take_background_receiver(),
    ) else {
        warn!("TMDB worker already started");
        return;
    };
    let pool = state.pool.clone();
    let session: Arc<TmdbSession> = state.tmdb.clone();
    tauri::async_runtime::spawn(async move {
        let mut next_background_at = Instant::now();
        loop {
            tokio::select! {
                biased;
                job = rx.recv() => {
                    let Some(job) = job else { break };
                    let (app, pool, session) = (app.clone(), pool.clone(), session.clone());
                    tauri::async_runtime::spawn(async move {
                        run_job(&app, &pool, &session, job).await;
                    });
                }
                job = async {
                    tokio::time::sleep_until(next_background_at).await;
                    bg_rx.recv().await
                } => {
                    let Some(job) = job else { break };
                    if is_stale_job(&job, session.current_generation()) {
                        // Cancelled scan: free the claim so a visible row can
                        // search it right away; no pacing cost for a drop.
                        session.release(&claim_key(&job.key));
                        continue;
                    }
                    next_background_at = Instant::now() + BACKGROUND_MIN_INTERVAL;
                    let (app, pool, session) = (app.clone(), pool.clone(), session.clone());
                    tauri::async_runtime::spawn(async move {
                        run_background_job(&app, &pool, &session, job).await;
                    });
                }
            }
        }
    });
}
