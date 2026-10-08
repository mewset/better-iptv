//! Utility functions shared across modules

use lazy_static::lazy_static;
use regex::Regex;

lazy_static! {
    // Key/value pairs: `?username=X`, `&password=X`, but also `username=X` in a free-form log
    // line. The value stops at the next separator or closing bracket so that text after a URL
    // (user agent, attempt counter, reqwest's closing parenthesis) survives
    static ref KEY_VALUE_RE: Regex =
        Regex::new(r#"(?i)(username|password)=[^&\s,;)\]}'"]*"#).unwrap();

    // The same pair as JSON fields, e.g. a serialised Playlist with `"xtream_password":"secret"`
    static ref JSON_FIELD_RE: Regex =
        Regex::new(r#"(?i)("(?:xtream_)?(?:username|password)"\s*:\s*)"[^"]*""#).unwrap();

    // Path-based Xtream URLs: scheme://host/live|series|movie/USER/PASS/ — anchored to the URL
    // authority so that filesystem paths with a `movie` or `series` folder are left alone
    static ref PATH_CREDENTIALS_RE: Regex =
        Regex::new(r"(://[^/\s]+)/(live|series|movie)/[^/\s]+/[^/\s]+/").unwrap();

    // Userinfo in the authority: scheme://USER:PASS@host or scheme://USER@host
    static ref USERINFO_RE: Regex = Regex::new(r"(://)[^/@\s:]+(:[^/@\s]*)?@").unwrap();
}

/// Mask credentials in URLs for safe logging
///
/// Handles these credential formats:
/// 1. Query parameters or key/value pairs: `?username=X&password=Y`, `username=X`
/// 2. JSON fields: `"xtream_password":"Y"`
/// 3. Path-based (Xtream): `/series/USERNAME/PASSWORD/12345.mp4`
/// 4. Userinfo: `http://USERNAME:PASSWORD@server.com/`
///
/// Also safe to run on whole log lines or error messages that embed a URL; the log formatter
/// in `lib.rs` runs it on every record, so it only allocates when something matched.
///
/// # Examples
///
/// Query parameters:
/// - `http://server.com/xmltv.php?username=john&password=secret`
/// - becomes: `http://server.com/xmltv.php?username=****&password=****`
///
/// Path-based Xtream URLs:
/// - `http://server.com/series/john/secret/12345.mp4`
/// - becomes: `http://server.com/series/****/****/12345.mp4`
pub fn mask_credentials(url: &str) -> String {
    let masked = KEY_VALUE_RE.replace_all(url, "${1}=****");
    let masked = JSON_FIELD_RE.replace_all(&masked, "${1}\"****\"");
    let masked = PATH_CREDENTIALS_RE.replace_all(&masked, "$1/$2/****/****/");
    let masked = USERINFO_RE.replace_all(&masked, "${1}****:****@");
    masked.into_owned()
}

/// Country code configuration for EPG ID generation
/// Can be extended to support more countries
#[derive(Debug, Clone, Default)]
pub struct EpgConfig {
    pub country_suffix: String,
    pub country_code: String,
}

impl EpgConfig {
    /// Create config for Swedish channels (default)
    pub fn swedish() -> Self {
        Self {
            country_suffix: " SE".to_string(),
            country_code: "se".to_string(),
        }
    }
}

/// Generate EPG ID from channel name
///
/// Examples:
/// - "SVT1 HD SE" -> "SVT1 HD.se"
/// - "TV4 FHD SE" -> "TV4.se"
/// - "Discovery Channel" -> None (not a Swedish channel)
///
/// # Arguments
/// * `channel_name` - The full channel name
/// * `config` - EPG configuration with country settings
pub fn generate_epg_id(channel_name: &str, config: &EpgConfig) -> Option<String> {
    // Check if channel matches the configured country
    let is_target_country = channel_name.ends_with(&config.country_suffix)
        || channel_name.ends_with(&format!(" FHD{}", config.country_suffix))
        || channel_name.ends_with(&format!(" HD{}", config.country_suffix))
        || channel_name.ends_with(&format!(" SD{}", config.country_suffix));

    if !is_target_country {
        return None;
    }

    // Remove quality suffixes and country code to get clean name
    let clean_name = channel_name
        .trim_end_matches(&config.country_suffix)
        .trim_end_matches(" FHD")
        .trim_end_matches(" HD")
        .trim_end_matches(" SD")
        .trim();

    Some(format!("{}.{}", clean_name, config.country_code))
}

/// Generate EPG ID with default Swedish configuration
pub fn generate_epg_id_swedish(channel_name: &str) -> Option<String> {
    generate_epg_id(channel_name, &EpgConfig::swedish())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_generate_epg_id_swedish() {
        let config = EpgConfig::swedish();

        // HD suffix is stripped along with SE
        assert_eq!(
            generate_epg_id("SVT1 HD SE", &config),
            Some("SVT1.se".to_string())
        );

        // FHD suffix is stripped
        assert_eq!(
            generate_epg_id("TV4 FHD SE", &config),
            Some("TV4.se".to_string())
        );

        // Simple name without quality suffix
        assert_eq!(
            generate_epg_id("Kanal 5 SE", &config),
            Some("Kanal 5.se".to_string())
        );

        // SD suffix is stripped
        assert_eq!(
            generate_epg_id("TV3 SD SE", &config),
            Some("TV3.se".to_string())
        );

        // Non-Swedish channel should return None
        assert_eq!(generate_epg_id("BBC One", &config), None);
        assert_eq!(generate_epg_id("CNN International", &config), None);
    }

    #[test]
    fn test_generate_epg_id_swedish_shorthand() {
        // HD suffix is stripped
        assert_eq!(
            generate_epg_id_swedish("SVT2 HD SE"),
            Some("SVT2.se".to_string())
        );

        // Without quality suffix
        assert_eq!(
            generate_epg_id_swedish("Discovery SE"),
            Some("Discovery.se".to_string())
        );
    }

    #[test]
    fn test_mask_credentials_query_params() {
        // Both username and password
        assert_eq!(
            mask_credentials("http://server.com/xmltv.php?username=john&password=secret"),
            "http://server.com/xmltv.php?username=****&password=****"
        );

        // Password first, username second
        assert_eq!(
            mask_credentials("http://server.com/api?password=secret&username=john"),
            "http://server.com/api?password=****&username=****"
        );

        // Only username
        assert_eq!(
            mask_credentials("http://server.com/api?username=john"),
            "http://server.com/api?username=****"
        );

        // No credentials
        assert_eq!(
            mask_credentials("http://server.com/public"),
            "http://server.com/public"
        );

        // Username with additional params after
        assert_eq!(
            mask_credentials("http://server.com/api?username=john&format=xml"),
            "http://server.com/api?username=****&format=xml"
        );
    }

    #[test]
    fn test_mask_credentials_path_based() {
        // Xtream series URL
        assert_eq!(
            mask_credentials("http://server.com/series/myuser/mypass/12345.mp4"),
            "http://server.com/series/****/****/12345.mp4"
        );

        // Xtream live URL
        assert_eq!(
            mask_credentials("http://server.com/live/john/secret/channel.m3u8"),
            "http://server.com/live/****/****/channel.m3u8"
        );

        // Xtream movie URL
        assert_eq!(
            mask_credentials("http://server.com/movie/user123/pass456/movie.mkv"),
            "http://server.com/movie/****/****/movie.mkv"
        );

        // Non-Xtream path should not be masked
        assert_eq!(
            mask_credentials("http://server.com/other/path/here/file.mp4"),
            "http://server.com/other/path/here/file.mp4"
        );
    }

    #[test]
    fn test_mask_credentials_userinfo() {
        assert_eq!(
            mask_credentials("http://john:secret@server.com/get.php?type=m3u"),
            "http://****:****@server.com/get.php?type=m3u"
        );
        // Userinfo inside a longer log line, e.g. a reqwest error message
        assert_eq!(
            mask_credentials(
                "error sending request for url (https://john:secret@server.com/list.m3u)"
            ),
            "error sending request for url (https://****:****@server.com/list.m3u)"
        );
        // A port is not userinfo
        assert_eq!(
            mask_credentials("http://server.com:8080/list.m3u"),
            "http://server.com:8080/list.m3u"
        );
        // Username-only userinfo (password prompted or sent in a header)
        assert_eq!(
            mask_credentials("http://john@server.com/get.php?type=m3u"),
            "http://****:****@server.com/get.php?type=m3u"
        );
    }

    #[test]
    fn test_mask_credentials_keeps_text_after_url() {
        // The formatter runs on whole log lines; the value must stop at the URL's end
        assert_eq!(
            mask_credentials(
                "Fetching EPG from: http://h/xmltv.php?username=j&password=s with UA VLC/3.0 (attempt 2 of 3)"
            ),
            "Fetching EPG from: http://h/xmltv.php?username=****&password=**** with UA VLC/3.0 (attempt 2 of 3)"
        );
        assert_eq!(
            mask_credentials("error sending request for url (http://h/x.php?password=secret)"),
            "error sending request for url (http://h/x.php?password=****)"
        );
    }

    #[test]
    fn test_mask_credentials_key_value_outside_query() {
        assert_eq!(
            mask_credentials("Xtream import started: server=http://h, username=john"),
            "Xtream import started: server=http://h, username=****"
        );
        assert_eq!(
            mask_credentials("Importing {\"serverUrl\":\"http://h\",\"username\":\"john\"}"),
            "Importing {\"serverUrl\":\"http://h\",\"username\":\"****\"}"
        );
    }

    #[test]
    fn test_mask_credentials_json_fields() {
        assert_eq!(
            mask_credentials(
                "Xtream import result: {\"id\":1,\"xtream_username\":\"john\",\"xtream_password\":\"secret\",\"name\":\"Home\"}"
            ),
            "Xtream import result: {\"id\":1,\"xtream_username\":\"****\",\"xtream_password\":\"****\",\"name\":\"Home\"}"
        );
    }

    #[test]
    fn test_mask_credentials_leaves_filesystem_paths() {
        assert_eq!(
            mask_credentials("Failed to read /home/m0s/movie/a/b/x.m3u"),
            "Failed to read /home/m0s/movie/a/b/x.m3u"
        );
        assert_eq!(
            mask_credentials("Failed to read C:\\Users\\me\\series\\a\\b\\x.m3u"),
            "Failed to read C:\\Users\\me\\series\\a\\b\\x.m3u"
        );
    }

    #[test]
    fn test_mask_credentials_plain_line_untouched() {
        let line = "Fetched 10432 channels for playlist 3";
        assert_eq!(mask_credentials(line), line);
    }

    #[test]
    fn test_mask_credentials_mixed() {
        // URL with both query params and would-be path (query should be masked)
        let url = "http://server.com/api?username=john&password=secret&action=play";
        let masked = mask_credentials(url);
        assert!(!masked.contains("john"));
        assert!(!masked.contains("secret"));
        assert!(masked.contains("username=****"));
        assert!(masked.contains("password=****"));
    }
}
