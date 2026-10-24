use crate::db::models::Channel;
use crate::http::{download_error, ensure_success, get_http_client, BULK_DOWNLOAD_TIMEOUT};
use crate::series_domain;
use anyhow::{Context, Result};
use reqwest::header::USER_AGENT;
use std::collections::HashMap;
use std::time::Instant;

/// Simple M3U playlist parser
pub async fn parse_m3u(source: &str, user_agent: Option<&str>) -> Result<Vec<Channel>> {
    let content = if source.starts_with("http://") || source.starts_with("https://") {
        // Download from URL using shared HTTP client. A large playlist can
        // take minutes on a slow line; the client's stall timeout still ends
        // a dead connection early.
        const SERVER: &str = "playlist server";
        let deadline = BULK_DOWNLOAD_TIMEOUT;
        let started = Instant::now();
        let request = get_http_client().get(source).timeout(deadline);
        let request = if let Some(ua) = user_agent.filter(|ua| !ua.trim().is_empty()) {
            request.header(USER_AGENT, ua)
        } else {
            request
        };

        let response = request
            .send()
            .await
            .map_err(|e| download_error(e, SERVER, started, deadline))?;
        ensure_success(response, SERVER)?
            .text()
            .await
            .map_err(|e| download_error(e, SERVER, started, deadline))?
    } else {
        // Read from file without blocking the async worker
        tokio::fs::read_to_string(source)
            .await
            .context("Failed to read M3U file")?
    };

    // Parsing a multi-megabyte playlist is CPU work; keep it off the runtime.
    tokio::task::spawn_blocking(move || parse_m3u_content(&content))
        .await
        .context("M3U parse task failed")?
}

/// Parse M3U content string
fn parse_m3u_content(content: &str) -> Result<Vec<Channel>> {
    let mut channels = Vec::new();
    let mut current_info: Option<HashMap<String, String>> = None;
    let mut idx = 0;

    for line in content.lines() {
        let line = line.trim();

        if line.is_empty() || line.starts_with("##") {
            continue;
        }

        if line.starts_with("#EXTM3U") {
            // Playlist header, skip
            continue;
        }

        if line.starts_with("#EXTINF:") {
            // Parse channel info
            current_info = Some(parse_extinf_line(line));
        } else if line.starts_with("#EXT") {
            // Other extended directives, skip for now
            continue;
        } else if !line.starts_with('#') {
            // This is a URL line
            if let Some(info) = current_info.take() {
                channels.push(create_channel_from_info(info, line.to_string(), idx));
                idx += 1;
            }
        }
    }

    Ok(channels)
}

/// Parse #EXTINF line into its attributes plus the title under `name`
///
/// Format: #EXTINF:duration tvg-id="..." group-title="...",Channel Name
/// The title starts at the first comma outside double quotes, so quoted
/// values may hold spaces and commas, and the title may hold commas.
fn parse_extinf_line(line: &str) -> HashMap<String, String> {
    let line = line.strip_prefix("#EXTINF:").unwrap_or(line);
    let (header, title) = split_title(line);

    let mut info = parse_attributes(header);
    if let Some(title) = title {
        info.insert("name".to_string(), title.trim().to_string());
    }
    info
}

/// Split at the first comma outside double quotes
fn split_title(line: &str) -> (&str, Option<&str>) {
    let mut in_quotes = false;
    for (i, c) in line.char_indices() {
        match c {
            '"' => in_quotes = !in_quotes,
            ',' if !in_quotes => return (&line[..i], Some(&line[i + 1..])),
            _ => {}
        }
    }
    (line, None)
}

/// Read `key="value"` and `key=value` pairs; words without `=` (the duration) are skipped
fn parse_attributes(header: &str) -> HashMap<String, String> {
    let mut attrs = HashMap::new();
    let mut rest = header;

    while let Some(eq) = rest.find('=') {
        let key = rest[..eq].rsplit(char::is_whitespace).next().unwrap_or("");
        let after = &rest[eq + 1..];
        let (value, remainder) = match after.strip_prefix('"') {
            Some(quoted) => quoted.split_once('"').unwrap_or((quoted, "")),
            None => after.split_once(char::is_whitespace).unwrap_or((after, "")),
        };
        if !key.is_empty() {
            attrs.insert(key.to_string(), value.to_string());
        }
        rest = remainder;
    }

    attrs
}

/// Create Channel from parsed info
fn create_channel_from_info(info: HashMap<String, String>, url: String, idx: usize) -> Channel {
    let name = info
        .get("name")
        .cloned()
        .unwrap_or_else(|| "Unknown".to_string());
    let logo = info.get("tvg-logo").cloned();
    let group_name = info.get("group-title").cloned();
    let epg_id = info.get("tvg-id").cloned();
    let tvg_name = info.get("tvg-name").cloned();
    let content_type = determine_content_type(&name, &group_name, &url);

    Channel {
        id: None,
        playlist_id: 0, // Will be set when inserting to database
        name,
        url,
        logo,
        group_name,
        epg_id,
        tvg_name,
        content_type,
        is_favorite: false,
        sort_order: idx as i32,
        category_order: 0, // M3U files don't have category ordering, use 0
        created_at: None,
    }
}

/// Determine content type from M3U entry (live, vod, series)
///
/// Group-name keywords and provider URL paths decide first. Otherwise a URL
/// that points at a video file is on demand: a series episode when the name
/// has an episode marker, a movie when it does not. Everything else is live.
fn determine_content_type(name: &str, group_name: &Option<String>, url: &str) -> String {
    if let Some(group) = group_name {
        let group_lower = group.to_lowercase();
        if group_lower.contains("vod")
            || group_lower.contains("movie")
            || group_lower.contains("film")
        {
            return "vod".to_string();
        }
        if group_lower.contains("series")
            || group_lower.contains("show")
            || group_lower.contains("tv show")
        {
            return "series".to_string();
        }
    }

    // Check URL patterns
    let url_lower = url.to_lowercase();
    if url_lower.contains("/vod/") || url_lower.contains("/movie/") {
        return "vod".to_string();
    }
    if url_lower.contains("/series/") || url_lower.contains("/show/") {
        return "series".to_string();
    }

    if series_domain::is_video_file(url) {
        let is_episode = series_domain::parse_episode_name(name, group_name.as_deref()).is_some();
        return if is_episode { "series" } else { "vod" }.to_string();
    }

    "live".to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_m3u_content() {
        let content = r#"#EXTM3U
#EXTINF:-1 tvg-id="test1" tvg-name="Test Channel 1" tvg-logo="http://logo.png" group-title="News",Test Channel 1
http://stream.test.com/channel1.m3u8
#EXTINF:-1 tvg-id="test2" group-title="Sports",Test Channel 2
http://stream.test.com/channel2.m3u8
"#;

        let channels = parse_m3u_content(content).unwrap();
        assert_eq!(channels.len(), 2);
        assert_eq!(channels[0].name, "Test Channel 1");
        assert_eq!(channels[0].tvg_name.as_deref(), Some("Test Channel 1"));
        assert_eq!(channels[0].url, "http://stream.test.com/channel1.m3u8");
        assert_eq!(channels[1].name, "Test Channel 2");
    }

    #[test]
    fn a_quoted_attribute_keeps_its_spaces() {
        let info = parse_extinf_line(
            r#"#EXTINF:-1 tvg-name="Action Movies HD" group-title="Action Movies",Die Hard"#,
        );
        assert_eq!(info["tvg-name"], "Action Movies HD");
        assert_eq!(info["group-title"], "Action Movies");
        assert_eq!(info["name"], "Die Hard");
    }

    #[test]
    fn a_group_with_a_space_still_decides_the_content_type() {
        let content =
            "#EXTM3U\n#EXTINF:-1 group-title=\"Action Movies\",Die Hard\nhttp://proxy.example/42\n";
        let channels = parse_m3u_content(content).unwrap();
        assert_eq!(channels[0].group_name.as_deref(), Some("Action Movies"));
        assert_eq!(channels[0].content_type, "vod");
    }

    #[test]
    fn a_comma_inside_quotes_does_not_end_the_attributes() {
        let info = parse_extinf_line(
            r#"#EXTINF:-1 tvg-logo="http://img.example/a,b.png" group-title="Movies, Classic",Casablanca"#,
        );
        assert_eq!(info["tvg-logo"], "http://img.example/a,b.png");
        assert_eq!(info["group-title"], "Movies, Classic");
        assert_eq!(info["name"], "Casablanca");
    }

    #[test]
    fn a_comma_in_the_title_is_part_of_the_title() {
        let info = parse_extinf_line(r#"#EXTINF:-1 group-title="Series",Dexter, Season 1"#);
        assert_eq!(info["name"], "Dexter, Season 1");
    }

    #[test]
    fn an_unquoted_attribute_value_ends_at_whitespace() {
        let info = parse_extinf_line("#EXTINF:-1 tvg-id=svt1.se group-title=News,SVT1");
        assert_eq!(info["tvg-id"], "svt1.se");
        assert_eq!(info["group-title"], "News");
        assert_eq!(info["name"], "SVT1");
    }

    #[test]
    fn a_line_without_attributes_has_only_a_name() {
        let info = parse_extinf_line("#EXTINF:-1,Plain Channel");
        assert_eq!(info.len(), 1);
        assert_eq!(info["name"], "Plain Channel");
    }

    #[test]
    fn a_line_without_a_comma_has_no_name() {
        let info = parse_extinf_line(r#"#EXTINF:-1 tvg-id="x""#);
        assert_eq!(info["tvg-id"], "x");
        assert!(!info.contains_key("name"));

        let content = "#EXTM3U\n#EXTINF:-1 tvg-id=\"x\"\nhttp://example.com/1.ts\n";
        assert_eq!(parse_m3u_content(content).unwrap()[0].name, "Unknown");
    }

    #[test]
    fn test_determine_content_type() {
        assert_eq!(
            determine_content_type("A", &Some("VOD Movies".to_string()), "http://test.com"),
            "vod"
        );
        assert_eq!(
            determine_content_type("A", &Some("TV Series".to_string()), "http://test.com"),
            "series"
        );
        assert_eq!(
            determine_content_type("A", &Some("Live TV".to_string()), "http://test.com"),
            "live"
        );
        assert_eq!(
            determine_content_type("A", &None, "http://test.com/vod/movie.m3u8"),
            "vod"
        );
    }

    #[test]
    fn a_video_file_without_an_episode_marker_is_a_movie() {
        let group = Some("1910s & Earlier".to_string());
        assert_eq!(
            determine_content_type(
                "Cabiria (1914)",
                &group,
                "https://s3.us.archive.org/Cabiria/CabiriagiovanniPastrone1914.mp4"
            ),
            "vod"
        );
    }

    #[test]
    fn a_video_file_with_an_episode_marker_is_a_series() {
        let group = Some("Dexter".to_string());
        assert_eq!(
            determine_content_type(
                "Dexter New Blood S01E03 (2021)",
                &group,
                "http://host/media/dexter-new-blood-s01e03.mkv"
            ),
            "series"
        );
    }

    #[test]
    fn a_stream_with_an_episode_like_name_stays_live() {
        let group = Some("Entertainment".to_string());
        assert_eq!(
            determine_content_type("Friends S01E01 Marathon", &group, "http://host/live/1.m3u8"),
            "live"
        );
        assert_eq!(
            determine_content_type("News 24x7", &group, "http://host/news.mp4"),
            "vod"
        );
    }

    #[test]
    fn episodes_found_by_their_file_are_grouped_into_one_series() {
        let content = "#EXTM3U
#EXTINF:-1 group-title=\"Dexter\",Dexter New Blood S01E01 (2021)
http://host/media/dnb-s01e01.mkv
#EXTINF:-1 group-title=\"Dexter\",Dexter New Blood S01E02 (2021)
http://host/media/dnb-s01e02.mkv
";
        let channels = parse_m3u_content(content).unwrap();
        let grouped = crate::series_domain::group_series(channels);

        assert!(grouped.plain.is_empty());
        assert_eq!(grouped.series.len(), 1);
        assert_eq!(grouped.series[0].channel.name, "Dexter New Blood");
        assert_eq!(grouped.series[0].episodes.len(), 2);
    }

    #[tokio::test]
    async fn an_error_page_is_reported_by_status_not_parsed_as_an_empty_playlist() {
        use crate::http::test_server::{respond, serve};
        let server = serve(vec![respond(
            "403 Forbidden",
            b"<html>Account expired</html>",
        )])
        .await;

        let err = parse_m3u(
            &format!("{}/get.php?username=john&password=secret", server.base),
            None,
        )
        .await
        .unwrap_err();

        assert_eq!(
            err.to_string(),
            "The playlist server answered 403 Forbidden"
        );
    }

    #[tokio::test]
    async fn a_downloaded_playlist_is_parsed() {
        use crate::http::test_server::{respond, serve};
        let body = b"#EXTM3U\n#EXTINF:-1 group-title=\"News\",SVT1\nhttp://example.com/live/1.ts\n";
        let server = serve(vec![respond("200 OK", body)]).await;

        let channels = parse_m3u(&format!("{}/list.m3u", server.base), None)
            .await
            .unwrap();

        assert_eq!(channels.len(), 1);
        assert_eq!(channels[0].name, "SVT1");
    }
}
