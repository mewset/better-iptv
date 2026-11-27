//! Watch progress commands, and the recording the playback commands and the
//! background task share (`playback::progress`).

use crate::commands::with_db;
use crate::error::AppError;
use crate::playback::ipc;
use crate::playback::progress::{self, Session, WatchProgress};
use crate::state::AppState;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tauri::State;

/// How often the background task asks MPV where it is.
pub const RECORD_EVERY: Duration = Duration::from_secs(5);

fn now() -> i64 {
    chrono::Utc::now().timestamp()
}

/// Ask MPV where it is and save it for the session playing. A snapshot taken
/// while the session changed is dropped: it may come from the new player.
fn record_blocking(state: &AppState) {
    let Some(mut session) = state.watching.lock().ok().and_then(|g| g.clone()) else {
        return;
    };
    let Some(snap) = ipc::snapshot(&ipc::socket_path()) else {
        return;
    };
    let writes = progress::step(&mut session, snap);
    {
        let Ok(mut guard) = state.watching.lock() else {
            return;
        };
        match guard.as_mut() {
            Some(current) if current.id == session.id => {
                current.last_playlist_pos = session.last_playlist_pos;
            }
            _ => return,
        }
    }
    if writes.is_empty() {
        return;
    }
    match state.pool.get() {
        Ok(conn) => {
            if let Err(e) = progress::apply(&conn, &writes, now()) {
                log::warn!("Could not save watch progress: {e}");
            }
        }
        Err(e) => log::warn!("Could not save watch progress: {e}"),
    }
}

/// Save where the current session is now.
pub async fn record_now(state: &AppState) {
    let state = state.clone();
    let _ = tokio::task::spawn_blocking(move || record_blocking(&state)).await;
}

/// Before MPV is replaced or stopped: save the session's last position and
/// end it, so a snapshot of the next player is never put down to it.
pub async fn end_session(state: &AppState) {
    record_now(state).await;
    if let Ok(mut guard) = state.watching.lock() {
        *guard = None;
    }
}

/// After MPV started a film or episodes: track them.
pub fn begin_session(state: &AppState, channel_id: i64, episodes: Vec<String>) {
    static NEXT_ID: AtomicU64 = AtomicU64::new(1);
    if let Ok(mut guard) = state.watching.lock() {
        *guard = Some(Session {
            id: NEXT_ID.fetch_add(1, Ordering::Relaxed),
            channel_id,
            episodes,
            last_playlist_pos: 0,
        });
    }
}

/// Records the session every few seconds, for as long as the app runs.
pub async fn run_recorder(state: AppState) {
    let mut tick = tokio::time::interval(RECORD_EVERY);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tick.tick().await;
        record_now(&state).await;
    }
}

/// Every title with progress in a profile, most recently watched first.
#[tauri::command]
pub async fn get_watch_progress(
    state: State<'_, AppState>,
    playlist_id: i64,
) -> Result<Vec<WatchProgress>, AppError> {
    with_db(&state.pool, move |conn| {
        Ok(progress::list(conn, playlist_id)?)
    })
    .await
}

/// Mark a film (no episode id) or an episode watched, or forget it.
#[tauri::command]
pub async fn set_watched(
    state: State<'_, AppState>,
    channel_id: i64,
    episode_id: Option<String>,
    watched: bool,
) -> Result<(), AppError> {
    with_db(&state.pool, move |conn| {
        let episode = episode_id.unwrap_or_default();
        Ok(progress::set_watched(
            conn,
            channel_id,
            &episode,
            watched,
            now(),
        )?)
    })
    .await
}
