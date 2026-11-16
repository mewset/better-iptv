//! The player's controls (`player.lua`): a streaming-style layout drawn over
//! the video, given to every MPV the app starts. The viewer's own MPV
//! scripts stay out of the app's player (another control bar would draw over
//! this one).
//!
//! Films and episodes download ahead into an on-disk cache, over the one
//! connection the player already has: the timeline's previews are cut from
//! it (`player.lua`, Previews), as a provider line often allows a single
//! connection and a second one for previews would be refused or cut the film.

use super::episodes::work_dir;
use anyhow::{Context, Result};
use std::path::PathBuf;

const SCRIPT: &str = include_str!("player.lua");

/// What the controls show besides what MPV knows.
pub struct PlayerKind<'a> {
    /// The series an episode belongs to, for "Series  S2:E5  Name".
    pub series: Option<&'a str>,
    /// Live TV: no timeline or jumps, a LIVE badge.
    pub live: bool,
}

/// How much of a film or episode the cache keeps, ahead and behind.
const CACHE_BYTES: &str = "3GiB";

/// Where the player's cache goes: on disk in the user's cache folder (the
/// temp folder is often memory). MPV removes its files as it closes.
fn cache_dir() -> Option<PathBuf> {
    let base = std::env::var_os("XDG_CACHE_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".cache")))
        .or_else(|| std::env::var_os("LOCALAPPDATA").map(PathBuf::from))?;
    let dir = base.join("better-iptv").join("player-cache");
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir)
}

/// MPV arguments for the controls.
pub fn args(kind: &PlayerKind) -> Result<Vec<String>> {
    let work = work_dir()?;
    let script = work.join("player.lua");
    std::fs::write(&script, SCRIPT).context("could not write the player's controls")?;
    let mut args = vec![
        "--load-scripts=no".to_string(),
        "--osc=no".to_string(),
        "--osd-bar=no".to_string(),
        format!("--script={}", script.display()),
        format!(
            "--script-opts-append=biptv-player-mpv={}",
            super::mpv::get_mpv_path().display()
        ),
        format!("--script-opts-append=biptv-player-work={}", work.display()),
    ];
    // Films and episodes: download ahead and keep it, for the previews (after
    // the playback settings' own cache options, so these win)
    if !kind.live {
        if let Some(dir) = cache_dir() {
            args.extend([
                "--cache=yes".to_string(),
                "--cache-on-disk=yes".to_string(),
                format!("--demuxer-cache-dir={}", dir.display()),
                format!("--demuxer-max-bytes={CACHE_BYTES}"),
                format!("--demuxer-max-back-bytes={CACHE_BYTES}"),
                "--cache-secs=36000".to_string(),
            ]);
        }
    }
    if let Some(series) = kind.series.filter(|s| !s.is_empty()) {
        // One key=value per -append, so a comma in the name is safe
        args.push(format!(
            "--script-opts-append=biptv-player-series={}",
            series.replace(['\r', '\n'], " ")
        ));
    }
    args.push(format!(
        "--script-opts-append=biptv-player-live={}",
        if kind.live { "yes" } else { "no" }
    ));
    Ok(args)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn args_load_the_controls_alone_and_say_what_plays() {
        let args = args(&PlayerKind {
            series: Some("The Expanse"),
            live: false,
        })
        .unwrap();
        assert_eq!(args[0], "--load-scripts=no");
        let script = args[3].strip_prefix("--script=").unwrap();
        assert!(std::fs::read_to_string(script)
            .unwrap()
            .contains("biptv-player"));
        assert!(args.contains(&"--script-opts-append=biptv-player-series=The Expanse".to_string()));
        assert!(args.contains(&"--script-opts-append=biptv-player-live=no".to_string()));

        let live = super::args(&PlayerKind {
            series: None,
            live: true,
        })
        .unwrap();
        assert!(!live.iter().any(|a| a.contains("biptv-player-series")));
        // Only films and episodes download ahead for the previews
        assert!(args.contains(&"--cache-on-disk=yes".to_string()));
        assert!(!live.contains(&"--cache-on-disk=yes".to_string()));
        assert!(args
            .iter()
            .any(|a| a.starts_with("--script-opts-append=biptv-player-work=")));
        assert!(live.contains(&"--script-opts-append=biptv-player-live=yes".to_string()));
    }
}
