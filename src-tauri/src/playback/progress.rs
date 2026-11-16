//! Watch progress: where each film and episode was left, and whether it was
//! watched. While MPV plays a film or episodes, a background task asks it
//! where it is every few seconds (`ipc::snapshot`) and `step` turns each
//! answer into writes to `watch_progress`.
//!
//! A row is keyed by the channel (the film, or the series) and the episode's
//! id as the frontend knows it ('' for a film): the provider's episode id
//! for Xtream, the `series_episodes` row id for M3U. Channel ids survive a
//! playlist refresh (`merge_channels`), and the rows go with their channel.

use super::ipc::Snapshot;
use rusqlite::{params, Connection};
use serde::Serialize;

/// Played this far through, a title counts as watched (end credits).
pub const WATCHED_FRACTION: f64 = 0.9;
/// Less than this in is an accidental start, not worth resuming.
pub const MIN_POSITION_SECS: f64 = 30.0;

/// What MPV is playing, as far as progress is concerned.
#[derive(Debug, Clone, PartialEq)]
pub struct Session {
    /// Tells a session from the one that replaced it while a snapshot was taken.
    pub id: u64,
    /// The film, or the series the episodes belong to.
    pub channel_id: i64,
    /// The queued episodes' ids in playlist order; empty for a film.
    pub episodes: Vec<String>,
    /// The playlist entry seen last, to notice MPV moving to the next episode.
    pub last_playlist_pos: usize,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Write {
    Progress {
        channel_id: i64,
        episode_id: String,
        position: f64,
        duration: f64,
    },
    Watched {
        channel_id: i64,
        episode_id: String,
    },
}

/// The writes one snapshot calls for. An episode MPV moved on from was
/// played to its end, so it is watched; the current file's position is kept
/// once it is past the first half minute. Nothing without a length (a live
/// stream, or a file still opening).
pub fn step(session: &mut Session, snap: Snapshot) -> Vec<Write> {
    let mut writes = Vec::new();
    if !session.episodes.is_empty() && snap.playlist_pos > session.last_playlist_pos {
        for i in session.last_playlist_pos..snap.playlist_pos {
            if let Some(id) = session.episodes.get(i) {
                writes.push(Write::Watched {
                    channel_id: session.channel_id,
                    episode_id: id.clone(),
                });
            }
        }
    }
    session.last_playlist_pos = snap.playlist_pos;

    let episode_id = if session.episodes.is_empty() {
        String::new()
    } else {
        match session.episodes.get(snap.playlist_pos) {
            Some(id) => id.clone(),
            None => return writes,
        }
    };
    if let Some(duration) = snap.duration {
        if snap.position >= MIN_POSITION_SECS {
            writes.push(Write::Progress {
                channel_id: session.channel_id,
                episode_id,
                position: snap.position.min(duration),
                duration,
            });
        }
    }
    writes
}

/// Apply writes. Watched sticks: watching again from the start keeps the mark.
pub fn apply(conn: &Connection, writes: &[Write], now: i64) -> rusqlite::Result<()> {
    for write in writes {
        match write {
            Write::Progress {
                channel_id,
                episode_id,
                position,
                duration,
            } => {
                let watched = *position >= duration * WATCHED_FRACTION;
                conn.execute(
                    "INSERT INTO watch_progress
                        (channel_id, episode_id, position_secs, duration_secs, watched, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                     ON CONFLICT (channel_id, episode_id) DO UPDATE SET
                        position_secs = excluded.position_secs,
                        duration_secs = excluded.duration_secs,
                        watched = MAX(watched, excluded.watched),
                        updated_at = excluded.updated_at",
                    params![channel_id, episode_id, position, duration, watched, now],
                )?;
            }
            Write::Watched {
                channel_id,
                episode_id,
            } => set_watched(conn, *channel_id, episode_id, true, now)?,
        }
    }
    Ok(())
}

/// Mark a title watched, or forget it altogether (unwatched: no progress either).
pub fn set_watched(
    conn: &Connection,
    channel_id: i64,
    episode_id: &str,
    watched: bool,
    now: i64,
) -> rusqlite::Result<()> {
    if watched {
        conn.execute(
            "INSERT INTO watch_progress
                (channel_id, episode_id, position_secs, duration_secs, watched, updated_at)
             VALUES (?1, ?2, 0, 0, 1, ?3)
             ON CONFLICT (channel_id, episode_id) DO UPDATE SET
                watched = 1, updated_at = excluded.updated_at",
            params![channel_id, episode_id, now],
        )?;
    } else {
        conn.execute(
            "DELETE FROM watch_progress WHERE channel_id = ?1 AND episode_id = ?2",
            params![channel_id, episode_id],
        )?;
    }
    Ok(())
}

/// One title's progress, as the frontend gets it.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct WatchProgress {
    pub channel_id: i64,
    /// '' for a film.
    pub episode_id: String,
    pub position_secs: f64,
    pub duration_secs: f64,
    pub watched: bool,
    /// Seconds since the epoch.
    pub updated_at: i64,
}

/// Every title with progress in a profile, most recently watched first.
pub fn list(conn: &Connection, playlist_id: i64) -> rusqlite::Result<Vec<WatchProgress>> {
    let mut stmt = conn.prepare(
        "SELECT w.channel_id, w.episode_id, w.position_secs, w.duration_secs, w.watched, w.updated_at
         FROM watch_progress w JOIN channels c ON c.id = w.channel_id
         WHERE c.playlist_id = ?1
         ORDER BY w.updated_at DESC, w.rowid DESC",
    )?;
    let rows = stmt.query_map(params![playlist_id], |row| {
        Ok(WatchProgress {
            channel_id: row.get(0)?,
            episode_id: row.get(1)?,
            position_secs: row.get(2)?,
            duration_secs: row.get(3)?,
            watched: row.get(4)?,
            updated_at: row.get(5)?,
        })
    })?;
    rows.collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_helpers::{create_test_channel, create_test_playlist, setup_test_db};

    fn snap(position: f64, duration: Option<f64>, playlist_pos: usize) -> Snapshot {
        Snapshot {
            position,
            duration,
            playlist_pos,
        }
    }

    fn film(channel_id: i64) -> Session {
        Session {
            id: 1,
            channel_id,
            episodes: vec![],
            last_playlist_pos: 0,
        }
    }

    fn episodes(channel_id: i64, ids: &[&str]) -> Session {
        Session {
            episodes: ids.iter().map(|s| s.to_string()).collect(),
            ..film(channel_id)
        }
    }

    #[test]
    fn a_film_keeps_its_position_once_past_the_first_half_minute() {
        let mut s = film(7);
        assert_eq!(step(&mut s, snap(12.0, Some(6000.0), 0)), vec![]);
        assert_eq!(
            step(&mut s, snap(600.0, Some(6000.0), 0)),
            vec![Write::Progress {
                channel_id: 7,
                episode_id: String::new(),
                position: 600.0,
                duration: 6000.0
            }]
        );
    }

    #[test]
    fn nothing_is_kept_without_a_length() {
        let mut s = film(7);
        assert_eq!(step(&mut s, snap(600.0, None, 0)), vec![]);
    }

    #[test]
    fn moving_to_the_next_episode_marks_the_last_one_watched() {
        let mut s = episodes(3, &["e1", "e2", "e3"]);
        step(&mut s, snap(1500.0, Some(2400.0), 0));
        let writes = step(&mut s, snap(40.0, Some(2400.0), 1));
        assert_eq!(
            writes,
            vec![
                Write::Watched {
                    channel_id: 3,
                    episode_id: "e1".into()
                },
                Write::Progress {
                    channel_id: 3,
                    episode_id: "e2".into(),
                    position: 40.0,
                    duration: 2400.0
                }
            ]
        );
        // Out of the queue's range: nothing to attribute the position to
        assert_eq!(step(&mut s, snap(40.0, Some(2400.0), 9)).len(), 2);
    }

    #[test]
    fn progress_is_stored_listed_per_profile_and_marked_watched() {
        let conn = setup_test_db();
        let p1 = create_test_playlist(&conn, "One");
        let p2 = create_test_playlist(&conn, "Two");
        let a = create_test_channel(&conn, p1, "Film");
        let b = create_test_channel(&conn, p2, "Other");
        let progress = |c: i64, e: &str, pos: f64| Write::Progress {
            channel_id: c,
            episode_id: e.into(),
            position: pos,
            duration: 6000.0,
        };
        apply(&conn, &[progress(a, "", 600.0)], 100).unwrap();
        apply(&conn, &[progress(b, "", 900.0)], 200).unwrap();
        apply(&conn, &[progress(a, "", 1200.0)], 300).unwrap();

        let rows = list(&conn, p1).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].position_secs, 1200.0);
        assert!(!rows[0].watched);
        assert_eq!(rows[0].updated_at, 300);

        // Past 90 %: watched; going back keeps the mark
        apply(&conn, &[progress(a, "", 5500.0)], 400).unwrap();
        assert!(list(&conn, p1).unwrap()[0].watched);
        apply(&conn, &[progress(a, "", 60.0)], 500).unwrap();
        assert!(list(&conn, p1).unwrap()[0].watched);

        // Unwatched forgets the title
        set_watched(&conn, a, "", false, 600).unwrap();
        assert!(list(&conn, p1).unwrap().is_empty());
    }

    #[test]
    fn rows_go_with_their_channel() {
        let conn = setup_test_db();
        let p = create_test_playlist(&conn, "One");
        let a = create_test_channel(&conn, p, "Film");
        set_watched(&conn, a, "e1", true, 1).unwrap();
        conn.execute("DELETE FROM channels WHERE id = ?1", [a])
            .unwrap();
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM watch_progress", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 0);
    }
}
