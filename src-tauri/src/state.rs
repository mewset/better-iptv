use r2d2::Pool;
use r2d2_sqlite::SqliteConnectionManager;
use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};
use tokio::sync::RwLock;

/// Lightweight struct for tracking current channel (avoids cloning full Channel)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CurrentChannel {
    pub id: Option<i64>,
    pub name: String,
    pub url: String,
    pub content_type: String,
}

impl CurrentChannel {
    /// Create from a full Channel struct, extracting only necessary fields
    pub fn from_channel(c: &crate::db::models::Channel) -> Self {
        Self {
            id: c.id,
            name: c.name.clone(),
            url: c.url.clone(),
            content_type: c.content_type.clone(),
        }
    }
}

/// Global application state shared across all Tauri commands
#[derive(Clone)]
pub struct AppState {
    /// Database connection pool
    pub pool: Pool<SqliteConnectionManager>,

    /// Currently playing channel (if any) - uses lightweight struct
    pub current_channel: Arc<RwLock<Option<CurrentChannel>>>,

    /// MPV player instance. Every MpvPlayer operation is synchronous (process
    /// spawn, kill, wait), so a std mutex is used and callers hold it only on
    /// the blocking pool — see `playback::play_stream` and friends.
    pub mpv_player: crate::playback::SharedPlayer,

    /// Serialises manual (Update Now, EPG URL save) and automatic EPG
    /// refreshes so they never download and store concurrently.
    pub epg_refresh_lock: Arc<tokio::sync::Mutex<()>>,
}

impl AppState {
    pub fn new(pool: Pool<SqliteConnectionManager>) -> Self {
        Self {
            pool,
            current_channel: Arc::new(RwLock::new(None)),
            mpv_player: Arc::new(Mutex::new(crate::playback::mpv::MpvPlayer::new())),
            epg_refresh_lock: Arc::new(tokio::sync::Mutex::new(())),
        }
    }
}
