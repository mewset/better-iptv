use crate::db::models::Channel;
use crate::http::get_http_client;
use anyhow::{Context, Result};
use reqwest::header::USER_AGENT;
use std::collections::HashMap;

/// Simple M3U playlist parser
pub async fn parse_m3u(source: &str, user_agent: Option<&str>) -> Result<Vec<Channel>> {
    let content = if source.starts_with("http://") || source.starts_with("https://") {
        // Download from URL using shared HTTP client
        let request = get_http_client().get(source);
        let request = if let Some(ua) = user_agent.filter(|ua| !ua.trim().is_empty()) {
            request.header(USER_AGENT, ua)
        } else {
            request
        };

        request
            .send()
            .await
            .context("Failed to download M3U playlist")?
            .text()
            .await
            .context("Failed to read M3U content")?
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

/// Parse #EXTINF line
fn parse_extinf_line(line: &str) -> HashMap<String, String> {
    let mut info = HashMap::new();

    // Format: #EXTINF:duration tvg-id="..." tvg-name="..." tvg-logo="..." group-title="...",Channel Name
    // Extract attributes
    if let Some(attrs_part) = line.split(',').next() {
        for attr in attrs_part.split_whitespace() {
            if let Some((key, value)) = attr.split_once('=') {
                let value = value.trim_matches('"');
                info.insert(key.to_string(), value.to_string());
            }
        }
    }

    // Extract channel name (after last comma)
    if let Some(name) = line.split(',').next_back() {
        info.insert("name".to_string(), name.trim().to_string());
    }

    info
}

/// Create Channel from parsed info
fn create_channel_from_info(info: HashMap<String, String>, url: String, idx: usize) -> Channel {
    let name = info.get("name").cloned().unwrap_or_else(|| "Unknown".to_string());
    let logo = info.get("tvg-logo").cloned();
    let group_name = info.get("group-title").cloned();
    let epg_id = info.get("tvg-id").cloned();
    let tvg_name = info.get("tvg-name").cloned();
    let content_type = determine_content_type(&group_name, &url);

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
fn determine_content_type(group_name: &Option<String>, url: &str) -> String {
    if let Some(group) = group_name {
        let group_lower = group.to_lowercase();
        if group_lower.contains("vod") || group_lower.contains("movie") || group_lower.contains("film") {
            return "vod".to_string();
        }
        if group_lower.contains("series") || group_lower.contains("show") || group_lower.contains("tv show") {
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
        assert_eq!(channels[0].url, "http://stream.test.com/channel1.m3u8");
        assert_eq!(channels[1].name, "Test Channel 2");
    }

    #[test]
    fn test_determine_content_type() {
        assert_eq!(determine_content_type(&Some("VOD Movies".to_string()), "http://test.com"), "vod");
        assert_eq!(determine_content_type(&Some("TV Series".to_string()), "http://test.com"), "series");
        assert_eq!(determine_content_type(&Some("Live TV".to_string()), "http://test.com"), "live");
        assert_eq!(determine_content_type(&None, "http://test.com/vod/movie.m3u8"), "vod");
    }
}
