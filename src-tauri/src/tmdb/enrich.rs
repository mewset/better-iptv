//! Enrichment worker: one search per queued title, result written to the
//! cache and pushed to the frontend as a `tmdb-card` event. Two queues feed
//! it: the visible rows (foreground, served first) and the opt-in library
//! scan (background, paced so it never crowds the foreground out).

use crate::commands::tmdb::{card_from_row, group_jobs, TmdbCard};
use crate::commands::with_db;
use crate::db::models::{Channel, TmdbKey, TmdbRow};
use crate::db::{mutations, queries};
use crate::error::AppError;
use crate::state::AppState;
use crate::tmdb::keys::{
    handle_unauthorized, read_key_settings, read_language, resolve_key, TMDB_BACKGROUND_ENRICH_KEY,
};
use crate::tmdb::session::{generation_is_stale, is_stale_job, BackgroundProgress, TmdbSession};
use crate::tmdb::{Kind, TmdbClient, TmdbError};
use crate::tmdb_domain::{pick_match, search_is_stale, Normalized};
use chrono::Utc;
use log::{debug, info, warn};
use r2d2::Pool;
use r2d2_sqlite::SqliteConnectionManager;
use rusqlite::Connection;
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
/// The startup scan waits this long so it never competes with the first
/// channel load and the visible rows' own lookups.
pub const BACKGROUND_SCAN_START_DELAY: Duration = Duration::from_secs(30);

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

/// Whether the library scan may run right now: the feature on, the flag on
/// and the user's own key present. Re-read on every scan, so the shared key
/// never carries background load.
pub fn background_scan_allowed(conn: &Connection) -> rusqlite::Result<bool> {
    let settings = read_key_settings(conn)?;
    let flag_on = queries::get_setting(conn, TMDB_BACKGROUND_ENRICH_KEY)?.is_some_and(|v| v == "1");
    Ok(settings.enabled
        && flag_on
        && settings
            .user_key
            .as_deref()
            .is_some_and(|k| !k.trim().is_empty()))
}

/// The active profile, or the oldest playlist until one has been chosen
/// (the first launch imports before `active_profile_id` exists).
pub fn active_playlist_id(conn: &Connection) -> rusqlite::Result<Option<i64>> {
    if let Some(id) = queries::get_setting(conn, "active_profile_id")?.and_then(|s| s.parse().ok())
    {
        return Ok(Some(id));
    }
    Ok(queries::get_playlists(conn)?.first().and_then(|p| p.id))
}

/// One job per movie or series title without a fresh cache row, every
/// channel sharing a title grouped into it. Live channels are skipped.
pub fn plan_background_jobs(
    channels: &[Channel],
    is_fresh: &dyn Fn(&TmdbKey) -> bool,
) -> Vec<EnrichJob> {
    group_jobs(channels)
        .into_iter()
        .filter(|job| !is_fresh(&job.key))
        .collect()
}

/// The database half of a scan: the active profile's channels, filtered
/// by the same freshness rule `get_tmdb_cards` uses.
fn plan_library_scan(conn: &Connection) -> Result<Vec<EnrichJob>, AppError> {
    let Some(playlist_id) = active_playlist_id(conn)? else {
        return Ok(Vec::new());
    };
    let channels = queries::get_channels(conn, Some(playlist_id))?;
    let now = Utc::now();
    let is_fresh = |key: &TmdbKey| {
        queries::get_tmdb_row(conn, key)
            .ok()
            .flatten()
            .is_some_and(|row| {
                !search_is_stale(&row.searched_at, now, row.tmdb_id.is_some(), row.manual)
            })
    };
    Ok(plan_background_jobs(&channels, &is_fresh))
}

/// Queue every unsearched movie and series of the active profile behind the
/// foreground work. A no-op unless the user opted in with an own key, and
/// while a previous scan is still running.
pub fn schedule_library_scan(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        if let Err(e) = run_library_scan(&app).await {
            warn!("TMDB library scan failed: {e}");
        }
    });
}

async fn run_library_scan(app: &AppHandle) -> Result<(), AppError> {
    let state = app.state::<AppState>();
    let pool = state.pool.clone();
    let session: Arc<TmdbSession> = state.tmdb.clone();
    if !with_db(&pool, |conn| Ok(background_scan_allowed(conn)?)).await? {
        debug!("TMDB library scan not enabled");
        return Ok(());
    }
    if !session.try_begin_scan() {
        debug!("TMDB library scan already running");
        return Ok(());
    }
    let started = std::time::Instant::now();
    let jobs = match with_db(&pool, plan_library_scan).await {
        Ok(jobs) => jobs,
        Err(e) => {
            session.end_scan();
            return Err(e);
        }
    };
    debug!(
        "TMDB library scan planned {} titles in {:?}",
        jobs.len(),
        started.elapsed()
    );
    let generation = session.current_generation();
    let total = jobs.len() as u64;
    session.start_background(total);
    let mut queued = 0u64;
    for mut job in jobs {
        if session.try_claim(&claim_key(&job.key)) {
            job.generation = generation;
            session.enqueue_background(job);
            queued += 1;
        } else {
            // A visible row is searching it right now; that counts.
            session.note_background_done();
        }
    }
    info!("TMDB library scan: {queued} of {total} titles queued");
    if let Some(progress) = session.background_progress() {
        emit_progress(app, progress);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::models::Channel;
    use crate::db::mutations::set_setting;
    use crate::db::test_helpers::{create_test_playlist, setup_test_db};
    use crate::tmdb::keys::{TMDB_API_KEY_KEY, TMDB_BACKGROUND_ENRICH_KEY, TMDB_ENABLED_KEY};

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
    fn the_plan_dedupes_titles_skips_live_and_fresh_rows_and_keeps_ids_grouped() {
        let channels = vec![
            channel(1, "SVT1", "live"),
            channel(2, "Dune (2021)", "vod"),
            channel(3, "DUNE (2021)", "vod"),
            channel(4, "Shutter Island (2010)", "vod"),
            channel(5, "Fullt Hus", "series"),
        ];
        let is_fresh = |key: &TmdbKey| key.title == "shutter island";
        let jobs = plan_background_jobs(&channels, &is_fresh);
        assert_eq!(
            jobs.len(),
            2,
            "live and fresh titles are left out: {jobs:?}"
        );
        assert_eq!(jobs[0].key.title, "dune");
        assert_eq!(jobs[0].channel_ids, vec![2, 3]);
        assert_eq!(jobs[0].kind, Kind::Movie);
        assert_eq!(jobs[1].key.title, "fullt hus");
        assert_eq!(jobs[1].channel_ids, vec![5]);
        assert_eq!(jobs[1].kind, Kind::Tv);
        assert!(
            jobs.iter().all(|j| j.generation == 0),
            "the scheduler stamps the generation, not the planner"
        );
    }

    #[test]
    fn a_scan_needs_the_feature_on_the_flag_on_and_an_own_key() {
        let conn = setup_test_db();
        assert!(
            !background_scan_allowed(&conn).unwrap(),
            "flag defaults to off"
        );
        set_setting(&conn, TMDB_BACKGROUND_ENRICH_KEY, "1").unwrap();
        assert!(
            !background_scan_allowed(&conn).unwrap(),
            "no own key: the shared key must never carry the scan"
        );
        set_setting(&conn, TMDB_API_KEY_KEY, "own-key").unwrap();
        assert!(background_scan_allowed(&conn).unwrap());
        set_setting(&conn, TMDB_ENABLED_KEY, "0").unwrap();
        assert!(!background_scan_allowed(&conn).unwrap(), "feature off");
    }

    #[test]
    fn the_scan_covers_the_active_profile_or_the_oldest_playlist_before_one_is_set() {
        let conn = setup_test_db();
        assert_eq!(active_playlist_id(&conn).unwrap(), None);
        let first = create_test_playlist(&conn, "first");
        let second = create_test_playlist(&conn, "second");
        assert_eq!(active_playlist_id(&conn).unwrap(), Some(first));
        set_setting(&conn, "active_profile_id", &second.to_string()).unwrap();
        assert_eq!(active_playlist_id(&conn).unwrap(), Some(second));
    }
}
