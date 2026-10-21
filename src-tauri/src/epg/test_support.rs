//! Helpers shared by the ingest and store tests: a scratch directory, a
//! file database set up like the app's pool, and an XMLTV feed builder.

use super::sources::feed_path;
use super::store::IngestConnection;
use super::{ingest, Fetch, IngestEnv, IngestOutcome, IngestReport, IngestScope};
use crate::db::schema::init_schema;
use chrono::DateTime;
use flate2::write::GzEncoder;
use flate2::Compression;
use r2d2::{Pool, PooledConnection};
use r2d2_sqlite::SqliteConnectionManager;
use rusqlite::{params, Connection};
use std::fmt::Write as _;
use std::io::Write as _;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};

/// A fixed "now" for the tests: 2026-10-21 12:00 UTC.
pub const NOW: i64 = 1_792_584_000;
pub const H: i64 = 3600;

/// A fresh directory under the system temp dir, deleted on drop.
pub struct TestDir(pub PathBuf);

impl TestDir {
    pub fn new(tag: &str) -> Self {
        static NEXT: AtomicU32 = AtomicU32::new(0);
        let dir = std::env::temp_dir().join(format!(
            "better-iptv-epg-{tag}-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        TestDir(dir)
    }
}

impl Drop for TestDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// The pragmas `lib.rs` sets on every pooled connection.
#[derive(Debug)]
struct AppPragmas;

impl r2d2::CustomizeConnection<Connection, rusqlite::Error> for AppPragmas {
    fn on_acquire(&self, conn: &mut Connection) -> Result<(), rusqlite::Error> {
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             PRAGMA foreign_keys = ON;
             PRAGMA cache_size = 10000;
             PRAGMA temp_store = memory;",
        )
    }
}

/// `<dir>/app.db` with the app's schema, behind a pool configured as the
/// app's. `max_size` 1 makes every checkout the same connection.
pub fn pool_in(dir: &TestDir, max_size: u32) -> Pool<SqliteConnectionManager> {
    let pool = Pool::builder()
        .max_size(max_size)
        .connection_customizer(Box::new(AppPragmas))
        .build(SqliteConnectionManager::file(dir.0.join("app.db")))
        .unwrap();
    init_schema(&pool.get().unwrap()).unwrap();
    pool
}

/// A global `manual` source for `url`; returns its id.
pub fn add_manual(conn: &Connection, url: &str) -> i64 {
    conn.execute(
        "INSERT INTO epg_source (origin, url, priority) VALUES ('manual', ?1, 10)",
        params![url],
    )
    .unwrap();
    conn.last_insert_rowid()
}

/// An XMLTV time for Unix seconds, written in UTC.
pub fn xmltv_time(at: i64) -> String {
    DateTime::from_timestamp(at, 0)
        .unwrap()
        .format("%Y%m%d%H%M%S +0000")
        .to_string()
}

/// An XMLTV document built element by element.
#[derive(Default, Clone)]
pub struct Feed {
    body: String,
}

impl Feed {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn channel(mut self, id: &str, names: &[&str]) -> Self {
        let _ = write!(self.body, "<channel id=\"{id}\">");
        for name in names {
            let _ = write!(self.body, "<display-name>{name}</display-name>");
        }
        self.body.push_str("</channel>\n");
        self
    }

    /// A programme from `start` to `stop`, Unix seconds.
    pub fn programme(mut self, channel: &str, start: i64, stop: i64, title: &str) -> Self {
        let _ = writeln!(
            self.body,
            "<programme start=\"{}\" stop=\"{}\" channel=\"{channel}\">\
             <title>{title}</title><desc>About {title}</desc></programme>",
            xmltv_time(start),
            xmltv_time(stop)
        );
        self
    }

    pub fn xml(&self) -> String {
        format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<tv>\n{}</tv>\n",
            self.body
        )
    }

    /// The document cut off inside an element after everything so far, so
    /// it parses as incomplete with every programme added kept.
    pub fn truncated_xml(&self) -> String {
        format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<tv>\n{}<programme start=\"",
            self.body
        )
    }
}

/// A database, a cache directory and a client for ingest tests.
pub struct Fixture {
    pub dir: TestDir,
    pub db_path: PathBuf,
    pub pool: Pool<SqliteConnectionManager>,
    pub client: reqwest::Client,
}

impl Fixture {
    pub fn new(tag: &str) -> Self {
        let dir = TestDir::new(tag);
        let pool = pool_in(&dir, 2);
        // The shared client's setup on a clock scaled 1:60, as in `http`'s tests.
        let client = crate::http::build_client(
            std::time::Duration::from_millis(500),
            std::time::Duration::from_millis(500),
        );
        Fixture {
            db_path: dir.0.join("app.db"),
            dir,
            pool,
            client,
        }
    }

    pub fn env(&self) -> IngestEnv<'_> {
        IngestEnv {
            pool: &self.pool,
            db_path: &self.db_path,
            cache_dir: &self.dir.0,
            client: &self.client,
            download_deadline: std::time::Duration::from_secs(10),
        }
    }

    pub fn conn(&self) -> PooledConnection<SqliteConnectionManager> {
        self.pool.get().unwrap()
    }

    /// A connection set up as an ingest's own.
    pub fn ingest_connection(&self) -> IngestConnection {
        IngestConnection::open(&self.db_path, &self.dir.0).unwrap()
    }

    /// Make `xml` the source's cached feed, gzipped as a download would be.
    pub fn cache(&self, source_id: i64, xml: &str) {
        let mut gz = GzEncoder::new(Vec::new(), Compression::fast());
        gz.write_all(xml.as_bytes()).unwrap();
        std::fs::write(feed_path(&self.dir.0, source_id), gz.finish().unwrap()).unwrap();
    }

    /// Ingest `xml` as the source's feed (through the cache path) and
    /// return the report; the summaries must match the table after it.
    pub async fn store(&self, source_id: i64, xml: &str, now: i64) -> IngestReport {
        self.cache(source_id, xml);
        let outcome = ingest(&self.env(), source_id, Fetch::Cache, IngestScope::Feed, now)
            .await
            .unwrap();
        assert_summaries_exact(&self.conn());
        match outcome {
            IngestOutcome::Stored(report) => *report,
            other => panic!("not stored: {other:?}"),
        }
    }

    /// Every stored programme of a source: (key, start, stop, title), in
    /// key and start order.
    pub fn programmes(&self, source_id: i64) -> Vec<(String, i64, i64, String)> {
        self.conn()
            .prepare(
                "SELECT c.key, p.start, p.stop, p.title FROM epg_programme p
                 JOIN epg_channel c ON c.id = p.channel_id
                 WHERE c.source_id = ?1 ORDER BY c.key, p.start",
            )
            .unwrap()
            .query_map(params![source_id], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
            })
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap()
    }

    /// One `epg_source` column of a source.
    pub fn status<T: rusqlite::types::FromSql>(&self, source_id: i64, column: &str) -> T {
        self.conn()
            .query_row(
                &format!("SELECT {column} FROM epg_source WHERE id = ?1"),
                params![source_id],
                |r| r.get(0),
            )
            .unwrap()
    }

    pub fn set_shift(&self, source_id: i64, minutes: i32) {
        self.conn()
            .execute(
                "UPDATE epg_source SET time_shift_minutes = ?2 WHERE id = ?1",
                params![source_id, minutes],
            )
            .unwrap();
    }
}

/// (key, start, stop, title) tuples from string slices, for comparisons.
pub fn rows(list: &[(&str, i64, i64, &str)]) -> Vec<(String, i64, i64, String)> {
    list.iter()
        .map(|(k, a, b, t)| (k.to_string(), *a, *b, t.to_string()))
        .collect()
}

/// Every channel's summary equals its rows, and every source's count the
/// sum of its channels' rows.
pub fn assert_summaries_exact(conn: &Connection) {
    let mismatched: Vec<(i64, String)> = conn
        .prepare(
            "SELECT c.id, c.key FROM epg_channel c
             WHERE c.programme_count IS NOT (SELECT COUNT(*) FROM epg_programme p
                                            WHERE p.channel_id = c.id)
                OR c.first_start IS NOT (SELECT MIN(start) FROM epg_programme p
                                        WHERE p.channel_id = c.id)
                OR c.last_stop IS NOT (SELECT MAX(stop) FROM epg_programme p
                                      WHERE p.channel_id = c.id)",
        )
        .unwrap()
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    assert!(mismatched.is_empty(), "summaries differ: {mismatched:?}");
    let sources: Vec<i64> = conn
        .prepare(
            "SELECT s.id FROM epg_source s
             WHERE s.programme_count IS NOT (SELECT COUNT(*) FROM epg_programme p
                 JOIN epg_channel c ON c.id = p.channel_id WHERE c.source_id = s.id)",
        )
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    assert!(sources.is_empty(), "source counts differ: {sources:?}");
    let dangling = conn
        .prepare("PRAGMA foreign_key_check")
        .unwrap()
        .query_map([], |r| r.get::<_, String>(0))
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    assert!(dangling.is_empty(), "rows without a parent in {dangling:?}");
}
