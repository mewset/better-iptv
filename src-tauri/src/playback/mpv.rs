use anyhow::{Context, Result};
use log::{debug, info, warn};
use std::ffi::{OsStr, OsString};
use std::path::PathBuf;
use std::process::{Child, Command};
use std::time::Duration;
use wait_timeout::ChildExt;

use crate::utils::mask_credentials;

/// Allowed URL schemes for stream playback: the protocols streams are served
/// over, each with its TLS form where it has one, plus SRT
const ALLOWED_SCHEMES: &[&str] = &[
    "http://", "https://", "rtsp://", "rtsps://", "rtmp://", "rtmps://", "rtp://", "udp://",
    "srt://",
];

/// Maximum allowed URL length
const MAX_URL_LENGTH: usize = 4096;

/// Validate a stream URL before passing to MPV
///
/// Checks:
/// - URL scheme is whitelisted (`ALLOWED_SCHEMES`), which also keeps out
///   mpv's own protocols (`edl://`, `av://`, ...) and anything mpv would read
///   as an option
/// - No control characters
/// - Reasonable URL length
///
/// Shell metacharacters such as `&` or `;` are allowed: mpv is started with the
/// URL as a single argument and no shell in between, so they reach mpv as
/// plain text, and a query string like `?token=a&exp=1` needs them.
///
/// Each error is a sentence the viewer is shown as it stands. None of them
/// quotes the address: it carries the provider's username and password.
/// Whether MPV may be handed this address (the same check as a start).
pub fn is_playable_url(url: &str) -> bool {
    validate_stream_url(url).is_ok()
}

fn validate_stream_url(url: &str) -> Result<()> {
    // Check URL length
    if url.len() > MAX_URL_LENGTH {
        return Err(anyhow::anyhow!(
            "The stream address is longer than {} characters",
            MAX_URL_LENGTH
        ));
    }

    // Check for allowed scheme
    let has_valid_scheme = ALLOWED_SCHEMES.iter().any(|scheme| url.starts_with(scheme));
    if !has_valid_scheme {
        warn!(
            "Rejected URL with invalid scheme: {}",
            url.chars().take(50).collect::<String>()
        );
        return Err(anyhow::anyhow!(
            "The stream address must start with http, https, rtsp, rtsps, rtmp, rtmps, rtp, udp or srt"
        ));
    }

    if url.chars().any(char::is_control) {
        warn!("Rejected URL containing control characters");
        return Err(anyhow::anyhow!(
            "The stream address contains characters that are not allowed in an address"
        ));
    }

    Ok(())
}

/// Get the path to MPV executable
///
/// On Windows, checks for bundled MPV first, then falls back to system PATH.
/// On macOS/Linux, uses system MPV only.
pub(crate) fn get_mpv_path() -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        // Try bundled MPV first (Windows only)
        // Bundled MPV is in resources/mpv/mpv.exe relative to the executable
        if let Ok(exe_path) = std::env::current_exe() {
            if let Some(exe_dir) = exe_path.parent() {
                // Check if mpv.exe exists in the bundle
                let bundled_mpv = exe_dir.join("mpv").join("mpv.exe");
                if bundled_mpv.exists() {
                    info!("Using bundled MPV at: {}", bundled_mpv.display());
                    return bundled_mpv;
                }
            }
        }

        // Fallback to system MPV
        info!("Bundled MPV not found, falling back to system MPV");
        PathBuf::from("mpv.exe")
    }

    #[cfg(not(target_os = "windows"))]
    {
        // macOS and Linux: Use system MPV only
        PathBuf::from("mpv")
    }
}

/// The command that starts MPV. An AppImage's AppRun points `LD_LIBRARY_PATH` and the GTK/GIO
/// variables into the image, and a system mpv that inherits them loads the bundled libraries (an
/// OpenSSL older than the system curl needs) and exits at once (#85). So nothing inside `APPDIR`
/// reaches mpv. Outside an AppImage `APPDIR` is unset and the environment passes unchanged.
fn mpv_command() -> Command {
    let mut cmd = Command::new(get_mpv_path());
    if let Some(appdir) = std::env::var_os("APPDIR") {
        for (key, value) in env_without_appdir(&appdir, std::env::vars_os()) {
            match value {
                Some(value) => cmd.env(key, value),
                None => cmd.env_remove(key),
            };
        }
    }
    cmd
}

/// The changes that keep `appdir` out of an environment: a `:`-separated value loses its entries
/// inside `appdir`, and a variable left with none is removed (`None`). Unaffected variables are
/// not listed.
fn env_without_appdir(
    appdir: &OsStr,
    vars: impl Iterator<Item = (OsString, OsString)>,
) -> Vec<(OsString, Option<OsString>)> {
    let appdir = appdir.to_string_lossy();
    let appdir = appdir.trim_end_matches('/');
    if appdir.is_empty() {
        return Vec::new();
    }
    let inside = |entry: &str| {
        entry
            .strip_prefix(appdir)
            .is_some_and(|rest| rest.is_empty() || rest.starts_with('/'))
    };
    vars.filter_map(|(key, value)| {
        let value = value.to_string_lossy();
        if !value.split(':').any(inside) {
            return None;
        }
        let kept: Vec<&str> = value
            .split(':')
            .filter(|entry| !entry.is_empty() && !inside(entry))
            .collect();
        Some((
            key,
            (!kept.is_empty()).then(|| OsString::from(kept.join(":"))),
        ))
    })
    .collect()
}

/// The window title of a queue: mpv fills in the playing file's own title.
pub const QUEUE_WINDOW_TITLE: &str = "${media-title}";

/// MPV player controller using external process approach
pub struct MpvPlayer {
    process: Option<Child>,
    /// Set when the last process exited with a failure code, until `status()` reports it.
    last_exit_failure: Option<PlaybackFailure>,
}

/// MPV playback options
#[derive(Clone, Copy)]
pub struct MpvPlaybackOptions<'a> {
    pub title: Option<&'a str>,
    pub audio_lang: Option<&'a str>,
    pub subtitle_lang: Option<&'a str>,
    pub hwdec: bool,
    pub video_output: Option<&'a str>,
    pub deinterlace: Option<&'a str>,
    pub start_fullscreen: bool,
    pub cache_secs: Option<u32>,
    pub start_volume: Option<u32>,
    /// User-Agent for the stream request, the same one the playlist and EPG
    /// downloads use, so providers that allow-list players see one identity.
    pub user_agent: Option<&'a str>,
    /// Seconds into the first file to start at (resuming).
    pub start_secs: Option<f64>,
    /// More arguments (a series' playlist).
    pub extra_args: &'a [String],
}

impl MpvPlayer {
    /// Create a new MPV player instance
    pub fn new() -> Self {
        Self {
            process: None,
            last_exit_failure: None,
        }
    }

    /// Check if MPV is installed on the system: `mpv --version` runs and
    /// succeeds. An mpv that starts but exits with an error (a broken
    /// install, a library it cannot load) cannot play anything either.
    pub fn check_installed() -> bool {
        command_succeeds(mpv_command().arg("--version"))
    }

    /// Apply MPV arguments from playback options
    fn apply_args(cmd: &mut Command, options: &MpvPlaybackOptions) {
        // Hardware acceleration
        if options.hwdec {
            cmd.arg("--hwdec=auto");
        } else {
            cmd.arg("--hwdec=no");
        }

        // Video output
        let vo = options.video_output.unwrap_or("gpu-next");
        cmd.arg(format!("--vo={}", vo));

        // Only use high-quality profile with GPU renderers
        if vo == "gpu-next" || vo == "gpu" {
            cmd.arg("--profile=high-quality");
        }

        // Deinterlacing
        if let Some(deinterlace) = options.deinterlace {
            match deinterlace {
                "yes" => {
                    cmd.arg("--deinterlace=yes");
                }
                "no" => {
                    cmd.arg("--deinterlace=no");
                }
                _ => {
                    cmd.arg("--deinterlace=auto");
                }
            }
        }

        // Fullscreen
        if options.start_fullscreen {
            cmd.arg("--fullscreen");
        }

        // Volume
        if let Some(vol) = options.start_volume {
            cmd.arg(format!("--volume={}", vol.min(100)));
        }

        // Cache
        let cache_secs = options.cache_secs.unwrap_or(30);
        cmd.arg("--cache=yes")
            .arg(format!("--cache-secs={}", cache_secs))
            .arg("--demuxer-max-bytes=100M");

        // Logging
        cmd.arg("--msg-level=all=error");

        // Title
        if let Some(title_str) = options.title {
            cmd.arg(format!("--title={}", title_str));
        }

        // Audio language preference
        if let Some(lang) = options.audio_lang {
            if !lang.is_empty() {
                cmd.arg(format!("--alang={}", lang));
            }
        }

        // Subtitle language preference
        if let Some(lang) = options.subtitle_lang {
            if !lang.is_empty() {
                cmd.arg(format!("--slang={}", lang));
            }
        }

        // User-Agent for the stream request
        if let Some(ua) = options.user_agent {
            if !ua.is_empty() {
                cmd.arg(format!("--user-agent={}", ua));
            }
        }

        cmd.args(options.extra_args);

        // Where the app asks MPV how far playback is (watch progress)
        cmd.arg(format!("--input-ipc-server={}", super::ipc::socket_path()));
    }

    /// Log MPV command with masked credentials
    fn log_command(cmd: &Command, episode_count: Option<usize>) {
        let args: Vec<String> = cmd
            .get_args()
            .map(|a| a.to_string_lossy().to_string())
            .collect();
        let safe_args = args
            .iter()
            .map(|arg| mask_credentials(arg))
            .collect::<Vec<_>>();

        if let Some(count) = episode_count {
            info!("MPV playlist command: {} episodes", count);
        }
        debug!("MPV command: mpv {}", safe_args.join(" "));
    }

    /// Spawn MPV process and store handle
    fn spawn_mpv(&mut self, cmd: &mut Command) -> Result<()> {
        let child = cmd.spawn().map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => anyhow::anyhow!(
                "mpv could not be started because it was not found. Is mpv installed?"
            ),
            _ => anyhow::Error::new(e).context("mpv could not be started"),
        })?;

        self.process = Some(child);
        self.last_exit_failure = None;
        Ok(())
    }

    /// Play a stream URL with playback options
    pub fn play_stream(&mut self, url: &str, options: &MpvPlaybackOptions) -> Result<()> {
        // Validate URL before passing to MPV
        validate_stream_url(url)?;

        // Stop any existing playback
        self.stop()?;

        // Build MPV command
        let mut cmd = mpv_command();
        Self::apply_args(&mut cmd, options);
        cmd.args(Self::queue_args(
            &[url.to_string()],
            &[],
            options.start_secs,
        ));

        // Log and spawn
        Self::log_command(&cmd, None);
        self.spawn_mpv(&mut cmd)
    }

    /// Start MPV with only the configured arguments: what to play comes in
    /// `extra_args` (a series' playlist file, `playback::episodes`).
    pub fn play_prepared(&mut self, options: &MpvPlaybackOptions) -> Result<()> {
        self.stop()?;
        let mut cmd = mpv_command();
        Self::apply_args(&mut cmd, options);
        Self::log_command(&cmd, None);
        self.spawn_mpv(&mut cmd)
    }

    /// The files to play, each in a per-file option group (`--{ ... --}`)
    /// when it has options of its own: its title (the window shows the
    /// playing file's) and, for the first file only, where to start
    /// (resuming), so the rest of a queue still starts at the beginning. A
    /// file without either is the plain address, under its file name.
    fn queue_args(urls: &[String], titles: &[String], start_secs: Option<f64>) -> Vec<String> {
        let start = start_secs.filter(|s| s.is_finite() && *s > 0.0);
        let mut args = Vec::with_capacity(urls.len() * 5);
        for (i, url) in urls.iter().enumerate() {
            let title = titles.get(i).map(|t| t.trim()).filter(|t| !t.is_empty());
            let start = start.filter(|_| i == 0);
            if title.is_none() && start.is_none() {
                args.push(url.clone());
                continue;
            }
            args.push("--{".to_string());
            if let Some(title) = title {
                args.push(format!("--force-media-title={title}"));
            }
            if let Some(start) = start {
                args.push(format!("--start={start:.0}"));
            }
            args.push(url.clone());
            args.push("--}".to_string());
        }
        args
    }

    /// Play a playlist of URLs (for series episodes). `titles` are the
    /// episodes' names, in the order of `urls`: the window shows the one that
    /// is playing. One `--title` for the whole queue kept the first episode's
    /// name on the window while the later ones played.
    pub fn play_playlist(
        &mut self,
        urls: &[String],
        titles: &[String],
        options: &MpvPlaybackOptions,
    ) -> Result<()> {
        if urls.is_empty() {
            return Err(anyhow::anyhow!("There are no episodes to play"));
        }

        // Validate all URLs before passing to MPV
        for (i, url) in urls.iter().enumerate() {
            validate_stream_url(url)
                .with_context(|| format!("Queued episode {} cannot be played", i + 1))?;
        }

        // Stop any existing playback
        self.stop()?;

        // Build MPV command. The window follows the title of the file that
        // is playing, which `queue_args` sets for each one.
        let mut cmd = mpv_command();
        let queue_options = MpvPlaybackOptions {
            title: Some(QUEUE_WINDOW_TITLE),
            ..*options
        };
        Self::apply_args(&mut cmd, &queue_options);

        // Add all URLs as arguments (MPV will play them in sequence)
        cmd.args(Self::queue_args(urls, titles, options.start_secs));

        // Log and spawn
        Self::log_command(&cmd, Some(urls.len()));
        self.spawn_mpv(&mut cmd)
    }

    /// Stop current playback with timeout to prevent hanging
    pub fn stop(&mut self) -> Result<()> {
        if let Some(mut child) = self.process.take() {
            // Send kill signal
            let _ = child.kill();

            // Wait with timeout (5 seconds) to prevent indefinite blocking
            match child
                .wait_timeout(Duration::from_secs(5))
                .context("The running mpv could not be stopped")?
            {
                Some(_status) => {
                    // Process terminated normally
                }
                None => {
                    // Process didn't respond within timeout, force kill
                    warn!("MPV process did not respond to kill signal, forcing termination");
                    let _ = child.kill();
                    // Try waiting again briefly
                    let _ = child.wait_timeout(Duration::from_secs(1));
                }
            }
        }
        Ok(())
    }

    /// Poll the process and report whether it is still playing and, if it has
    /// exited, whether it exited on a failure and whose. A failure is
    /// reported once: the next call after it reads `failure: None`.
    /// The running player's process id, if one runs.
    pub fn pid(&self) -> Option<u32> {
        self.process.as_ref().map(|c| c.id())
    }

    pub fn status(&mut self) -> PlaybackStatus {
        if let Some(child) = &mut self.process {
            match child.try_wait() {
                Ok(None) => {
                    return PlaybackStatus {
                        playing: true,
                        failure: None,
                    }
                }
                Ok(Some(exit)) => {
                    self.last_exit_failure = exit_failure(exit.code());
                    self.process = None;
                }
                Err(_) => self.process = None,
            }
        }
        PlaybackStatus {
            playing: false,
            failure: self.last_exit_failure.take(),
        }
    }
}

/// Whether a command runs and exits successfully.
fn command_succeeds(cmd: &mut Command) -> bool {
    cmd.output().is_ok_and(|output| output.status.success())
}

/// What the frontend's playback poll learns about MPV. Serialized as
/// `{"playing":false,"failure":"player"}`, with `null` for no failure.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
pub struct PlaybackStatus {
    pub playing: bool,
    /// Why MPV exited on its own, when it did so on a failure.
    pub failure: Option<PlaybackFailure>,
}

/// Who a failed exit of MPV is down to. The viewer is told different things:
/// a stream that cannot be played is the provider's, an mpv that cannot
/// start is this machine's.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PlaybackFailure {
    /// mpv could not start (exit code 1).
    Player,
    /// The stream could not be played (exit code 2 or 3).
    Stream,
}

/// The failure an MPV exit code stands for, if any.
///
/// mpv exits 1 when it fails to initialise, which includes an option or a
/// profile it does not know, 2 when the file could not be played (a provider
/// answering 503, a dead link), and 3 when only some files of a playlist
/// played. Closing the window exits 0, and `stop()` kills the process with a
/// signal, which has no exit code at all; neither is a failure.
pub fn exit_failure(code: Option<i32>) -> Option<PlaybackFailure> {
    match code {
        Some(1) => Some(PlaybackFailure::Player),
        Some(2) | Some(3) => Some(PlaybackFailure::Stream),
        _ => None,
    }
}

impl Drop for MpvPlayer {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env_changes(appdir: &str, vars: &[(&str, &str)]) -> Vec<(String, Option<String>)> {
        env_without_appdir(
            OsStr::new(appdir),
            vars.iter()
                .map(|(k, v)| (OsString::from(k), OsString::from(v))),
        )
        .into_iter()
        .map(|(k, v)| {
            (
                k.to_string_lossy().into_owned(),
                v.map(|v| v.to_string_lossy().into_owned()),
            )
        })
        .collect()
    }

    #[test]
    fn appimage_entries_are_kept_away_from_mpv() {
        let a = "/tmp/.mount_betterAbc";
        let changes = env_changes(
            a,
            &[
                (
                    "LD_LIBRARY_PATH",
                    &format!("{a}/usr/lib/:{a}/usr/lib/x86_64-linux-gnu/:/opt/lib"),
                ),
                ("GTK_PATH", &format!("{a}//usr/lib/gtk-3.0")),
                (
                    "XDG_DATA_DIRS",
                    &format!("{a}/usr/share:/usr/share:/usr/local/share"),
                ),
                ("APPDIR", a),
                ("APPIMAGE", "/home/u/Better_IPTV.AppImage"),
                ("HOME", "/home/u"),
                ("GDK_BACKEND", "x11"),
            ],
        );
        assert_eq!(
            changes,
            vec![
                ("LD_LIBRARY_PATH".into(), Some("/opt/lib".into())),
                ("GTK_PATH".into(), None),
                (
                    "XDG_DATA_DIRS".into(),
                    Some("/usr/share:/usr/local/share".into())
                ),
                ("APPDIR".into(), None),
            ]
        );
    }

    #[test]
    fn a_path_that_only_shares_the_appdir_prefix_is_kept() {
        let changes = env_changes(
            "/tmp/.mount_abc/",
            &[(
                "PATH",
                "/tmp/.mount_abcdef/bin:/tmp/.mount_abc/usr/bin:/usr/bin",
            )],
        );
        assert_eq!(
            changes,
            vec![(
                "PATH".into(),
                Some("/tmp/.mount_abcdef/bin:/usr/bin".into())
            )]
        );
    }

    #[test]
    fn an_empty_appdir_changes_nothing() {
        assert!(env_changes("", &[("LD_LIBRARY_PATH", "/usr/lib")]).is_empty());
        assert!(env_changes("/", &[("LD_LIBRARY_PATH", "/usr/lib")]).is_empty());
    }

    #[test]
    fn exit_code_1_blames_the_player_and_2_or_3_the_stream() {
        assert_eq!(exit_failure(Some(1)), Some(PlaybackFailure::Player));
        assert_eq!(exit_failure(Some(2)), Some(PlaybackFailure::Stream));
        assert_eq!(exit_failure(Some(3)), Some(PlaybackFailure::Stream));
    }

    #[test]
    fn a_normal_quit_or_a_signal_is_no_failure() {
        assert_eq!(exit_failure(Some(0)), None);
        assert_eq!(exit_failure(Some(4)), None);
        assert_eq!(exit_failure(None), None);
    }

    #[test]
    fn the_status_reaches_the_frontend_as_player_stream_or_null() {
        let json = |failure| {
            serde_json::to_string(&PlaybackStatus {
                playing: false,
                failure,
            })
            .unwrap()
        };
        assert_eq!(
            json(Some(PlaybackFailure::Player)),
            r#"{"playing":false,"failure":"player"}"#
        );
        assert_eq!(
            json(Some(PlaybackFailure::Stream)),
            r#"{"playing":false,"failure":"stream"}"#
        );
        assert_eq!(json(None), r#"{"playing":false,"failure":null}"#);
    }

    #[cfg(unix)]
    #[test]
    fn a_command_that_runs_but_exits_with_an_error_is_not_an_installed_mpv() {
        assert!(command_succeeds(Command::new("sh").arg("-c").arg("exit 0")));
        assert!(!command_succeeds(
            Command::new("sh").arg("-c").arg("exit 1")
        ));
        assert!(!command_succeeds(&mut Command::new(
            "/nonexistent/better-iptv-test/mpv"
        )));
    }

    #[cfg(unix)]
    fn exited_player(code: i32) -> MpvPlayer {
        let mut child = Command::new("sh")
            .arg("-c")
            .arg(format!("exit {code}"))
            .spawn()
            .unwrap();
        child.wait().unwrap();
        MpvPlayer {
            process: Some(child),
            last_exit_failure: None,
        }
    }

    #[cfg(unix)]
    #[test]
    fn stop_ends_a_running_process() {
        // A stand-in for mpv: stop() is what the app calls on exit.
        let child = Command::new("sleep").arg("60").spawn().unwrap();
        #[cfg(target_os = "linux")]
        let proc_entry = std::path::PathBuf::from(format!("/proc/{}", child.id()));
        let mut player = MpvPlayer {
            process: Some(child),
            last_exit_failure: None,
        };

        player.stop().unwrap();

        assert!(player.process.is_none());
        // Killed and reaped: the process is gone, not left as a zombie
        #[cfg(target_os = "linux")]
        assert!(!proc_entry.exists());
        assert_eq!(
            player.status(),
            PlaybackStatus {
                playing: false,
                failure: None
            },
            "a stop is not a failure"
        );
    }

    #[cfg(unix)]
    #[test]
    fn status_reports_a_failed_exit_once() {
        let mut player = exited_player(2);
        assert_eq!(
            player.status(),
            PlaybackStatus {
                playing: false,
                failure: Some(PlaybackFailure::Stream)
            }
        );
        assert_eq!(
            player.status(),
            PlaybackStatus {
                playing: false,
                failure: None
            }
        );
    }

    #[cfg(unix)]
    #[test]
    fn status_reports_an_mpv_that_could_not_start_as_a_player_failure() {
        let mut player = exited_player(1);
        assert_eq!(player.status().failure, Some(PlaybackFailure::Player));
    }

    fn args_of(options: &MpvPlaybackOptions) -> Vec<String> {
        let mut cmd = Command::new("mpv");
        MpvPlayer::apply_args(&mut cmd, options);
        cmd.get_args()
            .map(|a| a.to_string_lossy().to_string())
            .collect()
    }

    fn bare_options() -> MpvPlaybackOptions<'static> {
        MpvPlaybackOptions {
            title: None,
            audio_lang: None,
            subtitle_lang: None,
            hwdec: true,
            video_output: None,
            deinterlace: None,
            start_fullscreen: false,
            cache_secs: None,
            start_volume: None,
            user_agent: None,
            start_secs: None,
            extra_args: &[],
        }
    }

    #[test]
    fn the_configured_user_agent_is_passed_to_mpv() {
        let options = MpvPlaybackOptions {
            user_agent: Some("VLC/3.0.20 LibVLC/3.0.20"),
            ..bare_options()
        };
        assert!(args_of(&options).contains(&"--user-agent=VLC/3.0.20 LibVLC/3.0.20".to_string()));
    }

    #[test]
    fn only_the_first_file_starts_at_the_resume_point() {
        let urls = vec!["http://a/1".to_string(), "http://a/2".to_string()];
        let titles = vec!["One".to_string(), "Two".to_string()];
        assert_eq!(
            MpvPlayer::queue_args(&urls, &titles, Some(1234.4)),
            [
                "--{",
                "--force-media-title=One",
                "--start=1234",
                "http://a/1",
                "--}",
                "--{",
                "--force-media-title=Two",
                "http://a/2",
                "--}",
            ]
        );
        assert_eq!(
            MpvPlayer::queue_args(&urls, &[], Some(0.0)),
            ["http://a/1", "http://a/2"]
        );
        assert_eq!(
            MpvPlayer::queue_args(&urls[..1], &[], Some(90.0)),
            ["--{", "--start=90", "http://a/1", "--}"]
        );
    }

    #[test]
    fn mpv_listens_for_the_app_on_its_ipc_socket() {
        assert!(args_of(&bare_options())
            .iter()
            .any(|a| a.starts_with("--input-ipc-server=")));
    }

    #[test]
    fn every_queued_episode_carries_its_own_title() {
        let urls = vec![
            "http://a/1.mp4".to_string(),
            "http://a/2.mp4".to_string(),
            "http://a/3.mp4".to_string(),
        ];
        let titles = vec!["Pilot".to_string(), "  ".to_string()];
        assert_eq!(
            MpvPlayer::queue_args(&urls, &titles, None),
            [
                "--{",
                "--force-media-title=Pilot",
                "http://a/1.mp4",
                "--}",
                // No title of its own: the plain address, under its file name
                "http://a/2.mp4",
                "http://a/3.mp4",
            ]
        );
    }

    #[test]
    fn a_queue_shows_the_title_of_the_file_that_is_playing() {
        let queue = MpvPlaybackOptions {
            title: Some(QUEUE_WINDOW_TITLE),
            ..bare_options()
        };
        assert!(args_of(&queue).contains(&"--title=${media-title}".to_string()));
    }

    #[test]
    fn no_user_agent_flag_without_a_configured_user_agent() {
        assert!(!args_of(&bare_options())
            .iter()
            .any(|a| a.starts_with("--user-agent=")));
    }

    #[cfg(unix)]
    #[test]
    fn status_does_not_report_a_normal_quit_as_a_failure() {
        let mut player = exited_player(0);
        assert_eq!(player.status().failure, None);
    }

    #[test]
    fn a_missing_mpv_binary_is_reported_as_not_installed() {
        let mut player = MpvPlayer::new();
        let err = player
            .spawn_mpv(&mut Command::new("/nonexistent/better-iptv-test/mpv"))
            .unwrap_err();
        assert_eq!(
            format!("{err:#}"),
            "mpv could not be started because it was not found. Is mpv installed?"
        );
    }

    #[test]
    fn test_check_installed() {
        // This will pass if MPV is installed on the system
        let installed = MpvPlayer::check_installed();
        debug!("MPV installed: {}", installed);
    }

    #[test]
    fn test_validate_url_valid_schemes() {
        assert!(validate_stream_url("http://example.com/stream.m3u8").is_ok());
        assert!(validate_stream_url("https://example.com/stream.m3u8").is_ok());
        assert!(validate_stream_url("rtsp://example.com/live").is_ok());
        assert!(validate_stream_url("rtsps://example.com/live").is_ok());
        assert!(validate_stream_url("rtmp://example.com/live").is_ok());
        assert!(validate_stream_url("rtmps://example.com/live/key").is_ok());
        assert!(validate_stream_url("srt://example.com:9000?streamid=live/tv1").is_ok());
        assert!(validate_stream_url("rtp://example.com:1234").is_ok());
        assert!(validate_stream_url("udp://239.0.0.1:1234").is_ok());
    }

    #[test]
    fn test_validate_url_invalid_schemes() {
        assert!(validate_stream_url("file:///etc/passwd").is_err());
        assert!(validate_stream_url("ftp://example.com/file").is_err());
        assert!(validate_stream_url("javascript:alert(1)").is_err());
        // mpv's own protocols and option-like strings stay out
        for url in [
            "edl://file.mkv",
            "av://lavfi:testsrc",
            "memory://x",
            "smb://host/share/a.mkv",
            "--script=/tmp/x.lua",
            "srt:/missing-slash",
        ] {
            assert!(validate_stream_url(url).is_err(), "{url}");
        }
        assert!(validate_stream_url("/etc/passwd").is_err());
        assert!(validate_stream_url("./local/file").is_err());
    }

    #[test]
    fn test_validate_url_accepts_query_strings_and_shell_characters() {
        assert!(validate_stream_url("http://example.com/live.m3u8?token=a&exp=1").is_ok());
        assert!(validate_stream_url("http://example.com/live/u/p$s;w|d/1.m3u8").is_ok());
    }

    #[test]
    fn test_validate_url_rejects_control_characters() {
        assert!(validate_stream_url("http://example.com/\nmalicious").is_err());
        assert!(validate_stream_url("http://example.com/a\rb").is_err());
        assert!(validate_stream_url("http://example.com/a\0b").is_err());
        assert!(validate_stream_url("http://example.com/a\tb").is_err());
    }

    #[test]
    fn test_validate_url_length() {
        let long_url = format!("http://example.com/{}", "a".repeat(5000));
        assert!(validate_stream_url(&long_url).is_err());
    }
}
