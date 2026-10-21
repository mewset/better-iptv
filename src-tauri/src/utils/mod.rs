//! Utility functions shared across modules

use lazy_static::lazy_static;
use regex::Regex;

lazy_static! {
    // Key/value pairs: `?username=X`, `&password=X`, but also `username=X` in a free-form log
    // line. The value stops at the next separator or closing bracket so that text after a URL
    // (user agent, attempt counter, reqwest's closing parenthesis) survives
    static ref KEY_VALUE_RE: Regex =
        Regex::new(r#"(?i)(username|password|api_key)=[^&\s,;)\]}'"]*"#).unwrap();

    // The same pair, plus api_key, as JSON fields, e.g. a serialised Playlist with `"xtream_password":"secret"`
    static ref JSON_FIELD_RE: Regex =
        Regex::new(r#"(?i)("(?:xtream_|tmdb_)?(?:username|password|api_key)"\s*:\s*)"[^"]*""#).unwrap();

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

#[cfg(test)]
mod tests {
    use super::*;

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
    fn test_mask_credentials_api_key() {
        assert_eq!(
            mask_credentials(
                "GET https://api.themoviedb.org/3/search/movie?api_key=abc123&query=x"
            ),
            "GET https://api.themoviedb.org/3/search/movie?api_key=****&query=x"
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
    fn test_mask_credentials_json_api_key_fields() {
        assert_eq!(
            mask_credentials("Settings: {\"tmdb_api_key\":\"abc123\",\"x\":1}"),
            "Settings: {\"tmdb_api_key\":\"****\",\"x\":1}"
        );
        assert_eq!(
            mask_credentials("{\"api_key\": \"abc123\",\"name\":\"Home\"}"),
            "{\"api_key\": \"****\",\"name\":\"Home\"}"
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
