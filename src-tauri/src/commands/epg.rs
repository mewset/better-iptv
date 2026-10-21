//! Guide commands: thin handlers over `epg::read` (what the guide shows),
//! `epg::service` (downloads, sources, time policy, matches set by hand),
//! `epg::search`, `epg::matching` and `epg::status`.
//!
//! Times cross IPC as RFC 3339 strings and are Unix seconds inside. Keys are
//! the channel ids as the playlist spells them; answers are keyed the same
//! way (`epg::read`).

use crate::commands::with_db;
use crate::epg::matching::{self, MatchDetails};
use crate::epg::read::{self, active_profile, NowNext, Programme};
use crate::epg::search::{self, EpgChannelHit};
use crate::epg::service::EpgService;
use crate::epg::sources::SourcePatch;
use crate::epg::status::{EpgSourceStatus, EpgStatus};
use crate::epg_domain;
use crate::epg_domain::policy::TimePolicy;
use crate::error::AppError;
use crate::state::AppState;
use r2d2::Pool;
use r2d2_sqlite::SqliteConnectionManager;
use std::collections::HashMap;
use tauri::State;

/// Upper bound on keys per now/next request; the channel grid asks for at
/// most 100.
const MAX_EPG_BATCH: usize = 500;

fn now() -> i64 {
    chrono::Utc::now().timestamp()
}

fn check_batch(count: usize) -> Result<(), AppError> {
    if count > MAX_EPG_BATCH {
        return Err(AppError::InvalidInput(format!(
            "At most {} EPG ids per request",
            MAX_EPG_BATCH
        )));
    }
    Ok(())
}

/// Now and next for each key at `now`, in the active profile.
async fn read_now_next(
    pool: &Pool<SqliteConnectionManager>,
    keys: Vec<String>,
    now: i64,
) -> Result<HashMap<String, NowNext>, AppError> {
    with_db(pool, move |conn| {
        let profile = active_profile(conn)?;
        Ok(read::now_next(conn, profile, &keys, now)?)
    })
    .await
}

/// The guide between `from` and `to` (RFC 3339) for each key.
async fn read_guide(
    pool: &Pool<SqliteConnectionManager>,
    keys: Vec<String>,
    from: &str,
    to: &str,
) -> Result<HashMap<String, Vec<Programme>>, AppError> {
    epg_domain::validate_guide_id_count(keys.len())?;
    let (from, to) = epg_domain::validate_guide_window(from, to)?;
    with_db(pool, move |conn| {
        let profile = active_profile(conn)?;
        Ok(read::guide(conn, profile, &keys, from, to)?)
    })
    .await
}

/// The keys the guide has programmes for between `from` and `to`.
async fn read_guide_keys(
    pool: &Pool<SqliteConnectionManager>,
    from: &str,
    to: &str,
) -> Result<Vec<String>, AppError> {
    let (from, to) = epg_domain::validate_guide_ids_window(from, to)?;
    with_db(pool, move |conn| {
        let profile = active_profile(conn)?;
        Ok(read::guide_keys(conn, profile, from, to)?)
    })
    .await
}

/// What each channel shows now and next. Keyed by the key as sent; a key
/// the guide has nothing for is left out.
#[tauri::command]
pub async fn get_epg_now_next(
    state: State<'_, AppState>,
    keys: Vec<String>,
) -> Result<HashMap<String, NowNext>, AppError> {
    check_batch(keys.len())?;
    read_now_next(&state.pool, keys, now()).await
}

/// Programmes overlapping `from`-`to` (RFC 3339, at most 48 hours) for each
/// key; every key sent is in the answer.
#[tauri::command]
pub async fn get_epg_guide(
    state: State<'_, AppState>,
    keys: Vec<String>,
    from: String,
    to: String,
) -> Result<HashMap<String, Vec<Programme>>, AppError> {
    read_guide(&state.pool, keys, &from, &to).await
}

/// Keys of the channels whose stored guide (first start to last stop)
/// touches `from`-`to` (at most seven days), in a source of the active
/// profile. A channel with a gap over the whole range is listed too; for the
/// guide's five-day range that reading and "has a programme in it" agree.
#[tauri::command]
pub async fn get_epg_guide_keys(
    state: State<'_, AppState>,
    from: String,
    to: String,
) -> Result<Vec<String>, AppError> {
    read_guide_keys(&state.pool, &from, &to).await
}

/// Add a guide URL for every profile and start its first download.
#[tauri::command]
pub async fn add_epg_source(
    epg: State<'_, EpgService>,
    url: String,
) -> Result<EpgSourceStatus, AppError> {
    Ok(epg.add_source(url).await?.0)
}

/// Enable or disable a source, change its priority, or (for a URL added by
/// hand) its URL. Fields left out stay as they are.
#[tauri::command]
pub async fn update_epg_source(
    epg: State<'_, EpgService>,
    id: i64,
    patch: SourcePatch,
) -> Result<(), AppError> {
    epg.update_source(id, patch).await?;
    Ok(())
}

/// Remove a URL added by hand, with its programmes and cached feed.
#[tauri::command]
pub async fn remove_epg_source(epg: State<'_, EpgService>, id: i64) -> Result<(), AppError> {
    epg.remove_source(id).await
}

/// Download one source, or every enabled source of the active profile, now.
/// Returns at once; progress arrives as `epg-status` events.
#[tauri::command]
pub async fn refresh_epg(
    epg: State<'_, EpgService>,
    source_id: Option<i64>,
) -> Result<(), AppError> {
    epg.refresh(source_id).await?;
    Ok(())
}

/// Set how a source's times are read. Returns at once; a cached feed is
/// read again under the new policy in the background.
#[tauri::command]
pub async fn set_epg_time_policy(
    epg: State<'_, EpgService>,
    source_id: i64,
    policy: TimePolicy,
) -> Result<(), AppError> {
    policy.validate()?;
    epg.set_time_policy(source_id, policy).await?;
    Ok(())
}

/// `(channel id, guide key)` of the playlist's live channels that are
/// matched to the guide. After an `epg-refreshed` event with
/// `matches_changed` above 0, the frontend sets these keys on the channels
/// it holds (and clears the key of every other live channel) instead of
/// reading the whole channel list again.
#[tauri::command]
pub async fn get_channel_epg_keys(
    state: State<'_, AppState>,
    playlist_id: i64,
) -> Result<Vec<(i64, String)>, AppError> {
    with_db(&state.pool, move |conn| {
        Ok(crate::db::queries::get_channel_epg_keys(conn, playlist_id)?)
    })
    .await
}

/// Match a live channel to the guide channel `key` by hand, or with `None`
/// clear its manual match and match it automatically again. A key without
/// programmes in the channel's profile is refused (`InvalidInput`). A change
/// is announced with `epg-refreshed` (`match`, one channel) and `epg-status`.
#[tauri::command]
pub async fn set_channel_epg_match(
    epg: State<'_, EpgService>,
    channel_id: i64,
    key: Option<String>,
) -> Result<(), AppError> {
    epg.set_channel_match(channel_id, key).await
}

/// Guide channels of the active profile's sources whose display name or
/// key contains `query`, best first, at most `limit` (1 to 50). A query
/// under two characters finds nothing.
#[tauri::command]
pub async fn search_epg_channels(
    state: State<'_, AppState>,
    query: String,
    limit: u32,
) -> Result<Vec<EpgChannelHit>, AppError> {
    with_db(&state.pool, move |conn| {
        let profile = active_profile(conn)?;
        Ok(search::search_channels(conn, profile, &query, limit)?)
    })
    .await
}

/// The playlist's channels matched by hand (with the guide's name for each
/// key) and the ids of those matched by name, which the channel list does
/// not tell apart from a match by id.
#[tauri::command]
pub async fn get_channel_match_details(
    state: State<'_, AppState>,
    playlist_id: i64,
) -> Result<MatchDetails, AppError> {
    with_db(&state.pool, move |conn| {
        Ok(matching::match_details(conn, playlist_id)?)
    })
    .await
}

/// The guide's status for the active profile: one row per source that
/// applies to it, and the totals. The same payload arrives as `epg-status`
/// whenever it changes.
#[tauri::command]
pub async fn get_epg_status(epg: State<'_, EpgService>) -> Result<EpgStatus, AppError> {
    epg.status().await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::epg::service::{EpgEvents, EpgRefreshed, ServiceParts};
    use crate::epg::sources::feed_path;
    use crate::epg::status::EpgStatus;
    use crate::epg::test_support::*;
    use crate::epg::{ingest, Fetch, IngestOutcome, IngestScope};
    use std::collections::HashSet;
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    struct NoEvents;

    impl EpgEvents for NoEvents {
        fn refreshed(&self, _: &EpgRefreshed) {}
        fn status(&self, _: &EpgStatus) {}
    }

    fn service(f: &Fixture) -> EpgService {
        EpgService::new(ServiceParts {
            pool: f.pool.clone(),
            db_path: f.db_path.clone(),
            cache_dir: f.dir.0.clone(),
            client: f.client.clone(),
            download_deadline: Duration::from_secs(10),
            lock: Arc::new(tokio::sync::Mutex::new(())),
            refreshing: Arc::new(Mutex::new(HashSet::new())),
            pending_policy: Arc::new(Mutex::new(HashSet::new())),
            events: Arc::new(NoEvents),
            clock: Arc::new(|| NOW),
        })
    }

    fn at(t: i64) -> String {
        read::rfc3339(t).unwrap()
    }

    fn feed() -> String {
        Feed::new()
            .programme("SVT1.se", NOW - H, NOW + H, "News")
            .programme("SVT1.se", NOW + H, NOW + 2 * H, "Film")
            .programme("Ämne.se", NOW, NOW + H, "Ämne")
            .xml()
    }

    #[tokio::test]
    async fn the_read_commands_answer_from_the_store() {
        let f = Fixture::new("commands");
        let s = add_manual(&f.conn(), "http://epg.example/epg.xml");
        f.store(s, &feed(), NOW).await;
        let keys = |list: &[&str]| list.iter().map(|k| k.to_string()).collect::<Vec<_>>();

        let now_next = read_now_next(&f.pool, keys(&["svt1.se", "ÄMNE.SE", "none"]), NOW)
            .await
            .unwrap();
        assert_eq!(now_next.len(), 2);
        let programme = |title: &str, start: i64, stop: i64| Programme {
            title: title.to_string(),
            description: None,
            start: at(start),
            stop: at(stop),
        };
        assert_eq!(
            now_next["svt1.se"],
            NowNext {
                now: Some(programme("News", NOW - H, NOW + H)),
                next: Some(programme("Film", NOW + H, NOW + 2 * H)),
            }
        );
        assert_eq!(
            now_next["ÄMNE.SE"].now.as_ref().map(|p| p.title.as_str()),
            Some("Ämne")
        );
        // The IPC shape the frontend's types list.
        assert_eq!(
            serde_json::to_value(&now_next["svt1.se"]).unwrap(),
            serde_json::json!({
                "now": {"title": "News", "description": null, "start": at(NOW - H), "stop": at(NOW + H)},
                "next": {"title": "Film", "description": null, "start": at(NOW + H), "stop": at(NOW + 2 * H)},
            })
        );

        // `to` half a second after a start keeps that programme in, as the
        // string comparison of the old store did.
        let guide = read_guide(
            &f.pool,
            keys(&["SVT1.se"]),
            "2026-10-21T13:00:00+01:00",
            "2026-10-21T13:00:00.500Z",
        )
        .await
        .unwrap();
        let titles: Vec<&str> = guide["SVT1.se"].iter().map(|p| p.title.as_str()).collect();
        assert_eq!(titles, ["News", "Film"]);
        let film = &guide["SVT1.se"][1];
        assert_eq!(
            (film.start.clone(), film.stop.clone()),
            (at(NOW + H), at(NOW + 2 * H))
        );
        let err = read_guide(&f.pool, keys(&["svt1.se"]), &at(NOW), &at(NOW + 49 * H))
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::InvalidInput(_)));

        assert_eq!(
            read_guide_keys(&f.pool, &at(NOW - 24 * H), &at(NOW + 96 * H))
                .await
                .unwrap(),
            ["svt1.se", "ämne.se"]
        );
        let status = service(&f).status().await.unwrap();
        assert_eq!(status.sources.len(), 1);
        assert_eq!(status.programme_count, 3);
        assert!(
            !status.guide_downloaded,
            "read from the cache, not downloaded"
        );
    }

    #[tokio::test]
    async fn the_status_counts_only_enabled_sources_of_the_active_profile() {
        let f = Fixture::new("commands");
        let conn = f.conn();
        let s = add_manual(&conn, "http://epg.example/epg.xml");
        conn.execute(
            "UPDATE epg_source SET last_success_at = ?2, programme_count = 7 WHERE id = ?1",
            rusqlite::params![s, NOW],
        )
        .unwrap();
        let status = service(&f).status().await.unwrap();
        assert_eq!((status.programme_count, status.guide_downloaded), (7, true));
        assert_eq!(status.sources[0].last_success_at, Some(at(NOW)));
        assert_eq!(
            status.sources[0].display_url.as_deref(),
            Some("http://epg.example/epg.xml")
        );

        conn.execute("UPDATE epg_source SET enabled = 0", [])
            .unwrap();
        let status = service(&f).status().await.unwrap();
        assert_eq!(status.sources.len(), 1, "a disabled source keeps its row");
        assert!(!status.sources[0].enabled);
        assert_eq!(
            (status.programme_count, status.guide_downloaded),
            (0, false)
        );
    }

    /// The captured feed (see the EPG rewrite brief) through the ingest and
    /// the read commands, at the capture's noon:
    /// `EPG_REAL_FEED=/path/to/xmltv.xml cargo test --lib real_feed -- --ignored`.
    /// Prints counts only.
    #[tokio::test]
    #[ignore]
    async fn real_feed_through_the_read_commands() {
        let Some(path) = std::env::var_os("EPG_REAL_FEED") else {
            eprintln!("EPG_REAL_FEED is not set; skipped");
            return;
        };
        let f = Fixture::new("commands-real");
        let s = add_manual(&f.conn(), "http://real.example/epg.xml");
        std::fs::copy(&path, feed_path(&f.dir.0, s)).unwrap();
        let outcome = ingest(&f.env(), s, Fetch::Cache, IngestScope::Feed, NOW)
            .await
            .unwrap();
        let IngestOutcome::Stored(report) = outcome else {
            panic!("not stored: {outcome:?}");
        };

        let keys = read_guide_keys(&f.pool, &at(NOW - 24 * H), &at(NOW + 96 * H))
            .await
            .unwrap();
        // The feed lists 2,055 ids; fewer of them carry programmes.
        assert!(keys.len() > 500, "{} keys", keys.len());

        let wanted: Vec<String> = keys.iter().take(100).cloned().collect();
        let now_next = read_now_next(&f.pool, wanted.clone(), NOW).await.unwrap();
        assert!(now_next.len() >= 50, "{} answered", now_next.len());
        let parse = |t: &str| chrono::DateTime::parse_from_rfc3339(t).unwrap().timestamp();
        for (key, entry) in &now_next {
            assert!(wanted.contains(key));
            if let Some(now) = &entry.now {
                assert!(parse(&now.start) <= NOW && NOW < parse(&now.stop), "{key}");
            }
            if let Some(next) = &entry.next {
                assert!(parse(&next.start) > NOW, "{key}");
            }
        }

        let wanted: Vec<String> = keys.iter().take(763).cloned().collect();
        let guide = read_guide(&f.pool, wanted.clone(), &at(NOW), &at(NOW + 3 * H))
            .await
            .unwrap();
        assert_eq!(guide.len(), wanted.len());
        let mut programmes = 0;
        for list in guide.values() {
            for pair in list.windows(2) {
                assert!(parse(&pair[0].start) < parse(&pair[1].start));
            }
            for p in list {
                let (start, end) = (parse(&p.start), parse(&p.stop));
                assert!(start < end && end > NOW && start < NOW + 3 * H);
            }
            programmes += list.len();
        }
        assert!(programmes > wanted.len(), "{programmes} programmes");

        let status = service(&f).status().await.unwrap();
        assert_eq!(status.programme_count, report.stored);
        eprintln!(
            "REAL FEED: {} programmes on {} channels stored; {} guide keys; now/next {} of 100; \
             guide 3 h {} programmes for {} keys",
            report.stored,
            report.keys,
            keys.len(),
            now_next.len(),
            programmes,
            wanted.len()
        );
    }
}
