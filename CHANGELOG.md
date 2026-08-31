# Changelog

All notable changes to Better IPTV will be documented in this file.
This file is a developer-changelog, aimed towards development changes.

## [Unreleased]

### Added

- **MPV Playback Settings** - Full control over video playback from the Playback tab
  - Video Output: `gpu-next` (default), `gpu`, or `x11` software fallback (`--vo`)
  - Deinterlacing: auto (default), always on, or off (`--deinterlace`)
  - Start in Fullscreen: launch MPV fullscreen (`--fullscreen`)
  - Start Volume: 0-100% slider (`--volume`)
  - Cache Duration: 10s to 5min for stream buffering (`--cache-secs`)
  - Hardware Acceleration toggle now actually works (was UI-only before)
  - All settings persisted in SQLite and read via single `get_multiple_settings` call
  - Backend refactored: `MpvPlaybackOptions` struct replaces scattered args, shared by channel and series playback

- **Reorganized Settings Tabs** - Cleaner settings layout with 6 tabs (was 5)
  - General: theme, playlist refresh, user-agent (slimmed down)
  - Playback: all MPV settings + audio/subtitle language (moved from General)
  - EPG: dedicated tab for EPG URL, status, and force refresh (extracted from General)
  - Parental, Profiles, About: unchanged
  - Keyboard shortcuts updated to Ctrl+1-6

- **Channel Logo Fallback** - Graceful fallback when channel logos fail to load
  - Added `onError` handler on logo `<img>` to detect broken/unreachable logo URLs
  - Falls back to gradient + initial letter instead of showing a broken image
  - State resets on remount so logos get a fresh attempt when scrolled back into view

- **Next Program in Channel Cards** - Show upcoming EPG program on channel cards
  - Channel cards now display both current (📺) and next (⏭) program titles
  - Backend already returned next program data; frontend now captures and displays it
  - `channelEpgData` store changed from `Map<number, string>` to `Map<number, { current, next? }>`
  - Next program shown in muted gray below the current program in blue

- **Design Token Layer** - Semantic colors and a fluid type scale
  - CSS variables in `src/index.css` for the roles the UI has: `bg`, `surface`, `surface-hover`, `text`, `text-muted`, `border`, `accent`, `accent-hover`
  - Exposed as Tailwind colors via `rgb(var(--color-x) / <alpha-value>)`, so `bg-surface` replaces `bg-white dark:bg-gray-800` and opacity modifiers like `bg-surface/50` still work
  - Values are this app's existing palette, counted off the codebase rather than chosen fresh — `bg-white`/`dark:bg-gray-800` appears 17 times, plus `border-gray-200`/`dark:border-gray-700`, `bg-gray-50`/`dark:bg-gray-900`, `hover:bg-gray-100`/`dark:hover:bg-gray-700`
  - Accent stays `blue-600` in both themes: accent surfaces always carry white text, and white on `blue-500` measures 3.68:1, under the 4.5:1 AA threshold. `blue-600` gives 5.17:1
  - `fontSize` scale `fluid-xs` … `fluid-3xl` using `clamp()`, for use on a TV as well as a desktop monitor. Added but not yet applied to components
  - Purely additive — the default palette is untouched, so existing `gray-*` classes still resolve and components migrate one at a time
  - Idea adapted from PR #57 by @andrezinhovg; palette values, accent choice and contrast work are ours

### Fixed

- **Channel Cards Now Play on Click** - The whole card is a click target, not just the Play button (Issue: #55)
  - Reported twice on Windows as "clicking a channel does nothing" (#55). Nothing was swallowing the click: the card body simply had no `onClick`, so only the Play button, the favorite star and the parental overlay were live pixels
  - The reporter noting that "keyboard navigation works" is the same finding from the other side - there is no arrow-key navigation in the app, so what worked was Tab landing on the Play button and Enter firing the very same handler
  - Card root gets `onClick` + `cursor-pointer`; the Play button now calls `stopPropagation()` so a click on it fires `onPlay` once instead of twice (the second call would have toggled playback straight back off)
  - Card stays a plain `div` - no `role`/`tabIndex`. It is a mouse shortcut, not a second control: a `role="button"` card would nest buttons inside a button and add a third tab stop to every card in a 10,000-channel list. The Play button remains the keyboard and screen-reader path
  - Logo `<img>` set to `draggable={false}`: images are draggable by default, and a click that starts with a few pixels of drag becomes a drag gesture that never fires a click - on the biggest target on the card
  - Covered by `src/test/components/ChannelCard.click.test.tsx`

- **Log File Paths Were Wrong on Every Platform** - Documentation pointed users at directories that do not exist (Issue: #55)
  - Verified against `tauri-2.10.3/src/path/desktop.rs:278-290`: `app_log_dir()` resolves to `dirs::data_local_dir()/<identifier>/logs`, and on macOS to `~/Library/Logs/<identifier>`
  - Windows said `%APPDATA%` (Roaming) - logs are written to `%LOCALAPPDATA%`
  - Linux omitted the identifier: `~/.local/share/better-ip-tv/logs` should be `~/.local/share/com.m0s.better-ip-tv/logs`
  - macOS said `~/Library/Application Support/...` - logs are in `~/Library/Logs/com.m0s.better-ip-tv/`
  - This is why bug reports arrive without logs: the reporter on #55 answered the log request with "I don't have such a file"
  - Corrected in `README.md`, `.github/ISSUE_TEMPLATE/bug_report.yml` and `CLAUDE.md`

- **Theme Switcher** - Light/dark/system theme now actually works
  - Previously, `index.html` had `class="dark"` hardcoded and no code toggled it
  - New `src/lib/theme.ts` module: `applyTheme()` sets/removes `dark` class on `<html>`, listens to `prefers-color-scheme` for "system" mode
  - Theme applied instantly on click (no need to save first)
  - `localStorage` cache prevents flash of wrong theme on startup; SQLite remains authoritative
  - `<body>` background now uses `bg-gray-100 dark:bg-gray-900` instead of hardcoded `bg-gray-900`

- **Parental Controls Bypass** - Require PIN to disable parental controls
  - Previously, unchecking "Enable Parental Controls" bypassed PIN protection entirely
  - Now triggers PIN verification modal when a PIN is set and user tries to disable
  - Enabling parental controls still works without PIN (nothing to protect yet)

- **Xtream Series Parsing** - Tolerate mixed string/number types from provider panels
  - Xtream panels are inconsistent about JSON scalar types: the same field arrives as `3` from one provider and `"3"` from another, IDs flip between quoted and bare, and optional numbers arrive as `""` instead of `null`
  - serde is strict by default, so a single mistyped field rejected the *entire* response — one odd `episode_num` lost the whole series listing
  - New `LooseScalar` untagged enum plus `de_lenient_*` helpers widen what is accepted for `Season`, `Episode`, `EpisodeInfo`, `SeriesMetadata` and `XtreamStream`; anything that parsed before parses identically
  - Out-of-range integers now error instead of silently truncating through `as i32`
  - Also covers two fields beyond the reported ones: `SeriesMetadata.rating` (declared `String`, sent as a number) and `XtreamStream.stream_id`/`num` (declared `i64`, sent quoted)
  - Found via PR #56 by @andrezinhovg

- **Missing Series Artwork** - Add `cover` alias to `XtreamStream.stream_icon`
  - `get_series` returns artwork as `cover` while `get_live_streams`/`get_vod_streams` use `stream_icon`
  - Without the alias, series responses parsed cleanly but silently yielded `stream_icon: None`, so every series lost its artwork with no error anywhere
  - Found via PR #56 by @andrezinhovg

- **Playlist Refresh on Large Playlists** - Avoid SQLite's bound-parameter limit when pruning stale channels
  - The prune step built `id NOT IN (?, ?, ...)` with one bound parameter per kept channel
  - Once the keep-set reached `SQLITE_MAX_VARIABLE_NUMBER` (32766) the refresh failed with `variable number must be between ?1 and ?32766` — reachable on real playlists, which routinely exceed that once VOD is included
  - Now passes the ids as a single JSON array and prunes via `json_each()`, binding exactly 2 parameters regardless of playlist size
  - Measured against a temp-table approach at 49k kept ids: `json_each` 183ms vs temp table 337ms, and it leaves no per-connection state behind on pooled connections
  - Found via PR #56 by @andrezinhovg

- **Provider Logos over Plain HTTP** - Allow `http:` in the CSP `img-src` directive
  - Logos render as raw `<img src={channel.logo}>`; many providers still serve them over plain HTTP, so they were blocked outright
  - Trade-off accepted knowingly: `img-src http:` permits mixed-content images, so a network attacker could substitute logo imagery. `connect-src`/`media-src` already allowed `http:` for the streams themselves
  - Found via PR #56 by @andrezinhovg

- **Stale Profile Name After Rename** - Keep `currentPlaylist` in sync
  - `currentPlaylist` is its own copy in the store rather than a lookup into `playlists`, so renaming the active profile updated only the list
  - Three consumers kept showing the old name until the next profile switch or restart: Settings > General, the refresh modal, and the stale-playlist prompt
  - Found via PR #56 by @andrezinhovg

- **Broken Production Build** - `useEpgData` return type no longer contradicts the store
  - `UseEpgDataResult.channelEpgData` was still `Map<number, string>` after the next-program work widened the store to `Map<number, { current, next? }>`
  - `npm run build` runs `tsc && vite build`, so this failed the build outright; caught while verifying the fixes above

- **ESLint Browser Globals** - Add `localStorage`, `MediaQueryList`, `MediaQueryListEvent`
  - The globals list is maintained by hand; the theme switcher work introduced uses that were not declared, so `npm run lint` reported 4 `no-undef` errors

- **Category Bar Ignored the Light Theme** - The one component sitting inline in the main UI with no light-mode variant
  - `bg-gray-800/50` band, `bg-gray-700` chips and `focus:ring-offset-gray-900` rendered as a dark band across an otherwise light app once the theme switcher started working
  - Migrated to design tokens; the band, chips, focus ring and accent now all follow the theme
  - Inactive chip text moved from `text-gray-300` to `text-text`: 14.7:1 against the chip surface instead of 7.0:1, which matters at TV viewing distance. The active chip is still distinguished by its accent fill
  - Chips gained a border matching the channel cards — chip against band is only 1.2:1 on its own, so without an edge they dissolve into the bar. Border sits on the shared base class so active and inactive chips stay the same size and nothing shifts when the selection moves

- **CI Would Have Failed on the Next Push** - Two blockers in `test.yml`, both found while verifying the above
  - `npm run format:check` failed on 5 files, all touched by recent work: `ChannelCard.tsx`, `Settings.tsx`, `settings/constants.ts`, `settings/GeneralTab.tsx`, `hooks/useEpgData.ts`. Formatting only — the sole non-whitespace changes were trailing commas
  - `cargo clippy --all-targets -- -D warnings` failed on `channel_domain::sort_by_name` (`unnecessary_sort_by`). That line dates from the December refactor and is present on `origin/main`; it only started failing because CI pins `stable` and the lint tightened in clippy 1.98. Replaced with `sort_by_key`, matching the sibling sort functions. It was the crate's only clippy warning

### Changed

- **README Brought Back in Sync With the App** - Rewrote the parts that no longer described what ships
  - Quick Start described buttons that do not exist: the setup screen has **M3U URL** / **Xtream Codes** tabs and an **Add Playlist** button, not "Import M3U Playlist" and a Local File / URL chooser
  - EPG setup moved to Settings → **EPG**, and the settings shortcut is `Ctrl+1-6`, matching the six-tab reorganization in this release
  - Download table now lists the real release asset names (`Better.IPTV_<version>_...`, dots not hyphens). The Windows `.exe` is an NSIS setup installer, not a portable build, and the `.dmg` is Apple Silicon only - both were described wrong
  - `-arch.AppImage` guidance widened past Arch: it is the right build on any distro with a current `webkit2gtk`, Fedora included (Issue: #54). Names the `EGL_BAD_PARAMETER` symptom so the error text is searchable
  - MPV section leads with Windows needing nothing, and drops the "New in v2.3.0" marker three releases later. Same for the FAQ entry
  - Parental troubleshooting no longer tells people to upgrade to v2.3.0; replaced with the PIN reset that actually helps
  - New "Where your files live" table for the database and the log, because `app_data_dir()` and `app_log_dir()` resolve to different roots on Windows (Roaming vs Local) and macOS (Application Support vs Logs)
  - Playback Settings added to the feature list; language count corrected from 19 to 18 (the 19th entry is "None (Original)"); channel-count claims unified on the 150,000 figure the FAQ already used
  - Playing a channel now documented as clicking anywhere on the card

- **Channel Artwork Fit** - Fit artwork to the card based on content type
  - Movie and series artwork is poster-shaped and designed to fill its frame, so it is now cropped to the card with `object-cover`
  - Live channel logos are wide, transparent marks with their own margins; cropping those cuts the logo, so they stay letterboxed with `object-contain`
  - Adds `decoding="async"` on the artwork so image decode does not block the main thread during scroll

### Removed

- **Unreachable Components** - `ChannelHeader`, `SectionErrorBoundary` and `withSectionErrorBoundary`
  - All three had zero references anywhere in `src`; `App.tsx` uses `ErrorBoundary` and nothing else
  - `SectionErrorBoundary` also carried a bug no one could hit: `text-white` over a translucent `bg-red-500/5` panel, i.e. invisible text in light mode. Deleting it removes the bug with the code

### Performance

- **Scroll Performance** - Eliminate GPU paint thrashing and reduce unnecessary re-renders
  - Remove `transition-shadow` from ChannelCard: stops GPU from rasterizing shadow blur every frame during scroll (biggest single improvement for weak hardware like Intel HD 620)
  - Increase virtualizer overscan from 3 to 5: pre-renders more rows to reduce DOM churn at scroll boundaries
  - Stabilize `handlePlayChannel` callback: read parental control state via `getState()` at call time instead of reactive dependencies, reducing dependency array from 6 to 1 so `ChannelCard` `memo()` properly skips re-renders during scroll

### Tests

- Add `ChannelCard.memo.test.ts` documenting Zustand store action reference stability
- Add `lenient_scalar_tests` covering every Xtream JSON shape that previously failed to parse, including the silent `cover` artwork loss and out-of-range integer rejection
- Add `test_merge_channels_prunes_playlist_larger_than_sqlite_variable_limit`, exercising 33 000 kept channels. The count must stay above 32766 for the test to mean anything — verified to fail against the old implementation and pass against the new one

### Credits

Thanks to @andrezinhovg for reporting the Xtream parsing, SQLite prune, CSP and
profile-rename issues in PR #56. The fixes shipped here were written
independently, but the underlying bugs — including the silent loss of series
artwork, which produced no error of any kind — were found through that report.

The design token layer and fluid type scale come from the same contributor's
TV-readability work in PR #57 and #58. Those branches predate several commits on
main and could not be merged, but the idea is a good one and is adopted here on
current code — with this project's own palette values, a blue accent to match
the logo, and contrast measured rather than assumed.

## [2.6.1] - 2026-03-10

### Fixed

- **Scroll Performance** - Stabilize ChannelCard `React.memo()` callbacks
  - Replace inline arrow functions (`onPlay`, `onToggleFavorite`) with stable callback references
  - Previously, every scroll frame created ~56 new function references (28 visible cards × 2 callbacks), defeating memo()
  - Now only cards entering/leaving the viewport actually re-render
  - Reduce MPV status polling interval from 1s to 3s (fewer IPC calls during playback)

## [2.6.0] - 2026-03-09

### Added

- **About Tab** - New settings tab with app info, PayPal/crypto donation CTAs, and log folder shortcut
  - `truncateAddress` utility for crypto address display with tests
  - Uses `tauri-plugin-opener` (`openPath`/`openUrl`) for external links
  - Keyboard shortcut: Ctrl+5

- **Expanded Logging** - Comprehensive backend logging coverage
  - Channel commands: debug logging for get/search/favorite operations with result counts
  - Playback commands: info logging for play/stop with channel name and content type
  - M3U import: info log at start (matching Xtream pattern)
  - Settings: debug logging for get/set operations
  - Performance timing: `Instant`-based elapsed time for batch insert, merge, EPG fetch/parse/store
  - App startup: version, database path, connection pool size
  - Removed `is_playing` debug log from polling endpoint (fired every second, spamming logfile)

### Changed

- **SQLite Connection Pooling** - Replace single `Arc<Mutex<Connection>>` with r2d2 pool
  - New deps: `r2d2 0.8`, `r2d2_sqlite 0.25`
  - Pool size: 4 connections with per-connection PRAGMA initialization
  - Concurrent reads in WAL mode, serialized writes (SQLite native behavior)
  - Commands use `pool.get()` instead of `state.db.lock().await`

- **Parameterized SQL** - Eliminate dynamic SQL string formatting
  - `merge_channels`: dynamic parameterized delete via `Vec<Box<dyn ToSql>>`
  - `get_stale_playlists`: days parameter via SQL bind instead of format interpolation

- **Code Quality**
  - DRY: `map_playlist_row()` + `PLAYLIST_SELECT_COLUMNS` (mirrors existing channel pattern)
  - DRY: Shared `db/test_helpers.rs` for test setup functions
  - `create_channels_batch`: use `prepare_cached` for repeated inserts
  - Dead code: `#[cfg(test)]` for test-only `create_channel`, removed unused model structs

- **UI Performance Optimization** - Systematic re-render elimination and search pipeline rework
  - Zustand selectors: replace full-store destructuring with individual selectors across MainScreen, CategoryBar, useKeyboardShortcuts, useEpgData, useChannelFilter
  - Component memoization: `React.memo` on NowPlayingBar, ContentTypeTabs, SearchBar, CategoryBar
  - Stable callback refs: `useCallback` on handlePlayChannel, handlePlayEpisode, handlePinSuccess, handleStop
  - Search debounce: new `useDebouncedValue` hook (300ms) decouples typing from filtering
  - Filter consolidation: MainScreen's inline 13-dependency filter effect replaced by `useChannelFilter` hook with `useMemo` base list selection
  - Polling dedup: remove duplicate `isPlaying` (2s) and EPG (60s) intervals from MainScreen, delegate to `useChannelPlayback` hook
  - `toggleChannelFavorite`: rebuild only affected content-type array instead of all 6 arrays
  - Parental blocking cache: `useMemo` Map replaces per-card `shouldBlockChannel` calls in render loop

### Removed

- Unused `react-window` dependency (replaced by `@tanstack/react-virtual`)
- Unused `src/assets/react.svg`

## [2.5.0] - 2026-02-26

### Added

- **Favorites System** - Full favorites support with dedicated tab and interactive toggle
  - New "Favorites" tab in content type navigation (alongside All/Live/Movies/Series)
  - Star icon tab using `lucide-react` Star component
  - Clickable favorite star on every channel card (top-right of logo area)
  - Non-favorites show subtle star on hover, favorites show filled yellow star
  - Accessible `<button>` with dynamic `aria-label` ("Add to favorites" / "Remove from favorites")
  - `toggleChannelFavorite` store action: persists via IPC then updates all local state arrays
  - `favoriteChannels` pre-filtered array in Zustand store (same pattern as liveChannels/vodChannels/seriesChannels)
  - Favorites span all content types (live, vod, series) in a single view
  - CategoryBar hidden when Favorites tab is active (prevents invalid backend call)
  - Search works within favorites
  - Parental controls apply to favorites
  - Implementation:
    - Type: `ContentTypeFilter` extended with `'favorites'` in `useChannelFilter.ts`, `player-store.ts`
    - Store: `favoriteChannels` + `toggleChannelFavorite` in `stores/player-store.ts`
    - UI: `ContentTypeTabs.tsx` (new tab), `ChannelCard.tsx` (interactive star)
    - Integration: `MainScreen.tsx` (filter switch, CategoryBar guard, toggle wiring)
    - Hook: `useChannelFilter.ts` (favorites case in switch)
  - Backend: No changes needed (existing `toggle_favorite`, `get_favorites`, `is_favorite` column)

- **Playlist User-Agent Settings** - Configurable request identity for provider compatibility
  - New setting in Settings > General > Playlist Requests
  - Presets: `Default (Better-IP-TV)`, `TiviMate`, `VLC`, and `Custom`
  - Custom value input with live preview of current HTTP header
  - Input validation on frontend and backend (trim, max length, no line breaks)
  - Implementation:
    - Frontend: `GeneralTab.tsx`, `Settings.tsx`, `settings/constants.ts`
    - Backend: validation in `commands/settings.rs`
    - Backend: resolution utilities in `http.rs`

### Changed

- **Playlist/Xtream Request Behavior** - Selected User-Agent is now applied to playlist fetches
  - M3U URL imports and refreshes send selected User-Agent
  - Xtream API channel/category requests send selected User-Agent
  - Implementation: `commands/playlist.rs`, `playlist/parser.rs`, `playlist/xtream.rs`

- **EPG User-Agent Scope (Xtream-only)** - EPG requests reuse selected User-Agent only for active Xtream EPG URL
  - If EPG URL matches active profile Xtream `xmltv.php` endpoint, playlist User-Agent is reused
  - External/custom EPG URLs keep default HTTP behavior (no forced custom/preset override)
  - Implementation: `commands/epg.rs`, `epg/xmltv.rs`

### Improved

- **User-Agent Fallback Safety** - Invalid custom values safely fall back to app default
  - Prevents malformed header values from breaking imports/refresh

## [2.4.0] - 2026-01-27

### Added

- **Keyboard Shortcuts** - Global media shortcuts for faster navigation
  - Space: Toggle play/stop (suppressed in input fields)
  - `/`: Focus search bar
  - Escape: Stop playback
  - Guards against firing inside input/textarea/select elements
  - Implementation:
    - New `useKeyboardShortcuts` hook in `src/hooks/useKeyboardShortcuts.ts`
    - `SearchBar` converted to `forwardRef` for keyboard focus support
    - Hook activated in `MainScreen.tsx` with search input ref

- **Playlist Auto-Refresh (Merge-based)** - Keep channel lists up to date
  - Startup stale check: prompts user if playlist >7 days old
  - Manual refresh button in Settings > General > Playlist section
  - Merge strategy preserves favorites for existing channels
  - Xtream match key: `stream_id` extracted from URL path
  - M3U match key: `(name, group_name)` with `name`-only fallback
  - Removed channels deleted from DB; new channels inserted; existing updated
  - Progress modal with live/vod/series counts during fetch
  - Summary modal showing added/updated/removed counts
  - Implementation:
    - Backend: `merge_channels()` in `mutations.rs` (single transaction)
    - Backend: `extract_stream_id_from_url()` helper for Xtream URL parsing
    - Backend: `update_playlist_last_updated()` in `mutations.rs`
    - Backend: `get_stale_playlists()` query in `queries.rs`
    - Backend: `refresh_playlist` and `get_stale_playlist_ids` commands in `commands/playlist.rs`
    - Frontend: `RefreshModal` component in `src/components/modals/RefreshModal.tsx`
    - Frontend: `refreshPlaylist()` and `getStalePlaylistIds()` IPC wrappers
    - Frontend: `MergeResult` type in `src/types/index.ts`
    - Frontend: Refresh button in `GeneralTab.tsx`, stale prompt in `MainScreen.tsx`
    - Model: `MergeResult` struct in `db/models.rs`

- **Force EPG Update** - Manual EPG refresh button in Settings
  - New "Update Now" button in Settings > General > EPG section
  - Shows EPG status: last updated timestamp and program count
  - Refreshes EPG data from configured URL without changing settings
  - Useful when EPG source updates data or after network issues
  - Loading spinner and disabled state during update
  - Error handling with user-friendly messages
  - Implementation:
    - Backend: `force_refresh_epg` and `get_epg_status` commands in `commands/epg.rs`
    - Database: `get_epg_program_count` query, `epg_last_fetched` setting
    - Frontend: EPG status card with refresh button in `Settings.tsx`
    - TypeScript: `EpgStatus` and `EpgRefreshResult` types in `lib/tauri.ts`

- **Xtream EPG Auto-Population** - Automatic EPG URL setup for Xtream providers
  - When importing Xtream playlist, EPG URL is auto-populated from provider
  - Uses standard Xtream `xmltv.php` endpoint with credentials
  - EPG URL defaults to Xtream provider when cleared (never empty for Xtream users)
  - User can still override with custom EPG source in settings
  - Implementation:
    - Backend: `get_xtream_epg_url()` helper in `playlist/xtream.rs`
    - Auto-save in `import_xtream_playlist` command after successful import
    - Default fallback in `set_setting` command when `epg_url` is empty
    - Database: `get_playlist_by_id` query in `queries.rs`
    - Utility: `mask_credentials()` for safe logging of EPG URLs

### Improved

- **SQLite WAL Mode & PRAGMAs** - Database performance and correctness improvements
  - Enabled WAL (Write-Ahead Logging) for better concurrent read/write performance
  - Enabled `foreign_keys = ON` — CASCADE deletes were silently ignored without this
  - Set `synchronous = NORMAL` (safe with WAL, faster than default FULL)
  - Set `cache_size = 10000` (~40MB) and `temp_store = memory`
  - Implementation: `lib.rs` — `execute_batch` after `Connection::open()`

- **Release Profile Optimization** - Smaller and faster production binaries
  - Added `[profile.release]` to `Cargo.toml`: `lto = true`, `codegen-units = 1`, `strip = true`
  - Skipped `panic = 'abort'` — Tauri needs unwind for cleanup

- **Settings Component Refactoring** - Modular architecture for better maintainability
  - Split 717-line monolith into focused tab components (~150 lines each)
  - New structure: `src/components/settings/`
    - `GeneralTab.tsx` - EPG, Theme, Language settings
    - `PlaybackTab.tsx` - Hardware acceleration
    - `ParentalTab.tsx` - PIN, channel blocking, visibility modes
    - `constants.ts` - Shared types (Theme, LanguageCode, ParentalVisibility)
    - `index.ts` - Barrel exports
  - Main `Settings.tsx` now thin orchestrator (413 lines, handles state + modals)
  - Tab components are pure presentation (props in, UI out) - easier to test
  - Contributor-friendly: each feature area isolated in its own file

- **MainScreen Component Cleanup** - Use existing extracted components
  - Replaced inline code with existing `SearchBar`, `ContentTypeTabs`, `NowPlayingBar` components
  - Reduced MainScreen.tsx from 606 to 503 lines (-103 lines)
  - Removed unused icon imports (Search, Tv, Film, Clapperboard, Square)
  - Better accessibility: NowPlayingBar has aria-label on stop button

- **Consolidated Credential Masking** - Single implementation for URL credential masking
  - Merged duplicate `mask_credentials()` (utils) and `mask_sensitive_data()` (mpv.rs)
  - Uses `lazy_static` for one-time regex compilation (better performance)
  - Now handles both query params (`?username=X`) and Xtream path-based URLs (`/series/user/pass/`)
  - Removed regex dependency from playback/mpv.rs

### Fixed

### Changed

## [2.3.1] - 2025-12-29

### Fixed

- **Linux EGL Display Fix for Arch/Manjaro** - Fixed "Could not create default EGL display: EGL_BAD_PARAMETER" crash on Arch Linux and other rolling-release distros
  - Root cause: Bundled WebKit libs from Ubuntu conflicted with Wayland/EGL on newer systems
  - Solution: New Arch-compatible AppImage (`*-arch.AppImage`) without bundled WebKit libs
  - Uses system WebKit which is properly integrated with the graphics stack
  - Regular AppImage still available for Ubuntu/Debian users
  - Implementation:
    - `.github/workflows/release.yml`: Creates separate Arch AppImage after main build
    - Extracts AppImage, removes bundled webkit2gtk/gdk-pixbuf/gio/gtk libs, repacks
    - AUR package updated to use Arch-specific AppImage

### Changed

- **Release artifacts now include two Linux AppImage variants**:
  - `Better.IPTV_x.x.x_amd64.AppImage` - Full bundle for Ubuntu/Debian
  - `Better.IPTV_x.x.x_amd64-arch.AppImage` - Arch-compatible (uses system libs)

## [2.3.0] - 2025-12-23

### Added

- **Parental Controls** - Comprehensive content restriction system with PIN protection
  - **PIN Protection**: Secure 4-6 digit PIN with Argon2 hashing
    - Backend: `set_parental_pin`, `verify_parental_pin`, `reset_parental_pin` commands
    - Argon2 password hashing (memory-hard, GPU-resistant)
    - Unique cryptographic salt per PIN
  - **Manual Channel Blocking**: Select specific channels to block
    - Virtualized channel selection modal for performance with 10,000+ channels
    - Search and bulk select/deselect functionality
    - Blocked channels stored as JSON array in settings
  - **Auto-Detection**: Automatic blocking of adult content
    - Regex patterns for +18, XXX, Adult, Erotic, Porn markers
    - Configurable toggle in Settings
  - **Category Blocking**: Block entire channel categories at once
  - **Three Visibility Modes**:
    - Hide: Blocked channels completely filtered from list (default)
    - Lock Icon: Shows channel with lock icon overlay (clickable to unlock)
    - Blur: Shows blurred channel with lock icon (clickable to unlock)
  - **PIN Verification Before Playback**: Blocked channels require PIN before streaming
    - Click on blocked channel (or lock overlay) triggers PIN modal
    - Correct PIN unlocks and starts playback
    - Incorrect PIN shows error, prevents playback
  - **Secure PIN Reset**: Must verify current PIN before resetting parental controls
  - **Session-Based Unlock**: Temporarily unlock with PIN (resets on app restart)
  - **Filter Integration**: Parental filter applied between category and search filters
  - Implementation:
    - Backend: 6 new Tauri commands in `src-tauri/src/commands.rs` (~140 lines)
    - Database: `delete_setting()` helper function
    - Frontend: Extended Zustand store with parental state
    - Utilities: `src/lib/parentalControls.ts` - Detection and filtering logic
    - Modals: `PinEntryModal.tsx`, `ChannelBlockingModal.tsx`
    - UI: Comprehensive Parental Controls section in Settings
    - Visual: Lock/blur overlay system in `ChannelCard.tsx`

- **Bundled MPV for Windows** - MPV player now included in Windows installer
  - Windows installer size increased from ~6MB to ~100MB
  - Latest MPV Windows build bundled in `resources/mpv/` directory
  - MPV uses date-based builds (format: `mpv-x86_64-YYYYMMDD-git-HASH.7z`)
  - Automatic fallback to system MPV if bundled version fails
  - Eliminates need for manual MPV installation on Windows
  - Implementation:
    - `scripts/download-mpv.sh`: Downloads MPV Windows build (supports version argument)
    - `src-tauri/tauri.conf.json`: Bundles MPV in Windows resources
    - `src-tauri/src/mpv/player.rs`: `get_mpv_path()` checks bundled path first on Windows
    - `.github/workflows/release.yml`: Downloads MPV during Windows build
  - macOS and Linux still use system MPV (via Homebrew/package managers)

### Changed

- **Modal System - Replaced native browser dialogs**
  - Created reusable modal components: `ConfirmationModal.tsx` and `ErrorModal.tsx`
  - Replaced all `window.confirm()` and `alert()` calls across the application
  - Affected components:
    - `Settings.tsx`: PIN reset confirmation, save error handling
    - `ProfileManager.tsx`: Profile operations errors (5 instances)
    - `ChannelBlockingModal.tsx`: Save error handling
  - Features:
    - Consistent styling with app theme (light/dark mode support)
    - Customizable titles, messages, and button labels
    - Danger variant for destructive actions (red styling with AlertTriangle icon)
    - Proper z-index layering for nested modals
  - Implementation:
    - `ConfirmationModal`: Supports danger/primary variants, custom button text
    - `ErrorModal`: Red AlertCircle icon, single action button

- **EPG URL Settings - Removed hardcoded default**
  - EPG URL field now starts empty instead of pre-filled with `https://iptv-epg.org/files/epg-se.xml.gz`
  - Added helpful recommendation text with clickable link to iptv-epg.org
  - Prevents confusion for users whose Xtream providers include EPG data
  - Implementation: `Settings.tsx` lines 39-40 (state initialization) and lines 246-256 (help text)

- **MPV Path Resolution (Windows)** - New platform-specific logic
  - Windows: Checks `resources/mpv/mpv.exe` first, falls back to system PATH
  - macOS/Linux: Uses system MPV only (unchanged behavior)

### Performance

- **Channel Blocking Modal Optimization** - Virtualized rendering for large channel lists
  - Uses `@tanstack/react-virtual` for efficient DOM rendering
  - Renders only ~10-15 visible items instead of all channels
  - Smooth scrolling and instant search with 10,000+ channels
  - 68px estimated item height with 5-item overscan buffer

### Refactored

- **Rust Backend Architecture** - Comprehensive code organization refactoring for maintainability and testability

  **Commands Layer Reorganization**
  - Split monolithic `commands.rs` (668 lines) into 7 focused command modules:
    - `commands/playback.rs` - MPV playback control (59 lines)
    - `commands/playlist.rs` - M3U and Xtream playlist management (215 lines)
    - `commands/channel.rs` - Channel queries and favorites (52 lines)
    - `commands/epg.rs` - EPG data fetching (50 lines)
    - `commands/series.rs` - Series/VOD playback (118 lines)
    - `commands/settings.rs` - Settings and profile management (60 lines)
    - `commands/parental.rs` - Parental controls (130 lines)
  - All commands maintain identical signatures - zero breaking changes
  - Clear module boundaries with `commands/mod.rs` re-exporting all commands

  **Database Layer Separation**
  - Split `db/operations.rs` into focused CQRS pattern:
    - `db/queries.rs` - All SELECT queries (read operations, 420 lines)
      - Functions: `get_playlists`, `get_channels`, `search_channels`, `get_favorites`, `get_setting`, `get_multiple_settings`, `get_channel_groups`
    - `db/mutations.rs` - All INSERT/UPDATE/DELETE (write operations, 349 lines)
      - Functions: `create_playlist`, `delete_playlist`, `rename_playlist`, `create_channels_batch`, `toggle_favorite`, `set_setting`, `delete_setting`, `update_channel_epg_ids`
  - 35 unit tests for database operations

  **Domain Business Logic Extraction**
  - Created 5 new domain modules for pure business logic (sync, no database, no async):
    - `playlist_domain/mod.rs` (342 lines, 11 tests)
      - Validation: `validate_playlist_name`, `validate_playlist_source`, `validate_xtream_credentials`
      - Construction: `build_m3u_playlist`, `build_xtream_playlist`
      - Utilities: `assign_playlist_id_to_channels`, `batch_channels` (with `DEFAULT_BATCH_SIZE = 1000`)
    - `channel_domain/mod.rs` (437 lines, with planned filter/sort functions)
      - Validation: `validate_search_query`, `validate_content_type`, `validate_playlist_id`, `validate_channel_id`
      - Filtering: `filter_by_content_type`, `filter_favorites`, `filter_by_playlist`, `filter_by_group` (planned)
      - Sorting: `sort_by_name`, `sort_by_order`, `sort_by_category_order` (planned)
      - Search: `normalize_search_query`, `matches_search_query` (planned)
    - `epg_domain/mod.rs` (157 lines, 13 tests)
      - Validation: `validate_epg_url`, `validate_channel_epg_id`
      - Utilities: `normalize_epg_url`, `is_gzipped_url`
    - `series_domain/mod.rs` (219 lines, 14 tests)
      - Types: `PlaylistEpisode` struct
      - Validation: `validate_server_url`, `validate_credentials`, `validate_episodes`
      - URL Building: `build_episode_urls`
    - `parental_domain/mod.rs` (247 lines, 14 tests)
      - PIN Security: `validate_pin`, `hash_pin`, `verify_pin_hash` (Argon2)
      - Filtering: `is_adult_content`, `should_block_channel` (planned)
  - Extracted playback domain (Week 2, Day 6):
    - `playback/mod.rs` - Business logic orchestration (54 lines)
      - Functions: `play_channel`, `stop`, `is_playing`, `check_mpv_installed`
    - `playback/mpv.rs` - MPV player integration (unchanged location, enhanced validation)
  - All commands updated to delegate business logic to domain modules

  **Code Quality & Security**
  - Fixed ALL 19 clippy warnings:
    - 17 dead code warnings (planned functions marked with `#[allow(dead_code)]`)
    - 1 unnecessary lazy evaluation (`or_else` → `or`)
    - 2 bool assert comparisons (`assert_eq!(x, true)` → `assert!(x)`)
  - Comprehensive URL validation in all domains:
    - EPG: `http://` or `https://` validation, whitespace trimming
    - Series: Server URL and credentials validation
    - Playlist: M3U source and Xtream credentials validation
    - MPV: Multi-protocol support (http, https, rtsp, rtmp, rtp, udp)
  - Security enhancements:
    - Shell injection protection in `playback/mpv.rs` (blocks `, $, ;, |, &, \n)
    - URL length limits (4096 characters max)
    - Credential masking in logs (`password=***REDACTED***`)

  **Testing & Documentation**
  - Test suite expanded: 35 → 93 tests (+165% increase)
  - All domain modules have comprehensive unit tests
  - Zero compilation errors, zero clippy warnings
  - All 93 tests passing (verified with `cargo test --lib`)

  **Benefits**
  - **Maintainability**: Largest file reduced from 668 to ~215 lines (68% reduction)
  - **Testability**: Business logic testable without Tauri/database/async
  - **Separation of Concerns**: Commands (async/IO) vs Domains (sync/logic)
  - **Code Reuse**: Domain functions usable across multiple commands
  - **Developer Experience**: Idiomatic Rust patterns, clear module boundaries
  - **Zero Regressions**: All Tauri commands maintain identical signatures

### Improved

- **Settings UI - Tab-based Navigation**
  - Replaced long scrolling form with clean tab-based layout
  - Four organized tabs: General (EPG, Theme, Language), Playback (Hardware Acceleration), Parental (All parental controls), Profiles (Profile Manager)
  - Keyboard shortcuts: Ctrl+1 (General), Ctrl+2 (Playback), Ctrl+3 (Parental), Ctrl+4 (Profiles)
  - Fixed content height (`min-h-[700px]`) eliminates jumping when switching tabs
  - Modern design with border-bottom navigation instead of filled backgrounds
  - Active tab indicated by blue underline (`border-blue-600`)
  - Improved organization reduces cognitive load: ~175 lines per tab vs 574 all at once
  - Implementation:
    - New components: `src/components/ui/tabs.tsx` (Radix UI Tabs primitives)
    - New utility: `src/lib/utils.ts` (classname merging with `clsx` + `tailwind-merge`)
    - Dependencies: `@radix-ui/react-tabs`, `clsx`, `tailwind-merge`
    - Controlled tab state with keyboard event listener for shortcuts
    - File: `src/components/Settings.tsx` (~580 lines)

### Fixed

- **Parental Controls - Auto-detect now actually blocks channels**
  - Auto-detect toggle now scans all channels and adds adult content to blocked list when saving settings
  - Previously only filtered at runtime without persisting to blocked channels list
  - Now logs: `"Auto-detect found X additional adult channels"`
  - Implementation: `Settings.tsx` handleSave() scans channels using `isAdultContent()` when auto-detect enabled

- **Parental Controls - Visibility modes now work correctly**
  - "Lock Icon" and "Blur" modes now show channels with visual overlay
  - Previously all blocked channels were hidden regardless of visibility mode
  - Filter now only hides channels when `parentalVisibility === 'hide'`
  - Implementation: `MainScreen.tsx` line 110 - Added visibility mode check to parental filter

- **Parental Controls - Lock overlay now clickable**
  - Click anywhere on locked channel card to trigger PIN verification
  - Added visual hover feedback (opacity change) to indicate clickability
  - Tooltip: "Click to unlock with PIN"
  - Implementation: `ChannelCard.tsx` - Added onClick handler to parental overlay div

- **PIN Modal - State reset between uses**
  - PIN modal now resets all state (PIN input, error, isSubmitting) when reopened
  - Previously would show "Processing..." if reopened after successful verification
  - Added useEffect hook that resets state when `isOpen` changes to true
  - Also updated `resetForm()` to include `isSubmitting` state
  - Implementation: `PinEntryModal.tsx` lines 27-36 and line 86

## [2.2.0] - 2025-12-17

### Added

- **Category Quick-Access Bar** - New horizontal scrollable bar for filtering by provider categories
  - Backend: `get_channel_groups()` function in `src-tauri/src/db/operations.rs`
  - Tauri command: `get_channel_groups(playlist_id, content_type?)` returns unique categories
  - Frontend: New `CategoryBar` component with chip-style buttons
  - Zustand store: Added `categoryFilter`, `categories`, `setCategoryFilter`, `setCategories`
  - Auto-fetches categories when content type tab changes
  - Filter resets to "All" when switching content type tabs
  - Supports filtering within Live TV, Movies, and Series tabs independently

- **Provider Category Ordering** - Categories now display in the provider's original order
  - New `category_order` column in channels table stores provider's category position
  - Xtream API categories are fetched and indexed before streams
  - Database migration auto-adds column for existing installations
  - Categories sorted by `MIN(category_order)` instead of alphabetically

- **Category Tests** - 2 new Rust unit tests for `get_channel_groups()` function

### Changed

- Channel filtering logic now includes category filter layer between content type and search

### Fixed

- **Xtream Category Names** - Fixed missing category names from Xtream API
  - Xtream API returns `category_id` in streams but not `category_name`
  - Now fetches categories separately (`get_live_categories`, `get_vod_categories`, `get_series_categories`)
  - Builds category ID → name map before processing streams
  - Users need to re-import playlist for categories to appear

## [2.1.1] - 2025-12-02

### Added

- **Typed Error System (Rust)** - New `AppError` enum in `src-tauri/src/error.rs`
  - Structured error types: `Database`, `Http`, `InvalidInput`, `PlaylistNotFound`, `ChannelNotFound`, `Mpv`, `Parse`, `Epg`, `Io`, `Config`
  - JSON-serializable with `thiserror` + `serde` integration
  - All Tauri commands now return `Result<T, AppError>` instead of `Result<T, String>`
  - Input validation on all commands

- **Frontend Error Handling**
  - `src/types/errors.ts`: TypeScript types matching Rust `AppError`
  - `src/hooks/useErrorHandler.ts`: Toast-based error display with auto-dismiss
  - `SectionErrorBoundary` component for granular error isolation

- **Extracted React Hooks** - Improved code organization
  - `useChannelFilter`: Channel filtering and search logic
  - `useChannelPlayback`: MPV playback control
  - `useEpgData`: EPG fetching with automatic refresh

- **Extracted UI Components**
  - `ChannelCard`: Individual channel display
  - `ChannelHeader`: Page header with playlist info
  - `SearchBar`: Search input with keyboard handling
  - `ContentTypeTabs`: Live/VOD/Series tab navigation
  - `NowPlayingBar`: Current playback status display

- **Database Performance Indexes**
  ```sql
  CREATE INDEX idx_channels_playlist_id ON channels(playlist_id);
  CREATE INDEX idx_channels_epg_id ON channels(epg_id);
  CREATE INDEX idx_watch_history_channel_id ON watch_history(channel_id);
  ```

- **Test Coverage** - 76 automated tests total
  - 32 Rust unit tests (database operations, MPV player, error handling)
  - 44 Frontend tests (error types, hooks, component behavior)

### Changed

- **MPV Player Refactoring** (`src-tauri/src/mpv/player.rs`)
  - Extracted helper methods: `apply_default_args()`, `apply_playback_options()`, `log_command()`, `spawn_mpv()`
  - New `MpvPlaybackOptions` struct for cleaner API
  - ~40% reduction in code duplication

- **MainScreen Component** - Reduced from 800+ to ~400 lines through hook extraction

### Fixed

- Channel ID handling for virtual/temporary channels (now uses `id: -1`)
- Error messages now display Swedish translations for known error types

### Technical Debt

- Consolidated 15+ `.map_err(|e| e.to_string())` patterns into typed errors
- Merged 3 overlapping EPG `useEffect` hooks into single `useEpgData` hook
- Removed string-based error propagation throughout Rust backend

## [2.1.0] - 2025-11-21

### Added

- **Multi-Profile System** - Manage multiple IPTV playlists as profiles
  - Card-based UI in Settings for easy profile management
  - Create, rename, delete, and switch between profiles
  - Active profile indication with visual badge (blue highlight)
  - Automatic profile switching with channel reload
  - Setup component reusable as modal for creating profiles within Settings
  - Automatic migration for existing users (first playlist becomes active profile)
  - Warning modal when attempting to delete the last profile
  - Seamless profile switching preserves EPG and favorites data

- **Language Settings** - Choose default audio and subtitle languages from 19 supported languages
  - Settings stored as ISO language codes for MPV integration
  - Dropdown selectors in Settings > Language Settings
  - Languages: Swedish, English, Norwegian, Danish, Finnish, German, French, Spanish, Italian, Portuguese, Dutch, Polish, Russian, Arabic, Turkish, Japanese, Chinese, Korean, and "Original"
  - MPV receives `--alang=` and `--slang=` parameters for each stream

- **Comprehensive Logging System** - Persistent application logging for troubleshooting
  - Backend: `tauri-plugin-log` with automatic file rotation
  - Frontend: Unified logging across TypeScript/React components
  - Log files stored at platform-specific locations:
    - Linux: `~/.local/share/better-ip-tv/logs/better-ip-tv.log`
    - Windows: `%APPDATA%\com.m0s.better-ip-tv\logs\better-ip-tv.log`
    - macOS: `~/Library/Application Support/com.m0s.better-ip-tv/logs/better-ip-tv.log`
  - Debug level in development, Info level in production
  - 10MB file rotation with 1 archived log retained

- **EPG Fetch Optimization** - Conditional EPG fetching
  - Only fetches EPG data when URL actually changes
  - Prevents unnecessary network requests when saving other settings
  - Added debug logging to track EPG fetch decisions

- **Responsive Grid Layout** - Dynamic card layout that adapts to screen size
  - Cards scale automatically based on viewport dimensions
  - Columns adjust from 2 (mobile) to 7 (4K displays)
  - Card height optimized to show ~4 rows on any screen
  - Improved space utilization on large monitors
  - Smooth resize handling with debounced updates

### Fixed

- **Wayland/Hyprland Compatibility** - Resolved EGL_BAD_PARAMETER crash on Wayland systems
  - Pinned WebKit2GTK to stable version 2.44.1 in GitHub Actions build pipeline
  - Fixes compatibility issues on Arch Linux with Hyprland and other Wayland compositors

- **Dropdown Dark Mode Styling** - Fixed dropdown menu colors in dark theme
  - Added `dark:[color-scheme:dark]` CSS property to properly style native select elements
  - Dropdown now respects dark theme in all browsers

- **Default Tab Selection** - Live TV tab now selected by default
  - Changed default content type filter from "All" to "Live" for better UX
  - Users see live channels immediately when opening the app

- **Non-Functional Setting Removed** - Removed "Remember Position" setting
  - Setting did nothing due to MPV being started with `--no-resume-playback` flag
  - Cleaned up associated MPV flags

- **Credential Masking in Logs** - Sensitive data protection for bug reports
  - Masks Xtream username and password parameters in MPV logs
  - Prevents accidental credential leakage when sharing log files in issue reports
  - Uses regex to replace credentials with `***` while preserving log structure

- **Custom HTTP User-Agent** - Improved provider compatibility
  - All external HTTP requests now use proper user-agent: `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Better-IPTV/2.1.0`
  - Shared HTTP client with connection pooling and reasonable timeouts (30s default)
  - Centralized HTTP client management for consistency
  - Prevents potential provider blocking of generic `reqwest/0.12.x` user-agent

### Changed

- Replaced all console logging with persistent file logging
  - Frontend: `console.*` → `logger.*` (23 replacements)
  - Backend: `println!`/`eprintln!` → log macros (27 replacements)

## [2.0.1] - 2025-11-15

### Fixed

- Version bumping in build pipeline
- AppImage permissions issue
- EGL display errors on Wayland systems

## [2.0.0] - 2025-11-10

### Added

- Initial stable release
- M3U/M3U8 playlist import
- Xtream Codes API support
- EPG (Electronic Program Guide) integration
- Live TV, Movies (VOD), and TV Series support
- Dark/light theme
- Favorites system
- Cross-platform support (Linux, Windows, macOS)
- GitHub Actions CI/CD
- AUR (Arch User Repository) package

[2.2.0]: https://github.com/mewset/better-ip-tv/compare/v2.1.1...v2.2.0
[2.1.1]: https://github.com/mewset/better-ip-tv/compare/v2.1.0...v2.1.1
[2.1.0]: https://github.com/mewset/better-ip-tv/compare/v2.0.1...v2.1.0
[2.0.1]: https://github.com/mewset/better-ip-tv/compare/v2.0.0...v2.0.1
[2.0.0]: https://github.com/mewset/better-ip-tv/releases/tag/v2.0.0
