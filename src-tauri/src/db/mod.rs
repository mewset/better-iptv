pub mod logo_fallbacks;
pub mod models;
pub mod mutations;
pub mod pinned_categories;
pub mod queries;
pub mod schema;
#[cfg(test)]
pub mod schema_v3_1;
#[cfg(test)]
pub mod test_helpers;

use rusqlite::{Connection, Transaction, TransactionBehavior};

/// Opens a write transaction on the app database. Every write transaction starts here, with
/// `BEGIN IMMEDIATE`: it takes the write lock up front, waiting out other writers with the busy
/// timeout. A deferred transaction that reads before it writes is refused at once
/// ("database is locked", `SQLITE_BUSY_SNAPSHOT`) when another connection, such as the TMDB scan,
/// commits between its read and its first write; the busy timeout never applies to that.
/// (The EPG ingest's staging writes go to its own attached database and do not use this.)
pub fn write_transaction(conn: &Connection) -> rusqlite::Result<Transaction<'_>> {
    Transaction::new_unchecked(conn, TransactionBehavior::Immediate)
}
