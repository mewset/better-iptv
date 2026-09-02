#![cfg(test)]

use rusqlite::Connection;
use super::models::*;
use super::schema::init_schema;
use super::mutations;

/// Create an in-memory test database with schema initialized
pub fn setup_test_db() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
    init_schema(&conn).unwrap();
    conn
}

/// Create a test playlist and return its ID
pub fn create_test_playlist(conn: &Connection, name: &str) -> i64 {
    let playlist = Playlist {
        id: None,
        name: name.to_string(),
        url: Some("http://example.com/playlist.m3u".to_string()),
        file_path: None,
        last_updated: None,
        auto_refresh: false,
        xtream_username: None,
        xtream_password: None,
        created_at: None,
    };
    mutations::create_playlist(conn, &playlist).unwrap()
}

/// Create a test channel and return its ID
pub fn create_test_channel(conn: &Connection, playlist_id: i64, name: &str) -> i64 {
    let channel = Channel {
        id: None,
        playlist_id,
        name: name.to_string(),
        url: "http://example.com/stream.m3u8".to_string(),
        logo: None,
        group_name: Some("Test Group".to_string()),
        epg_id: None,
        tvg_name: None,
        content_type: "live".to_string(),
        is_favorite: false,
        sort_order: 0,
        category_order: 0,
        created_at: None,
    };
    mutations::create_channel(conn, &channel).unwrap()
}
