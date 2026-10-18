//! Background job for the iptv-org logo fallback: fetch the logo list weekly,
//! store it, expire old dead-logo marks and recompute the overrides.

use crate::commands::with_db;
use crate::db::{logo_fallbacks, mutations, queries};
use crate::http;
use crate::logo_domain::{
    fetch_due, is_enabled, select_fallbacks, IptvOrgLogo, LOGOS_URL, LOGO_FALLBACK_ENABLED_KEY,
    LOGO_FALLBACK_ETAG_KEY, LOGO_FALLBACK_FETCHED_AT_KEY,
};
use chrono::Utc;
use log::{debug, info, warn};
use r2d2::Pool;
use r2d2_sqlite::SqliteConnectionManager;
use reqwest::StatusCode;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Mutex;

/// Nothing here runs before the app has had time to settle.
pub const LOGO_FALLBACK_START_DELAY: Duration = Duration::from_secs(45);

/// What one request for the iptv-org logo list came to.
#[derive(Debug)]
pub enum FetchOutcome {
    NotModified,
    Fresh {
        fallbacks: HashMap<String, String>,
        etag: Option<String>,
    },
    Failed,
}

/// Fetch the logo list, sending `If-None-Match` when an ETag is known. Never
/// errors: every failure is a logged `Failed`.
pub async fn fetch_index(url: &str, etag: Option<&str>) -> FetchOutcome {
    let mut request = http::get_http_client()
        .get(url)
        .timeout(http::BULK_DOWNLOAD_TIMEOUT);
    if let Some(etag) = etag {
        request = request.header(reqwest::header::IF_NONE_MATCH, etag);
    }
    let response = match request.send().await {
        Ok(r) => r,
        Err(e) => {
            warn!("logo list request failed: {}", e.without_url());
            return FetchOutcome::Failed;
        }
    };
    let status = response.status();
    if status == StatusCode::NOT_MODIFIED {
        return FetchOutcome::NotModified;
    }
    if !status.is_success() {
        warn!("logo list request got HTTP {status}");
        return FetchOutcome::Failed;
    }
    let new_etag = response
        .headers()
        .get(reqwest::header::ETAG)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    let body = match response.bytes().await {
        Ok(b) => b,
        Err(e) => {
            warn!("logo list download failed: {}", e.without_url());
            return FetchOutcome::Failed;
        }
    };
    let parsed = tokio::task::spawn_blocking(move || {
        serde_json::from_slice::<Vec<IptvOrgLogo>>(&body).map(select_fallbacks)
    })
    .await;
    match parsed {
        Ok(Ok(fallbacks)) if !fallbacks.is_empty() => FetchOutcome::Fresh {
            fallbacks,
            etag: new_etag,
        },
        Ok(Ok(_)) => {
            warn!("logo list held no usable logos");
            FetchOutcome::Failed
        }
        Ok(Err(e)) => {
            warn!("logo list was unreadable: {e}");
            FetchOutcome::Failed
        }
        Err(e) => {
            warn!("logo list parsing did not finish: {e}");
            FetchOutcome::Failed
        }
    }
}

/// Expire old dead marks, refresh the fallback list when due (or forced) and
/// recompute every override. Never returns an error.
pub async fn run_maintenance(
    pool: Pool<SqliteConnectionManager>,
    lock: Arc<Mutex<()>>,
    force_fetch: bool,
) {
    run_maintenance_with(pool, lock, force_fetch, LOGOS_URL).await;
}

async fn run_maintenance_with(
    pool: Pool<SqliteConnectionManager>,
    lock: Arc<Mutex<()>>,
    force_fetch: bool,
    url: &str,
) {
    let _guard = lock.lock().await;

    let state = with_db(&pool, |conn| {
        logo_fallbacks::expire_marks(conn, Utc::now())?;
        Ok((
            queries::get_setting(conn, LOGO_FALLBACK_ENABLED_KEY)?,
            queries::get_setting(conn, LOGO_FALLBACK_FETCHED_AT_KEY)?,
            queries::get_setting(conn, LOGO_FALLBACK_ETAG_KEY)?,
        ))
    })
    .await;
    let (enabled_setting, fetched_at, etag) = match state {
        Ok(s) => s,
        Err(e) => {
            warn!("logo maintenance could not read its state: {e}");
            return;
        }
    };
    let enabled = is_enabled(enabled_setting.as_deref());

    if enabled && (force_fetch || fetch_due(fetched_at.as_deref(), Utc::now())) {
        match fetch_index(url, etag.as_deref()).await {
            FetchOutcome::Fresh { fallbacks, etag } => {
                let stored = with_db(&pool, move |conn| {
                    let n = logo_fallbacks::replace_fallbacks(conn, &fallbacks)?;
                    if let Some(etag) = etag {
                        mutations::set_setting(conn, LOGO_FALLBACK_ETAG_KEY, &etag)?;
                    }
                    mutations::set_setting(
                        conn,
                        LOGO_FALLBACK_FETCHED_AT_KEY,
                        &Utc::now().to_rfc3339(),
                    )?;
                    Ok(n)
                })
                .await;
                match stored {
                    Ok(n) => info!("stored {n} iptv-org logo fallbacks"),
                    Err(e) => warn!("could not store the logo fallbacks: {e}"),
                }
            }
            FetchOutcome::NotModified => {
                debug!("iptv-org logo list not modified");
                if let Err(e) = with_db(&pool, |conn| {
                    mutations::set_setting(
                        conn,
                        LOGO_FALLBACK_FETCHED_AT_KEY,
                        &Utc::now().to_rfc3339(),
                    )?;
                    Ok(())
                })
                .await
                {
                    warn!("could not record the logo list check: {e}");
                }
            }
            // Nothing stored: the next start tries again.
            FetchOutcome::Failed => {}
        }
    } else {
        debug!("logo list fetch skipped (enabled: {enabled}, not due or off)");
    }

    match with_db(&pool, move |conn| {
        Ok(logo_fallbacks::recompute_overrides(conn, None, enabled)?)
    })
    .await
    {
        Ok(n) => debug!("recomputed logo overrides, {n} changed"),
        Err(e) => warn!("could not recompute logo overrides: {e}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::schema::init_schema;
    use crate::http::test_server::{respond, serve};
    use chrono::Duration as ChronoDuration;

    fn pool() -> Pool<SqliteConnectionManager> {
        let pool = Pool::builder()
            .max_size(1)
            .build(SqliteConnectionManager::memory())
            .unwrap();
        init_schema(&pool.get().unwrap()).unwrap();
        pool
    }

    const TWO_LOGOS: &str = r#"[
        {"channel":"TV3.se","feed":null,"in_use":true,"width":100,"height":100,"url":"https://x/tv3.png"},
        {"channel":"SVT1.se","feed":null,"in_use":true,"width":50,"height":50,"url":"https://x/svt1.png"}
    ]"#;

    #[tokio::test]
    async fn fetch_parses_and_selects() {
        let server = serve(vec![respond("200 OK", TWO_LOGOS.as_bytes())]).await;
        match fetch_index(&server.base, None).await {
            FetchOutcome::Fresh { fallbacks, .. } => {
                assert_eq!(fallbacks.len(), 2);
                assert_eq!(fallbacks["tv3.se"], "https://x/tv3.png");
                assert_eq!(fallbacks["svt1.se"], "https://x/svt1.png");
            }
            other => panic!("expected Fresh, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn fetch_sends_etag_and_handles_304() {
        let server = serve(vec![respond("304 Not Modified", b"")]).await;
        let outcome = fetch_index(&server.base, Some("\"abc123\"")).await;
        assert!(matches!(outcome, FetchOutcome::NotModified), "{outcome:?}");
        let request = server.first_request().to_lowercase();
        assert!(
            request.contains("if-none-match: \"abc123\""),
            "request was: {request}"
        );
    }

    #[tokio::test]
    async fn fetch_failure_on_500_and_bad_json() {
        let server = serve(vec![respond("500 Internal Server Error", b"oops")]).await;
        assert!(matches!(
            fetch_index(&server.base, None).await,
            FetchOutcome::Failed
        ));
        let server = serve(vec![respond("200 OK", b"not json")]).await;
        assert!(matches!(
            fetch_index(&server.base, None).await,
            FetchOutcome::Failed
        ));
    }

    #[tokio::test]
    async fn maintenance_keeps_old_fallbacks_on_failure() {
        let pool = pool();
        {
            let conn = pool.get().unwrap();
            let old: HashMap<String, String> =
                [("tv3.se".to_string(), "https://old/tv3.png".to_string())].into();
            logo_fallbacks::replace_fallbacks(&conn, &old).unwrap();
        }
        let server = serve(vec![respond("500 Internal Server Error", b"oops")]).await;

        run_maintenance_with(pool.clone(), Arc::new(Mutex::new(())), true, &server.base).await;

        let conn = pool.get().unwrap();
        let url: String = conn
            .query_row(
                "SELECT url FROM logo_fallbacks WHERE epg_key = 'tv3.se'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(url, "https://old/tv3.png");
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM logo_fallbacks", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 1);
        assert_eq!(
            queries::get_setting(&conn, LOGO_FALLBACK_FETCHED_AT_KEY).unwrap(),
            None
        );
    }

    #[tokio::test]
    async fn maintenance_expires_marks_even_when_fetch_not_due() {
        let pool = pool();
        {
            let conn = pool.get().unwrap();
            mutations::set_setting(
                &conn,
                LOGO_FALLBACK_FETCHED_AT_KEY,
                &Utc::now().to_rfc3339(),
            )
            .unwrap();
            let old = (Utc::now() - ChronoDuration::days(8))
                .to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
            conn.execute(
                "INSERT INTO dead_logo_urls (url, state, marked_at, launch_id) \
                 VALUES ('http://dead/x.png', 'dead', ?1, 1)",
                [old],
            )
            .unwrap();
        }
        let server = serve(vec![respond("200 OK", TWO_LOGOS.as_bytes())]).await;

        run_maintenance_with(pool.clone(), Arc::new(Mutex::new(())), false, &server.base).await;

        let conn = pool.get().unwrap();
        let left: i64 = conn
            .query_row("SELECT COUNT(*) FROM dead_logo_urls", [], |r| r.get(0))
            .unwrap();
        assert_eq!(left, 0);
        assert_eq!(server.connections(), 0);
    }
}
