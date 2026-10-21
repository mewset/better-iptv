//! Guide commands: thin handlers over `epg::read` (what the guide shows),
//! `epg::service` (downloads, sources, time policy) and `epg::status`.
//!
//! Times cross IPC as RFC 3339 strings and are Unix seconds inside. Keys are
//! the channel ids as the playlist spells them; answers are keyed the same
//! way (`epg::read`).

use crate::commands::with_db;
use crate::epg::read::{self, active_profile, NowNext, Programme};
use crate::epg::service::{EpgService, Finished};
use crate::epg::sources::{list_sources, SourcePatch};
use crate::epg::status::{label, EpgSourceStatus, EpgStatus};
use crate::epg_domain::policy::TimePolicy;
use crate::epg_domain::source::SourceOrigin;
use crate::epg_domain::{self, normalize_epg_url};
use crate::error::AppError;
use crate::state::AppState;
use log::{debug, info, warn};
use r2d2::Pool;
use r2d2_sqlite::SqliteConnectionManager;
use serde::Serialize;
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

/// The guide's status for the active profile: one row per source that
/// applies to it, and the totals. The same payload arrives as `epg-status`
/// whenever it changes.
#[tauri::command]
pub async fn get_epg_status(epg: State<'_, EpgService>) -> Result<EpgStatus, AppError> {
    epg.status().await
}

// ========== Temporary wrappers ==========
//
// TEMPORARY: the commands below keep the names and payloads the shipped
// frontend calls until it moves to the commands above (PR A-frontend), which
// deletes them.

/// Current/next titles with times, in the old `get_channels_epg` shape.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ChannelEpg {
    pub current: Option<String>,
    pub current_start: Option<String>,
    pub current_end: Option<String>,
    pub next: Option<String>,
    pub next_start: Option<String>,
}

impl From<NowNext> for ChannelEpg {
    fn from(entry: NowNext) -> Self {
        let (current, current_start, current_end) = match entry.now {
            Some(p) => (Some(p.title), Some(p.start), Some(p.stop)),
            None => (None, None, None),
        };
        let (next, next_start) = match entry.next {
            Some(p) => (Some(p.title), Some(p.start)),
            None => (None, None),
        };
        ChannelEpg {
            current,
            current_start,
            current_end,
            next,
            next_start,
        }
    }
}

/// One guide programme in the old `get_guide` shape.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct GuideProgram {
    pub title: String,
    pub description: Option<String>,
    pub start_time: String,
    pub end_time: String,
}

impl From<Programme> for GuideProgram {
    fn from(p: Programme) -> Self {
        GuideProgram {
            title: p.title,
            description: p.description,
            start_time: p.start,
            end_time: p.stop,
        }
    }
}

/// The old `force_refresh_epg` answer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct EpgRefreshResult {
    pub success: bool,
    pub programs_loaded: usize,
    pub timestamp: String,
    pub error: Option<String>,
}

/// Shown by `force_refresh_epg` when no source applies.
const NO_SOURCE_MESSAGE: &str = "No guide source is enabled for this profile";

/// TEMPORARY: `get_channel_epg` → current and next title of one channel.
#[tauri::command]
pub async fn get_channel_epg(
    state: State<'_, AppState>,
    channel_epg_id: String,
) -> Result<(Option<String>, Option<String>), AppError> {
    epg_domain::validate_channel_epg_id(&channel_epg_id)?;
    let mut answer = read_now_next(&state.pool, vec![channel_epg_id.clone()], now()).await?;
    Ok(match answer.remove(&channel_epg_id) {
        Some(entry) => (entry.now.map(|p| p.title), entry.next.map(|p| p.title)),
        None => (None, None),
    })
}

/// TEMPORARY: `get_channels_epg` → `get_epg_now_next` in the old shape.
#[tauri::command]
pub async fn get_channels_epg(
    state: State<'_, AppState>,
    epg_ids: Vec<String>,
) -> Result<HashMap<String, ChannelEpg>, AppError> {
    check_batch(epg_ids.len())?;
    let ids: Vec<String> = epg_ids
        .into_iter()
        .filter(|id| !id.trim().is_empty())
        .collect();
    if ids.is_empty() {
        return Ok(HashMap::new());
    }
    let answer = read_now_next(&state.pool, ids, now()).await?;
    debug!("get_channels_epg -> {} channels with data", answer.len());
    Ok(answer.into_iter().map(|(k, v)| (k, v.into())).collect())
}

/// TEMPORARY: `get_guide` → `get_epg_guide` in the old shape.
#[tauri::command]
pub async fn get_guide(
    state: State<'_, AppState>,
    epg_ids: Vec<String>,
    from: String,
    to: String,
) -> Result<HashMap<String, Vec<GuideProgram>>, AppError> {
    for id in &epg_ids {
        epg_domain::validate_channel_epg_id(id)?;
    }
    let answer = read_guide(&state.pool, epg_ids, &from, &to).await?;
    Ok(answer
        .into_iter()
        .map(|(k, list)| (k, list.into_iter().map(GuideProgram::from).collect()))
        .collect())
}

/// TEMPORARY: `get_guide_epg_ids` → `get_epg_guide_keys`.
#[tauri::command]
pub async fn get_guide_epg_ids(
    state: State<'_, AppState>,
    from: String,
    to: String,
) -> Result<Vec<String>, AppError> {
    read_guide_keys(&state.pool, &from, &to).await
}

/// The old answer for downloads that ended as `ended`, `labels` naming the
/// sources. A success only when every source stored its feed. Otherwise the
/// error names each source that did not, and says when the others were
/// updated: Settings shows it under "EPG Update Failed".
fn refresh_result(
    ended: &[(i64, Finished)],
    labels: &HashMap<i64, String>,
    at: i64,
) -> EpgRefreshResult {
    let stored: usize = ended
        .iter()
        .filter_map(|(_, f)| match f {
            Finished::Stored(count) => Some(*count as usize),
            _ => None,
        })
        .sum();
    let any_stored = ended.iter().any(|(_, f)| matches!(f, Finished::Stored(_)));
    let problems: Vec<String> = ended
        .iter()
        .filter_map(|(id, f)| {
            let label = labels
                .get(id)
                .cloned()
                .unwrap_or_else(|| format!("Guide source {id}"));
            match f {
                Finished::Stored(_) => None,
                Finished::Failed(message) => Some(format!("{label}: {message}")),
                Finished::Abandoned => Some(format!(
                    "{label}: the source changed during the update, nothing was stored"
                )),
                Finished::Unknown => Some(format!("{label}: the result of the update was lost")),
            }
        })
        .collect();
    let error = if ended.is_empty() {
        Some(NO_SOURCE_MESSAGE.to_string())
    } else if problems.is_empty() {
        None
    } else if any_stored {
        Some(format!(
            "{}. The other guide sources were updated.",
            problems.join(". ")
        ))
    } else {
        Some(problems.join(". "))
    };
    EpgRefreshResult {
        success: error.is_none(),
        programs_loaded: stored,
        timestamp: read::rfc3339(at).unwrap_or_default(),
        error,
    }
}

/// TEMPORARY: "Update Now". Downloads every enabled source of the active
/// profile and waits for the result, also when a download was already
/// running.
#[tauri::command]
pub async fn force_refresh_epg(
    state: State<'_, AppState>,
    epg: State<'_, EpgService>,
) -> Result<EpgRefreshResult, AppError> {
    update_now(&state.pool, &epg).await
}

async fn update_now(
    pool: &Pool<SqliteConnectionManager>,
    epg: &EpgService,
) -> Result<EpgRefreshResult, AppError> {
    let ended = epg.refresh_and_wait(None).await?;
    let labels = with_db(pool, |conn| {
        Ok(list_sources(conn)?
            .iter()
            .map(|s| (s.id, label(s)))
            .collect::<HashMap<_, _>>())
    })
    .await?;
    let result = refresh_result(&ended, &labels, now());
    match &result.error {
        None => info!(
            "EPG refresh completed: {} programmes loaded",
            result.programs_loaded
        ),
        Some(e) => warn!("EPG refresh failed: {e}"),
    }
    Ok(result)
}

/// TEMPORARY: the Settings URL field, saved. An empty URL means the
/// providers' guides, as in 3.1.x: the global URL sources are disabled and
/// the provider sources enabled. A URL goes into a global URL source (the
/// one that has it is enabled, otherwise the first one takes it, or a new
/// one is added) and is downloaded now. Returns the programmes stored.
#[tauri::command]
pub async fn fetch_epg_data(
    state: State<'_, AppState>,
    epg: State<'_, EpgService>,
    epg_url: String,
) -> Result<usize, AppError> {
    save_guide_url(&state.pool, &epg, &epg_url).await
}

async fn save_guide_url(
    pool: &Pool<SqliteConnectionManager>,
    epg: &EpgService,
    epg_url: &str,
) -> Result<usize, AppError> {
    let url = normalize_epg_url(epg_url);
    let manual: Vec<(i64, String)> = with_db(pool, |conn| {
        Ok(list_sources(conn)?
            .into_iter()
            .filter(|s| s.origin == SourceOrigin::Manual && s.playlist_id.is_none())
            .map(|s| (s.id, s.url.unwrap_or_default()))
            .collect())
    })
    .await?;

    if url.is_empty() {
        epg.use_provider_guides().await?;
        return Ok(0);
    }
    epg_domain::validate_epg_url(&url)?;

    let target = manual
        .iter()
        .find(|(_, u)| *u == url)
        .or_else(|| manual.first());
    let (id, run) = match target {
        Some((id, _)) => {
            let patch = SourcePatch {
                enabled: Some(true),
                url: Some(url),
                ..SourcePatch::default()
            };
            (*id, epg.update_source(*id, patch).await?)
        }
        None => {
            let (status, run) = epg.add_source(url).await?;
            (status.id, run)
        }
    };

    // The change may have started the download. Otherwise one was running
    // already, or the source was fetched a moment ago and is not due: then
    // ask for one and wait for it.
    let started = match run {
        Some(run) => run
            .await
            .map_err(|e| AppError::Epg(format!("The guide update failed: {e}")))?
            .into_iter()
            .rev()
            .find(|r| r.source_id == id)
            .map(|r| Finished::of_result(&r.result)),
        None => None,
    };
    let mut outcome = started;
    // A download of the old URL that was running when the URL changed ends
    // as abandoned, and the new URL's download follows it: wait for that.
    for _ in 0..2 {
        if matches!(outcome, Some(ref f) if *f != Finished::Abandoned) {
            break;
        }
        outcome = epg
            .refresh_and_wait(Some(id))
            .await?
            .into_iter()
            .find(|(source, _)| *source == id)
            .map(|(_, f)| f);
    }
    match outcome {
        Some(Finished::Stored(count)) => Ok(count as usize),
        Some(Finished::Failed(message)) => Err(AppError::Epg(message)),
        Some(Finished::Abandoned | Finished::Unknown) | None => Err(AppError::Epg(
            "The guide source changed during the update".to_string(),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::epg::service::{EpgEvents, EpgRefreshed, ServiceParts};
    use crate::epg::sources::feed_path;
    use crate::epg::status::EpgStatus;
    use crate::epg::test_support::*;
    use crate::epg::{ingest, Fetch, IngestOutcome, IngestScope};
    use crate::http::test_server::{respond, serve, trickle};
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
    async fn the_old_read_commands_answer_from_the_new_store() {
        let f = Fixture::new("commands");
        let s = add_manual(&f.conn(), "http://epg.example/epg.xml");
        f.store(s, &feed(), NOW).await;
        let keys = |list: &[&str]| list.iter().map(|k| k.to_string()).collect::<Vec<_>>();

        let now_next = read_now_next(&f.pool, keys(&["svt1.se", "ÄMNE.SE", "none"]), NOW)
            .await
            .unwrap();
        let old: HashMap<String, ChannelEpg> =
            now_next.into_iter().map(|(k, v)| (k, v.into())).collect();
        assert_eq!(old.len(), 2);
        assert_eq!(
            old["svt1.se"],
            ChannelEpg {
                current: Some("News".into()),
                current_start: Some(at(NOW - H)),
                current_end: Some(at(NOW + H)),
                next: Some("Film".into()),
                next_start: Some(at(NOW + H)),
            }
        );
        assert_eq!(old["ÄMNE.SE"].current.as_deref(), Some("Ämne"));

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
        let old = GuideProgram::from(guide["SVT1.se"][1].clone());
        assert_eq!(
            (old.start_time, old.end_time),
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

    /// (id, url, enabled) of every source, by id.
    fn all_sources(f: &Fixture) -> Vec<(i64, Option<String>, bool)> {
        list_sources(&f.conn())
            .unwrap()
            .into_iter()
            .map(|s| (s.id, s.url, s.enabled))
            .collect()
    }

    #[tokio::test]
    async fn saving_the_url_field_keeps_one_url_source_and_downloads_it() {
        let f = Fixture::new("commands");
        let server = serve(vec![respond("200 OK", feed().as_bytes())]).await;
        let epg = service(&f);
        let (first, second) = (
            format!("{}/a.xml", server.base),
            format!("{}/b.xml", server.base),
        );

        assert_eq!(save_guide_url(&f.pool, &epg, &first).await.unwrap(), 3);
        let id = all_sources(&f)[0].0;
        assert_eq!(all_sources(&f), [(id, Some(first.clone()), true)]);
        assert!(feed_path(&f.dir.0, id).exists());

        // Another URL replaces it in the same source, and downloads.
        assert_eq!(save_guide_url(&f.pool, &epg, &second).await.unwrap(), 3);
        assert_eq!(all_sources(&f), [(id, Some(second.clone()), true)]);

        // Emptied: the provider's guide again, as in 3.1.x. The URL
        // source is disabled and kept.
        let conn = f.conn();
        conn.execute(
            "INSERT INTO playlists (id, name, url, xtream_username, xtream_password)
             VALUES (1, 'Provider', 'http://127.0.0.1:9', 'john', 'secret')",
            [],
        )
        .unwrap();
        let provider = crate::epg::sources::ensure_xtream_source(&conn, 1).unwrap();
        conn.execute(
            "UPDATE epg_source SET enabled = 0, last_attempt_at = ?2, last_success_at = ?2
             WHERE id = ?1",
            rusqlite::params![provider, NOW],
        )
        .unwrap();
        drop(conn);
        assert_eq!(save_guide_url(&f.pool, &epg, "  ").await.unwrap(), 0);
        assert_eq!(
            all_sources(&f),
            [(id, Some(second.clone()), false), (provider, None, true)]
        );

        // The same URL again: enabled and downloaded, though fetched a
        // moment ago.
        assert_eq!(save_guide_url(&f.pool, &epg, &second).await.unwrap(), 3);
        assert_eq!(
            all_sources(&f),
            [(id, Some(second), true), (provider, None, true)]
        );
        assert_eq!(server.connections(), 3);

        let err = save_guide_url(&f.pool, &epg, "ftp://epg.example/a.xml")
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::InvalidInput(_)), "{err:?}");
    }

    #[tokio::test]
    async fn a_failed_download_after_saving_the_url_is_an_error() {
        let f = Fixture::new("commands");
        let server = serve(vec![respond("403 Forbidden", b"no")]).await;
        let epg = service(&f);

        let err = save_guide_url(&f.pool, &epg, &format!("{}/epg.xml", server.base))
            .await
            .unwrap_err();

        assert_eq!(
            err.to_string(),
            "EPG error: The EPG server answered 403 Forbidden"
        );
    }

    #[tokio::test]
    async fn saving_a_url_while_the_old_one_downloads_waits_for_the_new_one() {
        let f = Fixture::new("commands");
        let body = feed().into_bytes();
        let server = serve(vec![trickle(&body, 8, Duration::from_millis(100))]).await;
        let epg = service(&f);
        let s = add_manual(&f.conn(), &format!("{}/old.xml", server.base));
        let running = epg.refresh(Some(s)).await.unwrap().unwrap();
        while !crate::epg::sources::download_path(&f.dir.0, s).exists() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }

        let stored = save_guide_url(&f.pool, &epg, &format!("{}/new.xml", server.base))
            .await
            .unwrap();

        assert_eq!(stored, 3, "the new URL's download, not the abandoned one");
        let runs = running.await.unwrap();
        assert!(matches!(
            runs[0].result,
            Ok(IngestOutcome::Abandoned(
                crate::epg::AbandonReason::UrlChanged
            ))
        ));
        assert_eq!(f.programmes(s).len(), 3);
    }

    #[tokio::test]
    async fn update_now_waits_for_the_download_and_reports_it() {
        let f = Fixture::new("commands");
        let server = serve(vec![respond("200 OK", feed().as_bytes())]).await;
        let epg = service(&f);

        let none = update_now(&f.pool, &epg).await.unwrap();
        assert_eq!(none.error.as_deref(), Some(NO_SOURCE_MESSAGE));

        add_manual(&f.conn(), &format!("{}/epg.xml", server.base));
        let result = update_now(&f.pool, &epg).await.unwrap();

        assert!(result.success, "{result:?}");
        assert_eq!(result.programs_loaded, 3);
        assert_eq!(server.connections(), 1);
    }

    /// The captured feed (see the EPG rewrite brief) through the ingest and
    /// the old read commands, at the capture's noon:
    /// `EPG_REAL_FEED=/path/to/xmltv.xml cargo test --lib real_feed -- --ignored`.
    /// Prints counts only.
    #[tokio::test]
    #[ignore]
    async fn real_feed_through_the_old_read_commands() {
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
            let old = ChannelEpg::from(entry.clone());
            if let (Some(start), Some(end)) = (&old.current_start, &old.current_end) {
                assert!(parse(start) <= NOW && NOW < parse(end), "{key}");
            }
            if let Some(next) = &old.next_start {
                assert!(parse(next) > NOW, "{key}");
            }
        }

        let wanted: Vec<String> = keys.iter().take(763).cloned().collect();
        let guide = read_guide(&f.pool, wanted.clone(), &at(NOW), &at(NOW + 3 * H))
            .await
            .unwrap();
        assert_eq!(guide.len(), wanted.len());
        let mut programmes = 0;
        for list in guide.values() {
            let old: Vec<GuideProgram> = list.iter().cloned().map(GuideProgram::from).collect();
            for pair in old.windows(2) {
                assert!(parse(&pair[0].start_time) < parse(&pair[1].start_time));
            }
            for p in &old {
                let (start, end) = (parse(&p.start_time), parse(&p.end_time));
                assert!(start < end && end > NOW && start < NOW + 3 * H);
            }
            programmes += old.len();
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

    #[test]
    fn the_old_now_next_shape_carries_titles_and_times() {
        let programme = |title: &str, start: &str, stop: &str| Programme {
            title: title.to_string(),
            description: None,
            start: start.to_string(),
            stop: stop.to_string(),
        };
        let entry = NowNext {
            now: Some(programme("News", "a", "b")),
            next: Some(programme("Film", "b", "c")),
        };
        assert_eq!(
            ChannelEpg::from(entry),
            ChannelEpg {
                current: Some("News".into()),
                current_start: Some("a".into()),
                current_end: Some("b".into()),
                next: Some("Film".into()),
                next_start: Some("b".into()),
            }
        );
        let only_next = NowNext {
            now: None,
            next: Some(programme("Film", "b", "c")),
        };
        let old = ChannelEpg::from(only_next);
        assert_eq!((old.current, old.current_start), (None, None));
        assert_eq!(old.next.as_deref(), Some("Film"));
        assert_eq!(
            serde_json::to_value(GuideProgram::from(programme("News", "a", "b"))).unwrap(),
            serde_json::json!({"title": "News", "description": null, "start_time": "a", "end_time": "b"})
        );
    }

    #[test]
    fn update_now_succeeds_only_when_every_source_stored_and_names_the_others() {
        let at = 1_792_584_000;
        let labels = HashMap::from([
            (1, "epg.example".to_string()),
            (2, "My provider".to_string()),
        ]);
        let all = refresh_result(
            &[(1, Finished::Stored(40)), (2, Finished::Stored(2))],
            &labels,
            at,
        );
        assert_eq!(
            all,
            EpgRefreshResult {
                success: true,
                programs_loaded: 42,
                timestamp: "2026-10-21T12:00:00+00:00".into(),
                error: None,
            }
        );

        let some = refresh_result(
            &[
                (1, Finished::Failed("down".into())),
                (2, Finished::Stored(40)),
            ],
            &labels,
            at,
        );
        assert!(!some.success);
        assert_eq!(some.programs_loaded, 40);
        assert_eq!(
            some.error.as_deref(),
            Some("epg.example: down. The other guide sources were updated.")
        );

        let failed = refresh_result(
            &[
                (1, Finished::Abandoned),
                (
                    2,
                    Finished::Failed("The EPG server answered 403 Forbidden".into()),
                ),
            ],
            &labels,
            at,
        );
        assert!(!failed.success);
        assert_eq!(
            failed.error.as_deref(),
            Some(
                "epg.example: the source changed during the update, nothing was stored. \
                 My provider: The EPG server answered 403 Forbidden"
            )
        );

        let abandoned = refresh_result(&[(1, Finished::Abandoned)], &labels, at);
        assert!(!abandoned.success, "nothing stored is no success");
        let lost = refresh_result(&[(3, Finished::Unknown)], &labels, at);
        assert!(!lost.success);
        assert_eq!(
            lost.error.as_deref(),
            Some("Guide source 3: the result of the update was lost"),
            "a lost outcome is not \"no source\""
        );
        let none = refresh_result(&[], &labels, at);
        assert!(!none.success);
        assert_eq!(none.error.as_deref(), Some(NO_SOURCE_MESSAGE));
    }
}
