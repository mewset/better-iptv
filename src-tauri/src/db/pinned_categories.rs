//! Storage for pinned categories: the categories a user pinned to the front of the
//! category bar, per profile (playlist) and per section (content type). All SQL for
//! the feature lives here.

use crate::db::models::CategoryGroups;
use crate::db::queries;
use rusqlite::{params, Connection, Result};
use std::collections::HashSet;

/// The section's categories split into the pinned ones (in pin order) and the rest
/// (in provider order). A stored pin whose category the section no longer has is
/// left out, but kept: it shows again if the category comes back.
pub fn get_category_groups(
    conn: &Connection,
    playlist_id: i64,
    content_type: &str,
) -> Result<CategoryGroups> {
    let all = queries::get_channel_groups(conn, playlist_id, Some(content_type))?;
    let present: HashSet<&str> = all.iter().map(String::as_str).collect();

    let mut stmt = conn.prepare(
        "SELECT group_name FROM pinned_categories
         WHERE playlist_id = ?1 AND content_type = ?2
         ORDER BY position",
    )?;
    let pinned: Vec<String> = stmt
        .query_map(params![playlist_id, content_type], |row| row.get(0))?
        .collect::<Result<Vec<String>>>()?
        .into_iter()
        .filter(|name| present.contains(name.as_str()))
        .collect();

    let pinned_set: HashSet<&str> = pinned.iter().map(String::as_str).collect();
    let others = all
        .iter()
        .filter(|name| !pinned_set.contains(name.as_str()))
        .cloned()
        .collect();

    Ok(CategoryGroups { pinned, others })
}

/// Pin or unpin one category in one section of one profile. A new pin goes last
/// among the section's pins; pinning a pinned category or unpinning an unpinned
/// one changes nothing.
pub fn set_category_pinned(
    conn: &Connection,
    playlist_id: i64,
    content_type: &str,
    group_name: &str,
    pinned: bool,
) -> Result<()> {
    if pinned {
        conn.execute(
            "INSERT OR IGNORE INTO pinned_categories (playlist_id, content_type, group_name, position)
             SELECT ?1, ?2, ?3, COALESCE(MAX(position), -1) + 1 FROM pinned_categories
             WHERE playlist_id = ?1 AND content_type = ?2",
            params![playlist_id, content_type, group_name],
        )?;
    } else {
        conn.execute(
            "DELETE FROM pinned_categories
             WHERE playlist_id = ?1 AND content_type = ?2 AND group_name = ?3",
            params![playlist_id, content_type, group_name],
        )?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::models::Channel;
    use crate::db::mutations;
    use crate::db::test_helpers::{create_test_playlist, setup_test_db};

    fn add_channel(conn: &Connection, playlist_id: i64, group: &str, order: i32, ct: &str) {
        let channel = Channel {
            id: None,
            playlist_id,
            name: format!("{group} channel"),
            url: "http://example.com/stream.m3u8".to_string(),
            logo: None,
            group_name: Some(group.to_string()),
            epg_id: None,
            tvg_name: None,
            content_type: ct.to_string(),
            is_favorite: false,
            sort_order: 0,
            category_order: order,
            created_at: None,
        };
        mutations::create_channel(conn, &channel).unwrap();
    }

    /// Playlist with live groups Sweden(0), Norway(1), Denmark(2).
    fn setup() -> (Connection, i64) {
        let conn = setup_test_db();
        let id = create_test_playlist(&conn, "Test");
        for (group, order) in [("Sweden", 0), ("Norway", 1), ("Denmark", 2)] {
            add_channel(&conn, id, group, order, "live");
        }
        (conn, id)
    }

    fn pin(conn: &Connection, id: i64, name: &str) {
        set_category_pinned(conn, id, "live", name, true).unwrap();
    }

    fn live(conn: &Connection, id: i64) -> CategoryGroups {
        get_category_groups(conn, id, "live").unwrap()
    }

    fn row_count(conn: &Connection) -> i64 {
        conn.query_row("SELECT COUNT(*) FROM pinned_categories", [], |r| r.get(0))
            .unwrap()
    }

    #[test]
    fn no_pins_returns_provider_order() {
        let (conn, id) = setup();
        let groups = live(&conn, id);
        assert!(groups.pinned.is_empty());
        assert_eq!(groups.others, ["Sweden", "Norway", "Denmark"]);
    }

    #[test]
    fn pinned_come_in_pin_order() {
        let (conn, id) = setup();
        pin(&conn, id, "Denmark");
        pin(&conn, id, "Norway");
        let groups = live(&conn, id);
        assert_eq!(groups.pinned, ["Denmark", "Norway"]);
        assert_eq!(groups.others, ["Sweden"]);
    }

    #[test]
    fn pinning_twice_keeps_one_pin_and_its_position() {
        let (conn, id) = setup();
        pin(&conn, id, "Denmark");
        pin(&conn, id, "Norway");
        pin(&conn, id, "Denmark");
        assert_eq!(live(&conn, id).pinned, ["Denmark", "Norway"]);
        assert_eq!(row_count(&conn), 2);
    }

    #[test]
    fn unpin_returns_category_to_provider_order() {
        let (conn, id) = setup();
        pin(&conn, id, "Denmark");
        set_category_pinned(&conn, id, "live", "Denmark", false).unwrap();
        let groups = live(&conn, id);
        assert!(groups.pinned.is_empty());
        assert_eq!(groups.others, ["Sweden", "Norway", "Denmark"]);
        // Unpinning a category that is not pinned is fine
        set_category_pinned(&conn, id, "live", "Norway", false).unwrap();
    }

    #[test]
    fn absent_pin_is_kept_and_hidden() {
        let (conn, id) = setup();
        pin(&conn, id, "Finland");
        let groups = live(&conn, id);
        assert!(groups.pinned.is_empty());
        assert_eq!(groups.others, ["Sweden", "Norway", "Denmark"]);
        assert_eq!(row_count(&conn), 1);

        add_channel(&conn, id, "Finland", 3, "live");
        assert_eq!(live(&conn, id).pinned, ["Finland"]);
    }

    #[test]
    fn pins_are_per_content_type() {
        let (conn, id) = setup();
        add_channel(&conn, id, "Sweden", 0, "vod");
        pin(&conn, id, "Sweden");
        assert_eq!(live(&conn, id).pinned, ["Sweden"]);
        let vod = get_category_groups(&conn, id, "vod").unwrap();
        assert!(vod.pinned.is_empty());
        assert_eq!(vod.others, ["Sweden"]);
    }

    #[test]
    fn pins_are_per_playlist() {
        let (conn, first) = setup();
        let second = create_test_playlist(&conn, "Second");
        for (group, order) in [("Sweden", 0), ("Norway", 1), ("Denmark", 2)] {
            add_channel(&conn, second, group, order, "live");
        }
        pin(&conn, first, "Norway");
        assert_eq!(live(&conn, first).pinned, ["Norway"]);
        assert!(live(&conn, second).pinned.is_empty());
    }

    #[test]
    fn deleting_the_playlist_deletes_its_pins() {
        let (conn, id) = setup();
        pin(&conn, id, "Norway");
        mutations::delete_playlist(&conn, id).unwrap();
        assert_eq!(row_count(&conn), 0);
    }

    #[test]
    fn refresh_reorder_keeps_pin_order() {
        let (conn, id) = setup();
        pin(&conn, id, "Denmark");
        pin(&conn, id, "Sweden");
        for (group, order) in [("Norway", 0), ("Denmark", 1), ("Sweden", 2)] {
            conn.execute(
                "UPDATE channels SET category_order = ?1 WHERE playlist_id = ?2 AND group_name = ?3",
                params![order, id, group],
            )
            .unwrap();
        }
        let groups = live(&conn, id);
        assert_eq!(groups.pinned, ["Denmark", "Sweden"]);
        assert_eq!(groups.others, ["Norway"]);
    }

    #[test]
    fn names_are_stored_verbatim() {
        let (conn, id) = setup();
        let name = "SE: Sverige | ÅÄÖ 4K";
        add_channel(&conn, id, name, 3, "live");
        pin(&conn, id, name);
        assert_eq!(live(&conn, id).pinned, [name]);

        // A trailing space is a different category, and this one has no channels
        pin(&conn, id, "SE: Sverige | ÅÄÖ 4K ");
        assert_eq!(live(&conn, id).pinned, [name]);
    }
}
