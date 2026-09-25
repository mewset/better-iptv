//! Which TMDB key to use, and where the shared one comes from.

use crate::commands::with_db;
use crate::db::{mutations, queries};
use crate::error::AppError;
use crate::http;
use crate::tmdb::session::TmdbSession;
use crate::tmdb_domain::{decide_key, KeyDecision, KeySettings, KeySource};
use chrono::Utc;
use log::{debug, info};
use r2d2::Pool;
use r2d2_sqlite::SqliteConnectionManager;
use rusqlite::Connection;
use serde::Deserialize;

pub const TMDB_ENABLED_KEY: &str = "tmdb_enabled";
pub const TMDB_API_KEY_KEY: &str = "tmdb_api_key";
pub const TMDB_LANGUAGE_KEY: &str = "tmdb_language";
pub const TMDB_SHARED_KEY_KEY: &str = "tmdb_shared_key";
pub const TMDB_SHARED_KEY_FETCHED_AT_KEY: &str = "tmdb_shared_key_fetched_at";
pub const SHARED_KEY_URL: &str = "https://better-iptv.vercel.app/api/tmdb-key";
pub const DEFAULT_LANGUAGE: &str = "en-US";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedKey {
    pub key: String,
    pub source: KeySource,
}

pub fn read_key_settings(conn: &Connection) -> rusqlite::Result<KeySettings> {
    let map = queries::get_multiple_settings(
        conn,
        &[
            TMDB_ENABLED_KEY,
            TMDB_API_KEY_KEY,
            TMDB_SHARED_KEY_KEY,
            TMDB_SHARED_KEY_FETCHED_AT_KEY,
        ],
    )?;
    Ok(KeySettings {
        enabled: map.get(TMDB_ENABLED_KEY).map(|v| v != "0").unwrap_or(true),
        user_key: map.get(TMDB_API_KEY_KEY).cloned(),
        shared_key: map.get(TMDB_SHARED_KEY_KEY).cloned(),
        shared_fetched_at: map.get(TMDB_SHARED_KEY_FETCHED_AT_KEY).cloned(),
    })
}

#[allow(dead_code)] // Called by the enrichment queue in Task 7
pub fn read_language(conn: &Connection) -> rusqlite::Result<String> {
    Ok(queries::get_setting(conn, TMDB_LANGUAGE_KEY)?
        .filter(|l| !l.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_LANGUAGE.to_string()))
}

#[derive(Deserialize)]
struct SharedKeyBody {
    key: String,
}

pub fn parse_shared_key_body(body: &str) -> Option<String> {
    serde_json::from_str::<SharedKeyBody>(body)
        .ok()
        .map(|b| b.key.trim().to_string())
        .filter(|k| !k.is_empty())
}

/// GET the shared key from the website. The shared client's User-Agent
/// already carries `Better-IPTV/<version>`, which the endpoint requires.
pub async fn fetch_shared_key() -> Option<String> {
    let resp = http::get_http_client()
        .get(SHARED_KEY_URL)
        .send()
        .await
        .map_err(|e| debug!("shared TMDB key request failed: {e}"))
        .ok()?;
    if !resp.status().is_success() {
        debug!("shared TMDB key endpoint returned HTTP {}", resp.status());
        return None;
    }
    let body = resp.text().await.ok()?;
    parse_shared_key_body(&body)
}

/// Spec §1 steps 1-4. `None` means enrichment is dormant right now.
#[allow(dead_code)] // Called by the enrichment queue in Task 7
pub async fn resolve_key(
    pool: &Pool<SqliteConnectionManager>,
    session: &TmdbSession,
) -> Result<Option<ResolvedKey>, AppError> {
    let settings = with_db(pool, |conn| Ok(read_key_settings(conn)?)).await?;
    match decide_key(&settings, Utc::now()) {
        KeyDecision::Disabled => Ok(None),
        KeyDecision::Use {
            key,
            source: KeySource::User,
        } => {
            if session.user_key_rejected() {
                return Ok(None);
            }
            Ok(Some(ResolvedKey {
                key,
                source: KeySource::User,
            }))
        }
        KeyDecision::Use {
            key,
            source: KeySource::Shared,
        } => {
            if session.shared_key_rejected() {
                return Ok(None);
            }
            Ok(Some(ResolvedKey {
                key,
                source: KeySource::Shared,
            }))
        }
        KeyDecision::FetchShared { stale } => {
            if session.shared_key_rejected() {
                return Ok(None);
            }
            match fetch_shared_key().await {
                Some(key) => {
                    let stored = key.clone();
                    with_db(pool, move |conn| {
                        mutations::set_setting(conn, TMDB_SHARED_KEY_KEY, &stored)?;
                        mutations::set_setting(
                            conn,
                            TMDB_SHARED_KEY_FETCHED_AT_KEY,
                            &Utc::now().to_rfc3339(),
                        )?;
                        Ok(())
                    })
                    .await?;
                    info!("shared TMDB key fetched");
                    Ok(Some(ResolvedKey {
                        key,
                        source: KeySource::Shared,
                    }))
                }
                None => Ok(stale.map(|key| ResolvedKey {
                    key,
                    source: KeySource::Shared,
                })),
            }
        }
    }
}

/// Spec §1 step 5: what a 401 means for each key source.
#[allow(dead_code)] // Called by the enrichment queue in Task 7
pub async fn handle_unauthorized(
    pool: &Pool<SqliteConnectionManager>,
    session: &TmdbSession,
    source: KeySource,
) -> Result<(), AppError> {
    match source {
        KeySource::User => {
            info!("TMDB rejected the user's API key");
            session.set_user_key_rejected(true);
        }
        KeySource::Shared => {
            let n = session.note_shared_unauthorized();
            info!("TMDB rejected the shared key ({n})");
            with_db(pool, |conn| {
                mutations::delete_setting(conn, TMDB_SHARED_KEY_KEY)?;
                mutations::delete_setting(conn, TMDB_SHARED_KEY_FETCHED_AT_KEY)?;
                Ok(())
            })
            .await?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::mutations::set_setting;
    use crate::db::test_helpers::setup_test_db;

    #[test]
    fn settings_default_to_enabled_english_and_no_keys() {
        let conn = setup_test_db();
        let s = read_key_settings(&conn).unwrap();
        assert!(s.enabled);
        assert_eq!(s.user_key, None);
        assert_eq!(read_language(&conn).unwrap(), "en-US");
    }

    #[test]
    fn settings_read_every_key() {
        let conn = setup_test_db();
        set_setting(&conn, TMDB_ENABLED_KEY, "0").unwrap();
        set_setting(&conn, TMDB_API_KEY_KEY, "abc").unwrap();
        set_setting(&conn, TMDB_LANGUAGE_KEY, "sv-SE").unwrap();
        set_setting(&conn, TMDB_SHARED_KEY_KEY, "shared").unwrap();
        set_setting(
            &conn,
            TMDB_SHARED_KEY_FETCHED_AT_KEY,
            "2026-09-25T00:00:00+00:00",
        )
        .unwrap();
        let s = read_key_settings(&conn).unwrap();
        assert!(!s.enabled);
        assert_eq!(s.user_key.as_deref(), Some("abc"));
        assert_eq!(s.shared_key.as_deref(), Some("shared"));
        assert_eq!(
            s.shared_fetched_at.as_deref(),
            Some("2026-09-25T00:00:00+00:00")
        );
        assert_eq!(read_language(&conn).unwrap(), "sv-SE");
    }

    #[test]
    fn shared_key_body_parses() {
        assert_eq!(
            parse_shared_key_body(r#"{"key":"abc"}"#).as_deref(),
            Some("abc")
        );
        assert_eq!(parse_shared_key_body(r#"{"key":""}"#), None);
        assert_eq!(parse_shared_key_body("nope"), None);
    }

    #[tokio::test]
    async fn resolve_prefers_the_user_key_and_stops_when_it_was_rejected() {
        let pool = r2d2::Pool::builder()
            .max_size(1)
            .build(r2d2_sqlite::SqliteConnectionManager::memory())
            .unwrap();
        {
            let conn = pool.get().unwrap();
            crate::db::schema::init_schema(&conn).unwrap();
            set_setting(&conn, TMDB_API_KEY_KEY, "user-key").unwrap();
        }
        let session = TmdbSession::default();
        let r = resolve_key(&pool, &session).await.unwrap().unwrap();
        assert_eq!(r.key, "user-key");
        assert_eq!(r.source, KeySource::User);
        handle_unauthorized(&pool, &session, KeySource::User)
            .await
            .unwrap();
        assert!(session.user_key_rejected());
        assert!(resolve_key(&pool, &session).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn shared_unauthorized_drops_the_cached_key_and_the_second_time_goes_dormant() {
        let pool = r2d2::Pool::builder()
            .max_size(1)
            .build(r2d2_sqlite::SqliteConnectionManager::memory())
            .unwrap();
        {
            let conn = pool.get().unwrap();
            crate::db::schema::init_schema(&conn).unwrap();
            set_setting(&conn, TMDB_SHARED_KEY_KEY, "shared").unwrap();
            set_setting(
                &conn,
                TMDB_SHARED_KEY_FETCHED_AT_KEY,
                &chrono::Utc::now().to_rfc3339(),
            )
            .unwrap();
        }
        let session = TmdbSession::default();
        assert_eq!(
            resolve_key(&pool, &session).await.unwrap().unwrap().source,
            KeySource::Shared
        );
        handle_unauthorized(&pool, &session, KeySource::Shared)
            .await
            .unwrap();
        let conn = pool.get().unwrap();
        assert_eq!(
            crate::db::queries::get_setting(&conn, TMDB_SHARED_KEY_KEY).unwrap(),
            None
        );
        drop(conn);
        assert!(!session.shared_key_rejected());
        handle_unauthorized(&pool, &session, KeySource::Shared)
            .await
            .unwrap();
        assert!(session.shared_key_rejected());
        assert!(resolve_key(&pool, &session).await.unwrap().is_none());
    }

    #[tokio::test]
    #[ignore]
    async fn the_website_serves_a_key_to_the_app_user_agent() {
        let key = fetch_shared_key().await.expect("website returned no key");
        assert!(!key.is_empty());
    }
}
