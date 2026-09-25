mod channel_domain;
mod commands;
mod db;
mod epg;
mod epg_domain;
pub mod error;
mod http;
mod parental_domain;
mod playback;
mod playlist;
mod playlist_domain;
mod series_domain;
mod state;
mod update_domain;
mod utils;

pub use error::{AppError, AppResult};

use commands::*;
use db::schema::{ensure_active_profile, init_schema};
use log::{info, warn};
use r2d2::Pool;
use r2d2_sqlite::SqliteConnectionManager;
use state::AppState;
use tauri::Manager;
use tauri_plugin_log::{RotationStrategy, Target, TargetKind, TimezoneStrategy};

/// PRAGMA initializer for each new connection in the pool
#[derive(Debug)]
struct PragmaCustomizer;

impl r2d2::CustomizeConnection<rusqlite::Connection, rusqlite::Error> for PragmaCustomizer {
    fn on_acquire(&self, conn: &mut rusqlite::Connection) -> Result<(), rusqlite::Error> {
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             PRAGMA foreign_keys = ON;
             PRAGMA cache_size = 10000;
             PRAGMA temp_store = memory;",
        )?;
        Ok(())
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Workaround for WebKitGTK 2.50+ EGL display bug on Wayland
    // See: https://github.com/tauri-apps/tauri/issues/11988
    // See: https://bugs.webkit.org/show_bug.cgi?id=280239
    #[cfg(target_os = "linux")]
    {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(if cfg!(debug_assertions) {
                    log::LevelFilter::Debug
                } else {
                    log::LevelFilter::Info
                })
                .targets([
                    Target::new(TargetKind::Stdout),
                    Target::new(TargetKind::Webview),
                    Target::new(TargetKind::LogDir {
                        file_name: Some("better-ip-tv".to_string()),
                    }),
                ])
                .max_file_size(10_000_000) // 10 MB
                .rotation_strategy(RotationStrategy::KeepOne)
                .timezone_strategy(TimezoneStrategy::UseLocal)
                .build(),
        )
        .setup(|app| {
            // Get app data directory
            let app_data_dir = app
                .path()
                .app_data_dir()
                .expect("Failed to get app data directory");

            // Create directory if it doesn't exist
            std::fs::create_dir_all(&app_data_dir).expect("Failed to create app data directory");

            // Database path
            let db_path = app_data_dir.join("better-ip-tv.db");

            // Build connection pool
            let manager = SqliteConnectionManager::file(&db_path);
            let pool = Pool::builder()
                .max_size(4)
                .connection_customizer(Box::new(PragmaCustomizer))
                .build(manager)
                .expect("Failed to create connection pool");

            // Startup logging
            info!("Better-IP-TV v{} starting", env!("CARGO_PKG_VERSION"));
            info!("Database: {}", db_path.display());
            info!("Connection pool: {} connections", pool.max_size());

            // Initialize schema using a connection from the pool
            {
                let conn = pool
                    .get()
                    .expect("Failed to get connection for schema init");

                init_schema(&conn).expect("Failed to initialize database schema");

                // Run migration for active profile setting
                ensure_active_profile(&conn).expect("Failed to ensure active profile setting");

                // Update EPG IDs for existing channels (for migration)
                match db::mutations::update_channel_epg_ids(&conn) {
                    Ok(count) => {
                        if count > 0 {
                            info!("Updated EPG IDs for {} channels", count);
                        }
                    }
                    Err(e) => warn!("Failed to update EPG IDs: {}", e),
                }
            }

            // Create and manage app state
            let state = AppState::new(pool);
            app.manage(state);

            // Background EPG refresh. Runs on Tauri's tokio runtime; the
            // heavy parts (download, parse, store) already go through
            // spawn_blocking / async HTTP inside run_epg_refresh.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(commands::epg::EPG_AUTO_REFRESH_INITIAL_DELAY).await;
                loop {
                    commands::epg::maybe_auto_refresh_epg(&handle).await;
                    tokio::time::sleep(commands::epg::EPG_AUTO_REFRESH_POLL_INTERVAL).await;
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // MPV commands
            check_mpv_installed,
            play_channel,
            stop_playback,
            playback_status,
            // Playlist commands
            import_playlist,
            import_xtream_playlist,
            get_playlists,
            delete_playlist,
            refresh_playlist,
            get_subscription_expiry,
            get_stale_playlist_ids,
            get_playlist_channel_counts,
            // Channel commands
            get_channels,
            get_channel_groups,
            toggle_favorite,
            get_favorites,
            // Series commands
            get_series_info,
            play_episode_with_season,
            get_local_series_info,
            play_series_episodes,
            // Settings commands
            get_setting,
            set_setting,
            // Profile management commands
            get_active_profile_id,
            set_active_profile_id,
            rename_playlist,
            // EPG commands
            fetch_epg_data,
            get_channel_epg,
            get_channels_epg,
            get_guide,
            get_epg_status,
            force_refresh_epg,
            // Parental controls commands
            set_parental_pin,
            verify_parental_pin,
            reset_parental_pin,
            get_blocked_channels,
            set_blocked_channels,
            get_parental_settings,
            // Update check
            check_for_update,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod desktop_entry_tests {
    const TEMPLATE: &str = include_str!("../templates/better-iptv.desktop");
    const CONFIG: &str = include_str!("../tauri.conf.json");

    /// The Linux desktop entry must announce the same string the window
    /// reports as its class, or KDE's taskbar and GNOME Shell fall back to a
    /// generic icon. The window class is the main binary name, which the
    /// bundler exposes as `{{{exec}}}`. `{{{name}}}` is the product name
    /// ("Better IPTV") and was the original bug.
    #[test]
    fn startup_wm_class_uses_the_exec_variable() {
        let line = TEMPLATE
            .lines()
            .find(|l| l.starts_with("StartupWMClass="))
            .expect("template must declare StartupWMClass");

        assert_eq!(
            line, "StartupWMClass={{{exec}}}",
            "StartupWMClass must render from the binary name, not the product name"
        );
    }

    /// The template above only matters while the bundler renders it. Both
    /// Linux bundles that carry a desktop entry must still point at it.
    #[test]
    fn deb_and_rpm_bundles_render_this_template() {
        let config: serde_json::Value =
            serde_json::from_str(CONFIG).expect("tauri.conf.json must be valid JSON");

        for bundle in ["deb", "rpm"] {
            assert_eq!(
                config["bundle"]["linux"][bundle]["desktopTemplate"],
                "templates/better-iptv.desktop",
                "bundle.linux.{bundle}.desktopTemplate no longer points at the tested template"
            );
        }
    }
}
