//! Fetch a guide feed: one request, the body streamed to `<id>.download`.
//!
//! The body never sits in memory as a whole. A plain body is gzipped while it
//! is written, so the file is always gzip and the cache stays small; a body
//! that arrives gzipped is written as it comes. There is no retry: one failed
//! request is one failed attempt, because providers rate-limit hard.
//!
//! The file stays `<id>.download`. The ingest renames it to `<id>.feed.gz`
//! only once its programmes are stored; on any failure here it is deleted, so
//! the previous feed stays the cache.

use super::decode::is_gzipped;
use super::sources::{download_path, remove_if_present};
use crate::http::{download_error, ensure_success};
use anyhow::{Context, Result};
use flate2::write::GzEncoder;
use flate2::Compression;
use log::warn;
use std::fs::File;
use std::io::{self, BufWriter, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

const SERVER: &str = "EPG server";

/// Write buffer in front of the file.
const WRITE_BUF_LEN: usize = 256 * 1024;

/// A finished download.
#[derive(Debug, PartialEq, Eq)]
pub struct Downloaded {
    /// `<cache_dir>/<source_id>.download`, always gzip.
    pub path: PathBuf,
    /// Body bytes as reqwest hands them over: after it undid any
    /// `Content-Encoding`, so the decoded size when the server compressed
    /// the transfer, not the bytes on the wire.
    pub body_bytes: u64,
    /// Size of the file on disk.
    pub file_bytes: u64,
    /// The body arrived gzipped and was written unchanged; `false` when it
    /// was plain and gzipped here.
    pub server_gzipped: bool,
}

/// Where the body goes once its first two bytes have told gzip from plain.
enum Output {
    AsReceived(BufWriter<File>),
    Compressed(GzEncoder<BufWriter<File>>),
}

impl Output {
    fn start(file: BufWriter<File>, head: &[u8]) -> io::Result<Self> {
        let mut output = if is_gzipped(head) {
            Self::AsReceived(file)
        } else {
            // The fastest level: it runs on the download task, chunk by
            // chunk, and the file is read back once per ingest at most.
            Self::Compressed(GzEncoder::new(file, Compression::fast()))
        };
        output.write_all(head)?;
        Ok(output)
    }

    fn write_all(&mut self, bytes: &[u8]) -> io::Result<()> {
        match self {
            Self::AsReceived(file) => file.write_all(bytes),
            Self::Compressed(gz) => gz.write_all(bytes),
        }
    }

    /// Flush everything; returns whether the body was gzip as received.
    fn finish(self) -> io::Result<bool> {
        match self {
            Self::AsReceived(mut file) => {
                file.flush()?;
                Ok(true)
            }
            Self::Compressed(gz) => {
                gz.finish()?.flush()?;
                Ok(false)
            }
        }
    }
}

/// The download file, before and after the body's first two bytes arrived.
enum FeedFile {
    Head(BufWriter<File>, Vec<u8>),
    Body(Output),
}

impl FeedFile {
    fn create(path: &Path) -> io::Result<Self> {
        let file = BufWriter::with_capacity(WRITE_BUF_LEN, File::create(path)?);
        Ok(Self::Head(file, Vec::new()))
    }

    fn write(self, chunk: &[u8]) -> io::Result<Self> {
        match self {
            Self::Body(mut output) => {
                output.write_all(chunk)?;
                Ok(Self::Body(output))
            }
            Self::Head(file, mut head) => {
                head.extend_from_slice(chunk);
                if head.len() < 2 {
                    Ok(Self::Head(file, head))
                } else {
                    Ok(Self::Body(Output::start(file, &head)?))
                }
            }
        }
    }

    fn finish(self) -> io::Result<bool> {
        match self {
            Self::Head(file, head) => Output::start(file, &head)?.finish(),
            Self::Body(output) => output.finish(),
        }
    }
}

async fn fetch_to_file(
    client: &reqwest::Client,
    url: &str,
    user_agent: Option<&str>,
    deadline: Duration,
    path: &Path,
) -> Result<Downloaded> {
    let started = Instant::now();
    let request = client.get(url).timeout(deadline);
    let request = if let Some(ua) = user_agent.filter(|ua| !ua.trim().is_empty()) {
        request.header(reqwest::header::USER_AGENT, ua)
    } else {
        request
    };
    let response = request
        .send()
        .await
        .map_err(|e| download_error(e, SERVER, started, deadline))?;
    let mut response = ensure_success(response, SERVER)?;

    const WRITE_FAILURE: &str = "Failed to write the EPG download";
    // Plain file writes on the runtime thread: each chunk is a few KB of
    // page-cache writes and fast-level deflate, well under a millisecond.
    let mut file = FeedFile::create(path).context(WRITE_FAILURE)?;
    let mut body_bytes: u64 = 0;
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| download_error(e, SERVER, started, deadline))?
    {
        body_bytes += chunk.len() as u64;
        file = file.write(&chunk).context(WRITE_FAILURE)?;
    }
    let server_gzipped = file.finish().context(WRITE_FAILURE)?;
    let file_bytes = std::fs::metadata(path).context(WRITE_FAILURE)?.len();

    Ok(Downloaded {
        path: path.to_path_buf(),
        body_bytes,
        file_bytes,
        server_gzipped,
    })
}

/// Deletes the download file when dropped while still armed: on an error,
/// and when the download future itself is dropped half-way (a timeout
/// around it, shutdown), which no error path would see.
struct DiscardOnDrop<'a> {
    path: &'a Path,
    armed: bool,
}

impl Drop for DiscardOnDrop<'_> {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        if let Err(e) = remove_if_present(self.path) {
            warn!(
                "Could not delete the failed EPG download {}: {e}",
                self.path.display()
            );
        }
    }
}

/// Download a source's feed to `<cache_dir>/<source_id>.download`.
///
/// `user_agent` overrides the client's default when it is not blank.
/// `deadline` overrides the client's total timeout; the client's stall
/// timeout still ends a dead connection early. Errors name the failure in
/// words a viewer can act on and never carry the URL. On any error, and when
/// the returned future is dropped before it finishes, the download file is
/// deleted, including one left by an earlier attempt.
pub async fn download_feed(
    client: &reqwest::Client,
    url: &str,
    user_agent: Option<&str>,
    deadline: Duration,
    cache_dir: &Path,
    source_id: i64,
) -> Result<Downloaded> {
    let path = download_path(cache_dir, source_id);
    let mut discard = DiscardOnDrop {
        path: &path,
        armed: true,
    };
    // The fetch future, and the open file inside it, is a temporary of this
    // expression and is dropped before `discard`, so the file is closed
    // before it is deleted.
    let downloaded = fetch_to_file(client, url, user_agent, deadline, &path).await?;
    discard.armed = false;
    Ok(downloaded)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::epg::parse::{parse_feed, ParseSink, ParsedChannel, ParsedProgramme};
    use crate::epg::sources::feed_path;
    use crate::http::build_client;
    use crate::http::test_server::{head, respond, serve, trickle, Step};
    use std::io::Read;
    use std::sync::atomic::{AtomicU32, Ordering};

    /// A fresh directory under the system temp dir, deleted on drop.
    struct TestDir(PathBuf);

    impl TestDir {
        fn new() -> Self {
            static NEXT: AtomicU32 = AtomicU32::new(0);
            let dir = std::env::temp_dir().join(format!(
                "better-iptv-epg-download-{}-{}",
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

    /// The shared client's setup on a clock scaled 1:60, as in `http`'s tests.
    fn scaled_client() -> reqwest::Client {
        build_client(Duration::from_millis(500), Duration::from_millis(500))
    }

    const DEADLINE: Duration = Duration::from_secs(10);
    const SOURCE: i64 = 7;

    const XML: &[u8] = b"<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<tv>\
        <programme start=\"20261021200000 +0000\" stop=\"20261021210000 +0000\" channel=\"svt1.se\">\
        <title>Rapport</title></programme></tv>";

    fn gzip(bytes: &[u8]) -> Vec<u8> {
        let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(bytes).unwrap();
        encoder.finish().unwrap()
    }

    fn gunzip(bytes: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        flate2::read::GzDecoder::new(bytes)
            .read_to_end(&mut out)
            .unwrap();
        out
    }

    async fn download(server_base: &str, dir: &Path, ua: Option<&str>) -> Result<Downloaded> {
        let url = format!("{server_base}/xmltv.php?username=john&password=secret");
        download_feed(&scaled_client(), &url, ua, DEADLINE, dir, SOURCE).await
    }

    /// A previous feed that a failed download must leave alone.
    fn previous_feed(dir: &Path) -> Vec<u8> {
        let bytes = gzip(b"<tv>previous</tv>");
        std::fs::write(feed_path(dir, SOURCE), &bytes).unwrap();
        bytes
    }

    #[tokio::test]
    async fn a_gzipped_body_is_streamed_to_the_file_unchanged() {
        let dir = TestDir::new();
        let body = gzip(&XML.repeat(200));
        let server = serve(vec![trickle(&body, 8, Duration::from_millis(20))]).await;

        let done = download(&server.base, &dir.0, None).await.unwrap();

        assert_eq!(done.path, download_path(&dir.0, SOURCE));
        assert_eq!(std::fs::read(&done.path).unwrap(), body);
        assert!(done.server_gzipped);
        assert_eq!(done.body_bytes, body.len() as u64);
        assert_eq!(done.file_bytes, body.len() as u64);
        assert!(!feed_path(&dir.0, SOURCE).exists(), "not renamed here");
    }

    #[tokio::test]
    async fn a_plain_body_is_stored_gzipped_and_parses() {
        let dir = TestDir::new();
        // One byte first, so the gzip check has to wait for the second.
        let server = serve(vec![vec![
            head("200 OK", XML.len()),
            Step::Write(XML[..1].to_vec()),
            Step::Sleep(Duration::from_millis(50)),
            Step::Write(XML[1..].to_vec()),
        ]])
        .await;

        let done = download(&server.base, &dir.0, None).await.unwrap();

        let stored = std::fs::read(&done.path).unwrap();
        assert!(is_gzipped(&stored));
        assert_eq!(gunzip(&stored), XML);
        assert!(!done.server_gzipped);
        assert_eq!(done.body_bytes, XML.len() as u64);
        assert_eq!(done.file_bytes, stored.len() as u64);

        struct Count(usize);
        impl ParseSink for Count {
            fn programme(&mut self, _: ParsedProgramme) -> Result<()> {
                self.0 += 1;
                Ok(())
            }
            fn channel(&mut self, _: ParsedChannel) {}
        }
        let mut count = Count(0);
        let file = std::io::BufReader::new(File::open(&done.path).unwrap());
        assert!(parse_feed(file, &mut count).unwrap().complete);
        assert_eq!(count.0, 1);
    }

    #[tokio::test]
    async fn an_empty_body_becomes_an_empty_gzip_and_the_previous_feed_stays() {
        let dir = TestDir::new();
        let previous = previous_feed(&dir.0);
        let server = serve(vec![respond("200 OK", b"")]).await;

        let done = download(&server.base, &dir.0, None).await.unwrap();

        assert_eq!(done.body_bytes, 0);
        assert!(gunzip(&std::fs::read(&done.path).unwrap()).is_empty());
        assert_eq!(std::fs::read(feed_path(&dir.0, SOURCE)).unwrap(), previous);
    }

    #[tokio::test]
    async fn an_error_status_leaves_no_download_and_the_previous_feed() {
        for status in ["403 Forbidden", "500 Internal Server Error"] {
            let dir = TestDir::new();
            let previous = previous_feed(&dir.0);
            // A leftover from an interrupted earlier attempt goes too.
            std::fs::write(download_path(&dir.0, SOURCE), b"stale").unwrap();
            let server = serve(vec![respond(status, b"<html>Forbidden</html>")]).await;

            let err = download(&server.base, &dir.0, None).await.unwrap_err();

            assert_eq!(err.to_string(), format!("The EPG server answered {status}"));
            assert_eq!(server.connections(), 1, "{status}: one request only");
            assert!(!download_path(&dir.0, SOURCE).exists());
            assert_eq!(std::fs::read(feed_path(&dir.0, SOURCE)).unwrap(), previous);
        }
    }

    #[tokio::test]
    async fn a_stalled_body_leaves_no_download_and_the_previous_feed() {
        let dir = TestDir::new();
        let previous = previous_feed(&dir.0);
        let server = serve(vec![vec![
            head("200 OK", 100_000),
            Step::Write(XML.to_vec()),
            Step::Hang,
        ]])
        .await;

        let started = Instant::now();
        let err = download(&server.base, &dir.0, None).await.unwrap_err();

        assert!(
            started.elapsed() < Duration::from_secs(3),
            "stall not detected"
        );
        assert_eq!(err.to_string(), "The EPG server stopped sending data");
        assert!(!err.to_string().contains("secret"));
        assert_eq!(server.connections(), 1, "no retry");
        assert!(!download_path(&dir.0, SOURCE).exists());
        assert_eq!(std::fs::read(feed_path(&dir.0, SOURCE)).unwrap(), previous);
    }

    #[tokio::test]
    async fn a_download_dropped_half_way_leaves_no_file() {
        let dir = TestDir::new();
        let previous = previous_feed(&dir.0);
        let server = serve(vec![vec![
            head("200 OK", 100_000),
            Step::Write(XML.to_vec()),
            Step::Hang,
        ]])
        .await;

        // Shorter than the client's 0.5 s stall timeout, so the download is
        // still waiting for its next chunk when the future is dropped.
        let outcome = tokio::time::timeout(
            Duration::from_millis(300),
            download(&server.base, &dir.0, None),
        )
        .await;

        assert!(outcome.is_err(), "the timeout did not fire");
        assert!(!download_path(&dir.0, SOURCE).exists());
        assert_eq!(std::fs::read(feed_path(&dir.0, SOURCE)).unwrap(), previous);
    }

    #[tokio::test]
    async fn a_failed_write_is_an_error_without_the_url_and_leaves_no_file() {
        let dir = TestDir::new();
        let missing = dir.0.join("missing");
        let server = serve(vec![respond("200 OK", XML)]).await;

        let err = download(&server.base, &missing, None).await.unwrap_err();

        assert_eq!(err.to_string(), "Failed to write the EPG download");
        assert!(!format!("{err:#}").contains("secret"));
        assert!(!download_path(&missing, SOURCE).exists());
        assert!(!missing.exists());
    }

    #[tokio::test]
    async fn the_user_agent_is_sent_and_a_blank_one_falls_back_to_the_default() {
        for (ua, expected) in [
            (Some("TiviMate/4.7.0"), "TiviMate/4.7.0"),
            (Some("  "), crate::http::DEFAULT_HTTP_USER_AGENT),
            (None, crate::http::DEFAULT_HTTP_USER_AGENT),
        ] {
            let dir = TestDir::new();
            let server = serve(vec![respond("200 OK", XML)]).await;

            download(&server.base, &dir.0, ua).await.unwrap();

            let request = server.first_request().to_ascii_lowercase();
            let line = format!("user-agent: {}\r\n", expected.to_ascii_lowercase());
            assert!(request.contains(&line), "{ua:?}: {request}");
        }
    }
}
