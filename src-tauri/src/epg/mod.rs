//! EPG (Electronic Program Guide): fetching, parsing and storing guide feeds.
//!
//! `ingest` runs one source through the whole pipeline: the feed is
//! downloaded to `<id>.download` (or the cached `<id>.feed.gz` is read
//! again), parsed into staging with the source's time policy, normalised and
//! swapped into the guide tables in one transaction (`store`). Only then does
//! the download become the source's cached feed.

pub mod decode;
pub mod download;
pub mod parse;
pub mod read;
pub mod sources;
pub mod store;
#[cfg(test)]
mod test_support;
pub mod xmltv;

pub use xmltv::*;

use crate::db::queries::{get_multiple_settings, get_playlist_by_id};
use crate::epg_domain::policy::TimePolicy;
use crate::epg_domain::report::{NormaliseReport, ParseReport, StageTimes};
use crate::epg_domain::source::{same_server, xtream_epg_url, SourceOrigin};
use crate::error::AppError;
use anyhow::{anyhow, Context, Result};
use download::download_feed;
use log::{info, warn};
use r2d2::Pool;
use r2d2_sqlite::SqliteConnectionManager;
use rusqlite::{params, Connection};
use sources::{feed_path, get_source, remove_if_present, SourceRecord};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use store::{source_mismatch, store_feed, IngestConnection, StoreReport, Stored, SwapRequest};

/// Shown when a feed downloads fine but leaves no programme to store: an
/// empty file, a page that is not XMLTV, or a feed whose programmes all
/// ended. Nothing is stored and the previous guide and cached feed stay.
pub const EMPTY_GUIDE_MESSAGE: &str =
    "The EPG server sent a program guide without any programmes, so the current guide was kept";

/// A re-read of the cached feed (after a time policy change) left no
/// programme to store, mostly because every programme in it has ended. The
/// provider's status is not touched; the next download brings new ones.
pub const EMPTY_CACHE_MESSAGE: &str =
    "The saved guide has no programmes left to show, so the current guide was kept";

/// Where an ingest reads its feed from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Fetch {
    /// Download the feed: one request, no retry.
    Network,
    /// Read the source's cached `<id>.feed.gz` again, for a time policy change.
    Cache,
}

/// Which stored programmes an ingest replaces.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IngestScope {
    /// Per channel in the feed, the range the feed covers; other channels,
    /// and rows that ended before a channel's first new start, stay until
    /// they are pruned.
    Feed,
    /// Every programme of the source, for a changed time policy: rows made
    /// under the old policy must not survive next to the new ones.
    WholeSource,
}

/// Why an ingest stopped without storing or recording anything.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AbandonReason {
    SourceRemoved,
    SourceDisabled,
    /// The source's URL changed while the feed of the old one was read.
    UrlChanged,
}

/// What one stored ingest did, for the log line and the caller's events.
#[derive(Clone, Debug, PartialEq)]
pub struct IngestReport {
    pub parse: ParseReport,
    pub normalise: NormaliseReport,
    /// Programmes stored from this feed.
    pub stored: u32,
    /// Channels with programmes in this feed.
    pub keys: u32,
    /// The time policy the feed was read with, recorded as applied.
    pub policy: TimePolicy,
    pub scope: IngestScope,
    pub elapsed: StageTimes,
    /// Write transactions the swap took: one up to
    /// `store::SWAP_CHUNK_ROWS` programmes, one per range of channels above.
    pub transactions: u32,
    /// The longest the swap held the database's write lock at once.
    pub lock_hold: Duration,
}

/// How an ingest ended without an error.
#[derive(Clone, Debug, PartialEq)]
pub enum IngestOutcome {
    Stored(Box<IngestReport>),
    /// The source was removed, disabled or given another URL before the
    /// swap: nothing was stored and its status was left alone.
    Abandoned(AbandonReason),
}

/// What an ingest needs from the app.
pub struct IngestEnv<'a> {
    pub pool: &'a Pool<SqliteConnectionManager>,
    /// The app database the pool is opened on: the store runs on a
    /// connection of its own (`store::IngestConnection`).
    pub db_path: &'a Path,
    /// `<app_data>/epg/`.
    pub cache_dir: &'a Path,
    pub client: &'a reqwest::Client,
    /// Total deadline of the download, `http::BULK_DOWNLOAD_TIMEOUT` in use.
    pub download_deadline: Duration,
}

/// Fetch (or re-read) one source's feed and store its programmes.
///
/// The caller holds `AppState::epg_refresh_lock`: ingests share the staging
/// database and a source's download file. `now` is Unix seconds; it stamps
/// the attempt and decides which programmes have ended.
///
/// A network ingest stamps `last_attempt_at` before the request. The time
/// policy is read once, after the download, and the swap records it as
/// applied. A source that is removed, disabled or given another URL before
/// the swap ends the ingest as `Abandoned`, with nothing stored or recorded.
/// Any other failure keeps the stored programmes and the cached feed and
/// returns a credential-free sentence; after a download it is also recorded
/// as `last_result = 'error'` and `last_error`. A re-read of the cached feed
/// records only the applied policy and the counters when it succeeds and
/// nothing when it fails: `last_result` describes the provider.
pub async fn ingest(
    env: &IngestEnv<'_>,
    source_id: i64,
    fetch: Fetch,
    scope: IngestScope,
    now: i64,
) -> Result<IngestOutcome, AppError> {
    let source = blocking(env.pool, move |conn| Ok(get_source(conn, source_id)?))
        .await
        .map_err(|e| AppError::Epg(e.to_string()))?;
    let Some(source) = source else {
        return Ok(IngestOutcome::Abandoned(AbandonReason::SourceRemoved));
    };
    if !source.enabled {
        return Ok(IngestOutcome::Abandoned(AbandonReason::SourceDisabled));
    }
    let expected_url = source.url.clone();

    let failure = match run(env, &source, fetch, scope, now).await {
        Ok(outcome) => return Ok(outcome),
        Err(e) => e,
    };
    // The full chain goes to the log only, where the formatter masks
    // credentials; the status and the caller get the top-level sentence.
    warn!("EPG ingest of source {source_id} failed: {failure:#}");
    let message = failure.to_string();
    if fetch == Fetch::Cache {
        // The provider's status describes its last answer, not this re-read.
        let changed = blocking(env.pool, move |conn| {
            Ok(source_mismatch(conn, source_id, expected_url.as_deref())?)
        })
        .await;
        return match changed {
            Ok(Some(reason)) => Ok(IngestOutcome::Abandoned(reason)),
            _ => Err(AppError::Epg(message)),
        };
    }
    let recorded = {
        let message = message.clone();
        blocking(env.pool, move |conn| {
            Ok(record_failure(
                conn,
                source_id,
                expected_url.as_deref(),
                &message,
            )?)
        })
        .await
    };
    match recorded {
        Ok(Some(reason)) => Ok(IngestOutcome::Abandoned(reason)),
        Ok(None) => Err(AppError::Epg(message)),
        Err(e) => {
            warn!("EPG ingest of source {source_id}: the failure was not recorded: {e:#}");
            Err(AppError::Epg(message))
        }
    }
}

/// The request a network ingest sends.
struct Request {
    url: String,
    user_agent: Option<String>,
}

async fn run(
    env: &IngestEnv<'_>,
    source: &SourceRecord,
    fetch: Fetch,
    scope: IngestScope,
    now: i64,
) -> Result<IngestOutcome> {
    let source_id = source.id;
    let network = fetch == Fetch::Network;
    let (feed, download_time) = match fetch {
        Fetch::Network => {
            let planned = {
                let source = source.clone();
                blocking(env.pool, move |conn| start_attempt(conn, &source, now)).await?
            };
            let request = match planned {
                Ok(request) => request,
                Err(reason) => return Ok(IngestOutcome::Abandoned(reason)),
            };
            let started = Instant::now();
            let downloaded = download_feed(
                env.client,
                &request.url,
                request.user_agent.as_deref(),
                env.download_deadline,
                env.cache_dir,
                source_id,
            )
            .await?;
            (downloaded.path, started.elapsed())
        }
        Fetch::Cache => (feed_path(env.cache_dir, source_id), Duration::ZERO),
    };

    let job = Job {
        db_path: env.db_path.to_path_buf(),
        cache_dir: env.cache_dir.to_path_buf(),
        feed,
        source_id,
        expected_url: source.url.clone(),
        scope,
        network,
        now,
    };
    let (stored, policy) = tokio::task::spawn_blocking(move || {
        let result = read_and_store(&job);
        if network {
            settle_download(&job, &result);
        }
        result
    })
    .await
    .context("The EPG update task failed")??;

    let report = match stored {
        Stored::Abandoned(reason) => {
            info!("EPG ingest of source {source_id} abandoned: {reason:?}");
            return Ok(IngestOutcome::Abandoned(reason));
        }
        Stored::Committed(report) => report,
    };
    let report = ingest_report(report, policy, scope, download_time);
    info!(
        "EPG ingest of source {source_id} ({fetch:?}, {scope:?}): {} programmes on {} channels \
         stored{}; {} seen, normalise {:?}; download {:?}, parse {:?}, normalise {:?}, \
         store {:?}, lock held {:?} at most over {} transactions",
        report.stored,
        report.keys,
        if report.parse.complete {
            ""
        } else {
            " from a partial feed"
        },
        report.parse.programmes_seen,
        report.normalise,
        report.elapsed.download,
        report.elapsed.parse,
        report.elapsed.normalise,
        report.elapsed.store,
        report.lock_hold,
        report.transactions,
    );
    Ok(IngestOutcome::Stored(Box::new(report)))
}

fn ingest_report(
    report: Box<StoreReport>,
    policy: TimePolicy,
    scope: IngestScope,
    download: Duration,
) -> IngestReport {
    IngestReport {
        stored: report.stored,
        keys: report.keys,
        policy,
        scope,
        elapsed: StageTimes {
            download,
            parse: report.parse_time,
            normalise: report.normalise_time,
            store: report.store_time,
        },
        transactions: report.transactions,
        lock_hold: report.lock_hold,
        parse: report.parse,
        normalise: report.normalise,
    }
}

/// Stamp the attempt and build the request; `Err` when the source changed
/// since it was read.
fn start_attempt(
    conn: &Connection,
    source: &SourceRecord,
    now: i64,
) -> Result<Result<Request, AbandonReason>> {
    let stamped = conn.execute(
        "UPDATE epg_source SET last_attempt_at = ?2
         WHERE id = ?1 AND url IS ?3 AND enabled = 1",
        params![source.id, now, source.url],
    )?;
    if stamped == 0 {
        let reason = source_mismatch(conn, source.id, source.url.as_deref())?
            .unwrap_or(AbandonReason::SourceRemoved);
        return Ok(Err(reason));
    }
    Ok(Ok(fetch_request(conn, source)?))
}

/// The URL and user agent for a source's feed.
///
/// An Xtream source's URL is built from its playlist's credentials now, so a
/// changed password is picked up, and sent with the playlist user agent. A
/// URL source gets that user agent too when it points at an Xtream
/// profile's server, as a provider URL pasted by hand did before.
fn fetch_request(conn: &Connection, source: &SourceRecord) -> Result<Request> {
    match source.origin {
        SourceOrigin::Xtream => {
            let playlist = source
                .playlist_id
                .map(|id| get_playlist_by_id(conn, id))
                .transpose()?
                .flatten()
                .context("The profile this guide belongs to no longer exists")?;
            let (Some(server), Some(username), Some(password)) = (
                playlist.url,
                playlist.xtream_username,
                playlist.xtream_password,
            ) else {
                return Err(anyhow!(
                    "The profile this guide belongs to has no provider login"
                ));
            };
            let url = xtream_epg_url(&server, &username, &password).map_err(|e| match e {
                AppError::InvalidInput(message) => anyhow!(message),
                other => anyhow!(other.to_string()),
            })?;
            Ok(Request {
                url: url.into(),
                user_agent: Some(playlist_user_agent(conn)?),
            })
        }
        SourceOrigin::Manual | SourceOrigin::M3uHeader => {
            let url = source.url.clone().context("This guide source has no URL")?;
            let user_agent = if on_xtream_server(conn, &url)? {
                Some(playlist_user_agent(conn)?)
            } else {
                None
            };
            Ok(Request { url, user_agent })
        }
    }
}

fn playlist_user_agent(conn: &Connection) -> rusqlite::Result<String> {
    let settings = get_multiple_settings(
        conn,
        &["playlist_user_agent_mode", "playlist_user_agent_custom"],
    )?;
    Ok(crate::http::resolve_playlist_user_agent(
        settings.get("playlist_user_agent_mode").map(String::as_str),
        settings
            .get("playlist_user_agent_custom")
            .map(String::as_str),
    ))
}

/// Whether `url` is on the server (host and port) of an Xtream playlist.
fn on_xtream_server(conn: &Connection, url: &str) -> rusqlite::Result<bool> {
    let servers: Vec<String> = conn
        .prepare("SELECT url FROM playlists WHERE xtream_username IS NOT NULL AND url IS NOT NULL")?
        .query_map([], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    Ok(servers.iter().any(|server| same_server(url, server)))
}

/// The blocking half of an ingest: the feed file and what the swap checks.
struct Job {
    db_path: PathBuf,
    cache_dir: PathBuf,
    /// The download, or the cached feed.
    feed: PathBuf,
    source_id: i64,
    expected_url: Option<String>,
    scope: IngestScope,
    network: bool,
    now: i64,
}

/// Read the configured policy, then stage, normalise and swap the feed on
/// a connection of the ingest's own, closed before this returns. Returns the
/// outcome with the policy the feed was read with.
fn read_and_store(job: &Job) -> Result<(Stored, TimePolicy)> {
    let ingest = IngestConnection::open(&job.db_path, &job.cache_dir)?;
    // Read once, at parse start: a policy set later applies from the next
    // ingest, and the swap records the one used here.
    let Some(source) = get_source(ingest.conn(), job.source_id)? else {
        return Ok((
            Stored::Abandoned(AbandonReason::SourceRemoved),
            TimePolicy::default(),
        ));
    };
    let policy = source.policy;
    let file = std::fs::File::open(&job.feed).context(if job.network {
        "Failed to open the downloaded EPG"
    } else {
        "There is no downloaded guide to read again"
    })?;
    let request = SwapRequest {
        source_id: job.source_id,
        expected_url: job.expected_url.as_deref(),
        policy,
        scope: job.scope,
        network: job.network,
        now: job.now,
    };
    let stored = store_feed(
        &ingest,
        &job.cache_dir,
        std::io::BufReader::new(file),
        &request,
        &chrono::Local,
    )?;
    Ok((stored, policy))
}

/// After a network ingest: a stored feed becomes the source's cache, any
/// other outcome deletes the download and leaves the previous cache.
fn settle_download(job: &Job, result: &Result<(Stored, TimePolicy)>) {
    let (download, source_id) = (&job.feed, job.source_id);
    if matches!(result, Ok((Stored::Committed(_), _))) {
        match std::fs::rename(download, feed_path(&job.cache_dir, source_id)) {
            Ok(()) => return,
            // The programmes are stored; only a later re-ingest after a
            // policy change would read the older cache.
            Err(e) => warn!("EPG cache of source {source_id} not updated: {e}"),
        }
    }
    if let Err(e) = remove_if_present(download) {
        warn!("EPG download of source {source_id} not deleted: {e}");
    }
}

/// Record a failed ingest on the source, unless the source changed since the
/// ingest started; then the reason is returned and nothing is written.
fn record_failure(
    conn: &Connection,
    source_id: i64,
    expected_url: Option<&str>,
    message: &str,
) -> rusqlite::Result<Option<AbandonReason>> {
    let recorded = conn.execute(
        "UPDATE epg_source SET last_result = 'error', last_error = ?2
         WHERE id = ?1 AND url IS ?3 AND enabled = 1",
        params![source_id, message, expected_url],
    )?;
    if recorded > 0 {
        return Ok(None);
    }
    source_mismatch(conn, source_id, expected_url)
}

/// Run database work on the blocking pool with a pooled connection.
async fn blocking<T, F>(pool: &Pool<SqliteConnectionManager>, f: F) -> Result<T>
where
    F: FnOnce(&Connection) -> Result<T> + Send + 'static,
    T: Send + 'static,
{
    let pool = pool.clone();
    tokio::task::spawn_blocking(move || {
        let conn = pool
            .get()
            .context("No database connection for the EPG update")?;
        f(&conn)
    })
    .await
    .context("The EPG update task failed")?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::epg::sources::{download_path, ensure_xtream_source, update_source, SourcePatch};
    use crate::epg::test_support::*;
    use crate::http::test_server::{head, respond, serve, trickle, Step};
    use std::io::Read;

    fn feed() -> String {
        Feed::new()
            .channel("svt1.se", &["SVT1"])
            .programme("svt1.se", NOW, NOW + H, "News")
            .programme("svt1.se", NOW + H, NOW + 2 * H, "Film")
            .xml()
    }

    async fn fetch(f: &Fixture, source_id: i64, now: i64) -> Result<IngestOutcome, AppError> {
        ingest(&f.env(), source_id, Fetch::Network, IngestScope::Feed, now).await
    }

    fn gunzip(path: &Path) -> String {
        let mut out = String::new();
        flate2::read::GzDecoder::new(std::fs::File::open(path).unwrap())
            .read_to_string(&mut out)
            .unwrap();
        out
    }

    /// A manual source whose URL carries credentials, as provider URLs do.
    fn manual_on(f: &Fixture, base: &str) -> i64 {
        add_manual(
            &f.conn(),
            &format!("{base}/xmltv.php?username=john&password=secret"),
        )
    }

    #[tokio::test]
    async fn a_network_ingest_stores_the_feed_and_makes_it_the_cache() {
        let f = Fixture::new("ingest");
        let server = serve(vec![respond("200 OK", feed().as_bytes())]).await;
        let s = manual_on(&f, &server.base);

        let outcome = fetch(&f, s, NOW).await.unwrap();

        let IngestOutcome::Stored(report) = outcome else {
            panic!("not stored: {outcome:?}");
        };
        assert_eq!((report.stored, report.keys), (2, 1));
        assert_eq!(report.policy, TimePolicy::default());
        assert_eq!(f.programmes(s).len(), 2);
        assert_eq!(f.status::<Option<i64>>(s, "last_attempt_at"), Some(NOW));
        assert_eq!(f.status::<Option<i64>>(s, "last_success_at"), Some(NOW));
        assert_eq!(
            f.status::<Option<String>>(s, "last_result").as_deref(),
            Some("ok")
        );
        assert_eq!(gunzip(&feed_path(&f.dir.0, s)), feed());
        assert!(!download_path(&f.dir.0, s).exists());
        assert_eq!(server.connections(), 1);
    }

    #[tokio::test]
    async fn a_failed_download_records_the_error_and_keeps_the_guide() {
        let f = Fixture::new("ingest");
        let server = serve(vec![
            respond("200 OK", feed().as_bytes()),
            respond("500 Internal Server Error", b"<html>oops</html>"),
        ])
        .await;
        let s = manual_on(&f, &server.base);
        fetch(&f, s, NOW).await.unwrap();
        let rows_before = f.programmes(s);
        let cache_before = std::fs::read(feed_path(&f.dir.0, s)).unwrap();

        let err = fetch(&f, s, NOW + H).await.unwrap_err();

        assert_eq!(
            err.to_string(),
            "EPG error: The EPG server answered 500 Internal Server Error"
        );
        let last_error: String = f.status(s, "last_error");
        assert_eq!(
            last_error,
            "The EPG server answered 500 Internal Server Error"
        );
        assert!(!last_error.contains("secret") && !last_error.contains("http"));
        assert_eq!(
            f.status::<Option<String>>(s, "last_result").as_deref(),
            Some("error")
        );
        assert_eq!(f.status::<Option<i64>>(s, "last_attempt_at"), Some(NOW + H));
        assert_eq!(f.status::<Option<i64>>(s, "last_success_at"), Some(NOW));
        assert_eq!(f.programmes(s), rows_before);
        assert_eq!(std::fs::read(feed_path(&f.dir.0, s)).unwrap(), cache_before);
        assert!(!download_path(&f.dir.0, s).exists());
    }

    /// The sentence a failed download leaves, checked for the URL and login.
    fn assert_credential_free(f: &Fixture, source_id: i64, base: &str, expected: &str) {
        let last_error: String = f.status(source_id, "last_error");
        assert_eq!(last_error, expected);
        for leak in ["secret", "john", "http", base.trim_start_matches("http://")] {
            assert!(!last_error.contains(leak), "{leak} in {last_error}");
        }
        assert_eq!(
            f.status::<Option<String>>(source_id, "last_result")
                .as_deref(),
            Some("error")
        );
    }

    #[tokio::test]
    async fn a_stalled_download_records_a_sentence_without_the_url() {
        let f = Fixture::new("ingest");
        let server = serve(vec![vec![
            head("200 OK", 100_000),
            Step::Write(feed().into_bytes()),
            Step::Hang,
        ]])
        .await;
        let s = manual_on(&f, &server.base);

        let err = fetch(&f, s, NOW).await.unwrap_err();

        let sentence = "The EPG server stopped sending data";
        assert_eq!(err.to_string(), format!("EPG error: {sentence}"));
        assert_credential_free(&f, s, &server.base, sentence);
        assert_eq!(server.connections(), 1, "no retry");
        assert!(!download_path(&f.dir.0, s).exists());
    }

    #[tokio::test]
    async fn a_refused_connection_records_a_sentence_without_the_url() {
        let f = Fixture::new("ingest");
        // A port that was free a moment ago and has no listener now.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        drop(listener);
        let s = manual_on(&f, &base);

        let err = fetch(&f, s, NOW).await.unwrap_err();

        let sentence = "Could not connect to the EPG server";
        assert_eq!(err.to_string(), format!("EPG error: {sentence}"));
        assert_credential_free(&f, s, &base, sentence);
    }

    #[tokio::test]
    async fn a_download_that_breaks_off_is_stored_as_partial() {
        let f = Fixture::new("ingest");
        let cut = Feed::new()
            .programme("svt1.se", NOW, NOW + H, "News")
            .truncated_xml();
        let server = serve(vec![respond("200 OK", cut.as_bytes())]).await;
        let s = manual_on(&f, &server.base);

        let outcome = fetch(&f, s, NOW).await.unwrap();

        let IngestOutcome::Stored(report) = outcome else {
            panic!("not stored: {outcome:?}");
        };
        assert!(!report.parse.complete);
        assert_eq!(
            f.status::<Option<String>>(s, "last_result").as_deref(),
            Some("partial")
        );
        assert_eq!(f.status::<Option<i64>>(s, "last_success_at"), Some(NOW));
    }

    #[tokio::test]
    async fn an_empty_body_keeps_the_previous_cache_byte_identical() {
        let f = Fixture::new("ingest");
        let server = serve(vec![
            respond("200 OK", feed().as_bytes()),
            respond("200 OK", b""),
            respond("200 OK", b"<html><body>Service unavailable</body></html>"),
        ])
        .await;
        let s = manual_on(&f, &server.base);
        fetch(&f, s, NOW).await.unwrap();
        let rows_before = f.programmes(s);
        let cache_before = std::fs::read(feed_path(&f.dir.0, s)).unwrap();

        for attempt in 1..=2 {
            let err = fetch(&f, s, NOW + attempt * H).await.unwrap_err();

            assert_eq!(err.to_string(), format!("EPG error: {EMPTY_GUIDE_MESSAGE}"));
            assert_eq!(std::fs::read(feed_path(&f.dir.0, s)).unwrap(), cache_before);
            assert!(!download_path(&f.dir.0, s).exists());
            assert_eq!(f.programmes(s), rows_before);
            assert_eq!(f.status::<Option<i64>>(s, "last_success_at"), Some(NOW));
        }
    }

    #[tokio::test]
    async fn a_url_change_during_the_download_abandons_the_ingest() {
        let f = Fixture::new("ingest");
        let body = feed().into_bytes();
        let server = serve(vec![
            respond("200 OK", &body),
            trickle(&body, 8, Duration::from_millis(100)),
        ])
        .await;
        let s = manual_on(&f, &server.base);
        fetch(&f, s, NOW).await.unwrap();

        let change_url = async {
            while !download_path(&f.dir.0, s).exists() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            let patch = SourcePatch {
                url: Some("http://other.example/epg.xml".to_string()),
                ..SourcePatch::default()
            };
            update_source(&f.conn(), &f.dir.0, s, &patch).unwrap();
        };
        let (outcome, ()) = tokio::join!(fetch(&f, s, NOW + H), change_url);

        assert_eq!(
            outcome.unwrap(),
            IngestOutcome::Abandoned(AbandonReason::UrlChanged)
        );
        assert!(f.programmes(s).is_empty());
        assert!(!feed_path(&f.dir.0, s).exists());
        assert!(!download_path(&f.dir.0, s).exists());
        // The status `update_source` reset for the new URL is untouched.
        assert_eq!(f.status::<Option<i64>>(s, "last_attempt_at"), None);
        assert_eq!(f.status::<Option<String>>(s, "last_result"), None);
        assert_eq!(f.status::<Option<String>>(s, "last_error"), None);
    }

    #[tokio::test]
    async fn a_disabled_or_missing_source_is_not_fetched() {
        let f = Fixture::new("ingest");
        let server = serve(vec![respond("200 OK", feed().as_bytes())]).await;
        let s = manual_on(&f, &server.base);
        f.conn()
            .execute(
                "UPDATE epg_source SET enabled = 0 WHERE id = ?1",
                params![s],
            )
            .unwrap();

        assert_eq!(
            fetch(&f, s, NOW).await.unwrap(),
            IngestOutcome::Abandoned(AbandonReason::SourceDisabled)
        );
        assert_eq!(
            fetch(&f, s + 1, NOW).await.unwrap(),
            IngestOutcome::Abandoned(AbandonReason::SourceRemoved)
        );
        assert_eq!(server.connections(), 0);
        assert_eq!(f.status::<Option<i64>>(s, "last_attempt_at"), None);
    }

    fn add_xtream_playlist(conn: &Connection, server: &str, username: &str, password: &str) -> i64 {
        conn.execute(
            "INSERT INTO playlists (name, url, xtream_username, xtream_password)
             VALUES ('Provider', ?1, ?2, ?3)",
            params![server, username, password],
        )
        .unwrap();
        conn.last_insert_rowid()
    }

    fn use_vlc_user_agent(conn: &Connection) {
        crate::db::mutations::set_setting(conn, "playlist_user_agent_mode", "vlc").unwrap();
    }

    fn user_agent_line(request: &str) -> String {
        request
            .lines()
            .find(|l| l.to_ascii_lowercase().starts_with("user-agent:"))
            .unwrap_or_default()
            .to_string()
    }

    #[tokio::test]
    async fn an_xtream_source_is_fetched_with_the_playlist_login_and_user_agent() {
        let f = Fixture::new("ingest");
        let server = serve(vec![respond("200 OK", feed().as_bytes())]).await;
        let conn = f.conn();
        use_vlc_user_agent(&conn);
        let playlist = add_xtream_playlist(&conn, &format!("{}/", server.base), "john@x", "p&ss");
        let s = ensure_xtream_source(&conn, playlist).unwrap();
        drop(conn);

        let outcome = fetch(&f, s, NOW).await.unwrap();

        assert!(matches!(outcome, IngestOutcome::Stored(_)), "{outcome:?}");
        let request = server.first_request();
        assert!(
            request.starts_with("GET /xmltv.php?username=john%40x&password=p%26ss "),
            "{request}"
        );
        assert_eq!(
            user_agent_line(&request),
            "user-agent: VLC/3.0.20 LibVLC/3.0.20"
        );
    }

    #[tokio::test]
    async fn an_xtream_source_without_a_login_fails_without_a_request() {
        let f = Fixture::new("ingest");
        let server = serve(vec![respond("200 OK", feed().as_bytes())]).await;
        let conn = f.conn();
        let playlist = add_xtream_playlist(&conn, &server.base, "john", "secret");
        let s = ensure_xtream_source(&conn, playlist).unwrap();
        conn.execute(
            "UPDATE playlists SET xtream_password = NULL WHERE id = ?1",
            params![playlist],
        )
        .unwrap();
        drop(conn);

        let err = fetch(&f, s, NOW).await.unwrap_err();

        assert_eq!(
            err.to_string(),
            "EPG error: The profile this guide belongs to has no provider login"
        );
        assert_eq!(server.connections(), 0);
        assert_eq!(f.status::<Option<i64>>(s, "last_attempt_at"), Some(NOW));
        assert_eq!(
            f.status::<Option<String>>(s, "last_result").as_deref(),
            Some("error")
        );
    }

    #[tokio::test]
    async fn a_url_source_on_an_xtream_server_gets_the_playlist_user_agent() {
        let f = Fixture::new("ingest");
        let provider = serve(vec![respond("200 OK", feed().as_bytes())]).await;
        let elsewhere = serve(vec![respond("200 OK", feed().as_bytes())]).await;
        let conn = f.conn();
        use_vlc_user_agent(&conn);
        add_xtream_playlist(&conn, &provider.base, "john", "secret");
        drop(conn);
        let on_provider = add_manual(&f.conn(), &format!("{}/epg.xml.gz", provider.base));
        let other = add_manual(&f.conn(), &format!("{}/epg.xml", elsewhere.base));

        fetch(&f, on_provider, NOW).await.unwrap();
        fetch(&f, other, NOW).await.unwrap();

        assert_eq!(
            user_agent_line(&provider.first_request()),
            "user-agent: VLC/3.0.20 LibVLC/3.0.20"
        );
        assert_eq!(
            user_agent_line(&elsewhere.first_request()),
            format!("user-agent: {}", crate::http::DEFAULT_HTTP_USER_AGENT)
        );
    }
}
