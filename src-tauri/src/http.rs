use lazy_static::lazy_static;
use reqwest::Client;
use std::time::Duration;

/// Built from the crate version at compile time, which `sync-version.cjs`
/// keeps equal to the version in `package.json` and `tauri.conf.json`.
pub const DEFAULT_HTTP_USER_AGENT: &str = concat!(
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Better-IPTV/",
    env!("CARGO_PKG_VERSION")
);
const TIVIMATE_HTTP_USER_AGENT: &str = "TiviMate/4.7.0 (Linux;Android 10) ExoPlayerLib/2.18.1";
const VLC_HTTP_USER_AGENT: &str = "VLC/3.0.20 LibVLC/3.0.20";
pub const MAX_CUSTOM_USER_AGENT_LENGTH: usize = 512;

lazy_static! {
    /// Shared HTTP client with custom user-agent for all external requests
    static ref HTTP_CLIENT: Client = create_http_client();
}

/// Total deadline for ordinary requests (TMDB, update check, account info).
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// How long a connection may go without delivering a byte, headers included,
/// before it counts as stalled. Equal to `REQUEST_TIMEOUT`, so no request is
/// cut off earlier than before this limit existed.
pub const STALL_TIMEOUT: Duration = Duration::from_secs(30);

/// Total deadline for the large downloads: EPG files, M3U playlists and the
/// Xtream stream lists. They can take minutes on a slow line while still
/// making progress; a dead connection is caught by `STALL_TIMEOUT` instead.
/// Set per request with `RequestBuilder::timeout`, which overrides the
/// client's `REQUEST_TIMEOUT`.
pub const BULK_DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(10 * 60);

/// Create HTTP client with custom user-agent and reasonable timeouts
fn create_http_client() -> Client {
    build_client(REQUEST_TIMEOUT, STALL_TIMEOUT)
}

/// The shared client's configuration with the timeouts as parameters, so
/// tests can run the same setup on a scaled-down clock.
pub(crate) fn build_client(request_timeout: Duration, stall_timeout: Duration) -> Client {
    Client::builder()
        .user_agent(DEFAULT_HTTP_USER_AGENT)
        .timeout(request_timeout)
        .read_timeout(stall_timeout)
        .connect_timeout(Duration::from_secs(10))
        .build()
        .expect("Failed to create HTTP client")
}

/// Turn a non-success HTTP status into an error that names it. Used where a
/// body is parsed afterwards: an error page parsed as an EPG or a playlist
/// reads as an empty one, which hides what actually went wrong.
pub fn ensure_success(
    response: reqwest::Response,
    server: &str,
) -> anyhow::Result<reqwest::Response> {
    let status = response.status();
    if status.is_success() {
        Ok(response)
    } else {
        anyhow::bail!("The {server} answered {status}")
    }
}

/// Wrap a download error in a sentence a viewer can act on. The sentence is
/// built from the error's kind and never from reqwest's own text, which
/// carries the request URL and with it the provider's username and password;
/// the original error stays in the chain for `{:#}` in the log, where the
/// formatter masks it.
pub fn download_error(
    e: reqwest::Error,
    server: &str,
    started: std::time::Instant,
    deadline: Duration,
) -> anyhow::Error {
    let message = if e.is_timeout() {
        // reqwest does not say which limit fired; the deadline can only have
        // fired once the whole of it has passed
        if started.elapsed() + Duration::from_millis(500) >= deadline {
            let minutes = deadline.as_millis().div_ceil(60_000);
            let unit = if minutes == 1 { "minute" } else { "minutes" };
            format!("The download from the {server} took longer than {minutes} {unit}")
        } else {
            format!("The {server} stopped sending data")
        }
    } else if e.is_connect() {
        format!("Could not connect to the {server}")
    } else {
        format!("The connection to the {server} was interrupted")
    };
    anyhow::Error::new(e).context(message)
}

pub fn is_valid_playlist_user_agent_mode(mode: &str) -> bool {
    matches!(mode, "default" | "tivimate" | "vlc" | "custom")
}

pub fn resolve_playlist_user_agent(mode: Option<&str>, custom_value: Option<&str>) -> String {
    match mode.map(str::trim).map(str::to_ascii_lowercase).as_deref() {
        Some("tivimate") => TIVIMATE_HTTP_USER_AGENT.to_string(),
        Some("vlc") => VLC_HTTP_USER_AGENT.to_string(),
        Some("custom") => custom_value
            .and_then(normalize_custom_user_agent)
            .unwrap_or_else(|| DEFAULT_HTTP_USER_AGENT.to_string()),
        _ => DEFAULT_HTTP_USER_AGENT.to_string(),
    }
}

pub fn normalize_custom_user_agent(value: &str) -> Option<String> {
    let normalized = value.trim();
    if normalized.is_empty()
        || normalized.len() > MAX_CUSTOM_USER_AGENT_LENGTH
        || normalized.contains('\r')
        || normalized.contains('\n')
    {
        return None;
    }

    Some(normalized.to_string())
}

/// Get the shared HTTP client for making requests
pub fn get_http_client() -> &'static Client {
    &HTTP_CLIENT
}

/// A scripted local HTTP server for download tests: no network, real sockets,
/// so timeouts, stalls and status codes go through reqwest exactly as in use.
#[cfg(test)]
pub(crate) mod test_server {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use std::time::Duration;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    #[derive(Clone)]
    pub enum Step {
        Write(Vec<u8>),
        Sleep(Duration),
        /// Keep the connection open and silent until the test ends
        Hang,
    }

    /// Status line and headers for a body of `len` bytes
    pub fn head(status: &str, len: usize) -> Step {
        Step::Write(
            format!("HTTP/1.1 {status}\r\nContent-Length: {len}\r\nConnection: close\r\n\r\n")
                .into_bytes(),
        )
    }

    /// A complete response in one write
    pub fn respond(status: &str, body: &[u8]) -> Vec<Step> {
        vec![head(status, body.len()), Step::Write(body.to_vec())]
    }

    /// `body` in `chunks` pieces with `gap` between them: slow, never silent
    /// for longer than `gap`
    pub fn trickle(body: &[u8], chunks: usize, gap: Duration) -> Vec<Step> {
        let mut steps = vec![head("200 OK", body.len())];
        for piece in body.chunks(body.len().div_ceil(chunks)) {
            steps.push(Step::Write(piece.to_vec()));
            steps.push(Step::Sleep(gap));
        }
        steps
    }

    pub struct Server {
        pub base: String,
        connections: Arc<AtomicUsize>,
    }

    impl Server {
        pub fn connections(&self) -> usize {
            self.connections.load(Ordering::SeqCst)
        }
    }

    /// Serve connection `i` with `scripts[i]`, the last script repeating.
    pub async fn serve(scripts: Vec<Vec<Step>>) -> Server {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let connections = Arc::new(AtomicUsize::new(0));
        let counter = connections.clone();
        tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    return;
                };
                let index = counter.fetch_add(1, Ordering::SeqCst);
                let script = scripts[index.min(scripts.len() - 1)].clone();
                tokio::spawn(async move {
                    let mut request = [0u8; 4096];
                    let _ = socket.read(&mut request).await;
                    for step in script {
                        match step {
                            Step::Write(bytes) => {
                                if socket.write_all(&bytes).await.is_err() {
                                    return;
                                }
                            }
                            Step::Sleep(d) => tokio::time::sleep(d).await,
                            Step::Hang => std::future::pending::<()>().await,
                        }
                    }
                });
            }
        });
        Server { base, connections }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use super::test_server::{head, respond, serve, trickle, Step};
    use std::time::Instant;

    /// The shared client's setup on a clock scaled 1:60: one second stands
    /// for a minute, so the tests run in seconds
    fn scaled_client() -> Client {
        build_client(Duration::from_millis(500), Duration::from_millis(500))
    }

    async fn fetch(
        client: &Client,
        url: &str,
        deadline: Option<Duration>,
    ) -> anyhow::Result<usize> {
        let started = Instant::now();
        let deadline_or_default = deadline.unwrap_or(Duration::from_millis(500));
        let mut request = client.get(url);
        if let Some(d) = deadline {
            request = request.timeout(d);
        }
        let response = request
            .send()
            .await
            .map_err(|e| download_error(e, "EPG server", started, deadline_or_default))?;
        let response = ensure_success(response, "EPG server")?;
        let body = response
            .bytes()
            .await
            .map_err(|e| download_error(e, "EPG server", started, deadline_or_default))?;
        Ok(body.len())
    }

    #[tokio::test]
    async fn a_slow_download_that_keeps_moving_finishes_under_the_bulk_deadline() {
        // 1.2 s in total, never 0.5 s silent: today's 30 s total timeout,
        // scaled, would have cut it off
        let server = serve(vec![trickle(&[b'x'; 6000], 6, Duration::from_millis(200))]).await;
        let client = scaled_client();
        let url = format!("{}/xmltv.php", server.base);

        assert!(
            fetch(&client, &url, None).await.is_err(),
            "the small-request deadline still applies"
        );
        assert_eq!(
            fetch(&client, &url, Some(Duration::from_secs(10)))
                .await
                .unwrap(),
            6000
        );
    }

    #[tokio::test]
    async fn a_silent_connection_is_cut_off_by_the_stall_timeout_with_a_plain_message() {
        let server = serve(vec![vec![
            head("200 OK", 1000),
            Step::Write(vec![b'x'; 10]),
            Step::Hang,
        ]])
        .await;
        let url = format!("{}/xmltv.php?username=john&password=secret", server.base);

        let started = Instant::now();
        let err = fetch(&scaled_client(), &url, Some(Duration::from_secs(10)))
            .await
            .unwrap_err();

        assert!(
            started.elapsed() < Duration::from_secs(3),
            "stall was not detected early"
        );
        assert_eq!(server.connections(), 1, "reqwest retried on its own");
        assert_eq!(err.to_string(), "The EPG server stopped sending data");
        assert!(!format!("{err}").contains("secret"));
    }

    #[tokio::test]
    async fn a_download_that_outlives_the_bulk_deadline_says_so() {
        let server = serve(vec![trickle(&[b'x'; 6000], 6, Duration::from_millis(300))]).await;
        let url = format!("{}/xmltv.php", server.base);

        let err = fetch(&scaled_client(), &url, Some(Duration::from_millis(700)))
            .await
            .unwrap_err();

        assert_eq!(
            err.to_string(),
            "The download from the EPG server took longer than 1 minute"
        );
    }

    #[tokio::test]
    async fn an_error_status_is_named_instead_of_parsing_the_error_page() {
        let server = serve(vec![respond("403 Forbidden", b"<html>Forbidden</html>")]).await;
        let url = format!("{}/xmltv.php?username=john&password=secret", server.base);

        let err = fetch(&scaled_client(), &url, Some(Duration::from_secs(10)))
            .await
            .unwrap_err();

        assert_eq!(err.to_string(), "The EPG server answered 403 Forbidden");
    }

    #[tokio::test]
    async fn a_refused_connection_is_reported_without_the_url() {
        let port = std::net::TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let url = format!("http://127.0.0.1:{port}/xmltv.php?username=john&password=secret");

        let err = fetch(&scaled_client(), &url, Some(Duration::from_secs(10)))
            .await
            .unwrap_err();

        assert_eq!(err.to_string(), "Could not connect to the EPG server");
    }

    #[test]
    fn the_default_user_agent_carries_the_running_app_version() {
        // It read "Better-IPTV/2.1.1" from 4bd85d4 until 2026-09-09: a literal
        // that never followed the releases it was supposed to identify.
        assert!(
            DEFAULT_HTTP_USER_AGENT.ends_with(concat!("Better-IPTV/", env!("CARGO_PKG_VERSION"))),
            "user agent {DEFAULT_HTTP_USER_AGENT:?} does not end with the crate version {}",
            env!("CARGO_PKG_VERSION")
        );
    }

    #[test]
    fn the_default_mode_resolves_to_the_versioned_default() {
        assert_eq!(
            resolve_playlist_user_agent(Some("default"), None),
            DEFAULT_HTTP_USER_AGENT
        );
    }

    #[test]
    fn a_blank_custom_agent_falls_back_to_the_versioned_default() {
        assert_eq!(
            resolve_playlist_user_agent(Some("custom"), Some("   ")),
            DEFAULT_HTTP_USER_AGENT
        );
    }
}
