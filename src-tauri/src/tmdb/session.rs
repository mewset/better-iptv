//! Per-process TMDB state: which key was rejected this session, which
//! cache keys are being enriched right now, and the two enrichment queues
//! (visible rows first, the whole-library scan behind them).

use crate::tmdb::enrich::EnrichJob;
use serde::Serialize;
use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver, UnboundedSender};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

/// After any failed shared-key fetch the website is left alone for this
/// long, whether or not a stale key covered the gap; otherwise every queued
/// title would GET it again while offline.
pub const SHARED_FETCH_COOLDOWN: Duration = Duration::from_secs(300);

/// Background searches in flight at once. The client's four permits are
/// shared FIFO with the foreground, and a permit is held across the 429
/// retry sleep, so without this bound slow TMDB replies would let paced
/// background jobs pile up ahead of visible rows.
pub const BACKGROUND_MAX_IN_FLIGHT: usize = 2;

/// Every shared key TMDB has rejected this session. A stale key that is
/// still in flight on several requests produces several 401s; only the first
/// per key counts, so the second distinct key is the refetched one. The set
/// also lets the resolver refuse a key the website keeps serving after TMDB
/// revoked it, instead of storing it and paying another 401 per job.
#[derive(Debug, Default)]
struct SharedRejections {
    keys: HashSet<String>,
}

/// Where the background library scan stands. `running` is false once every
/// planned title has been searched (or the scan was cancelled).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct BackgroundProgress {
    pub done: u64,
    pub total: u64,
    pub running: bool,
}

/// Background jobs carry the generation they were planned in; a cancel
/// bumps it and the worker drops anything older. Foreground jobs carry 0.
pub fn is_stale_job(job: &EnrichJob, current_generation: u64) -> bool {
    generation_is_stale(job.generation, current_generation)
}

/// `is_stale_job` for a job that has already been consumed.
pub fn generation_is_stale(generation: u64, current_generation: u64) -> bool {
    generation != 0 && generation < current_generation
}

#[derive(Debug)]
pub struct TmdbSession {
    user_key_rejected: AtomicBool,
    shared_key_rejected: AtomicBool,
    shared_rejections: Mutex<SharedRejections>,
    shared_fetch_failed_at: Mutex<Option<Instant>>,
    /// Held while one caller fetches the shared key, so a burst of jobs
    /// sends one GET and the rest read the stored key afterwards.
    shared_fetch_lock: tokio::sync::Mutex<()>,
    in_flight: Mutex<HashSet<String>>,
    queue_tx: UnboundedSender<EnrichJob>,
    queue_rx: Mutex<Option<UnboundedReceiver<EnrichJob>>>,
    /// The low-priority queue for the library scan. The worker only takes
    /// from it while the foreground queue is empty.
    bg_tx: UnboundedSender<EnrichJob>,
    bg_rx: Mutex<Option<UnboundedReceiver<EnrichJob>>>,
    /// Starts at 1 so a background job is never mistaken for a foreground
    /// one (generation 0).
    bg_generation: AtomicU64,
    /// Held from the start of planning until the last planned job finished
    /// or the scan was cancelled, so scans never interleave.
    bg_scan_lock: AtomicBool,
    /// Set by `start_background`, cleared by `cancel_background`; while it
    /// is off there is no progress to report and nothing to count.
    bg_started: AtomicBool,
    bg_total: AtomicU64,
    bg_done: AtomicU64,
    bg_running: AtomicBool,
    /// Background-only permits; the worker takes one before it spawns a
    /// scan job and the job holds it until the search is written.
    bg_permits: Arc<Semaphore>,
}

impl Default for TmdbSession {
    fn default() -> Self {
        let (tx, rx) = unbounded_channel();
        let (bg_tx, bg_rx) = unbounded_channel();
        Self {
            user_key_rejected: AtomicBool::new(false),
            shared_key_rejected: AtomicBool::new(false),
            shared_rejections: Mutex::new(SharedRejections::default()),
            shared_fetch_failed_at: Mutex::new(None),
            shared_fetch_lock: tokio::sync::Mutex::new(()),
            in_flight: Mutex::new(HashSet::new()),
            queue_tx: tx,
            queue_rx: Mutex::new(Some(rx)),
            bg_tx,
            bg_rx: Mutex::new(Some(bg_rx)),
            bg_generation: AtomicU64::new(1),
            bg_scan_lock: AtomicBool::new(false),
            bg_started: AtomicBool::new(false),
            bg_total: AtomicU64::new(0),
            bg_done: AtomicU64::new(0),
            bg_running: AtomicBool::new(false),
            bg_permits: Arc::new(Semaphore::new(BACKGROUND_MAX_IN_FLIGHT)),
        }
    }
}

impl TmdbSession {
    pub fn user_key_rejected(&self) -> bool {
        self.user_key_rejected.load(Ordering::Relaxed)
    }

    pub fn set_user_key_rejected(&self, rejected: bool) {
        self.user_key_rejected.store(rejected, Ordering::Relaxed);
    }

    pub fn shared_key_rejected(&self) -> bool {
        self.shared_key_rejected.load(Ordering::Relaxed)
    }

    /// Count a 401 with the shared key `key`. The first distinct key is
    /// forgiven (it is refetched); the second marks the shared key rejected
    /// for the session. A repeat 401 for an already counted key is a no-op.
    /// Returns the number of distinct keys counted so far.
    pub fn note_shared_unauthorized(&self, key: &str) -> u32 {
        let mut r = self
            .shared_rejections
            .lock()
            .expect("tmdb shared rejections poisoned");
        r.keys.insert(key.to_string());
        let count = r.keys.len() as u32;
        if count >= 2 {
            self.shared_key_rejected.store(true, Ordering::Relaxed);
        }
        count
    }

    /// Whether TMDB already answered 401 for this shared key this session.
    pub fn is_shared_key_rejected(&self, key: &str) -> bool {
        self.shared_rejections
            .lock()
            .expect("tmdb shared rejections poisoned")
            .keys
            .contains(key)
    }

    /// Pause shared-key lookups for the session without counting a new 401,
    /// e.g. when the website serves a key that was already rejected.
    pub fn mark_shared_key_rejected(&self) {
        self.shared_key_rejected.store(true, Ordering::Relaxed);
    }

    /// Remember that the website did not hand out a shared key just now.
    pub fn note_shared_fetch_failed(&self) {
        *self
            .shared_fetch_failed_at
            .lock()
            .expect("tmdb cooldown poisoned") = Some(Instant::now());
    }

    /// Serialise shared-key fetches; the guard is held across the GET and
    /// the store.
    pub async fn lock_shared_fetch(&self) -> tokio::sync::MutexGuard<'_, ()> {
        self.shared_fetch_lock.lock().await
    }

    /// Whether a failed shared-key fetch is still recent enough to skip.
    pub fn shared_fetch_on_cooldown(&self) -> bool {
        self.shared_fetch_failed_at
            .lock()
            .expect("tmdb cooldown poisoned")
            .is_some_and(|at| at.elapsed() < SHARED_FETCH_COOLDOWN)
    }

    /// Called when the user changes the key or the enabled flag in Settings.
    pub fn reset_shared(&self) {
        *self
            .shared_rejections
            .lock()
            .expect("tmdb shared rejections poisoned") = SharedRejections::default();
        self.shared_key_rejected.store(false, Ordering::Relaxed);
        self.user_key_rejected.store(false, Ordering::Relaxed);
        *self
            .shared_fetch_failed_at
            .lock()
            .expect("tmdb cooldown poisoned") = None;
    }

    pub fn try_claim(&self, cache_key: &str) -> bool {
        self.in_flight
            .lock()
            .expect("tmdb in-flight set poisoned")
            .insert(cache_key.to_string())
    }

    pub fn release(&self, cache_key: &str) {
        self.in_flight
            .lock()
            .expect("tmdb in-flight set poisoned")
            .remove(cache_key);
    }

    /// Queue a title for background enrichment. Silently dropped if the
    /// worker is gone (only at shutdown).
    pub fn enqueue(&self, job: EnrichJob) {
        let _ = self.queue_tx.send(job);
    }

    /// The worker takes the receiver once, at startup.
    pub fn take_receiver(&self) -> Option<UnboundedReceiver<EnrichJob>> {
        self.queue_rx.lock().expect("tmdb queue poisoned").take()
    }

    /// Queue a title for the library scan; served only behind the
    /// foreground queue. Dropped if the worker is gone.
    pub fn enqueue_background(&self, job: EnrichJob) {
        let _ = self.bg_tx.send(job);
    }

    /// The worker takes the background receiver once, at startup.
    pub fn take_background_receiver(&self) -> Option<UnboundedReceiver<EnrichJob>> {
        self.bg_rx.lock().expect("tmdb bg queue poisoned").take()
    }

    pub fn current_generation(&self) -> u64 {
        self.bg_generation.load(Ordering::SeqCst)
    }

    /// Abandon the running scan: every queued background job becomes stale
    /// and the progress is cleared, so a late job cannot count towards the
    /// next scan. Releases the scan lock.
    pub fn cancel_background(&self) {
        self.bg_generation.fetch_add(1, Ordering::SeqCst);
        self.bg_started.store(false, Ordering::SeqCst);
        self.bg_running.store(false, Ordering::SeqCst);
        self.bg_total.store(0, Ordering::SeqCst);
        self.bg_done.store(0, Ordering::SeqCst);
        self.bg_scan_lock.store(false, Ordering::SeqCst);
    }

    /// Take the scan lock. False while another scan is planning or still
    /// has jobs in the queue.
    pub fn try_begin_scan(&self) -> bool {
        self.bg_scan_lock
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
    }

    /// Release the scan lock without touching the counters: planning bailed
    /// out before any job was queued.
    pub fn end_scan(&self) {
        self.bg_scan_lock.store(false, Ordering::SeqCst);
    }

    /// A scan has been planned with `total` jobs. Zero jobs is a finished
    /// scan, so the lock is released at once.
    pub fn start_background(&self, total: u64) {
        self.bg_total.store(total, Ordering::SeqCst);
        self.bg_done.store(0, Ordering::SeqCst);
        self.bg_started.store(true, Ordering::SeqCst);
        let running = total > 0;
        self.bg_running.store(running, Ordering::SeqCst);
        if !running {
            self.bg_scan_lock.store(false, Ordering::SeqCst);
        }
    }

    /// One background job finished (or was skipped). Returns `(done, total)`;
    /// the last one ends the scan and releases the lock. A no-op `(0, 0)`
    /// while no scan is started, which is where a cancelled job lands.
    pub fn note_background_done(&self) -> (u64, u64) {
        if !self.bg_started.load(Ordering::SeqCst) {
            return (0, 0);
        }
        let total = self.bg_total.load(Ordering::SeqCst);
        let done = (self.bg_done.fetch_add(1, Ordering::SeqCst) + 1).min(total);
        if done >= total {
            self.bg_running.store(false, Ordering::SeqCst);
            self.bg_scan_lock.store(false, Ordering::SeqCst);
        }
        (done, total)
    }

    /// Wait for one of the `BACKGROUND_MAX_IN_FLIGHT` permits. Cancel-safe;
    /// the permit is released when it is dropped.
    pub async fn acquire_background_permit(&self) -> OwnedSemaphorePermit {
        self.bg_permits
            .clone()
            .acquire_owned()
            .await
            .expect("tmdb background semaphore is never closed")
    }

    #[cfg(test)]
    pub fn background_permits_available(&self) -> usize {
        self.bg_permits.available_permits()
    }

    /// `None` until the first scan of the session starts (or after a cancel).
    pub fn background_progress(&self) -> Option<BackgroundProgress> {
        if !self.bg_started.load(Ordering::SeqCst) {
            return None;
        }
        let total = self.bg_total.load(Ordering::SeqCst);
        Some(BackgroundProgress {
            done: self.bg_done.load(Ordering::SeqCst).min(total),
            total,
            running: self.bg_running.load(Ordering::SeqCst),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn in_flight_claims_are_exclusive_until_released() {
        let s = TmdbSession::default();
        assert!(s.try_claim("vod|shutter island|2010"));
        assert!(!s.try_claim("vod|shutter island|2010"));
        s.release("vod|shutter island|2010");
        assert!(s.try_claim("vod|shutter island|2010"));
    }

    #[test]
    fn a_second_distinct_shared_key_rejection_marks_the_shared_key_rejected() {
        let s = TmdbSession::default();
        assert_eq!(s.note_shared_unauthorized("old"), 1);
        assert!(!s.shared_key_rejected());
        // The same stale key, still in flight elsewhere: already counted.
        assert_eq!(s.note_shared_unauthorized("old"), 1);
        assert!(!s.shared_key_rejected());
        assert_eq!(s.note_shared_unauthorized("new"), 2);
        assert!(s.shared_key_rejected());
        s.reset_shared();
        assert!(!s.shared_key_rejected());
        // After a reset the old key counts again.
        assert_eq!(s.note_shared_unauthorized("old"), 1);
        assert!(!s.shared_key_rejected());
    }

    #[test]
    fn rejected_shared_keys_are_remembered_until_reset() {
        let s = TmdbSession::default();
        assert!(!s.is_shared_key_rejected("K"));
        s.note_shared_unauthorized("K");
        assert!(s.is_shared_key_rejected("K"));
        assert!(!s.is_shared_key_rejected("L"));
        s.reset_shared();
        assert!(!s.is_shared_key_rejected("K"));
    }

    #[test]
    fn every_rejected_shared_key_stays_counted_not_just_the_last_one() {
        let s = TmdbSession::default();
        assert_eq!(s.note_shared_unauthorized("K"), 1);
        assert_eq!(s.note_shared_unauthorized("L"), 2);
        assert!(s.shared_key_rejected());
        // A late 401 for the first key is still a no-op.
        assert_eq!(s.note_shared_unauthorized("K"), 2);
        assert!(s.is_shared_key_rejected("K"));
        assert!(s.is_shared_key_rejected("L"));
    }

    #[test]
    fn mark_shared_key_rejected_pauses_the_shared_key_until_reset() {
        let s = TmdbSession::default();
        s.mark_shared_key_rejected();
        assert!(s.shared_key_rejected());
        s.reset_shared();
        assert!(!s.shared_key_rejected());
    }

    #[test]
    fn shared_fetch_cooldown_starts_on_failure_and_clears_on_reset() {
        let s = TmdbSession::default();
        assert!(!s.shared_fetch_on_cooldown());
        s.note_shared_fetch_failed();
        assert!(s.shared_fetch_on_cooldown());
        s.reset_shared();
        assert!(!s.shared_fetch_on_cooldown());
    }

    #[test]
    fn the_receiver_can_be_taken_once_and_sees_queued_jobs() {
        let s = TmdbSession::default();
        let mut rx = s.take_receiver().expect("first take yields the receiver");
        assert!(s.take_receiver().is_none());
        s.enqueue(EnrichJob {
            key: crate::db::models::TmdbKey {
                title: "dune".into(),
                year: 2021,
                content_type: "vod".into(),
            },
            query: crate::tmdb_domain::Normalized {
                title: "Dune".into(),
                year: Some(2021),
            },
            kind: crate::tmdb::Kind::Movie,
            channel_ids: vec![1, 2],
            generation: 0,
        });
        let job = rx.try_recv().expect("the job is queued");
        assert_eq!(job.channel_ids, vec![1, 2]);
    }

    fn bg_job(generation: u64) -> EnrichJob {
        EnrichJob {
            key: crate::db::models::TmdbKey {
                title: "dune".into(),
                year: 2021,
                content_type: "vod".into(),
            },
            query: crate::tmdb_domain::Normalized {
                title: "Dune".into(),
                year: Some(2021),
            },
            kind: crate::tmdb::Kind::Movie,
            channel_ids: vec![1],
            generation,
        }
    }

    #[test]
    fn the_background_receiver_can_be_taken_once_and_sees_queued_jobs() {
        let s = TmdbSession::default();
        let mut rx = s
            .take_background_receiver()
            .expect("first take yields the receiver");
        assert!(s.take_background_receiver().is_none());
        s.enqueue_background(bg_job(s.current_generation()));
        let job = rx.try_recv().expect("the job is queued");
        assert_eq!(job.generation, s.current_generation());
        // The foreground queue is untouched.
        let mut fg = s.take_receiver().unwrap();
        assert!(fg.try_recv().is_err());
    }

    #[test]
    fn cancelling_bumps_the_generation_and_only_older_background_jobs_are_stale() {
        let s = TmdbSession::default();
        let first = s.current_generation();
        assert!(
            first > 0,
            "background generations start above the foreground's 0"
        );
        let job = bg_job(first);
        assert!(!is_stale_job(&job, s.current_generation()));
        s.cancel_background();
        assert_eq!(s.current_generation(), first + 1);
        assert!(is_stale_job(&job, s.current_generation()));
        // A foreground job (generation 0) is never stale.
        assert!(!is_stale_job(&bg_job(0), s.current_generation()));
        assert!(!is_stale_job(
            &bg_job(s.current_generation()),
            s.current_generation()
        ));
    }

    #[test]
    fn progress_counts_up_to_the_total_and_is_absent_before_the_first_scan() {
        let s = TmdbSession::default();
        assert_eq!(s.background_progress(), None);
        assert!(s.try_begin_scan());
        s.start_background(2);
        assert_eq!(
            s.background_progress(),
            Some(BackgroundProgress {
                done: 0,
                total: 2,
                running: true
            })
        );
        assert_eq!(s.note_background_done(), (1, 2));
        assert!(s.background_progress().unwrap().running);
        assert_eq!(s.note_background_done(), (2, 2));
        assert_eq!(
            s.background_progress(),
            Some(BackgroundProgress {
                done: 2,
                total: 2,
                running: false
            })
        );
        // Cancelling clears the progress, so a stale job cannot count
        // towards the next scan.
        s.cancel_background();
        assert_eq!(s.background_progress(), None);
        assert_eq!(s.note_background_done(), (0, 0));
    }

    #[tokio::test]
    async fn background_permits_bound_in_flight_scan_jobs_to_two() {
        let s = TmdbSession::default();
        assert_eq!(BACKGROUND_MAX_IN_FLIGHT, 2);
        assert_eq!(s.background_permits_available(), 2);
        let a = s.acquire_background_permit().await;
        let b = s.acquire_background_permit().await;
        assert_eq!(s.background_permits_available(), 0);
        drop(a);
        assert_eq!(s.background_permits_available(), 1);
        drop(b);
        assert_eq!(s.background_permits_available(), 2);
    }

    #[test]
    fn one_scan_at_a_time_until_its_jobs_are_done_or_it_is_cancelled() {
        let s = TmdbSession::default();
        assert!(s.try_begin_scan());
        assert!(!s.try_begin_scan(), "a second scan must wait");
        s.start_background(1);
        assert!(!s.try_begin_scan(), "still running");
        s.note_background_done();
        assert!(s.try_begin_scan(), "released when the last job finished");
        s.cancel_background();
        assert!(s.try_begin_scan(), "released by cancel");
        s.end_scan();
        assert!(s.try_begin_scan(), "released when planning bails out");
        // An empty scan releases the lock right away.
        s.start_background(0);
        assert!(s.try_begin_scan());
    }
}
