//! Per-process TMDB state: which key was rejected this session, which
//! cache keys are being enriched right now, and the enrichment queue.

use crate::tmdb::enrich::EnrichJob;
use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver, UnboundedSender};

/// After any failed shared-key fetch the website is left alone for this
/// long, whether or not a stale key covered the gap; otherwise every queued
/// title would GET it again while offline.
pub const SHARED_FETCH_COOLDOWN: Duration = Duration::from_secs(300);

#[derive(Debug)]
pub struct TmdbSession {
    user_key_rejected: AtomicBool,
    shared_key_rejected: AtomicBool,
    shared_unauthorized_count: AtomicU32,
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
            shared_unauthorized_count: AtomicU32::new(0),
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

    /// Count a 401 with the shared key. The first one is forgiven (the key
    /// is refetched); the second marks the shared key rejected for the session.
    pub fn note_shared_unauthorized(&self) -> u32 {
        let n = self
            .shared_unauthorized_count
            .fetch_add(1, Ordering::Relaxed)
            + 1;
        if n >= 2 {
            self.shared_key_rejected.store(true, Ordering::Relaxed);
        }
        n
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
    #[allow(dead_code)] // Called by the TMDB commands in Task 8
    pub fn reset_shared(&self) {
        self.shared_unauthorized_count.store(0, Ordering::Relaxed);
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
    fn second_shared_unauthorized_marks_the_shared_key_rejected() {
        let s = TmdbSession::default();
        assert_eq!(s.note_shared_unauthorized(), 1);
        assert!(!s.shared_key_rejected());
        assert_eq!(s.note_shared_unauthorized(), 2);
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
