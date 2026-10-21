use r2d2::Pool;
use r2d2_sqlite::SqliteConnectionManager;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::PathBuf;
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

    /// TMDB session flags and the in-flight enrichment set.
    pub tmdb: Arc<crate::tmdb::session::TmdbSession>,

    /// Identifies this app launch (milliseconds since the epoch); dead-logo
    /// marks are stamped with it so a mark needs two separate launches to
    /// count as dead.
    pub launch_id: i64,

    /// Serialises the logo-fallback maintenance runs.
    pub logo_fallback_lock: Arc<tokio::sync::Mutex<()>>,

    /// `<app_data>/epg/`: each guide source's cached feed and the ingest's
    /// staging database (see `epg::sources`).
    pub epg_cache_dir: PathBuf,

    /// The database file the pool is opened on. A guide ingest opens a
    /// connection of its own on it (`epg::store::IngestConnection`).
    pub db_path: PathBuf,

    /// Guide sources with a download queued or running. An id goes in when
    /// the request is made and comes out when its ingest ends, so a second
    /// request for a busy source starts nothing (`epg::service`).
    pub epg_refreshing: Arc<Mutex<HashSet<i64>>>,

    /// Guide sources with a re-read of the cached feed queued after a time
    /// policy change; further changes meanwhile only update the policy.
    pub epg_pending_policy: Arc<Mutex<HashSet<i64>>>,
}

impl AppState {
    pub fn new(
        pool: Pool<SqliteConnectionManager>,
        db_path: PathBuf,
        epg_cache_dir: PathBuf,
    ) -> Self {
        Self {
            pool,
            current_channel: Arc::new(RwLock::new(None)),
            mpv_player: Arc::new(Mutex::new(crate::playback::mpv::MpvPlayer::new())),
            epg_refresh_lock: Arc::new(tokio::sync::Mutex::new(())),
            tmdb: Arc::new(crate::tmdb::session::TmdbSession::default()),
            launch_id: chrono::Utc::now().timestamp_millis(),
            logo_fallback_lock: Arc::new(tokio::sync::Mutex::new(())),
            epg_cache_dir,
            db_path,
            epg_refreshing: Arc::new(Mutex::new(HashSet::new())),
            epg_pending_policy: Arc::new(Mutex::new(HashSet::new())),
        }
    }
}
