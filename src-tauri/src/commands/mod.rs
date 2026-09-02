// Command modules organized by domain
pub mod playback;
pub mod playlist;
pub mod channel;
pub mod epg;
pub mod series;
pub mod settings;
pub mod parental;

// Re-export all commands for lib.rs
pub use playback::*;
pub use playlist::*;
pub use channel::*;
pub use epg::*;
pub use series::*;
pub use settings::*;
pub use parental::*;

use crate::error::AppError;
use r2d2::Pool;
use r2d2_sqlite::SqliteConnectionManager;

/// Run synchronous SQLite work on tokio's blocking thread pool.
///
/// Tauri executes async commands on the tokio runtime. rusqlite calls block
/// the thread they run on, so a large import or merge would otherwise stall
/// every other command until it finishes. Pool checkout happens inside the
/// closure so any wait for a free connection also stays off the async worker.
pub(crate) async fn with_db<T, F>(
    pool: &Pool<SqliteConnectionManager>,
    f: F,
) -> Result<T, AppError>
where
    F: FnOnce(&rusqlite::Connection) -> Result<T, AppError> + Send + 'static,
    T: Send + 'static,
{
    let pool = pool.clone();
    tokio::task::spawn_blocking(move || {
        let conn = pool.get()?;
        f(&conn)
    })
    .await?
}

#[cfg(test)]
mod tests {
    use super::with_db;
    use r2d2::Pool;
    use r2d2_sqlite::SqliteConnectionManager;

    #[tokio::test]
    async fn with_db_runs_closure_with_pooled_connection() {
        let pool = Pool::builder()
            .max_size(1)
            .build(SqliteConnectionManager::memory())
            .unwrap();

        let value = with_db(&pool, |conn| {
            Ok(conn.query_row("SELECT 40 + 2", [], |row| row.get::<_, i64>(0))?)
        })
        .await
        .unwrap();

        assert_eq!(value, 42);
    }

    #[tokio::test]
    async fn with_db_propagates_closure_errors() {
        let pool = Pool::builder()
            .max_size(1)
            .build(SqliteConnectionManager::memory())
            .unwrap();

        let result = with_db(&pool, |conn| {
            Ok(conn.execute("SELECT * FROM table_that_does_not_exist", [])?)
        })
        .await;

        assert!(matches!(result, Err(crate::error::AppError::Database(_))));
    }
}
