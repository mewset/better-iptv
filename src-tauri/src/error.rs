//! Application error types for Better-IP-TV
//!
//! This module provides a unified error type that is serializable for Tauri IPC
//! and implements proper error conversion traits.

use serde::Serialize;
use thiserror::Error;

/// Application-wide error type
///
/// This enum represents all possible errors that can occur in the application.
/// It is serializable so it can be sent to the frontend via Tauri IPC.
#[derive(Error, Debug, Serialize)]
#[serde(tag = "code", content = "details")]
pub enum AppError {
    /// Database operation failed
    #[error("Database error: {0}")]
    Database(String),

    /// HTTP request failed
    #[error("HTTP error: {0}")]
    Http(String),

    /// Invalid input provided
    #[error("Invalid input: {0}")]
    InvalidInput(String),

    /// Playlist was not found
    #[error("Playlist not found: {0}")]
    PlaylistNotFound(i64),

    /// Channel was not found
    #[error("Channel not found: {0}")]
    ChannelNotFound(i64),

    /// MPV player error
    #[error("MPV error: {0}")]
    Mpv(String),

    /// Parsing error (M3U, XML, etc.)
    #[error("Parse error: {0}")]
    Parse(String),

    /// EPG-related error
    #[error("EPG error: {0}")]
    Epg(String),

    /// IO error
    #[error("IO error: {0}")]
    Io(String),

    /// Configuration error
    #[error("Configuration error: {0}")]
    Config(String),
}

// Implement From traits for automatic error conversion

impl From<rusqlite::Error> for AppError {
    fn from(e: rusqlite::Error) -> Self {
        AppError::Database(e.to_string())
    }
}

impl From<reqwest::Error> for AppError {
    fn from(e: reqwest::Error) -> Self {
        AppError::Http(e.to_string())
    }
}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        AppError::Io(e.to_string())
    }
}

impl From<anyhow::Error> for AppError {
    fn from(e: anyhow::Error) -> Self {
        // Try to downcast to known error types
        if let Some(db_err) = e.downcast_ref::<rusqlite::Error>() {
            return AppError::Database(db_err.to_string());
        }
        if let Some(req_err) = e.downcast_ref::<reqwest::Error>() {
            return AppError::Http(req_err.to_string());
        }
        if let Some(io_err) = e.downcast_ref::<std::io::Error>() {
            return AppError::Io(io_err.to_string());
        }
        // Default to parse error for unknown anyhow errors
        AppError::Parse(e.to_string())
    }
}

impl From<quick_xml::Error> for AppError {
    fn from(e: quick_xml::Error) -> Self {
        AppError::Parse(format!("XML parse error: {}", e))
    }
}

impl From<quick_xml::DeError> for AppError {
    fn from(e: quick_xml::DeError) -> Self {
        AppError::Parse(format!("XML deserialization error: {}", e))
    }
}

impl From<serde_json::Error> for AppError {
    fn from(e: serde_json::Error) -> Self {
        AppError::Parse(format!("JSON parse error: {}", e))
    }
}

impl From<std::string::FromUtf8Error> for AppError {
    fn from(e: std::string::FromUtf8Error) -> Self {
        AppError::Parse(format!("UTF-8 decode error: {}", e))
    }
}

impl From<chrono::ParseError> for AppError {
    fn from(e: chrono::ParseError) -> Self {
        AppError::Parse(format!("Date/time parse error: {}", e))
    }
}

impl From<r2d2::Error> for AppError {
    fn from(e: r2d2::Error) -> Self {
        AppError::Database(format!("Connection pool error: {}", e))
    }
}

impl From<tokio::task::JoinError> for AppError {
    fn from(e: tokio::task::JoinError) -> Self {
        AppError::Io(format!("Background task failed: {}", e))
    }
}

/// Result type alias using AppError
pub type AppResult<T> = Result<T, AppError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_error_serialization() {
        let error = AppError::Database("connection failed".to_string());
        let json = serde_json::to_string(&error).unwrap();
        assert!(json.contains("Database"));
        assert!(json.contains("connection failed"));
    }

    #[test]
    fn test_error_display() {
        let error = AppError::Mpv("failed to start".to_string());
        assert_eq!(error.to_string(), "MPV error: failed to start");
    }

    #[test]
    fn test_from_rusqlite_error() {
        // Create a rusqlite error by trying to open an invalid path
        let result: Result<rusqlite::Connection, rusqlite::Error> =
            rusqlite::Connection::open("/nonexistent/path/to/db.sqlite");

        if let Err(e) = result {
            let app_error: AppError = e.into();
            match app_error {
                AppError::Database(msg) => assert!(!msg.is_empty()),
                _ => panic!("Expected Database error"),
            }
        }
    }

    #[test]
    fn test_invalid_input_error() {
        let error = AppError::InvalidInput("empty URL".to_string());
        assert_eq!(error.to_string(), "Invalid input: empty URL");
    }

    #[test]
    fn test_playlist_not_found() {
        let error = AppError::PlaylistNotFound(42);
        let json = serde_json::to_string(&error).unwrap();
        assert!(json.contains("PlaylistNotFound"));
        assert!(json.contains("42"));
    }
}
