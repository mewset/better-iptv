use crate::http::get_http_client;
use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use flate2::read::GzDecoder;
use log::{debug, info, warn};
use quick_xml::events::Event;
use quick_xml::Reader;
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::io::Read;
use std::time::Instant;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EpgProgram {
    pub channel_id: String,
    pub title: String,
    pub description: Option<String>,
    pub start_time: DateTime<Utc>,
    pub end_time: DateTime<Utc>,
    pub category: Option<String>,
}

/// Fetch and parse XMLTV EPG data from a URL (async part)
pub async fn fetch_and_parse_epg(url: &str, user_agent: Option<&str>) -> Result<Vec<EpgProgram>> {
    let start = Instant::now();
    info!("Fetching EPG from: {}", url);

    // Download EPG file using shared HTTP client
    let request = get_http_client().get(url);
    let request = if let Some(ua) = user_agent.filter(|ua| !ua.trim().is_empty()) {
        request.header(reqwest::header::USER_AGENT, ua)
    } else {
        request
    };

    let response = request
        .send()
        .await
        .context("Failed to download EPG file")?;

    let bytes = response.bytes().await.context("Failed to read EPG response")?;

    // Check if it's gzipped based on URL or magic bytes
    let xml_content = if url.ends_with(".gz") || is_gzipped(&bytes) {
        decompress_gzip(&bytes)?
    } else {
        String::from_utf8(bytes.to_vec()).context("Invalid UTF-8 in EPG file")?
    };

    debug!("EPG fetch completed in {:?}", start.elapsed());

    let parse_start = Instant::now();
    let programs = parse_xmltv(&xml_content)?;
    debug!("EPG parse completed in {:?}: {} programs", parse_start.elapsed(), programs.len());

    info!("Parsed {} EPG programs from XMLTV", programs.len());
    Ok(programs)
}

/// Store EPG programs in database (sync part)
pub fn store_epg_programs(conn: &Connection, programs: &[EpgProgram]) -> Result<usize> {
    let start = Instant::now();
    let count = store_programs(conn, programs)?;
    debug!("EPG store completed in {:?}: {} programs", start.elapsed(), count);
    info!("Stored {} EPG programs in database", count);
    Ok(count)
}

/// Check if bytes are gzipped (magic bytes: 1f 8b)
fn is_gzipped(bytes: &[u8]) -> bool {
    bytes.len() >= 2 && bytes[0] == 0x1f && bytes[1] == 0x8b
}

/// Decompress gzip data
fn decompress_gzip(bytes: &[u8]) -> Result<String> {
    let mut decoder = GzDecoder::new(bytes);
    let mut decompressed = String::new();
    decoder
        .read_to_string(&mut decompressed)
        .context("Failed to decompress gzipped EPG")?;
    Ok(decompressed)
}

/// Parse XMLTV format
fn parse_xmltv(xml: &str) -> Result<Vec<EpgProgram>> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);

    // Pre-allocate with estimated capacity (typical EPG has 5k-50k programs)
    let mut programs = Vec::with_capacity(10_000);
    let mut buf = Vec::with_capacity(1024);

    let mut current_program: Option<EpgProgramBuilder> = None;
    let mut in_title = false;
    let mut in_desc = false;
    let mut in_category = false;

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(ref e)) => {
                match e.name().as_ref() {
                    b"programme" => {
                        let mut channel_id = String::new();
                        let mut start_time = None;
                        let mut end_time = None;

                        for attr in e.attributes().flatten() {
                            match attr.key.as_ref() {
                                b"channel" => {
                                    channel_id = String::from_utf8_lossy(&attr.value).to_string();
                                }
                                b"start" => {
                                    start_time = parse_xmltv_time(&attr.value);
                                }
                                b"stop" => {
                                    end_time = parse_xmltv_time(&attr.value);
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
                    b"title" => in_title = true,
                    b"desc" => in_desc = true,
                    b"category" => in_category = true,
                    _ => {}
                }
            }
            Ok(Event::Text(e)) => {
                if let Some(ref mut prog) = current_program {
                    let text = e.unescape().unwrap_or_default().to_string();
                    if in_title {
                        prog.title = text;
                    } else if in_desc {
                        prog.description = Some(text);
                    } else if in_category {
                        prog.category = Some(text);
                    }
                }
            }
            Ok(Event::End(ref e)) => {
                match e.name().as_ref() {
                    b"programme" => {
                        if let Some(prog) = current_program.take() {
                            if !prog.title.is_empty() {
                                programs.push(prog.build());
                            }
                        }
                    }
                    b"title" => in_title = false,
                    b"desc" => in_desc = false,
                    b"category" => in_category = false,
                    _ => {}
                }
            }
            Ok(Event::Eof) => break,
            Err(e) => {
                warn!("XML parsing error: {}", e);
                break;
            }
            _ => {}
        }
        buf.clear();
    }

    Ok(programs)
}

/// Parse XMLTV timestamp format (YYYYMMDDHHmmss +ZZZZ)
fn parse_xmltv_time(value: &[u8]) -> Option<DateTime<Utc>> {
    let time_str = String::from_utf8_lossy(value);

    // Format: "20231215193000 +0100"
    if time_str.len() < 14 {
        return None;
    }

    let year: i32 = time_str[0..4].parse().ok()?;
    let month: u32 = time_str[4..6].parse().ok()?;
    let day: u32 = time_str[6..8].parse().ok()?;
    let hour: u32 = time_str[8..10].parse().ok()?;
    let minute: u32 = time_str[10..12].parse().ok()?;
    let second: u32 = time_str[12..14].parse().ok()?;

    use chrono::{NaiveDate, NaiveDateTime, NaiveTime, TimeZone};

    let date = NaiveDate::from_ymd_opt(year, month, day)?;
    let time = NaiveTime::from_hms_opt(hour, minute, second)?;
    let naive_dt = NaiveDateTime::new(date, time);

    // Parse timezone offset if present
    if time_str.len() >= 20 {
        let tz_part = time_str[15..20].trim();
        if let Ok(offset_minutes) = parse_tz_offset(tz_part) {
            use chrono::FixedOffset;
            if let Some(offset) = FixedOffset::east_opt(offset_minutes * 60) {
                if let Some(dt_with_tz) = offset.from_local_datetime(&naive_dt).single() {
                    return Some(dt_with_tz.with_timezone(&Utc));
                }
            }
        }
    }

    // Fallback: assume UTC
    Some(Utc.from_utc_datetime(&naive_dt))
}

/// Parse timezone offset (+0100, -0500, etc.)
fn parse_tz_offset(tz_str: &str) -> Result<i32, ()> {
    if tz_str.len() != 5 {
        return Err(());
    }

    let sign = if tz_str.starts_with('+') { 1 } else if tz_str.starts_with('-') { -1 } else { return Err(()); };

    let hours: i32 = tz_str[1..3].parse().map_err(|_| ())?;
    let minutes: i32 = tz_str[3..5].parse().map_err(|_| ())?;

    Ok(sign * (hours * 60 + minutes))
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
                program.channel_id,
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
            rusqlite::params![channel_epg_id, now.to_rfc3339()],
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
            rusqlite::params![channel_epg_id, now.to_rfc3339()],
            |row| row.get(0),
        )
        .optional()?;

    Ok(program)
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

        store_epg_programs(&conn, &[programme("svt1.se", "Old", now - Duration::days(2), 30)]).unwrap();
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

        assert_eq!(get_current_program(&conn, "svt1.se").unwrap().as_deref(), Some("Rapport"));
        assert_eq!(get_next_program(&conn, "svt1.se").unwrap().as_deref(), Some("Aktuellt"));
        assert_eq!(get_current_program(&conn, "unknown").unwrap(), None);
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

        let programs = parse_xmltv(xml).unwrap();

        assert_eq!(programs.len(), 1, "programmes without a title are skipped");
        let p = &programs[0];
        assert_eq!(p.channel_id, "svt1.se");
        assert_eq!(p.title, "Rapport");
        assert_eq!(p.description.as_deref(), Some("Nyheter"));
        assert_eq!(p.category.as_deref(), Some("News"));
        assert_eq!(p.start_time.to_rfc3339(), "2026-09-02T18:00:00+00:00");
        assert_eq!(p.end_time.to_rfc3339(), "2026-09-02T18:30:00+00:00");
    }
}
