//! Per-process TMDB state: which key was rejected this session, which
//! cache keys are being enriched right now, and the enrichment queue.

use crate::tmdb::enrich::EnrichJob;
use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver, UnboundedSender};

/// After any failed shared-key fetch the website is left alone for this
/// long, whether or not a stale key covered the gap; otherwise every queued
/// title would GET it again while offline.
pub const SHARED_FETCH_COOLDOWN: Duration = Duration::from_secs(300);

/// Every shared key TMDB has rejected this session. A stale key that is
/// still in flight on several requests produces several 401s; only the first
/// per key counts, so the second distinct key is the refetched one. The set
/// also lets the resolver refuse a key the website keeps serving after TMDB
/// revoked it, instead of storing it and paying another 401 per job.
#[derive(Debug, Default)]
struct SharedRejections {
    keys: HashSet<String>,
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
}

impl Default for TmdbSession {
    fn default() -> Self {
        let (tx, rx) = unbounded_channel();
        Self {
            user_key_rejected: AtomicBool::new(false),
            shared_key_rejected: AtomicBool::new(false),
            shared_rejections: Mutex::new(SharedRejections::default()),
            shared_fetch_failed_at: Mutex::new(None),
            shared_fetch_lock: tokio::sync::Mutex::new(()),
            in_flight: Mutex::new(HashSet::new()),
            queue_tx: tx,
            queue_rx: Mutex::new(Some(rx)),
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
        });
        let job = rx.try_recv().expect("the job is queued");
        assert_eq!(job.channel_ids, vec![1, 2]);
    }
}
