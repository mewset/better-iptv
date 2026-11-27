//! A series' queued episodes in the player: a private playlist file with a
//! title per episode (uosc lists them by it) and `episodes.lua` for the
//! resume, the next/previous keys and the "Up next" prompt.

use anyhow::{Context, Result};
use std::path::{Path, PathBuf};

const SCRIPT: &str = include_str!("episodes.lua");

/// Where the script and playlist files go: a folder of this app process,
/// only readable by the user (the playlist holds stream addresses with the
/// login; the script deletes it as soon as mpv has read it).
pub(crate) fn work_dir() -> Result<PathBuf> {
    let dir = std::env::temp_dir().join(format!("better-iptv-{}", std::process::id()));
    std::fs::create_dir_all(&dir).context("could not create the player's work folder")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(dir)
}

pub(crate) fn write_private(path: &Path, contents: &str) -> Result<()> {
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(path)?;
        file.write_all(contents.as_bytes())?;
        Ok(())
    }
    #[cfg(not(unix))]
    {
        std::fs::write(path, contents)?;
        Ok(())
    }
}

/// An extended M3U of the episodes: `#EXTINF` carries each one's title.
pub fn playlist(entries: &[(String, String)]) -> String {
    let mut out = String::from("#EXTM3U\n");
    for (title, url) in entries {
        // A title is one line; a comma is fine after the duration's
        let title = title.replace(['\r', '\n'], " ");
        out.push_str(&format!("#EXTINF:-1,{title}\n{url}\n"));
    }
    out
}

/// MPV arguments that play `entries` (title, address) in order, the first
/// from `start_secs`. The script deletes the playlist file once read.
pub fn args(entries: &[(String, String)], start_secs: Option<f64>) -> Result<Vec<String>> {
    let dir = work_dir()?;
    let script = dir.join("episodes.lua");
    std::fs::write(&script, SCRIPT).context("could not write the episodes script")?;
    let path = dir.join(format!(
        "episodes-{}.m3u",
        chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
    ));
    write_private(&path, &playlist(entries))?;
    let start = start_secs
        .filter(|s| s.is_finite() && *s > 0.0)
        .unwrap_or(0.0);
    Ok(vec![
        format!("--script={}", script.display()),
        format!("--script-opts-append=biptv-playlist={}", path.display()),
        format!("--script-opts-append=biptv-start={start:.0}"),
        format!("--playlist={}", path.display()),
    ])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_playlist_titles_each_episode_on_one_line() {
        let m3u = playlist(&[
            ("S1 E1 · Pilot".into(), "http://p/1.mkv".into()),
            ("S1 E2 · Two\nlines".into(), "http://p/2.mkv".into()),
        ]);
        assert_eq!(
            m3u,
            "#EXTM3U\n#EXTINF:-1,S1 E1 · Pilot\nhttp://p/1.mkv\n#EXTINF:-1,S1 E2 · Two lines\nhttp://p/2.mkv\n"
        );
    }

    #[test]
    fn args_point_mpv_at_a_private_playlist_and_the_resume_point() {
        let args = args(&[("A".into(), "http://p/1".into())], Some(1234.4)).unwrap();
        let path = args[3].strip_prefix("--playlist=").unwrap();
        assert!(std::fs::read_to_string(path)
            .unwrap()
            .contains("http://p/1"));
        assert_eq!(args[2], "--script-opts-append=biptv-start=1234");
        std::fs::remove_file(path).unwrap();
    }
}
