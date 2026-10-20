use super::decode::{is_gzipped, open_feed};
use crate::epg_domain::normalize_epg_id;
use crate::epg_domain::text::push_reference;
use crate::http::{download_error, ensure_success, get_http_client};
use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use log::{debug, info, warn};
use quick_xml::events::Event;
use quick_xml::Reader;
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::BufRead;
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EpgProgram {
    pub channel_id: String,
    pub title: String,
    pub description: Option<String>,
    pub start_time: DateTime<Utc>,
    pub end_time: DateTime<Utc>,
    pub category: Option<String>,
}

/// Shown when a feed downloads fine but holds no programmes: an empty file
/// or a page that is not XMLTV. Nothing is stored and `epg_last_fetched` is
/// left alone, so the next attempt is not pushed back by a refresh interval.
pub const EMPTY_GUIDE_MESSAGE: &str =
    "The EPG server sent a program guide without any programmes, so the current guide was kept";

/// Fetch and parse XMLTV EPG data from a URL (async part)
pub async fn fetch_and_parse_epg(url: &str, user_agent: Option<&str>) -> Result<Vec<EpgProgram>> {
    let start = Instant::now();
    info!("Fetching EPG from: {}", crate::utils::mask_credentials(url));

    let bytes = download_epg(
        get_http_client(),
        url,
        user_agent,
        crate::http::BULK_DOWNLOAD_TIMEOUT,
    )
    .await?;
    debug!(
        "EPG fetch completed in {:?}: {} bytes",
        start.elapsed(),
        bytes.len()
    );

    let parse_start = Instant::now();
    let programs = parse_epg_off_runtime(bytes).await?;
    debug!(
        "EPG parse completed in {:?}: {} programs",
        parse_start.elapsed(),
        programs.len()
    );

    if programs.is_empty() {
        anyhow::bail!(EMPTY_GUIDE_MESSAGE);
    }

    info!("Parsed {} EPG programs from XMLTV", programs.len());
    Ok(programs)
}

/// Download the raw EPG file. `deadline` overrides the client's total
/// timeout; the client's stall timeout still ends a dead connection early.
async fn download_epg(
    client: &reqwest::Client,
    url: &str,
    user_agent: Option<&str>,
    deadline: Duration,
) -> Result<bytes::Bytes> {
    const SERVER: &str = "EPG server";
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
    let response = ensure_success(response, SERVER)?;
    response
        .bytes()
        .await
        .map_err(|e| download_error(e, SERVER, started, deadline))
}

/// Decompress and parse on the blocking pool: a large feed takes over a
/// second of CPU, which would otherwise stall a tokio worker and every task
/// queued on it.
async fn parse_epg_off_runtime(bytes: bytes::Bytes) -> Result<Vec<EpgProgram>> {
    tokio::task::spawn_blocking(move || parse_epg_bytes(&bytes))
        .await
        .context("EPG parse task failed")?
}

/// Parse a downloaded EPG file, gzipped or plain.
///
/// A gzip stream is decompressed while it is parsed, so the XML text is never
/// held in memory as a whole (that halves peak memory). When the XML breaks
/// off, the rest of the stream is drained first, so gzip's length and CRC
/// check still runs: a damaged download fails as a whole, while malformed XML
/// in an intact file keeps the programmes read before the fault. The text is
/// transcoded to UTF-8 on the way (`decode::open_feed`), so a stray byte
/// becomes U+FFFD instead of ending the parse.
pub(crate) fn parse_epg_bytes(bytes: &[u8]) -> Result<Vec<EpgProgram>> {
    let read_failure = if is_gzipped(bytes) {
        "Failed to decompress gzipped EPG"
    } else {
        "Failed to read EPG"
    };
    finish_parse(parse_xmltv(open_feed(bytes)?), read_failure)
}

fn finish_parse<R: BufRead>(parsed: ParsedXmltv<R>, read_failure: &str) -> Result<Vec<EpgProgram>> {
    let ParsedXmltv {
        programs,
        error,
        mut rest,
    } = parsed;
    if let Some(e) = error {
        if let quick_xml::Error::Io(io) = &e {
            anyhow::bail!("{read_failure}: {io}");
        }
        std::io::copy(&mut rest, &mut std::io::sink()).context(read_failure.to_string())?;
        warn!("XML parsing error: {}", e);
    }
    Ok(programs)
}

/// Store EPG programs in database (sync part)
pub fn store_epg_programs(conn: &Connection, programs: &[EpgProgram]) -> Result<usize> {
    let start = Instant::now();
    let count = store_programs(conn, programs)?;
    debug!(
        "EPG store completed in {:?}: {} programs",
        start.elapsed(),
        count
    );
    info!("Stored {} EPG programs in database", count);
    Ok(count)
}

/// What `parse_xmltv` read before it stopped, and why it stopped early.
struct ParsedXmltv<R> {
    programs: Vec<EpgProgram>,
    /// The XML or read error that ended parsing before `</tv>`, if any
    error: Option<quick_xml::Error>,
    /// The unread rest of the source, for `finish_parse` to drain
    rest: R,
}

/// Parse XMLTV format from any buffered UTF-8 source.
///
/// quick-xml reports entity references as their own events and validates
/// UTF-8, so text is collected per field: text events appended, references
/// resolved leniently, the result trimmed at the field's end tag. A field
/// that is empty after trimming is ignored, so it neither replaces an earlier
/// value nor turns a missing description into an empty one. Bare ampersands
/// are text.
fn parse_xmltv<R: BufRead>(source: R) -> ParsedXmltv<R> {
    let mut reader = Reader::from_reader(source);
    let config = reader.config_mut();
    config.trim_text(false);
    config.allow_dangling_amp = true;

    // Pre-allocate with estimated capacity (typical EPG has 5k-50k programs)
    let mut programs = Vec::with_capacity(10_000);
    let mut buf = Vec::with_capacity(1024);

    let mut current_program: Option<EpgProgramBuilder> = None;
    let mut in_title = false;
    let mut in_desc = false;
    let mut in_category = false;
    let mut field_text = String::new();

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(ref e)) => match e.name().as_ref() {
                "programme" => {
                    let mut channel_id = String::new();
                    let mut start_time = None;
                    let mut end_time = None;

                    for attr in e.attributes().flatten() {
                        match attr.key.as_ref() {
                            "channel" => {
                                channel_id = attr.value.into_owned();
                            }
                            "start" => {
                                start_time = parse_xmltv_time(attr.value.as_bytes());
                            }
                            "stop" => {
                                end_time = parse_xmltv_time(attr.value.as_bytes());
                            }
                            _ => {}
                        }
                    }

                    if let (Some(start), Some(end)) = (start_time, end_time) {
                        current_program = Some(EpgProgramBuilder {
                            channel_id,
                            title: String::new(),
                            description: None,
                            start_time: start,
                            end_time: end,
                            category: None,
                        });
                    }
                }
                "title" | "desc" | "category" => {
                    match e.name().as_ref() {
                        "title" => in_title = true,
                        "desc" => in_desc = true,
                        _ => in_category = true,
                    }
                    field_text.clear();
                }
                _ => {}
            },
            Ok(Event::Text(e)) if in_title || in_desc || in_category => {
                field_text.push_str(&e.xml10_content());
            }
            Ok(Event::GeneralRef(e)) if in_title || in_desc || in_category => {
                push_reference(&mut field_text, &e);
            }
            Ok(Event::End(ref e)) => match e.name().as_ref() {
                "programme" => {
                    if let Some(prog) = current_program.take() {
                        if !prog.title.is_empty() {
                            programs.push(prog.build());
                        }
                    }
                }
                // A later non-empty element of the same kind replaces the
                // earlier one, as with the parser before quick-xml 0.42.
                "title" | "desc" | "category" => {
                    let text = field_text.trim();
                    if let (Some(prog), false) = (current_program.as_mut(), text.is_empty()) {
                        let text = text.to_string();
                        match e.name().as_ref() {
                            "title" => prog.title = text,
                            "desc" => prog.description = Some(text),
                            _ => prog.category = Some(text),
                        }
                    }
                    field_text.clear();
                    match e.name().as_ref() {
                        "title" => in_title = false,
                        "desc" => in_desc = false,
                        _ => in_category = false,
                    }
                }
                _ => {}
            },
            Ok(Event::Eof) => break,
            Err(e) => {
                return ParsedXmltv {
                    programs,
                    error: Some(e),
                    rest: reader.into_inner(),
                };
            }
            _ => {}
        }
        buf.clear();
    }

    ParsedXmltv {
        programs,
        error: None,
        rest: reader.into_inner(),
    }
}

/// Parse XMLTV timestamp format (YYYYMMDDHHmmss +ZZZZ)
///
/// Feeds differ in how they write the offset: "+0200", "+0200" with no space
/// before it, or "+02:00". All of them count. A missing or unreadable offset
/// means UTC, as the XMLTV spec says.
fn parse_xmltv_time(value: &[u8]) -> Option<DateTime<Utc>> {
    use chrono::{FixedOffset, NaiveDateTime, TimeZone};

    // Format: "20231215193000 +0100"
    let (stamp, rest) = value.split_at_checked(14)?;
    if !stamp.iter().all(u8::is_ascii_digit) {
        return None;
    }
    let naive_dt =
        NaiveDateTime::parse_from_str(std::str::from_utf8(stamp).ok()?, "%Y%m%d%H%M%S").ok()?;

    // Only the first word after the time is the offset; "+0200 CEST" counts as +0200.
    let tz = rest.trim_ascii_start();
    let tz = tz.split(u8::is_ascii_whitespace).next().unwrap_or(tz);
    if let Some(offset_minutes) = parse_tz_offset(tz) {
        if let Some(offset) = FixedOffset::east_opt(offset_minutes * 60) {
            if let Some(dt_with_tz) = offset.from_local_datetime(&naive_dt).single() {
                return Some(dt_with_tz.with_timezone(&Utc));
            }
        }
    }

    // Fallback: assume UTC
    Some(Utc.from_utc_datetime(&naive_dt))
}

/// Parse timezone offset (+0100, -0500, +01:00, etc.) into minutes
fn parse_tz_offset(tz: &[u8]) -> Option<i32> {
    let (sign, digits) = match tz {
        [b'+', rest @ ..] => (1, rest),
        [b'-', rest @ ..] => (-1, rest),
        _ => return None,
    };
    let (hh, mm) = match digits {
        [h1, h2, b':', m1, m2] | [h1, h2, m1, m2] => ([*h1, *h2], [*m1, *m2]),
        _ => return None,
    };
    let two_digits = |pair: [u8; 2]| -> Option<i32> {
        pair.iter()
            .all(u8::is_ascii_digit)
            .then(|| i32::from(pair[0] - b'0') * 10 + i32::from(pair[1] - b'0'))
    };

    Some(sign * (two_digits(hh)? * 60 + two_digits(mm)?))
}

/// Store programs in database.
///
/// Runs in one transaction: prune programmes that ended more than a day ago,
/// then upsert every programme in the feed on `(channel_epg_id, start_time)`
/// so a refresh updates titles in place instead of adding a second copy.
fn store_programs(conn: &Connection, programs: &[EpgProgram]) -> Result<usize> {
    let tx = conn.unchecked_transaction()?;

    let cutoff = Utc::now() - chrono::Duration::hours(24);
    tx.execute(
        "DELETE FROM epg_programs WHERE end_time < ?1",
        rusqlite::params![cutoff.to_rfc3339()],
    )?;

    let mut count = 0;
    {
        let mut stmt = tx.prepare_cached(
            "INSERT INTO epg_programs
             (channel_epg_id, title, description, start_time, end_time, category)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(channel_epg_id, start_time) DO UPDATE SET
                 title = excluded.title,
                 description = excluded.description,
                 end_time = excluded.end_time,
                 category = excluded.category",
        )?;

        for program in programs {
            stmt.execute(rusqlite::params![
                normalize_epg_id(&program.channel_id),
                program.title,
                program.description,
                program.start_time.to_rfc3339(),
                program.end_time.to_rfc3339(),
                program.category,
            ])?;
            count += 1;
        }
    }

    tx.commit()?;
    Ok(count)
}

/// Get current program for a channel
pub fn get_current_program(conn: &Connection, channel_epg_id: &str) -> Result<Option<String>> {
    let now = Utc::now();

    let program: Option<String> = conn
        .query_row(
            "SELECT title FROM epg_programs
             WHERE channel_epg_id = ?1
             AND start_time <= ?2
             AND end_time > ?2
             ORDER BY start_time DESC
             LIMIT 1",
            rusqlite::params![normalize_epg_id(channel_epg_id), now.to_rfc3339()],
            |row| row.get(0),
        )
        .optional()?;

    Ok(program)
}

/// Get next program for a channel
pub fn get_next_program(conn: &Connection, channel_epg_id: &str) -> Result<Option<String>> {
    let now = Utc::now();

    let program: Option<String> = conn
        .query_row(
            "SELECT title FROM epg_programs
             WHERE channel_epg_id = ?1
             AND start_time > ?2
             ORDER BY start_time ASC
             LIMIT 1",
            rusqlite::params![normalize_epg_id(channel_epg_id), now.to_rfc3339()],
            |row| row.get(0),
        )
        .optional()?;

    Ok(program)
}

/// Current and next programme for one channel, with the current programme's
/// start/end and the next programme's start as RFC 3339 strings (as stored).
#[derive(Debug, Clone, Serialize)]
pub struct ChannelEpg {
    pub current: Option<String>,
    pub current_start: Option<String>,
    pub current_end: Option<String>,
    pub next: Option<String>,
    pub next_start: Option<String>,
}

/// Look up current and next programme for many channels in one go.
///
/// Both statements are index-backed (`idx_channel_time`), so the cost is one
/// connection checkout plus two point lookups per id instead of one IPC round
/// trip per channel. Channels with neither a current nor a next programme are
/// left out of the map.
pub fn get_programs_for_channels(
    conn: &Connection,
    epg_ids: &[String],
) -> Result<HashMap<String, ChannelEpg>> {
    let now = Utc::now().to_rfc3339();

    let mut current_stmt = conn.prepare_cached(
        "SELECT title, start_time, end_time FROM epg_programs
         WHERE channel_epg_id = ?1 AND start_time <= ?2 AND end_time > ?2
         ORDER BY start_time DESC
         LIMIT 1",
    )?;
    let mut next_stmt = conn.prepare_cached(
        "SELECT title, start_time FROM epg_programs
         WHERE channel_epg_id = ?1 AND start_time > ?2
         ORDER BY start_time ASC
         LIMIT 1",
    )?;

    let mut result = HashMap::with_capacity(epg_ids.len());
    for id in epg_ids {
        if result.contains_key(id) {
            continue;
        }
        // Stored ids are normalised; the result stays keyed by the id asked for.
        let key = normalize_epg_id(id);
        let current: Option<(String, String, String)> = current_stmt
            .query_row(rusqlite::params![key, now], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })
            .optional()?;
        let next: Option<(String, String)> = next_stmt
            .query_row(rusqlite::params![key, now], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })
            .optional()?;
        if current.is_some() || next.is_some() {
            let (current, current_start, current_end) = match current {
                Some((t, s, e)) => (Some(t), Some(s), Some(e)),
                None => (None, None, None),
            };
            let (next, next_start) = match next {
                Some((t, s)) => (Some(t), Some(s)),
                None => (None, None),
            };
            result.insert(
                id.clone(),
                ChannelEpg {
                    current,
                    current_start,
                    current_end,
                    next,
                    next_start,
                },
            );
        }
    }

    Ok(result)
}

/// One row of a programme guide: title, optional synopsis and RFC 3339 start/end.
#[derive(Debug, Clone, Serialize)]
pub struct GuideProgram {
    pub title: String,
    pub description: Option<String>,
    pub start_time: String,
    pub end_time: String,
}

/// Programmes for many channels within a time window.
///
/// A programme is included if it overlaps `[from, to)` at all
/// (`end_time > from AND start_time < to`), so one already playing at `from`
/// is included while one that ends exactly at `from` or starts exactly at
/// `to` is not. `from` and `to` must already be RFC 3339 strings in the same
/// format `store_epg_programs` writes (UTC `to_rfc3339()`); callers should
/// run them through `epg_domain::validate_guide_window` first so the string
/// comparison in the SQL below is exact. Every id in `epg_ids` is a key in
/// the result, with an empty `Vec` when it has no programmes in the window.
pub fn get_guide(
    conn: &Connection,
    epg_ids: &[String],
    from: &str,
    to: &str,
) -> Result<HashMap<String, Vec<GuideProgram>>> {
    let mut stmt = conn.prepare_cached(
        "SELECT title, description, start_time, end_time FROM epg_programs
         WHERE channel_epg_id = ?1 AND end_time > ?2 AND start_time < ?3
         ORDER BY start_time",
    )?;

    let mut result = HashMap::with_capacity(epg_ids.len());
    for id in epg_ids {
        if result.contains_key(id) {
            continue;
        }
        // Stored ids are normalised; the result stays keyed by the id asked for.
        let key = normalize_epg_id(id);
        let programmes = stmt
            .query_map(rusqlite::params![key, from, to], |row| {
                Ok(GuideProgram {
                    title: row.get(0)?,
                    description: row.get(1)?,
                    start_time: row.get(2)?,
                    end_time: row.get(3)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        result.insert(id.clone(), programmes);
    }

    Ok(result)
}

/// The EPG ids with at least one programme overlapping `from`-`to`, each once.
/// Ids are stored normalized, so the answer is normalized too. The guide uses
/// it to list only channels that have something to show.
pub fn get_guide_epg_ids(conn: &Connection, from: &str, to: &str) -> Result<Vec<String>> {
    let mut stmt = conn.prepare_cached(
        "SELECT DISTINCT channel_epg_id FROM epg_programs
         WHERE end_time > ?1 AND start_time < ?2",
    )?;
    let ids = stmt
        .query_map(rusqlite::params![from, to], |row| row.get(0))?
        .collect::<rusqlite::Result<Vec<String>>>()?;
    Ok(ids)
}

// Builder struct for constructing programs
struct EpgProgramBuilder {
    channel_id: String,
    title: String,
    description: Option<String>,
    start_time: DateTime<Utc>,
    end_time: DateTime<Utc>,
    category: Option<String>,
}

impl EpgProgramBuilder {
    fn build(self) -> EpgProgram {
        EpgProgram {
            channel_id: self.channel_id,
            title: self.title,
            description: self.description,
            start_time: self.start_time,
            end_time: self.end_time,
            category: self.category,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_helpers::setup_test_db;
    use chrono::Duration;

    fn programme(channel: &str, title: &str, start: DateTime<Utc>, minutes: i64) -> EpgProgram {
        EpgProgram {
            channel_id: channel.to_string(),
            title: title.to_string(),
            description: None,
            start_time: start,
            end_time: start + Duration::minutes(minutes),
            category: None,
        }
    }

    #[test]
    fn storing_the_same_feed_twice_keeps_one_row_per_programme() {
        let conn = setup_test_db();
        let now = Utc::now();
        let feed = vec![
            programme("svt1.se", "Rapport", now - Duration::minutes(10), 30),
            programme("svt1.se", "Aktuellt", now + Duration::hours(2), 30),
            programme("tv4.se", "Nyheterna", now - Duration::minutes(5), 30),
        ];

        store_epg_programs(&conn, &feed).unwrap();
        store_epg_programs(&conn, &feed).unwrap();

        let rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM epg_programs", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 3);
    }

    #[test]
    fn a_refreshed_feed_updates_the_title_of_an_existing_slot() {
        let conn = setup_test_db();
        let start = Utc::now() + Duration::hours(1);

        store_epg_programs(&conn, &[programme("svt1.se", "Placeholder", start, 30)]).unwrap();
        store_epg_programs(&conn, &[programme("svt1.se", "Rapport", start, 45)]).unwrap();

        let (title, end): (String, String) = conn
            .query_row(
                "SELECT title, end_time FROM epg_programs WHERE channel_epg_id = 'svt1.se'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(title, "Rapport");
        assert_eq!(end, (start + Duration::minutes(45)).to_rfc3339());
    }

    #[test]
    fn programmes_that_ended_more_than_a_day_ago_are_pruned() {
        let conn = setup_test_db();
        let now = Utc::now();

        store_epg_programs(
            &conn,
            &[programme("svt1.se", "Old", now - Duration::days(2), 30)],
        )
        .unwrap();
        store_epg_programs(&conn, &[programme("svt1.se", "New", now, 30)]).unwrap();

        let titles: Vec<String> = conn
            .prepare("SELECT title FROM epg_programs ORDER BY title")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert_eq!(titles, vec!["New".to_string()]);
    }

    #[test]
    fn current_and_next_programme_lookups_use_the_stored_rows() {
        let conn = setup_test_db();
        let now = Utc::now();
        store_epg_programs(
            &conn,
            &[
                programme("svt1.se", "Rapport", now - Duration::minutes(10), 30),
                programme("svt1.se", "Aktuellt", now + Duration::minutes(20), 30),
            ],
        )
        .unwrap();

        assert_eq!(
            get_current_program(&conn, "svt1.se").unwrap().as_deref(),
            Some("Rapport")
        );
        assert_eq!(
            get_next_program(&conn, "svt1.se").unwrap().as_deref(),
            Some("Aktuellt")
        );
        assert_eq!(get_current_program(&conn, "unknown").unwrap(), None);
    }

    fn utc(value: &str) -> Option<String> {
        parse_xmltv_time(value.as_bytes()).map(|t| t.to_rfc3339())
    }

    #[test]
    fn the_offset_is_read_with_or_without_a_space_before_it() {
        let expected = Some("2026-10-20T12:00:00+00:00".to_string());
        assert_eq!(utc("20261020140000 +0200"), expected);
        assert_eq!(utc("20261020140000+0200"), expected);
        assert_eq!(utc("20261020140000  +0200"), expected);
        assert_eq!(utc("20261020140000 +02:00"), expected);
        assert_eq!(utc("20261020100000 -0200"), expected);
        assert_eq!(utc("20261020140000 +0200 CEST"), expected);
    }

    #[test]
    fn a_time_without_an_offset_is_utc() {
        assert_eq!(
            utc("20261020140000"),
            Some("2026-10-20T14:00:00+00:00".to_string())
        );
    }

    #[test]
    fn an_unreadable_offset_falls_back_to_utc() {
        assert_eq!(
            utc("20261020140000 CEST"),
            Some("2026-10-20T14:00:00+00:00".to_string())
        );
    }

    #[test]
    fn a_malformed_time_is_rejected_without_panicking() {
        assert_eq!(utc("2026102014"), None);
        assert_eq!(utc("202ö61020140000 +0200"), None);
        assert_eq!(utc("20261320140000 +0200"), None);
    }

    #[test]
    fn parse_xmltv_converts_offset_times_to_utc() {
        let xml = r#"<?xml version="1.0" encoding="UTF-8"?>
<tv>
  <channel id="svt1.se"><display-name>SVT1</display-name></channel>
  <programme start="20260902200000 +0200" stop="20260902203000 +0200" channel="svt1.se">
    <title>Rapport</title>
    <desc>Nyheter</desc>
    <category>News</category>
  </programme>
  <programme start="20260902203000 +0200" stop="20260902210000 +0200" channel="svt1.se">
    <title></title>
  </programme>
</tv>"#;

        let programs = parse_epg_bytes(xml.as_bytes()).unwrap();

        assert_eq!(programs.len(), 1, "programmes without a title are skipped");
        let p = &programs[0];
        assert_eq!(p.channel_id, "svt1.se");
        assert_eq!(p.title, "Rapport");
        assert_eq!(p.description.as_deref(), Some("Nyheter"));
        assert_eq!(p.category.as_deref(), Some("News"));
        assert_eq!(p.start_time.to_rfc3339(), "2026-09-02T18:00:00+00:00");
        assert_eq!(p.end_time.to_rfc3339(), "2026-09-02T18:30:00+00:00");
    }

    // ---- Download and parse pipeline ----

    fn feed(programmes: usize) -> Vec<u8> {
        let mut xml = String::from("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<tv>\n");
        for i in 0..programmes {
            xml += &format!(
                "<programme start=\"20261010{h:02}0000 +0200\" stop=\"20261010{h:02}5900 +0200\" channel=\"kanal{c}.se\">\
                 <title>Program {i}</title><desc>Avsnitt {i} med å, ä och ö</desc><category>Nyheter</category></programme>\n",
                h = i % 24,
                c = i % 40
            );
        }
        xml += "</tv>\n";
        xml.into_bytes()
    }

    fn gzip(bytes: &[u8]) -> Vec<u8> {
        use flate2::{write::GzEncoder, Compression};
        use std::io::Write;
        let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(bytes).unwrap();
        encoder.finish().unwrap()
    }

    fn summary(programs: &[EpgProgram]) -> Vec<(String, String, Option<String>, String)> {
        programs
            .iter()
            .map(|p| {
                (
                    p.channel_id.clone(),
                    p.title.clone(),
                    p.description.clone(),
                    p.start_time.to_rfc3339(),
                )
            })
            .collect()
    }

    #[test]
    fn gzipped_and_plain_feeds_parse_to_the_same_programmes() {
        let xml = feed(500);
        let plain = parse_epg_bytes(&xml).unwrap();
        let gzipped = parse_epg_bytes(&gzip(&xml)).unwrap();
        assert_eq!(plain.len(), 500);
        assert_eq!(summary(&plain), summary(&gzipped));
    }

    #[test]
    fn a_damaged_gzip_download_fails_as_a_whole_instead_of_giving_half_a_guide() {
        let gz = gzip(&feed(2000));
        let truncated = &gz[..gz.len() / 2];
        let mut flipped = gz.clone();
        let middle = flipped.len() / 2;
        flipped[middle] ^= 0xff;

        assert!(parse_epg_bytes(truncated).is_err(), "truncated gzip parsed");
        assert!(parse_epg_bytes(&flipped).is_err(), "corrupted gzip parsed");
    }

    #[test]
    fn malformed_xml_keeps_the_programmes_before_the_fault_gzipped_or_not() {
        let mut xml = feed(1000);
        let cut = xml.len() / 2;
        xml.splice(cut..cut, b"</oops>".iter().copied());

        let plain = parse_epg_bytes(&xml).unwrap();
        let gzipped = parse_epg_bytes(&gzip(&xml)).unwrap();

        assert!(
            !plain.is_empty() && plain.len() < 1000,
            "got {}",
            plain.len()
        );
        assert_eq!(summary(&plain), summary(&gzipped));
    }

    #[test]
    fn one_badly_encoded_title_keeps_the_programme_and_the_guide() {
        let mut xml = feed(100);
        let at = xml.windows(9).position(|w| w == b"Program 5").unwrap();
        xml[at + 1] = 0xE5; // a Latin-1 byte inside a UTF-8 feed

        for bytes in [xml.clone(), gzip(&xml)] {
            let programs = parse_epg_bytes(&bytes).unwrap();
            assert_eq!(programs.len(), 100);
            assert_eq!(programs[5].title, "P\u{fffd}ogram 5");
        }
    }

    #[test]
    fn an_empty_field_never_replaces_a_value_and_stays_none() {
        let xml = br#"<tv>
            <programme start="20260902200000 +0200" stop="20260902203000 +0200" channel="a">
              <title>First</title><title></title><title>  </title>
              <desc>Story</desc><desc> </desc><category>News</category><category/>
            </programme>
            <programme start="20260902203000 +0200" stop="20260902210000 +0200" channel="a">
              <title>Second</title><desc></desc><category>
              </category>
            </programme></tv>"#;
        for bytes in [xml.to_vec(), gzip(xml)] {
            let programs = parse_epg_bytes(&bytes).unwrap();
            assert_eq!(programs.len(), 2);
            assert_eq!(programs[0].title, "First");
            assert_eq!(programs[0].description.as_deref(), Some("Story"));
            assert_eq!(programs[0].category.as_deref(), Some("News"));
            assert_eq!(programs[1].title, "Second");
            assert_eq!(programs[1].description, None);
            assert_eq!(programs[1].category, None);
        }
    }

    #[test]
    fn a_later_title_still_replaces_an_earlier_one() {
        let xml = br#"<tv><programme start="20260902200000 +0200" stop="20260902203000 +0200" channel="a">
            <title>First</title><title>Last</title></programme></tv>"#;
        assert_eq!(parse_epg_bytes(xml).unwrap()[0].title, "Last");
    }

    #[test]
    fn entities_and_bare_ampersands_in_titles_are_kept() {
        let xml = br#"<tv><programme start="20260902200000 +0200" stop="20260902203000 +0200" channel="a">
            <title>Tom &amp; Jerry &amp friends</title><desc> Caf&eacute; &#229; </desc></programme></tv>"#;
        let programs = parse_epg_bytes(xml).unwrap();
        assert_eq!(programs[0].title, "Tom & Jerry &amp friends");
        assert_eq!(programs[0].description.as_deref(), Some("Café å"));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn parsing_leaves_the_runtime_free_for_other_tasks() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc;

        // On a current-thread runtime a sibling task only runs while the
        // parse future is pending. A parse on the runtime thread never
        // yields, so the ticker would stay at zero.
        let ticks = Arc::new(AtomicUsize::new(0));
        let counter = ticks.clone();
        let ticker = tokio::spawn(async move {
            loop {
                counter.fetch_add(1, Ordering::Relaxed);
                tokio::task::yield_now().await;
            }
        });
        tokio::task::yield_now().await;
        let before = ticks.load(Ordering::Relaxed);

        let programs = parse_epg_off_runtime(bytes::Bytes::from(gzip(&feed(20_000))))
            .await
            .unwrap();

        let during = ticks.load(Ordering::Relaxed) - before;
        ticker.abort();
        assert_eq!(programs.len(), 20_000);
        assert!(
            during > 0,
            "the runtime thread was blocked for the whole parse"
        );
    }

    #[tokio::test]
    async fn a_feed_without_programmes_is_an_error_not_an_empty_success() {
        use crate::http::test_server::{respond, serve};
        let server = serve(vec![respond("200 OK", b"<?xml version=\"1.0\"?><tv></tv>")]).await;

        let err = fetch_and_parse_epg(&format!("{}/xmltv.php", server.base), None)
            .await
            .unwrap_err();

        assert_eq!(err.to_string(), EMPTY_GUIDE_MESSAGE);
    }

    #[tokio::test]
    async fn an_error_page_is_reported_by_status_not_parsed_as_an_empty_guide() {
        use crate::http::test_server::{respond, serve};
        let server = serve(vec![respond(
            "403 Forbidden",
            b"<html><body>Forbidden</body></html>",
        )])
        .await;

        let err = fetch_and_parse_epg(&format!("{}/xmltv.php", server.base), None)
            .await
            .unwrap_err();

        assert_eq!(err.to_string(), "The EPG server answered 403 Forbidden");
    }

    #[test]
    fn batch_lookup_returns_one_entry_per_channel_with_data() {
        let conn = setup_test_db();
        let now = Utc::now();
        store_epg_programs(
            &conn,
            &[
                programme("svt1.se", "Rapport", now - Duration::minutes(10), 30),
                programme("svt1.se", "Aktuellt", now + Duration::minutes(20), 30),
                programme("tv4.se", "Nyheterna", now + Duration::hours(1), 30),
            ],
        )
        .unwrap();

        let ids = vec![
            "svt1.se".to_string(),
            "tv4.se".to_string(),
            "svt1.se".to_string(), // duplicate ids are fine
            "unknown".to_string(),
        ];
        let result = get_programs_for_channels(&conn, &ids).unwrap();

        assert_eq!(
            result.len(),
            2,
            "channels without any programme are omitted"
        );
        let svt1 = &result["svt1.se"];
        assert_eq!(svt1.current.as_deref(), Some("Rapport"));
        assert_eq!(svt1.next.as_deref(), Some("Aktuellt"));
        let tv4 = &result["tv4.se"];
        assert_eq!(tv4.current, None);
        assert_eq!(tv4.next.as_deref(), Some("Nyheterna"));
    }

    #[test]
    fn batch_lookup_returns_times_for_current_and_next() {
        let conn = setup_test_db();
        let now = Utc::now();
        let current_start = now - Duration::minutes(10);
        let next_start = now + Duration::minutes(20);
        store_epg_programs(
            &conn,
            &[
                programme("svt1.se", "Rapport", current_start, 30),
                programme("svt1.se", "Aktuellt", next_start, 30),
            ],
        )
        .unwrap();

        let map = get_programs_for_channels(&conn, &["svt1.se".to_string()]).unwrap();
        let epg = map.get("svt1.se").unwrap();
        assert_eq!(epg.current.as_deref(), Some("Rapport"));
        assert_eq!(
            epg.current_start.as_deref(),
            Some(current_start.to_rfc3339().as_str())
        );
        assert_eq!(
            epg.current_end.as_deref(),
            Some(
                (current_start + Duration::minutes(30))
                    .to_rfc3339()
                    .as_str()
            )
        );
        assert_eq!(epg.next.as_deref(), Some("Aktuellt"));
        assert_eq!(
            epg.next_start.as_deref(),
            Some(next_start.to_rfc3339().as_str())
        );
    }

    #[test]
    fn batch_lookup_with_only_a_next_programme_has_no_current_times() {
        let conn = setup_test_db();
        let now = Utc::now();
        store_epg_programs(
            &conn,
            &[programme("tv4.se", "Later", now + Duration::hours(1), 30)],
        )
        .unwrap();
        let map = get_programs_for_channels(&conn, &["tv4.se".to_string()]).unwrap();
        let epg = map.get("tv4.se").unwrap();
        assert!(epg.current.is_none() && epg.current_start.is_none() && epg.current_end.is_none());
        assert_eq!(epg.next.as_deref(), Some("Later"));
    }

    #[test]
    fn guide_epg_ids_lists_each_id_with_an_overlapping_programme_once() {
        let conn = setup_test_db();
        let from = Utc::now();
        let to = from + Duration::days(5);

        store_epg_programs(
            &conn,
            &[
                programme("svt1.se", "Rapport", from + Duration::hours(1), 30),
                programme("svt1.se", "Aktuellt", from + Duration::hours(3), 30),
                // Overlaps the start of the range.
                programme("tv4.se", "Nyheterna", from - Duration::minutes(10), 30),
                // Ends exactly at `from` / starts exactly at `to`: not inside.
                programme("kanal5.se", "Ended", from - Duration::minutes(30), 30),
                programme("tv6.se", "Later", to, 30),
            ],
        )
        .unwrap();

        let mut ids = get_guide_epg_ids(&conn, &from.to_rfc3339(), &to.to_rfc3339()).unwrap();
        ids.sort();
        assert_eq!(ids, vec!["svt1.se".to_string(), "tv4.se".to_string()]);
    }

    #[test]
    fn guide_epg_ids_returns_the_stored_normalized_form() {
        let conn = setup_test_db();
        let from = Utc::now();
        store_epg_programs(
            &conn,
            &[programme(
                " SVT1.se ",
                "Rapport",
                from + Duration::hours(1),
                30,
            )],
        )
        .unwrap();

        let ids = get_guide_epg_ids(
            &conn,
            &from.to_rfc3339(),
            &(from + Duration::days(1)).to_rfc3339(),
        )
        .unwrap();
        assert_eq!(ids, vec!["svt1.se".to_string()]);
    }

    #[test]
    fn guide_includes_overlapping_and_excludes_boundary_touching_programmes() {
        let conn = setup_test_db();
        let from = Utc::now();
        let to = from + Duration::hours(2);

        store_epg_programs(
            &conn,
            &[
                // Starts before the window and ends after `from`: overlaps the start.
                programme("svt1.se", "Overlap", from - Duration::minutes(30), 45),
                // Fully inside the window; stored out of chronological order.
                programme("svt1.se", "Second", from + Duration::minutes(30), 30),
                programme("svt1.se", "First", from + Duration::minutes(5), 10),
                // Ends exactly at `from`: must be excluded.
                programme("svt1.se", "EndsAtFrom", from - Duration::minutes(20), 20),
                // Starts exactly at `to`: must be excluded.
                programme("svt1.se", "StartsAtTo", to, 30),
            ],
        )
        .unwrap();

        let result = get_guide(
            &conn,
            &["svt1.se".to_string()],
            &from.to_rfc3339(),
            &to.to_rfc3339(),
        )
        .unwrap();

        let titles: Vec<&str> = result["svt1.se"].iter().map(|p| p.title.as_str()).collect();
        assert_eq!(
            titles,
            vec!["Overlap", "First", "Second"],
            "boundary-touching programmes are excluded and results are ordered by start"
        );
    }

    #[test]
    fn guide_isolates_channels_and_gives_empty_vec_for_ids_without_programmes() {
        let conn = setup_test_db();
        let from = Utc::now();
        let to = from + Duration::hours(2);

        store_epg_programs(
            &conn,
            &[
                programme("svt1.se", "Rapport", from + Duration::minutes(5), 30),
                programme("tv4.se", "Nyheterna", from + Duration::minutes(10), 20),
            ],
        )
        .unwrap();

        let result = get_guide(
            &conn,
            &[
                "svt1.se".to_string(),
                "tv4.se".to_string(),
                "unknown.se".to_string(),
            ],
            &from.to_rfc3339(),
            &to.to_rfc3339(),
        )
        .unwrap();

        let svt1: Vec<&str> = result["svt1.se"].iter().map(|p| p.title.as_str()).collect();
        let tv4: Vec<&str> = result["tv4.se"].iter().map(|p| p.title.as_str()).collect();
        assert_eq!(
            svt1,
            vec!["Rapport"],
            "other channels' programmes do not leak in"
        );
        assert_eq!(tv4, vec!["Nyheterna"]);
        assert!(
            result["unknown.se"].is_empty(),
            "an id without programmes still maps to an empty vec"
        );
    }
    #[test]
    fn batch_lookup_matches_ids_regardless_of_case() {
        let conn = setup_test_db();
        let now = Utc::now();
        store_epg_programs(
            &conn,
            &[programme(
                "svt1.se",
                "Rapport",
                now - Duration::minutes(10),
                30,
            )],
        )
        .unwrap();

        let map = get_programs_for_channels(&conn, &["SVT1.se".to_string()]).unwrap();
        // Keyed by the id the caller asked with, so the frontend finds it.
        let epg = map
            .get("SVT1.se")
            .expect("upper-case id finds lower-case feed");
        assert_eq!(epg.current.as_deref(), Some("Rapport"));
    }

    #[test]
    fn stored_ids_are_normalised_so_a_mixed_case_feed_matches_lower_case_channels() {
        let conn = setup_test_db();
        let now = Utc::now();
        store_epg_programs(
            &conn,
            &[programme(
                "SVT2.se",
                "Babel",
                now - Duration::minutes(5),
                30,
            )],
        )
        .unwrap();

        let map = get_programs_for_channels(&conn, &["svt2.se".to_string()]).unwrap();
        assert_eq!(
            map.get("svt2.se").and_then(|e| e.current.as_deref()),
            Some("Babel")
        );
        assert_eq!(
            get_current_program(&conn, "Svt2.Se").unwrap().as_deref(),
            Some("Babel")
        );
    }

    #[test]
    fn next_programme_lookup_ignores_case() {
        let conn = setup_test_db();
        let now = Utc::now();
        store_epg_programs(
            &conn,
            &[programme(
                "tv4.se",
                "Nyheterna",
                now + Duration::minutes(20),
                30,
            )],
        )
        .unwrap();
        assert_eq!(
            get_next_program(&conn, "TV4.se").unwrap().as_deref(),
            Some("Nyheterna")
        );
    }

    #[test]
    fn guide_lookup_ignores_case_and_keys_by_requested_id() {
        let conn = setup_test_db();
        let now = Utc::now();
        store_epg_programs(
            &conn,
            &[programme(
                "svt1.se",
                "Rapport",
                now - Duration::minutes(10),
                30,
            )],
        )
        .unwrap();
        let from = (now - Duration::hours(1)).to_rfc3339();
        let to = (now + Duration::hours(1)).to_rfc3339();

        let guide = get_guide(&conn, &["SVT1.se".to_string()], &from, &to).unwrap();
        let rows = guide.get("SVT1.se").expect("keyed by the requested id");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].title, "Rapport");
    }
}
