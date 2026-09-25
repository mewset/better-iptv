//! Per-process TMDB state: which key was rejected this session, and which
//! cache keys are being enriched right now.

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Mutex;

#[derive(Debug, Default)]
pub struct TmdbSession {
    user_key_rejected: AtomicBool,
    shared_key_rejected: AtomicBool,
    shared_unauthorized_count: AtomicU32,
    in_flight: Mutex<HashSet<String>>,
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

    /// Called when the user changes the key or the enabled flag in Settings.
    #[allow(dead_code)] // Called by the TMDB commands in Task 8
    pub fn reset_shared(&self) {
        self.shared_unauthorized_count.store(0, Ordering::Relaxed);
        self.shared_key_rejected.store(false, Ordering::Relaxed);
        self.user_key_rejected.store(false, Ordering::Relaxed);
    }

    #[allow(dead_code)] // Called by the enrichment queue in Task 7
    pub fn try_claim(&self, cache_key: &str) -> bool {
        self.in_flight
            .lock()
            .expect("tmdb in-flight set poisoned")
            .insert(cache_key.to_string())
    }

    #[allow(dead_code)] // Called by the enrichment queue in Task 7
    pub fn release(&self, cache_key: &str) {
        self.in_flight
            .lock()
            .expect("tmdb in-flight set poisoned")
            .remove(cache_key);
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
}
