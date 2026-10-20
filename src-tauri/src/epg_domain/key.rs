//! Canonical keys for matching guide channels to playlist channels.
//!
//! A feed's `<channel id>` and a playlist's `tvg-id` name the same channel in
//! different cases (`SVT1.se` vs `svt1.se`), so both sides are compared through
//! `channel_key`. Display names are looser and go through `name_key`.

/// Whitespace as JavaScript's `String.prototype.trim` sees it: Unicode
/// White_Space plus the byte order mark, which Rust's `trim` leaves alone. The
/// frontend normalises ids with `trim().toLowerCase()`, and the two sides must
/// produce the same key for the same id.
fn is_trim_char(c: char) -> bool {
    c.is_whitespace() || c == '\u{feff}'
}

/// Key of an EPG channel id: trimmed and lower-cased with Unicode case mapping.
///
/// Unicode, not ASCII, so `Ämne.se` and `ämne.se` meet, and so the key equals
/// what JavaScript's `toLowerCase` gives for the same id. An id that is empty
/// after trimming has no key.
pub fn channel_key(raw: &str) -> Option<String> {
    let trimmed = raw.trim_matches(is_trim_char);
    if trimmed.is_empty() {
        return None;
    }
    Some(trimmed.to_lowercase())
}

/// Key of a channel display name: trimmed, underscores read as spaces, runs of
/// whitespace collapsed to one space, lower-cased with Unicode case mapping.
///
/// Nothing else is stripped. Removing quality, bracket or country tokens made
/// channels from the wrong country match in earlier trials.
pub fn name_key(raw: &str) -> Option<String> {
    let spaced = raw.replace('_', " ");
    let mut key = String::with_capacity(spaced.len());
    for word in spaced.split(is_trim_char).filter(|w| !w.is_empty()) {
        if !key.is_empty() {
            key.push(' ');
        }
        key.push_str(word);
    }
    if key.is_empty() {
        return None;
    }
    Some(key.to_lowercase())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn channel_keys_are_trimmed_and_lower_cased() {
        assert_eq!(channel_key("SVT1.se").as_deref(), Some("svt1.se"));
        assert_eq!(channel_key("  TV4.SE ").as_deref(), Some("tv4.se"));
        assert_eq!(channel_key("svt1.se").as_deref(), Some("svt1.se"));
    }

    #[test]
    fn channel_keys_lower_case_non_ascii_letters_like_javascript() {
        // Parity case with the frontend's `id.trim().toLowerCase()`.
        assert_eq!(channel_key("Ämne.se").as_deref(), Some("ämne.se"));
        assert_eq!(channel_key("ÖSTERSUND.SE").as_deref(), Some("östersund.se"));
        // Final sigma, as JavaScript maps it.
        assert_eq!(
            channel_key("\u{39f}\u{394}\u{39f}\u{3a3}").as_deref(),
            Some("\u{3bf}\u{3b4}\u{3bf}\u{3c2}")
        );
    }

    #[test]
    fn channel_keys_trim_what_javascript_trims() {
        assert_eq!(
            channel_key("\u{feff}\u{a0}SVT1.se\t\n").as_deref(),
            Some("svt1.se")
        );
    }

    #[test]
    fn channel_keys_keep_inner_whitespace_and_underscores() {
        assert_eq!(channel_key("A B_C").as_deref(), Some("a b_c"));
    }

    #[test]
    fn empty_channel_ids_have_no_key() {
        assert_eq!(channel_key(""), None);
        assert_eq!(channel_key("   "), None);
        assert_eq!(channel_key("\u{feff}"), None);
    }

    #[test]
    fn name_keys_read_underscores_as_spaces_and_collapse_whitespace() {
        assert_eq!(name_key("SVT1_HD").as_deref(), Some("svt1 hd"));
        assert_eq!(name_key("  SVT1   HD ").as_deref(), Some("svt1 hd"));
        assert_eq!(name_key("SVT1 _ HD").as_deref(), Some("svt1 hd"));
        assert_eq!(name_key("SVT1\tHD").as_deref(), Some("svt1 hd"));
        assert_eq!(name_key("Kanal_Ämne").as_deref(), Some("kanal ämne"));
    }

    #[test]
    fn name_keys_strip_nothing_else() {
        assert_eq!(name_key("SE: TV4 [FHD]").as_deref(), Some("se: tv4 [fhd]"));
    }

    #[test]
    fn empty_names_have_no_key() {
        assert_eq!(name_key(""), None);
        assert_eq!(name_key(" _ __ "), None);
    }
}
