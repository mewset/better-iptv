mod channel_domain;
mod commands;
mod db;
mod epg;
mod epg_domain;
pub mod error;
mod http;
mod logo_domain;
mod logo_fallback;
mod parental_domain;
mod playback;
mod playlist;
mod playlist_domain;
mod series_domain;
mod state;
mod tmdb;
mod tmdb_domain;
mod update_domain;
mod utils;

pub use error::{AppError, AppResult};

use commands::*;
use db::schema::{ensure_active_profile, init_schema};
use log::info;
use r2d2::Pool;
use r2d2_sqlite::SqliteConnectionManager;
use state::AppState;
use tauri::Manager;
use tauri_plugin_log::{RotationStrategy, Target, TargetKind};

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
                // Same line layout as the plugin default (local time), plus a last line of defence: mask playlist/EPG credentials in every record, from Rust
                // and from the frontend alike, before it reaches the log file or the console
                .format(|out, message, record| {
                    out.finish(format_args!(
                        "{}[{}][{}] {}",
                        chrono::Local::now().format("[%Y-%m-%d][%H:%M:%S]"),
                        record.level(),
                        record.target(),
                        crate::utils::mask_credentials(&message.to_string())
                    ))
                })
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

            // Guide feed cache. Not fatal: without it the guide cannot be
            // downloaded, everything else works.
            let epg_cache_dir = epg::sources::cache_dir(&app_data_dir);
            if let Err(e) = std::fs::create_dir_all(&epg_cache_dir) {
                log::warn!(
                    "Could not create EPG cache directory {}: {}",
                    epg_cache_dir.display(),
                    e
                );
            }

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
            }

            // Create and manage app state
            let state = AppState::new(pool, db_path.clone(), epg_cache_dir);
            let logo_pool = state.pool.clone();
            let logo_lock = state.logo_fallback_lock.clone();
            let epg_service =
                epg::service::EpgService::new(epg::service::ServiceParts::from_state(
                    &state,
                    std::sync::Arc::new(app.handle().clone()),
                ));
            let (cleanup_pool, cleanup_dir, cleanup_lock) = (
                state.pool.clone(),
                state.epg_cache_dir.clone(),
                state.epg_refresh_lock.clone(),
            );
            app.manage(state);
            app.manage(epg_service.clone());

            // Off the boot path: drop the 3.1.x guide tables and delete
            // cache files of sources that no longer exist. Every start, so a
            // database a 3.1.x binary ran on in between is cleaned again.
            tauri::async_runtime::spawn_blocking(move || {
                let result = cleanup_pool.get().map_err(AppError::from).and_then(|conn| {
                    epg::sources::boot_cleanup(&conn, &cleanup_dir, &cleanup_lock)
                });
                if let Err(e) = result {
                    log::warn!("EPG clean-up at startup failed: {}", e);
                }
            });

            // TMDB enrichment: one search per visible title, plus the opt-in
            // library scan once the first channel load is out of the way.
            tmdb::enrich::spawn_worker(app.handle().clone());
            let scan_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(tmdb::enrich::BACKGROUND_SCAN_START_DELAY).await;
                tmdb::enrich::schedule_library_scan(scan_handle);
            });

            // Background guide refresh: every source due for the active
            // profile, one at a time. Parsing and storing run on the
            // blocking pool inside the ingest.
            tauri::async_runtime::spawn(epg_service.run_background());

            // iptv-org logo fallbacks: expire dead marks and refresh the list
            // weekly, well after startup.
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(logo_fallback::LOGO_FALLBACK_START_DELAY).await;
                logo_fallback::run_maintenance(logo_pool, logo_lock, false).await;
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
            // Series commands
            get_series_info,
            get_xtream_series_id,
            play_episode_with_season,
            get_local_series_info,
            play_series_episodes,
            // Settings commands
            get_setting,
            set_setting,
            // Logo fallback
            report_dead_logos,
            // Profile management commands
            get_active_profile_id,
            set_active_profile_id,
            rename_playlist,
            // EPG commands
            get_epg_now_next,
            get_epg_guide,
            get_epg_guide_keys,
            add_epg_source,
            update_epg_source,
            remove_epg_source,
            refresh_epg,
            set_epg_time_policy,
            // EPG commands kept for the current frontend (temporary)
            fetch_epg_data,
            get_channel_epg,
            get_channels_epg,
            get_guide,
            get_guide_epg_ids,
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
            // TMDB
            get_tmdb_cards,
            get_tmdb_status,
            check_tmdb_key,
            get_tmdb_details,
            get_tmdb_season,
            search_tmdb,
            set_tmdb_match,
            delete_tmdb_cache,
            get_home_rows,
            get_home_pick,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod desktop_entry_tests {
    const TEMPLATE: &str = include_str!("../templates/better-iptv.desktop");
    const CONFIG: &str = include_str!("../tauri.conf.json");
    const CAPABILITY: &str = include_str!("../capabilities/default.json");

    /// Without a `log:` permission every `plugin:log|log` call from
    /// `src/lib/logger.ts` is denied and the frontend never reaches the log file.
    #[test]
    fn default_capability_allows_frontend_logging() {
        let capability: serde_json::Value =
            serde_json::from_str(CAPABILITY).expect("capability must be valid JSON");
        let permissions = capability["permissions"]
            .as_array()
            .expect("capability must list permissions");

        assert!(
            permissions.iter().any(|p| p == "log:default"),
            "the main window needs log:default for frontend log records"
        );
    }

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
