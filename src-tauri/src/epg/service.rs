//! The refresh service: when guide sources are fetched, one at a time, and
//! what the frontend is told afterwards.
//!
//! Every ingest runs under `AppState::epg_refresh_lock`. The background task
//! takes it with `try_lock` and skips a poll while it is held; requests from
//! the UI queue on it. Two sets coalesce requests per source. An id enters
//! `epg_refreshing` when a download is requested and leaves when its ingest
//! ends, whatever the outcome; a request for a source already in the set
//! starts nothing, so two downloads of one source never run. An id enters
//! `epg_pending_policy` when a time policy change queues a re-read of the
//! cached feed and leaves when that re-read takes the lock; changes meanwhile
//! only update the configured policy, and the one re-read uses the last.
//!
//! After a download, a configured policy that differs from the one the rows
//! were stored under (it changed while the feed was read) is applied at once
//! by re-reading the cached feed.
//!
//! Events go through `EpgEvents`, so the service runs without a Tauri
//! runtime in tests: `epg-refreshed` (`EpgRefreshed`) after anything that
//! changes what the guide shows, `epg-status` (`EpgStatus`) whenever a
//! source's row in Settings changes, including the start and end of every
//! attempt.

use super::read::active_profile;
use super::sources::{
    self, add_manual_source, get_source, has_cached_feed, list_sources, SourcePatch,
};
use super::status::{epg_status, source_status, EpgSourceStatus, EpgStatus};
use super::{ingest, Fetch, IngestEnv, IngestOutcome, IngestPermit, IngestScope};
use crate::commands::with_db;
use crate::epg_domain::policy::TimePolicy;
use crate::epg_domain::source::{applies_to, source_due};
use crate::error::AppError;
use crate::state::AppState;
use log::{debug, info, warn};
use r2d2::Pool;
use r2d2_sqlite::SqliteConnectionManager;
use rusqlite::Connection;
use serde::Serialize;
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::task::JoinHandle;

/// First automatic check after startup; leaves the UI's own startup traffic
/// alone. The same as the single-URL refresh it replaces.
pub const AUTO_REFRESH_INITIAL_DELAY: Duration = Duration::from_secs(30);
/// How often the background task checks whether a source is due.
pub const AUTO_REFRESH_POLL_INTERVAL: Duration = Duration::from_secs(15 * 60);

/// Event names, as the frontend listens for them.
pub const REFRESHED_EVENT: &str = "epg-refreshed";
pub const STATUS_EVENT: &str = "epg-status";

/// Why the guide changed.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RefreshReason {
    /// A download was stored, complete or partial.
    Ingest,
    /// The cached feed was read again under a new time policy.
    Reingest,
    /// A source was enabled, disabled, removed, re-prioritised or given
    /// another URL.
    SourceChanged,
    /// Another profile became active; other sources apply.
    ProfileSwitch,
    /// Channel matches changed.
    Match,
}

/// The `epg-refreshed` payload: cached now/next and guide data is stale.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct EpgRefreshed {
    pub reason: RefreshReason,
    pub source_id: Option<i64>,
    /// Channels whose match changed; 0 until channel matching exists.
    pub matches_changed: u32,
}

impl EpgRefreshed {
    fn new(reason: RefreshReason, source_id: Option<i64>) -> Self {
        EpgRefreshed {
            reason,
            source_id,
            matches_changed: 0,
        }
    }
}

/// Where the service's events go: the app emits them to the WebView as
/// `REFRESHED_EVENT` and `STATUS_EVENT`.
pub trait EpgEvents: Send + Sync {
    fn refreshed(&self, event: &EpgRefreshed);
    fn status(&self, status: &EpgStatus);
}

/// Unix seconds now.
pub type Clock = Arc<dyn Fn() -> i64 + Send + Sync>;

/// What the service works with; `from_state` takes it from the app.
pub struct ServiceParts {
    pub pool: Pool<SqliteConnectionManager>,
    pub db_path: PathBuf,
    pub cache_dir: PathBuf,
    pub client: reqwest::Client,
    pub download_deadline: Duration,
    /// `AppState::epg_refresh_lock`.
    pub lock: Arc<tokio::sync::Mutex<()>>,
    /// `AppState::epg_refreshing`.
    pub refreshing: Arc<Mutex<HashSet<i64>>>,
    /// `AppState::epg_pending_policy`.
    pub pending_policy: Arc<Mutex<HashSet<i64>>>,
    pub events: Arc<dyn EpgEvents>,
    pub clock: Clock,
}

impl ServiceParts {
    pub fn from_state(state: &AppState, events: Arc<dyn EpgEvents>) -> Self {
        ServiceParts {
            pool: state.pool.clone(),
            db_path: state.db_path.clone(),
            cache_dir: state.epg_cache_dir.clone(),
            client: crate::http::get_http_client().clone(),
            download_deadline: crate::http::BULK_DOWNLOAD_TIMEOUT,
            lock: state.epg_refresh_lock.clone(),
            refreshing: state.epg_refreshing.clone(),
            pending_policy: state.epg_pending_policy.clone(),
            events,
            clock: Arc::new(|| chrono::Utc::now().timestamp()),
        }
    }
}

/// One source's turn in a run.
#[derive(Debug)]
pub struct SourceRun {
    pub source_id: i64,
    /// The download, or for a policy change the re-read of the cache.
    pub result: Result<IngestOutcome, AppError>,
    /// The re-read of the cache that followed a stored download because
    /// the policy changed meanwhile.
    pub reingest: Option<Result<IngestOutcome, AppError>>,
}

/// A run started in the background; awaiting it is optional.
pub type RunHandle = JoinHandle<Vec<SourceRun>>;

/// Membership of a source in one of the coalescing sets, released on drop,
/// so the id leaves the set on every path, a cancelled task included.
struct Mark {
    set: Arc<Mutex<HashSet<i64>>>,
    id: i64,
}

impl Drop for Mark {
    fn drop(&mut self) {
        lock_set(&self.set).remove(&self.id);
    }
}

fn lock_set(set: &Mutex<HashSet<i64>>) -> std::sync::MutexGuard<'_, HashSet<i64>> {
    // A panic while holding it cannot leave the set half-updated.
    set.lock().unwrap_or_else(|e| e.into_inner())
}

/// Put each id into `set`; returns marks for the ids that were not in it,
/// in the order given.
fn mark(set: &Arc<Mutex<HashSet<i64>>>, ids: impl IntoIterator<Item = i64>) -> Vec<Mark> {
    let mut members = lock_set(set);
    ids.into_iter()
        .filter(|id| members.insert(*id))
        .map(|id| Mark {
            set: set.clone(),
            id,
        })
        .collect()
}

/// Sources the background task fetches now, in precedence order: enabled,
/// applying to the active profile, stale, and not attempted in the last hour.
pub fn due_sources(conn: &Connection, now: i64) -> rusqlite::Result<Vec<i64>> {
    let profile = active_profile(conn)?;
    Ok(list_sources(conn)?
        .into_iter()
        .filter(|s| source_due(&s.schedule(), profile, now))
        .map(|s| s.id)
        .collect())
}

/// Enabled sources that apply to the active profile, in precedence order.
fn applicable_sources(conn: &Connection) -> rusqlite::Result<Vec<i64>> {
    let profile = active_profile(conn)?;
    Ok(list_sources(conn)?
        .into_iter()
        .filter(|s| s.enabled && applies_to(s.playlist_id, profile))
        .map(|s| s.id)
        .collect())
}

/// The refresh service. Cheap to clone; clones share everything.
#[derive(Clone)]
pub struct EpgService {
    parts: Arc<ServiceParts>,
}

impl EpgService {
    pub fn new(parts: ServiceParts) -> Self {
        EpgService {
            parts: Arc::new(parts),
        }
    }

    fn now(&self) -> i64 {
        (self.parts.clock)()
    }

    fn env<'a>(&'a self, permit: &'a IngestPermit) -> IngestEnv<'a> {
        let p = &self.parts;
        IngestEnv {
            pool: &p.pool,
            db_path: &p.db_path,
            cache_dir: &p.cache_dir,
            client: &p.client,
            download_deadline: p.download_deadline,
            permit,
        }
    }

    async fn db<T, F>(&self, f: F) -> Result<T, AppError>
    where
        F: FnOnce(&Connection) -> Result<T, AppError> + Send + 'static,
        T: Send + 'static,
    {
        with_db(&self.parts.pool, f).await
    }

    async fn wait_for_lock(&self) -> IngestPermit {
        IngestPermit::new(self.parts.lock.clone().lock_owned().await)
    }

    // ========== Events ==========

    fn refreshed(&self, reason: RefreshReason, source_id: Option<i64>) {
        self.parts
            .events
            .refreshed(&EpgRefreshed::new(reason, source_id));
    }

    /// Emit the current status; a failure to read it is logged.
    async fn emit_status(&self) {
        let (cache_dir, refreshing, now) = (
            self.parts.cache_dir.clone(),
            self.parts.refreshing.clone(),
            self.now(),
        );
        let status = self
            .db(move |conn| {
                let refreshing = lock_set(&refreshing).clone();
                Ok(epg_status(conn, &cache_dir, &refreshing, now)?)
            })
            .await;
        match status {
            Ok(status) => self.parts.events.status(&status),
            Err(e) => warn!("EPG status not sent: {e}"),
        }
    }

    // ========== Downloads ==========

    /// Download one source, or every enabled source of the active profile,
    /// now, whether or not it is due. Returns at once; `None` when every
    /// source asked for already has a download queued or running.
    pub async fn refresh(&self, source_id: Option<i64>) -> Result<Option<RunHandle>, AppError> {
        let ids = self
            .db(move |conn| match source_id {
                Some(id) => match get_source(conn, id)? {
                    Some(_) => Ok(vec![id]),
                    None => Err(AppError::InvalidInput(format!(
                        "Guide source {id} not found"
                    ))),
                },
                None => Ok(applicable_sources(conn)?),
            })
            .await?;
        Ok(self.spawn_downloads(ids))
    }

    /// Download the sources that are due now, in the background. Run after
    /// anything that can make a source due: enabling it, a new URL, a
    /// profile switch.
    pub async fn check_due(&self) -> Result<Option<RunHandle>, AppError> {
        let now = self.now();
        let ids = self.db(move |conn| Ok(due_sources(conn, now)?)).await?;
        Ok(self.spawn_downloads(ids))
    }

    /// Mark the ids now, then download them one at a time in a task, each
    /// under the refresh lock.
    fn spawn_downloads(&self, ids: Vec<i64>) -> Option<RunHandle> {
        let marks = mark(&self.parts.refreshing, ids);
        if marks.is_empty() {
            return None;
        }
        let service = self.clone();
        Some(tokio::spawn(async move {
            service.emit_status().await;
            let mut runs = Vec::with_capacity(marks.len());
            for mark in marks {
                let permit = service.wait_for_lock().await;
                let run = service.download(mark.id, &permit).await;
                drop(permit);
                drop(mark);
                service.emit_status().await;
                runs.push(run);
            }
            runs
        }))
    }

    /// One background poll: skipped while another refresh holds the lock;
    /// otherwise every due source not already being downloaded, one at a
    /// time, a failure not stopping the others.
    pub async fn tick(&self) -> Vec<SourceRun> {
        let Ok(guard) = self.parts.lock.clone().try_lock_owned() else {
            debug!("EPG auto-refresh: a refresh is already running, skipping");
            return Vec::new();
        };
        let permit = IngestPermit::new(guard);
        let now = self.now();
        let due = match self.db(move |conn| Ok(due_sources(conn, now)?)).await {
            Ok(due) => due,
            Err(e) => {
                warn!("EPG auto-refresh: could not read the sources: {e}");
                return Vec::new();
            }
        };
        let marks = mark(&self.parts.refreshing, due);
        if marks.is_empty() {
            return Vec::new();
        }
        info!("EPG auto-refresh: {} source(s) due", marks.len());
        self.emit_status().await;
        let mut runs = Vec::with_capacity(marks.len());
        for mark in marks {
            runs.push(self.download(mark.id, &permit).await);
            drop(mark);
            self.emit_status().await;
        }
        runs
    }

    /// The background task: a first check `AUTO_REFRESH_INITIAL_DELAY` after
    /// start, then one every `AUTO_REFRESH_POLL_INTERVAL`. Never returns.
    pub async fn run_background(self) {
        tokio::time::sleep(AUTO_REFRESH_INITIAL_DELAY).await;
        loop {
            self.tick().await;
            tokio::time::sleep(AUTO_REFRESH_POLL_INTERVAL).await;
        }
    }

    /// Download and store one source, then apply a policy that changed
    /// meanwhile. The caller holds the lock.
    async fn download(&self, source_id: i64, permit: &IngestPermit) -> SourceRun {
        let env = self.env(permit);
        let result = ingest(
            &env,
            source_id,
            Fetch::Network,
            IngestScope::Feed,
            self.now(),
        )
        .await;
        let mut reingest = None;
        if matches!(result, Ok(IngestOutcome::Stored(_))) {
            self.refreshed(RefreshReason::Ingest, Some(source_id));
            reingest = self.reingest_if_pending(source_id, permit).await;
        }
        SourceRun {
            source_id,
            result,
            reingest,
        }
    }

    // ========== Time policy ==========

    /// Set a source's time policy. With a cached feed, its programmes are
    /// read again under the new policy in the background (no download);
    /// without one, the next download applies it. Returns at once; `None`
    /// when nothing was queued, or a re-read is already waiting and will
    /// use this policy.
    pub async fn set_time_policy(
        &self,
        source_id: i64,
        policy: TimePolicy,
    ) -> Result<Option<RunHandle>, AppError> {
        self.db(move |conn| sources::set_time_policy(conn, source_id, &policy))
            .await?;
        self.emit_status().await;
        Ok(self.schedule_reingest(source_id))
    }

    fn schedule_reingest(&self, source_id: i64) -> Option<RunHandle> {
        if !has_cached_feed(&self.parts.cache_dir, source_id) {
            return None;
        }
        let queued = mark(&self.parts.pending_policy, [source_id]).pop()?;
        let service = self.clone();
        Some(tokio::spawn(async move {
            let permit = service.wait_for_lock().await;
            // From here a further change queues a re-read of its own: this
            // one may already have read the policy.
            drop(queued);
            let result = service.reingest_if_pending(source_id, &permit).await;
            drop(permit);
            service.emit_status().await;
            result
                .map(|result| SourceRun {
                    source_id,
                    result,
                    reingest: None,
                })
                .into_iter()
                .collect()
        }))
    }

    /// Read the cached feed again when the source's rows are not all under
    /// its configured policy; `None` when they are, or there is no cache.
    /// The caller holds the lock. A failure is logged and leaves the policy
    /// pending.
    async fn reingest_if_pending(
        &self,
        source_id: i64,
        permit: &IngestPermit,
    ) -> Option<Result<IngestOutcome, AppError>> {
        let pending = self
            .db(move |conn| Ok(get_source(conn, source_id)?.is_some_and(|s| s.policy_pending())))
            .await;
        match pending {
            Ok(true) => {}
            Ok(false) => return None,
            Err(e) => {
                warn!("EPG source {source_id}: could not check its time policy: {e}");
                return None;
            }
        }
        if !has_cached_feed(&self.parts.cache_dir, source_id) {
            return None;
        }
        let env = self.env(permit);
        let result = ingest(
            &env,
            source_id,
            Fetch::Cache,
            IngestScope::WholeSource,
            self.now(),
        )
        .await;
        match &result {
            Ok(IngestOutcome::Stored(_)) => {
                self.refreshed(RefreshReason::Reingest, Some(source_id));
            }
            Ok(IngestOutcome::Abandoned(_)) => {}
            Err(e) => warn!("EPG source {source_id}: the new time policy is not applied: {e}"),
        }
        Some(result)
    }

    // ========== Sources and profiles ==========

    /// Add a URL as a global source and start its first download.
    pub async fn add_source(
        &self,
        url: String,
    ) -> Result<(EpgSourceStatus, Option<RunHandle>), AppError> {
        let id = self.db(move |conn| add_manual_source(conn, &url)).await?;
        let run = self.spawn_downloads(vec![id]);
        if run.is_none() {
            self.emit_status().await;
        }
        let (cache_dir, refreshing) = (self.parts.cache_dir.clone(), self.parts.refreshing.clone());
        let status = self
            .db(move |conn| {
                let source = get_source(conn, id)?.ok_or_else(|| {
                    AppError::InvalidInput(format!("Guide source {id} not found"))
                })?;
                let busy = lock_set(&refreshing).contains(&id);
                Ok(source_status(&source, &cache_dir, busy))
            })
            .await?;
        Ok((status, run))
    }

    /// Apply a patch to a source. Enabling it or giving it a new URL runs
    /// the due-check, so it is fetched soon.
    pub async fn update_source(
        &self,
        source_id: i64,
        patch: SourcePatch,
    ) -> Result<Option<RunHandle>, AppError> {
        let cache_dir = self.parts.cache_dir.clone();
        let priority_set = patch.priority.is_some();
        let enabling = patch.enabled == Some(true);
        let update = self
            .db(move |conn| sources::update_source(conn, &cache_dir, source_id, &patch))
            .await?;
        if update.enabled_changed || update.url_changed || priority_set {
            self.refreshed(RefreshReason::SourceChanged, Some(source_id));
        }
        self.emit_status().await;
        if (enabling && update.enabled_changed) || update.url_changed {
            return self.check_due().await;
        }
        Ok(None)
    }

    /// Remove a source added by URL, with its programmes and cache files.
    pub async fn remove_source(&self, source_id: i64) -> Result<(), AppError> {
        let cache_dir = self.parts.cache_dir.clone();
        self.db(move |conn| sources::remove_source(conn, &cache_dir, source_id))
            .await?;
        self.refreshed(RefreshReason::SourceChanged, Some(source_id));
        self.emit_status().await;
        Ok(())
    }

    /// Another profile became active: other sources apply, and one of them
    /// may be due.
    pub async fn profile_switched(&self) -> Result<Option<RunHandle>, AppError> {
        self.refreshed(RefreshReason::ProfileSwitch, None);
        self.emit_status().await;
        self.check_due().await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::epg::sources::{ensure_xtream_source, feed_path};
    use crate::epg::test_support::*;
    use crate::epg::AbandonReason;
    use crate::http::test_server::{head, respond, serve, trickle, Step};
    use rusqlite::params;

    /// Events kept for the test to read.
    #[derive(Default)]
    struct Recorder {
        refreshed: Mutex<Vec<EpgRefreshed>>,
        statuses: Mutex<Vec<EpgStatus>>,
    }

    impl EpgEvents for Recorder {
        fn refreshed(&self, event: &EpgRefreshed) {
            self.refreshed.lock().unwrap().push(event.clone());
        }
        fn status(&self, status: &EpgStatus) {
            self.statuses.lock().unwrap().push(status.clone());
        }
    }

    impl Recorder {
        fn reasons(&self) -> Vec<(RefreshReason, Option<i64>)> {
            self.refreshed
                .lock()
                .unwrap()
                .iter()
                .map(|e| (e.reason, e.source_id))
                .collect()
        }

        /// `refreshing` of source `id` in each status sent, in order.
        fn refreshing(&self, id: i64) -> Vec<bool> {
            self.statuses
                .lock()
                .unwrap()
                .iter()
                .filter_map(|s| s.sources.iter().find(|r| r.id == id))
                .map(|r| r.refreshing)
                .collect()
        }

        fn last_status(&self) -> EpgStatus {
            self.statuses.lock().unwrap().last().unwrap().clone()
        }
    }

    fn service(f: &Fixture) -> (EpgService, Arc<Recorder>) {
        let events = Arc::new(Recorder::default());
        let service = EpgService::new(ServiceParts {
            pool: f.pool.clone(),
            db_path: f.db_path.clone(),
            cache_dir: f.dir.0.clone(),
            client: f.client.clone(),
            download_deadline: Duration::from_secs(10),
            lock: Arc::new(tokio::sync::Mutex::new(())),
            refreshing: Arc::new(Mutex::new(HashSet::new())),
            pending_policy: Arc::new(Mutex::new(HashSet::new())),
            events: events.clone(),
            clock: Arc::new(|| NOW),
        });
        (service, events)
    }

    fn feed() -> String {
        Feed::new()
            .programme("svt1.se", NOW, NOW + H, "News")
            .programme("svt1.se", NOW + H, NOW + 2 * H, "Film")
            .xml()
    }

    fn manual(f: &Fixture, base: &str, priority: i32) -> i64 {
        let id = add_manual(&f.conn(), &format!("{base}/epg.xml"));
        f.conn()
            .execute(
                "UPDATE epg_source SET priority = ?2 WHERE id = ?1",
                params![id, priority],
            )
            .unwrap();
        id
    }

    fn xtream(f: &Fixture, playlist_id: i64) -> i64 {
        let conn = f.conn();
        conn.execute(
            "INSERT INTO playlists (id, name, url, xtream_username, xtream_password)
             VALUES (?1, 'Provider', 'http://127.0.0.1:9', 'user', 'pass')",
            params![playlist_id],
        )
        .unwrap();
        ensure_xtream_source(&conn, playlist_id).unwrap()
    }

    fn set_active(f: &Fixture, profile: i64) {
        crate::db::mutations::set_setting(&f.conn(), "active_profile_id", &profile.to_string())
            .unwrap();
    }

    fn schedule(f: &Fixture, id: i64, success: Option<i64>, attempt: Option<i64>) {
        f.conn()
            .execute(
                "UPDATE epg_source SET last_success_at = ?2, last_attempt_at = ?3 WHERE id = ?1",
                params![id, success, attempt],
            )
            .unwrap();
    }

    fn stored(result: &Result<IngestOutcome, AppError>) -> bool {
        matches!(result, Ok(IngestOutcome::Stored(_)))
    }

    fn shift(minutes: i32) -> TimePolicy {
        TimePolicy {
            shift_minutes: minutes,
            ..TimePolicy::default()
        }
    }

    #[test]
    fn events_serialise_as_the_strings_the_frontend_lists() {
        let json = |r: RefreshReason| serde_json::to_string(&r).unwrap();
        assert_eq!(json(RefreshReason::Ingest), "\"ingest\"");
        assert_eq!(json(RefreshReason::Reingest), "\"reingest\"");
        assert_eq!(json(RefreshReason::SourceChanged), "\"source_changed\"");
        assert_eq!(json(RefreshReason::ProfileSwitch), "\"profile_switch\"");
        assert_eq!(json(RefreshReason::Match), "\"match\"");
        assert_eq!(
            serde_json::to_value(EpgRefreshed::new(RefreshReason::Ingest, Some(3))).unwrap(),
            serde_json::json!({"reason": "ingest", "source_id": 3, "matches_changed": 0})
        );
        assert_eq!(REFRESHED_EVENT, "epg-refreshed");
        assert_eq!(STATUS_EVENT, "epg-status");
    }

    #[test]
    fn sources_are_due_one_by_one_for_the_active_profile_only() {
        let f = Fixture::new("service");
        let base = "http://epg.example";
        let never = manual(&f, &format!("{base}/never"), 10);
        let fresh = manual(&f, &format!("{base}/fresh"), 11);
        let failing = manual(&f, &format!("{base}/failing"), 12);
        let disabled = manual(&f, &format!("{base}/disabled"), 13);
        let mine = xtream(&f, 1);
        let other = xtream(&f, 2);
        set_active(&f, 1);
        schedule(&f, fresh, Some(NOW - H), Some(NOW - H));
        schedule(&f, failing, Some(NOW - 7 * H), Some(NOW - 10 * 60));
        schedule(&f, mine, Some(NOW - 7 * H), Some(NOW - 7 * H));
        f.conn()
            .execute(
                "UPDATE epg_source SET enabled = 0 WHERE id = ?1",
                params![disabled],
            )
            .unwrap();

        assert_eq!(due_sources(&f.conn(), NOW).unwrap(), [never, mine]);
        assert!(!due_sources(&f.conn(), NOW).unwrap().contains(&other));
        set_active(&f, 2);
        assert_eq!(due_sources(&f.conn(), NOW).unwrap(), [never, other]);
    }

    #[tokio::test]
    async fn a_manual_refresh_ignores_the_six_hours_and_stamps_the_attempt() {
        let f = Fixture::new("service");
        let server = serve(vec![respond("200 OK", feed().as_bytes())]).await;
        let s = manual(&f, &server.base, 10);
        schedule(&f, s, Some(NOW - H), Some(NOW - H));
        let (service, _) = service(&f);
        assert!(due_sources(&f.conn(), NOW).unwrap().is_empty());

        let runs = service
            .refresh(Some(s))
            .await
            .unwrap()
            .unwrap()
            .await
            .unwrap();

        assert_eq!(runs.len(), 1);
        assert!(stored(&runs[0].result), "{:?}", runs[0].result);
        assert_eq!(server.connections(), 1);
        assert_eq!(f.status::<Option<i64>>(s, "last_attempt_at"), Some(NOW));
        assert_eq!(f.status::<Option<i64>>(s, "last_success_at"), Some(NOW));

        let err = service.refresh(Some(s + 99)).await.unwrap_err();
        assert!(matches!(err, AppError::InvalidInput(_)), "{err:?}");
    }

    #[tokio::test]
    async fn refreshing_everything_goes_source_by_source_past_a_failure() {
        let f = Fixture::new("service");
        let broken = serve(vec![respond("500 Internal Server Error", b"oops")]).await;
        let working = serve(vec![respond("200 OK", feed().as_bytes())]).await;
        let first = manual(&f, &broken.base, 10);
        let second = manual(&f, &working.base, 20);
        let off = manual(&f, &working.base.replace("127.0.0.1", "localhost"), 5);
        f.conn()
            .execute(
                "UPDATE epg_source SET enabled = 0 WHERE id = ?1",
                params![off],
            )
            .unwrap();
        // Another profile's provider source is not this profile's guide.
        xtream(&f, 2);
        set_active(&f, 1);
        let (service, events) = service(&f);

        let runs = service.refresh(None).await.unwrap().unwrap().await.unwrap();

        let order: Vec<i64> = runs.iter().map(|r| r.source_id).collect();
        assert_eq!(order, [first, second]);
        assert!(runs[0].result.is_err());
        assert!(stored(&runs[1].result), "{:?}", runs[1].result);
        assert_eq!((broken.connections(), working.connections()), (1, 1));
        assert_eq!(events.reasons(), [(RefreshReason::Ingest, Some(second))]);
    }

    #[tokio::test]
    async fn ten_requests_for_a_stalled_source_send_one_request() {
        let f = Fixture::new("service");
        let server = serve(vec![vec![
            head("200 OK", 100_000),
            Step::Write(feed().into_bytes()),
            Step::Hang,
        ]])
        .await;
        let s = manual(&f, &server.base, 10);
        let (service, events) = service(&f);

        let mut handles = Vec::new();
        for n in 0..10 {
            let source = if n % 2 == 0 { Some(s) } else { None };
            handles.push(service.refresh(source).await.unwrap());
        }

        assert!(handles[0].is_some());
        assert!(handles[1..].iter().all(Option::is_none));
        let runs = handles.remove(0).unwrap().await.unwrap();
        assert_eq!(
            runs[0].result.as_ref().unwrap_err().to_string(),
            "EPG error: The EPG server stopped sending data"
        );
        assert_eq!(server.connections(), 1);
        // The failure released the source: the next request downloads again.
        assert_eq!(events.refreshing(s), [true, false]);
        let again = service.refresh(Some(s)).await.unwrap();
        assert!(again.is_some());
        again.unwrap().await.unwrap();
        assert_eq!(server.connections(), 2);
    }

    #[tokio::test]
    async fn the_background_poll_skips_while_a_refresh_holds_the_lock() {
        let f = Fixture::new("service");
        let server = serve(vec![respond("200 OK", feed().as_bytes())]).await;
        let s = manual(&f, &server.base, 10);
        let (service, events) = service(&f);

        let held = service.parts.lock.clone().lock_owned().await;
        assert!(service.tick().await.is_empty());
        assert_eq!(server.connections(), 0);
        drop(held);

        let runs = service.tick().await;
        assert_eq!(runs.len(), 1);
        assert!(stored(&runs[0].result));
        assert_eq!(events.refreshing(s), [true, false]);
        // Just attempted: not due again.
        assert!(service.tick().await.is_empty());
        assert_eq!(server.connections(), 1);
    }

    #[tokio::test]
    async fn three_policy_steps_make_one_re_read_under_the_last_policy() {
        let f = Fixture::new("service");
        let s = add_manual(&f.conn(), "http://epg.example/epg.xml");
        f.store(s, &feed(), NOW).await;
        let (service, events) = service(&f);

        let held = service.parts.lock.clone().lock_owned().await;
        let first = service.set_time_policy(s, shift(30)).await.unwrap();
        let second = service.set_time_policy(s, shift(60)).await.unwrap();
        let third = service.set_time_policy(s, shift(90)).await.unwrap();
        assert!(first.is_some() && second.is_none() && third.is_none());
        assert!(events.last_status().sources[0].policy_pending);
        drop(held);

        let runs = first.unwrap().await.unwrap();

        assert_eq!(runs.len(), 1);
        assert!(stored(&runs[0].result));
        assert_eq!(events.reasons(), [(RefreshReason::Reingest, Some(s))]);
        assert_eq!(
            f.programmes(s),
            rows(&[
                ("svt1.se", NOW + 90 * 60, NOW + H + 90 * 60, "News"),
                ("svt1.se", NOW + H + 90 * 60, NOW + 2 * H + 90 * 60, "Film"),
            ])
        );
        assert!(!events.last_status().sources[0].policy_pending);
        // Nothing is queued any more: the next step queues its own re-read.
        let next = service.set_time_policy(s, shift(0)).await.unwrap();
        assert!(next.unwrap().await.unwrap()[0].result.is_ok());
    }

    #[tokio::test]
    async fn a_policy_without_a_cached_feed_waits_for_the_download() {
        let f = Fixture::new("service");
        let s = add_manual(&f.conn(), "http://epg.example/epg.xml");
        let (service, events) = service(&f);

        assert!(service
            .set_time_policy(s, shift(60))
            .await
            .unwrap()
            .is_none());
        assert_eq!(events.last_status().sources[0].policy.shift_minutes, 60);
        let err = service.set_time_policy(s, shift(45)).await.unwrap_err();
        assert!(matches!(err, AppError::InvalidInput(_)));
    }

    #[tokio::test]
    async fn a_failed_re_read_leaves_the_policy_pending() {
        let f = Fixture::new("service");
        let s = add_manual(&f.conn(), "http://epg.example/epg.xml");
        f.store(s, &feed(), NOW).await;
        let rows_before = f.programmes(s);
        f.cache(s, "<html>not a guide</html>");
        let (service, events) = service(&f);

        let runs = service
            .set_time_policy(s, shift(60))
            .await
            .unwrap()
            .unwrap()
            .await
            .unwrap();

        assert!(runs[0].result.is_err());
        assert_eq!(f.programmes(s), rows_before);
        assert!(events.last_status().sources[0].policy_pending);
        assert!(events.reasons().is_empty());
    }

    /// Changes the configured shift to 60 minutes inside the swap of the
    /// first programme stored under shift 0, after the ingest read it.
    const POLICY_CHANGED_MID_SWAP: &str = "CREATE TRIGGER policy_mid_swap
        AFTER INSERT ON epg_programme
        WHEN (SELECT time_shift_minutes FROM epg_source) = 0 BEGIN
            UPDATE epg_source SET time_shift_minutes = 60;
        END;";

    #[tokio::test]
    async fn a_policy_changed_during_a_download_is_applied_right_after_it() {
        let f = Fixture::new("service");
        let server = serve(vec![respond("200 OK", feed().as_bytes())]).await;
        let s = manual(&f, &server.base, 10);
        f.conn().execute_batch(POLICY_CHANGED_MID_SWAP).unwrap();
        let (service, events) = service(&f);

        let runs = service
            .refresh(Some(s))
            .await
            .unwrap()
            .unwrap()
            .await
            .unwrap();

        assert!(stored(&runs[0].result));
        let reingest = runs[0].reingest.as_ref().expect("a chained re-read");
        assert!(stored(reingest), "{reingest:?}");
        assert_eq!(
            f.programmes(s),
            rows(&[
                ("svt1.se", NOW + H, NOW + 2 * H, "News"),
                ("svt1.se", NOW + 2 * H, NOW + 3 * H, "Film"),
            ])
        );
        assert_eq!(
            f.status::<Option<i64>>(s, "applied_shift_minutes"),
            Some(60)
        );
        assert_eq!(
            events.reasons(),
            [
                (RefreshReason::Ingest, Some(s)),
                (RefreshReason::Reingest, Some(s))
            ]
        );
        assert_eq!(server.connections(), 1, "the re-read downloads nothing");
    }

    #[tokio::test]
    async fn a_failed_chained_re_read_leaves_the_policy_pending() {
        let f = Fixture::new("service");
        let one = Feed::new().programme("svt1.se", NOW, NOW + H, "News").xml();
        let server = serve(vec![respond("200 OK", one.as_bytes())]).await;
        let s = manual(&f, &server.base, 10);
        f.conn().execute_batch(POLICY_CHANGED_MID_SWAP).unwrap();
        f.conn()
            .execute_batch(
                "CREATE TRIGGER no_shifted_rows BEFORE INSERT ON epg_programme
                 WHEN (SELECT time_shift_minutes FROM epg_source) = 60 BEGIN
                     SELECT RAISE(ABORT, 'boom');
                 END;",
            )
            .unwrap();
        let (service, events) = service(&f);

        let runs = service
            .refresh(Some(s))
            .await
            .unwrap()
            .unwrap()
            .await
            .unwrap();

        assert!(stored(&runs[0].result));
        assert!(matches!(runs[0].reingest, Some(Err(_))));
        assert_eq!(f.programmes(s), rows(&[("svt1.se", NOW, NOW + H, "News")]));
        let row = &events.last_status().sources[0];
        assert!(row.policy_pending);
        assert_eq!(row.last_result, crate::epg_domain::source::LastResult::Ok);
        assert_eq!(events.reasons(), [(RefreshReason::Ingest, Some(s))]);
    }

    #[tokio::test]
    async fn every_attempt_is_announced_and_stored_ones_refresh_the_guide() {
        let f = Fixture::new("service");
        let cut = Feed::new()
            .programme("svt1.se", NOW, NOW + H, "News")
            .truncated_xml();
        let server = serve(vec![
            respond("200 OK", feed().as_bytes()),
            respond("200 OK", cut.as_bytes()),
            respond("403 Forbidden", b"no"),
        ])
        .await;
        let s = manual(&f, &server.base, 10);
        let (service, events) = service(&f);

        for _ in 0..3 {
            service
                .refresh(Some(s))
                .await
                .unwrap()
                .unwrap()
                .await
                .unwrap();
        }

        assert_eq!(
            events.refreshing(s),
            [true, false, true, false, true, false]
        );
        assert_eq!(
            events.reasons(),
            [
                (RefreshReason::Ingest, Some(s)),
                (RefreshReason::Ingest, Some(s)),
            ],
            "ok and partial refresh the guide, the 403 does not"
        );
        let row = &events.last_status().sources[0];
        assert_eq!(
            row.last_result,
            crate::epg_domain::source::LastResult::Error
        );
        assert_eq!(
            row.last_error.as_deref(),
            Some("The EPG server answered 403 Forbidden")
        );
    }

    #[tokio::test]
    async fn source_changes_and_profile_switches_refresh_the_guide() {
        let f = Fixture::new("service");
        let server = serve(vec![respond("200 OK", feed().as_bytes())]).await;
        let (service, events) = service(&f);
        set_active(&f, 1);

        let (row, run) = service
            .add_source(format!("{}/epg.xml", server.base))
            .await
            .unwrap();
        let s = row.id;
        assert!(row.refreshing, "the first download is under way");
        assert!(stored(&run.unwrap().await.unwrap()[0].result));

        let off = SourcePatch {
            enabled: Some(false),
            ..SourcePatch::default()
        };
        assert!(service.update_source(s, off).await.unwrap().is_none());
        let on = SourcePatch {
            enabled: Some(true),
            ..SourcePatch::default()
        };
        // Enabled again, but fetched a moment ago: not due.
        assert!(service.update_source(s, on).await.unwrap().is_none());
        let moved = SourcePatch {
            url: Some(format!("{}/other.xml", server.base)),
            ..SourcePatch::default()
        };
        let run = service.update_source(s, moved).await.unwrap();
        assert!(stored(
            &run.expect("a new URL is due").await.unwrap()[0].result
        ));

        let provider = xtream(&f, 2);
        set_active(&f, 2);
        let run = service.profile_switched().await.unwrap();
        let runs = run
            .expect("the profile's provider source is due")
            .await
            .unwrap();
        assert_eq!(runs[0].source_id, provider);
        service.remove_source(s).await.unwrap();

        assert_eq!(
            events.reasons(),
            [
                (RefreshReason::Ingest, Some(s)),
                (RefreshReason::SourceChanged, Some(s)),
                (RefreshReason::SourceChanged, Some(s)),
                (RefreshReason::SourceChanged, Some(s)),
                (RefreshReason::Ingest, Some(s)),
                (RefreshReason::ProfileSwitch, None),
                (RefreshReason::SourceChanged, Some(s)),
            ]
        );
        assert!(events.last_status().sources.iter().all(|r| r.id != s));
    }

    #[tokio::test]
    async fn a_url_change_during_a_download_abandons_it_and_frees_the_source() {
        let f = Fixture::new("service");
        let body = feed().into_bytes();
        let server = serve(vec![trickle(&body, 8, Duration::from_millis(100))]).await;
        let s = manual(&f, &server.base, 10);
        let (service, _) = service(&f);

        let run = service.refresh(Some(s)).await.unwrap().unwrap();
        while !crate::epg::sources::download_path(&f.dir.0, s).exists() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let moved = SourcePatch {
            url: Some("http://other.example/epg.xml".to_string()),
            ..SourcePatch::default()
        };
        service.update_source(s, moved).await.unwrap();
        let runs = run.await.unwrap();

        assert_eq!(
            runs[0].result.as_ref().unwrap(),
            &IngestOutcome::Abandoned(AbandonReason::UrlChanged)
        );
        assert!(f.programmes(s).is_empty());
        assert!(!feed_path(&f.dir.0, s).exists());
        assert!(lock_set(&service.parts.refreshing).is_empty());
    }
}
