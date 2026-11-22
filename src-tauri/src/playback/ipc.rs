//! MPV's JSON IPC: where playback is. MPV is started with
//! `--input-ipc-server=<socket_path()>`; `snapshot()` connects, asks for the
//! position, the length and the playlist entry, and gives up quickly, so a
//! busy or exited player never holds anything up.

use serde::Deserialize;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::time::Duration;

/// Where MPV listens for this app instance: one path per process, so two
/// running copies of the app never talk to each other's player.
pub fn socket_path() -> String {
    #[cfg(windows)]
    {
        format!(r"\\.\pipe\better-iptv-mpv-{}", std::process::id())
    }
    #[cfg(not(windows))]
    {
        std::env::temp_dir()
            .join(format!("better-iptv-mpv-{}.sock", std::process::id()))
            .to_string_lossy()
            .into_owned()
    }
}

/// Where MPV is, as far as it knows.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Snapshot {
    /// Seconds into the current file.
    pub position: f64,
    /// The current file's length, when MPV knows it (not for live streams).
    pub duration: Option<f64>,
    /// Which file of the playlist is playing (0 for a single file).
    pub playlist_pos: usize,
}

#[derive(Deserialize)]
struct Reply {
    request_id: Option<u64>,
    error: Option<String>,
    data: Option<Value>,
}

const TIMEOUT: Duration = Duration::from_millis(800);

/// Ask MPV where it is. None when no player answers (not started yet,
/// exited, or busy past the timeout) or nothing is loaded.
pub fn snapshot(path: &str) -> Option<Snapshot> {
    let stream = connect(path)?;
    let mut writer = stream.try_clone().ok()?;
    let mut reader = BufReader::new(stream);

    let ask = |writer: &mut dyn Write, id: u64, property: &str| {
        let line = json!({ "command": ["get_property", property], "request_id": id });
        writeln!(writer, "{line}").ok()
    };
    ask(&mut writer, 1, "time-pos")?;
    ask(&mut writer, 2, "duration")?;
    ask(&mut writer, 3, "playlist-pos")?;
    writer.flush().ok()?;

    let (mut position, mut duration, mut playlist_pos) = (None, None, None);
    let mut line = String::new();
    // MPV interleaves events with the replies; read until all three answered
    for _ in 0..32 {
        line.clear();
        if reader.read_line(&mut line).ok()? == 0 {
            break;
        }
        let Ok(reply) = serde_json::from_str::<Reply>(&line) else {
            continue;
        };
        let ok = reply.error.as_deref() == Some("success");
        match reply.request_id {
            Some(1) => {
                position = if ok {
                    reply.data.and_then(|v| v.as_f64())
                } else {
                    None
                }
            }
            Some(2) => {
                duration = if ok {
                    reply.data.and_then(|v| v.as_f64())
                } else {
                    None
                }
            }
            Some(3) => {
                playlist_pos = if ok {
                    reply.data.and_then(|v| v.as_i64())
                } else {
                    None
                }
            }
            _ => continue,
        }
        if reply.request_id == Some(3) {
            break;
        }
    }
    Some(Snapshot {
        position: position.filter(|p| p.is_finite() && *p >= 0.0)?,
        duration: duration.filter(|d| d.is_finite() && *d > 0.0),
        playlist_pos: playlist_pos
            .and_then(|p| usize::try_from(p).ok())
            .unwrap_or(0),
    })
}

/// when no player answers or the command fails.
fn request(path: &str, command: Value) -> Option<Option<Value>> {
    let stream = connect(path)?;
    let mut writer = stream.try_clone().ok()?;
    let mut reader = BufReader::new(stream);
    writeln!(writer, "{}", json!({ "command": command, "request_id": 1 })).ok()?;
    writer.flush().ok()?;
    let mut line = String::new();
    for _ in 0..32 {
        line.clear();
        if reader.read_line(&mut line).ok()? == 0 {
            return None;
        }
        let Ok(reply) = serde_json::from_str::<Reply>(&line) else {
            continue;
        };
        if reply.request_id == Some(1) {
            return (reply.error.as_deref() == Some("success")).then_some(reply.data);
        }
    }
    None
}

/// Send a message to the player's scripts (`script-message`); whether MPV took it.
pub fn script_message(path: &str, args: &[&str]) -> bool {
    let mut command = vec![json!("script-message")];
    command.extend(args.iter().map(|a| json!(a)));
    request(path, Value::Array(command)).is_some()
}

#[cfg(not(windows))]
mod platform {
    use super::TIMEOUT;
    use std::os::unix::net::UnixStream;

    pub type Conn = UnixStream;

    pub fn connect(path: &str) -> Option<Conn> {
        let stream = UnixStream::connect(path).ok()?;
        stream.set_read_timeout(Some(TIMEOUT)).ok()?;
        stream.set_write_timeout(Some(TIMEOUT)).ok()?;
        Some(stream)
    }
}

#[cfg(windows)]
mod platform {
    use std::fs::{File, OpenOptions};

    // A named pipe opens like a file; MPV answers get_property at once.
    pub type Conn = File;

    pub fn connect(path: &str) -> Option<Conn> {
        OpenOptions::new().read(true).write(true).open(path).ok()
    }
}

use platform::connect;

#[cfg(all(test, not(windows)))]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Write};
    use std::os::unix::net::UnixListener;

    /// A stand-in MPV: answers get_property with the given values, with an
    /// event line in between as the real one sends.
    fn fake_mpv(path: &std::path::Path, position: Value, duration: Value, pos: Value) {
        let listener = UnixListener::bind(path).unwrap();
        std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let mut out = stream.try_clone().unwrap();
            let reader = BufReader::new(stream);
            for line in reader.lines().take(3) {
                let req: Value = serde_json::from_str(&line.unwrap()).unwrap();
                let id = req["request_id"].as_u64().unwrap();
                let data = match req["command"][1].as_str().unwrap() {
                    "time-pos" => position.clone(),
                    "duration" => duration.clone(),
                    _ => pos.clone(),
                };
                writeln!(out, "{}", json!({"event": "property-change"})).unwrap();
                let reply = if data.is_null() {
                    json!({"request_id": id, "error": "property unavailable"})
                } else {
                    json!({"request_id": id, "error": "success", "data": data})
                };
                writeln!(out, "{reply}").unwrap();
            }
        });
    }

    fn socket(name: &str) -> std::path::PathBuf {
        let path =
            std::env::temp_dir().join(format!("bip-ipc-test-{}-{name}.sock", std::process::id()));
        let _ = std::fs::remove_file(&path);
        path
    }

    #[test]
    fn reads_position_duration_and_playlist_entry() {
        let path = socket("full");
        fake_mpv(&path, json!(1234.5), json!(6000.0), json!(2));
        let snap = snapshot(path.to_str().unwrap()).unwrap();
        assert_eq!(
            snap,
            Snapshot {
                position: 1234.5,
                duration: Some(6000.0),
                playlist_pos: 2
            }
        );
    }

    #[test]
    fn a_live_stream_has_no_duration_and_nothing_loaded_is_none() {
        let path = socket("live");
        fake_mpv(&path, json!(42.0), Value::Null, json!(0));
        let snap = snapshot(path.to_str().unwrap()).unwrap();
        assert_eq!(snap.duration, None);

        let path = socket("idle");
        fake_mpv(&path, Value::Null, Value::Null, json!(-1));
        assert_eq!(snapshot(path.to_str().unwrap()), None);
    }

    #[test]
    fn no_player_is_none() {
        assert_eq!(snapshot(socket("absent").to_str().unwrap()), None);
    }
}
