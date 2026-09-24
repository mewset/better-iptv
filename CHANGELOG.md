# Changelog

All notable changes to Better IPTV will be documented in this file.
This file is a developer-changelog, aimed towards development changes.

## Unreleased

### Added

- **3.0 UI: a dark-first redesign, live-programme progress and a TV Guide view** - the token layer started in an earlier release is now complete across `Setup`, `ProfileManager`, `Settings` and its tabs, every modal and `SeriesView`, so no component styles itself outside the palette, apart from the three donation buttons in `AboutTab` which keep their brand colours on purpose
  - The palette is dark by default with an amber accent, chosen with measured contrast rather than picked by eye: `--color-text` on `--color-bg` reads 16.97:1 in dark mode; the raw amber measures 1.85:1 on white and is unusable as text there, so light mode's `--color-accent-text` is a burnt amber (`138 90 0`) at 5.67:1 on gray-50 instead, while dark mode's background is dark enough for the raw amber to serve as `--color-accent-text` too (10.31:1 on `--color-bg`). `--color-on-accent` (dark text on the amber fill) measures 9.98:1
  - Familjen Grotesk and Schibsted Grotesk ship via `@fontsource/familjen-grotesk` and `@fontsource/schibsted-grotesk`, imported by weight in `src/main.tsx`, so no runtime font fetch is added
  - `ChannelEpg` gains `current_start`, `current_end` and `next_start` alongside the existing programme titles (`src-tauri/src/epg/xmltv.rs`), and the live channel card (`ChannelCard.tsx`) uses them to draw a progress line under the current programme
  - A `ColorBars` placeholder (`src/components/ColorBars.tsx`) fills in for channels and titles with no artwork
  - Movie and series posters render uncropped at their native 2:3 ratio (`PosterCard.tsx`), and the grid's virtualised rows measure themselves so a poster row and a live-channel row of different heights never overlap (`useResponsiveGrid.ts`, `MainScreen.tsx`)
  - The store's content-type filter changes from `'all' | 'live' | 'vod' | 'series' | 'favorites'` to a `Section` type (`'live' | 'vod' | 'series' | 'favorites' | 'guide'`), dropping the catch-all `'all'` variant; search now spans every content type instead of only the active one (`useChannelFilter.ts`)
  - `SearchBar.tsx` and `ContentTypeTabs.tsx` are removed. Navigation moves to an icon rail (`Rail.tsx`) plus a glass top bar (`TopBar.tsx`) carrying the profile switcher, now extracted into a `useProfileSwitch` hook
  - A floating now-playing dock replaces the fixed bar, showing programme progress (`NowPlayingBar.tsx`)
  - Settings opens as a view under the top bar instead of a modal overlay, with a vertical section list; it owns Escape via a capture-phase listener with `preventDefault`, closing itself without stopping playback, and its modals carry `role="dialog"` and `aria-modal`
  - Profile cards show a channel count from the new `get_playlist_channel_counts` command (`src-tauri/src/db/queries.rs`, `src-tauri/src/commands/playlist.rs`), plus a relative refresh age and expiry emphasis
  - The first-launch `Setup` screen is redesigned with live MPV detection status and an install link
  - The Movies section gains a "Recently added" hero row (`MoviesHero.tsx`, `src/lib/newestTitle.ts`)
  - A new `get_guide` command (`src-tauri/src/commands/epg.rs`, `src-tauri/src/epg/xmltv.rs`) returns programmes for a set of channels across a time window, validated by `epg_domain::validate_guide_window` (rejects an inverted or zero-width window before it reaches SQL). `GuideView.tsx` renders it, opened with the `G` key and closed through the same Escape ownership order as Settings. Its rows are every live channel (`useChannelFilter.ts`), narrowed by the category chips and by a Favorites chip ahead of them that lasts while the guide stays open

### Credits

- **@orcdev** reviewed the app's UI in a live stream on 2026-09-23; that review prompted this redesign

### Changed

- **Dependency updates closing 17 of 18 Dependabot advisories** - Dependabot alerts were enabled on the repository, deliberately without `dependabot.yml` and with security updates left off, so it flags and never opens a pull request. The first scan reported 18 advisories against the Rust tree, none of which `npm audit` can see
  - `openssl` 0.10.75 -> 0.10.81, `rustls-webpki` 0.103.9 -> 0.103.15, `serde_with` 3.17.0 -> 3.22.0 and `tauri` 2.10.3 -> 2.11.6. All inside semver, so `Cargo.toml` is untouched and only `Cargo.lock` moves
  - `rand` needed four copies resolved. 0.8.5, 0.9.2 and 0.10.0 moved to 0.8.8, 0.9.5 and 0.10.3. The fourth, 0.7.3, had no fix in its own line and sat inside an advisory range starting at 0.7.0; it left as a side effect of the Tauri bump, which drops `kuchikiki` for a newer html5ever stack and takes the `selectors` -> `phf_codegen` -> `phf_generator` chain with it
  - That chain was a build dependency reached only by `tauri-build` during code generation, never linked into the binary. Dependabot labels every cargo dependency `runtime` because `Cargo.lock` does not record the distinction the way npm's lockfile does, so the Rust list reads more severe than what ships warrants
  - The eight `openssl` advisories are all low-level APIs - `Deriver::derive`, AES key wrap, `MdCtxRef::digest_final`, the PSK and cookie trampolines - reached by neither this code nor the TLS paths `reqwest` uses. They are fixed because the fix costs a lockfile line, not because they were reachable
  - The `tauri` advisory is the one touching this project's own boundary: origin confusion letting a remote page invoke local-only commands. The configured CSP sets `script-src 'self'`, so no remote script runs in the webview, and `img-src` permits remote channel logos, which cannot reach IPC
  - `glib` stays at 0.18.5 and keeps its advisory open. The fix is 0.20.0, a major bump owned by Tauri's GTK stack rather than by this project, and the finding is unsoundness in the `Iterator` impls for `VariantStrIter` rather than a reachable hole. It waits for Tauri to move
  - `@tauri-apps/api`, `@tauri-apps/plugin-log`, `@tauri-apps/plugin-opener` and `@tauri-apps/cli` move with the crates. The Tauri CLI refuses to build when an npm package and its Rust crate differ on major or minor, so bumping the crate is not optional on the JavaScript side. It is one change, not two, and `npm run ci:test` only catches it with `--with-build`, since the app build is behind that flag locally while CI always runs it
  - The other 31 advisories are npm and every one is scoped `development` - vite, postcss, js-yaml, vitest, rollup. `npm audit --omit=dev` reports zero; none of that code is bundled into the app

- **npm dependencies updated within semver, clearing the remaining 31 advisories** - every one was scoped `development`, so none of it was ever bundled into the app, which is why `npm audit --omit=dev` read zero while `npm audit` read nineteen
  - `npm update` alone was enough; `package.json` is untouched because the declared caret ranges already permitted these versions, and only `package-lock.json` moves. vite 7.2.2 -> 7.3.6, vitest 4.0.16 -> 4.1.11, postcss 8.5.6 -> 8.5.28, prettier 3.7.3 -> 3.9.8 and the rest of the tree with them
  - The vite advisories were the ones worth closing despite being dev-only: a path traversal and two `server.fs.deny` bypasses in the dev server, which is a real surface while `npm run tauri dev` is running on a developer's machine, even though it never ships
  - prettier crossing two minors without reformatting a single file was checked before the build rather than assumed, since a formatting change would have meant a reformat commit and a `.git-blame-ignore-revs` entry
  - Majors are deliberately left: Vite 8, Vitest 5, Tailwind 4, TypeScript 7, ESLint 10 and `@vitejs/plugin-react` 6 each carry breaking changes and belong in their own change, not in a security sweep

- **`libdbus-1-dev` added to the Ubuntu package list in the test and release workflows** - Tauri 2.11 routes through `tao` 0.35, which pulls in `dbus` and `libdbus-sys`. That crate's build script resolves `dbus-1` through pkg-config, and neither workflow installed the headers. It builds locally because the development machine has them, which is exactly the kind of gap that only ever appears on a runner

## [2.9.0] - 2026-09-11

### Added

- **Each Xtream profile card shows when its subscription runs out** - the panel reports an expiry date for every account and nothing in the app ever read it, so the first sign of a lapsed subscription was channels that stopped playing
  - `player_api.php` called with no `action` answers with the account envelope rather than a stream list. `xtream::fetch_user_info` reads `user_info.exp_date` from it, and `XtreamUserInfo` decodes that field through `de_lenient_opt_string`, since a panel running `JSON_NUMERIC_CHECK` sends the timestamp as a JSON number and a strict `Option<String>` rejects the whole response. A test asserts both shapes land on the same value
  - Unlike the import calls, this one is a single attempt with no retry. Sixty seconds of backoff for a line of text is not a trade worth making when the caller can fall back to the value it stored last time
  - `playlist_domain::parse_xtream_exp_date` holds the reading of the field: Unix seconds, with a missing field, an empty string, `0` and anything unparsable all meaning no expiry date. `0` matters on its own, since panels use it for lifetime accounts and rendering it literally would claim the subscription ended in January 1970. A date already in the past is returned like any other, because the caller, not the parser, decides how to word it
  - `xtream_expiry_for_storage` converts that instant to RFC 3339 in UTC. The same string is stored and handed to the frontend, so the format is a contract and has its own test
  - `playlists.xtream_exp_date` caches the last known value, added by `ALTER TABLE` in `init_schema` like `category_order` before it, with a test that seeds a pre-column database and proves the migration runs. Writing `None` clears the column, so an account upgraded to lifetime stops showing the date it used to have rather than keeping it
  - `get_subscription_expiry` decides whether to ask the provider at all. `playlist_domain::subscription_check_due` leaves a stored expiry alone while it is still in the future, however old the check: the date only moves on a renewal, and a renewal cannot shorten it, so an account in good standing costs one request and then nothing. Everything else is asked about at most hourly, built like `update_check_due` and `epg_refresh_due` before it
  - The hourly floor is what `playlists.xtream_exp_checked_at` exists for. It is never displayed; it exists because a lifetime account, which reports no date at all, is indistinguishable in the cache from one never checked, and without a timestamp such a profile would ask the provider on every visit forever. The same floor covers a subscription that has run out and is not renewed. Providers rate limit this hard: the panel behind the profile this was tested against answers `{"message": "Line is invalid"}` with HTTP 403 to every request for a while once it has seen too many, including ones that succeeded seconds earlier
  - A renewal still shows up, because an expired date is exactly the state that keeps asking. When the provider cannot be reached the stored value is returned instead, and when there is neither, the command returns `None` and the row is not rendered at all. An unreachable provider is not an error here; the line is decoration and must never interrupt someone whose provider is down
  - The line sits under the type on each card in Settings → Profiles rather than beside the active playlist in General, so a user comparing profiles sees every subscription at once instead of having to activate one to read its date. `useSubscriptionExpiries` asks for every Xtream profile in parallel on mount, keyed by a joined id string so a freshly built array argument cannot re-run the effect, and `formatSubscriptionExpiry` words the line, switching to "Subscription ended" for a date that has passed and returning nothing for a value it cannot parse, so a corrupted row renders as absence rather than as "Invalid Date"
  - Only the day is shown. Xtream reports a clock time too, but it is noise for a subscription. There is no countdown, no colour and no warning state; the request was the date, and a date is what it shows
  - Prompted by Fredolx/open-tv, where the same field is read, though the feature here was built from the Xtream API rather than from that implementation

- **A security policy, and private vulnerability reporting** - the repository had no security contact, no `SECURITY.md` and no disclosure process, so anyone finding a problem had only the public issue tracker, which is where the details reach an attacker before a fixed release does
  - GitHub's private vulnerability reporting is now enabled, and `SECURITY.md` points at it rather than at an address. That keeps a personal mailbox out of a public file and gives the report a private thread, a draft advisory and a place to credit the reporter
  - The policy states a week as the first-reply target and tells a reporter what to do if that passes: open an ordinary issue saying only that a security report is waiting, with no details. A policy that promises nothing about response time is the reason reporters go public
  - Disclosure terms are deliberately loose. Report privately, allow time for a fix, then publish freely; a reporter who wants a deadline sets it in the report. Demanding indefinite silence is what makes researchers skip the private channel
  - The scope section names the actual threat model, a playlist or programme guide the user did not write, and lists what counts: argument injection into MPV, anything in a provider response that reaches code execution or file access, escaping the webview CSP, exposure of stored credentials or the parental PIN, and any unrequested network listener. Out of scope are MPV's own bugs, a provider's servers, an attacker who already has local access, and the app fetching addresses the user typed
  - Only the latest release is patched, which is stated rather than implied; there is no branch to backport to
  - Prompted by Fredolx/open-tv#424, where a researcher reported six findings publicly and said outright that the absent security contact was why. Our code was checked against all six classes and matched none of them, so this closes the process gap the report exposed rather than a vulnerability

- **Update check against the GitHub release list** - `check_for_update` asks `api.github.com` for the newest non-prerelease release, compares its tag with the running version and returns the tag plus its release URL when it is newer
  - `update_domain::is_newer_version` parses `MAJOR.MINOR.PATCH` numerically, tolerating a leading `v`, a missing component and a `-rc1` suffix. A string comparison would rank `2.10.0` below `2.9.0`; the test for that case is the reason the function exists rather than an inline compare
  - Either side unparsable means "not newer", so a version the app cannot read never produces a badge
  - `update_domain::update_check_due` spaces the network call a day apart, built like `epg_refresh_due`. The newest tag seen is cached in the `update_latest_version` setting, so the badge survives a restart without another request, and the timestamp is only stamped on success, so a failed check retries at the next start instead of going quiet for a day
  - Every failure path returns `None`: disabled, offline, rate limited, unreadable body. The check never blocks startup and never raises a dialog
  - `useUpdateCheck` calls it once per mount; `MainScreen` renders a link beside the title when it resolves, opening the release page through `openUrl` as the About tab already does
  - The release page is the target rather than an asset, because a user who installed from the AUR should update through their package manager and the app cannot tell how it was installed
  - New setting `update_check_enabled`, default on, with a toggle under Settings → General

- **A pull request that sets the app version now fails its check, on the offending line** - CONTRIBUTING.md tells contributors not to bump the version, since four files carry it and the maintainer moves them together at release time, but nothing enforced it and a bump only surfaced as a conflict later
  - `.github/workflows/version-guard.yml` compares the app version at the base commit and at the pull request's head, and prints one `::error` annotation per file that moved, anchored to the line that sets it. GitHub renders those on the line itself in Files changed, which is where the contributor is already looking when they fix it
  - The job is read-only and has no `pull-requests: write`, so it cannot label or comment, and a fork can never gain write access through it. The first version used `pull_request_target` for a label and a comment; the annotation carries the same information in the place it is needed, so the elevated token was dropped rather than justified. The file says as much, since moving the trigger later to regain write access would reintroduce the risk
  - The check compares resolved version values at both commits instead of reading the diff. `Cargo.lock` carries a `version` line for every dependency, so a diff-based match would fire on any pull request that legitimately bumps a crate; only the `[[package]]` entry for `better-ip-tv` counts, and `Cargo.toml` reads its `[package]` section rather than a dependency's version
  - `scripts/version-files.mjs` holds the extraction, the comparison, the line lookup and the annotation text; `scripts/check-version-bump.mjs` is git plumbing and exits 1 on a mismatch. Twenty tests cover them, including that a crate whose name merely starts with `better-ip-tv` cannot be read instead of the app, and that an annotation never contains a newline, which would end it early and print the rest as ordinary log output
  - `vitest.config.ts` now includes `scripts/**/*.test.mjs`, so CI tooling is tested with everything else instead of sitting unexecuted
  - Verified against the real 2.8.0 to 2.8.1 bump in this repository: four annotations at `package.json:4`, `Cargo.toml:3`, `Cargo.lock:308` and `tauri.conf.json:4`, all matching the actual files. The workflow itself is unrun until a pull request arrives

### Changed

- **CONTRIBUTING.md now explains the versioning** - the project has followed semver since 2.0.0, but nothing said so; it showed only in the `version:major|minor|patch` scripts and the conventional-commits line. A new Versioning section maps commit type to release size, states that the highest class among the changes decides the whole release, and asks contributors not to bump the version in a PR, since four files carry it and the maintainer moves them together
  - The section now also records the project's one deliberate departure from strict semver, and draws it on domain rather than on size: a `feat:` that touches none of what the app is for - playback, playlists and channels, the programme guide, profiles, parental controls - may ship in a PATCH however large it is, while anything inside that list is a MINOR even at two lines. The update check is the worked example, since it adds something to the app without changing anything about watching television. Strict semver makes any new feature a MINOR regardless, so the intro says the versioning is "based on" semver rather than that it follows it
  - A second paragraph states that the table describes how releases are normally sized rather than deciding on its own, and that the maintainer takes the call at release time and can read a borderline change either way. Contributors still label by type and never size a release in a pull request

- **`cargo fmt --check` is now one of the checks** - `scripts/ci-test-local.sh` runs it ahead of clippy, so `npm run ci:test` fails on unformatted Rust exactly as CI does; `test.yml` gained the matching step, and CONTRIBUTING.md lists `cargo fmt` again after `f27e826` pulled the advice for want of enforcement
  - The one-time reformat of `src-tauri` is its own commit, 23 of 32 files and no net change in line count. It is listed in `.git-blame-ignore-revs`, which GitHub honours on its own; locally it takes `git config blame.ignoreRevsFile .git-blame-ignore-revs` once

### Fixed

- **The MPV bundled with the Windows installer was never used** - `tauri.conf.json` declared the resource as `"../resources/mpv/*"`, and `tauri_utils::resources::resource_relpath` rewrites every `..` component to a directory literally named `_up_`. The player therefore installed to `_up_/resources/mpv/mpv.exe` while `playback::mpv::get_mpv_path` looked for `mpv/mpv.exe` beside the executable, missed, logged "Bundled MPV not found, falling back to system MPV" and spawned `mpv.exe` from `PATH`. On a machine without MPV installed that is every stream failing, with 120 MB of unused player sitting in the install directory
  - Confirmed against the shipped 2.8.1 artifacts rather than from the source alone. The NSIS installer lists `better-ip-tv.exe` at the root next to `_up_/resources/mpv/mpv.exe`, and the MSI's decoded Directory and File tables place it at `<INSTALLDIR>\_up_\resources\mpv`
  - The resource is now declared in the map form, `{ "../resources/mpv/": "mpv/" }`, which names the destination directly. `resource_relpath` is applied to the destination string, and `mpv/` contains no parent component, so the files land at `mpv/mpv.exe` relative to the resource directory. On Windows that directory is the executable's own, for both NSIS and MSI, so the path `get_mpv_path` already checks is the one that now exists and no Rust change is needed
  - The directory form with a trailing slash was chosen over the glob `{ "../resources/mpv/*": "mpv/" }`, which reaches the same destination but silently skips subdirectories. The old list form skipped them too, so any `doc` or `fonts` directory in the shinchiro archive has never been packaged
  - Also removes a trap: with the glob, an empty `resources/mpv` fails the build with "glob pattern ../resources/mpv/* path not found or didn't match any files", so the Linux and macOS builds were passing only because `.gitkeep` matched it. The deb ships `usr/lib/Better IPTV/_up_/resources/mpv/.gitkeep` and nothing else. The map form accepts an empty directory
  - `get_mpv_path` resolving from `current_exe()` is correct on Windows because the two directories coincide there, and is left alone. `app.path().resource_dir()` would be the accurate source and is worth revisiting if MPV is ever bundled on macOS, where resources live in `Contents/Resources`; that needs an `AppHandle` threaded into the function and is a separate change
  - Unverified: the fixed installer has not been run on Windows. The destination is verified by executing the real `tauri-utils` 2.8.3 functions against a replica directory, where the old list form reproduced the shipped layout exactly, and the resource directory's location is verified from the shipped installers' own trees

- **A refresh that returned nothing emptied the playlist** - a provider answering with an HTML error page under HTTP 200, an expired subscription or a truncated response all parse to an empty channel list. `merge_channels` then found every stored row unmatched and deleted the playlist's entire contents, favourites included, while `refresh_playlist` logged the result as a success
  - `playlist_domain::validate_refresh_not_empty` refuses a zero-channel result, and `refresh_playlist` calls it after the fetch and before the database work, so nothing is written on the way out. The message names the playlist as kept rather than only reporting a failure, because it reaches the user through the refresh dialog
  - The check sits in the domain layer rather than in `merge_channels`, whose contract is to make the stored rows match the list it is handed. "An empty list means the fetch failed" is policy, and policy belongs with the command
  - A provider that has genuinely removed every channel is not a supported case; the user can delete the playlist. Treating zero as a failure is the safe reading in every other situation
  - `parser.rs` accepts a file with no `#EXTM3U` header and skips lines it does not recognise, which is why an HTML page parses cleanly to nothing rather than raising a parse error. That leniency is deliberate and unchanged; this guard is the backstop
  - Found during the whole-branch review of the refresh work below, which made the gap visible: that fix promises a refresh will not remove channels, and this was the remaining path where one still could

- **An import that returned nothing created an empty playlist** - the same cause as the refresh case above, with a milder symptom: nothing is destroyed, but the user gets a playlist that silently contains no channels and no hint whether the address, the subscription or the app is at fault
  - `playlist_domain::validate_import_not_empty` refuses a zero-channel result. `import_playlist` calls it on the raw parse result before grouping and before the playlist row is created, and `import_xtream_playlist` calls it after the fetch, so neither writes a row on the way out
  - It is a separate function from the refresh guard rather than a shared one with a parameter. Nothing exists yet on an import, so the refresh wording about the playlist being kept would be nonsense; a test asserts the two messages do not drift into each other
  - An Xtream account with no active subscription answers every list endpoint with an empty array rather than an error, which is the same shape arriving by a different route

- **A provider that sent a category id as a number failed the whole playlist import** - `XtreamStream.category_id` was a strict `Option<String>`, and the streams are decoded as one `Vec`, so a single row carrying `"category_id":7` instead of `"7"` rejected the entire response. `fetch_json_with_retry` classifies a decode error as permanent, so it failed fast rather than after the retry budget
  - The cause is on the panel side: Xtream Codes panels are PHP, and `JSON_NUMERIC_CHECK` on `json_encode` turns every digit-only string into a JSON number. It is per-panel, which is why the field is a string from most providers and a number from some
  - `category_id` now uses the existing `de_lenient_opt_string`, so both forms land as `Some("7")` and match the category map. It also folds `""` to `None`; an empty string used to be kept and then silently miss every lookup
  - The same treatment went on `XtreamCategory.category_id` and `category_name`, and on `SeriesMetadata.name`. The category path is wrapped in `unwrap_or_default`, so a number there was not fatal but emptied the map and left every channel ungrouped, which is harder to notice. A category named `2024` or a series named `1883` hits the same edge
  - `#[serde(default, ...)]` is required alongside `deserialize_with` on the `Option` fields: a custom deserializer turns a missing key into an error, where a plain `Option` gets `None` for free

- **VOD URLs hardcoded `.mp4` whatever the provider served** - `build_stream_url` wrote the extension as a literal, so a film delivered as `mkv` or `m4v` produced a URL the provider does not serve. `get_vod_streams` reports the real one in `container_extension`, which was never read
  - The field is now captured and used for the `vod` arm, falling back to `mp4` when it is absent, empty or unusable, which reproduces the old output exactly for providers that omit it
  - The `series` arm deliberately keeps `mp4`. That URL is an id carrier that `parseXtreamSeriesId` and `extract_stream_key_from_url` read the id back out of, and it never reaches MPV; episodes get their own URLs from `Episode.container_extension`. A comment on the function says so
  - `safe_container_extension` constrains the value to one to eight ASCII alphanumerics. MPV is spawned through `Command::arg` with no shell, and `validate_stream_url` already rejects shell metacharacters, so this is not an injection fix; it stops a value like `mkv?token=x` or `mp4/../../admin` from rewriting the request path of a URL that is also stored and logged
  - No migration is needed. `extract_stream_key_from_url` ignores the extension, so the next playlist refresh rewrites stored VOD URLs while keeping favourites
  - Both bugs came to light through **@francois2metz**'s work in his own fork, where he had patched them for himself in May 2026. He never filed either one; the fork is what pointed us at them. The fix here is written from scratch against this tree
  - On the approach, for whoever revisits this: carrying the id as a `serde_json::Value` and looking the category up with `to_string()` does not work, because `Value` renders as JSON and the string form comes back quoted, which would send every string-id provider to Uncategorized. Normalising to a bare `String` through the lenient helper is what avoids that

- **The user agent claimed to be version 2.1.1** - `DEFAULT_HTTP_USER_AGENT` ended in a literal `Better-IPTV/2.1.1`, written when the setting was added in `4bd85d4` and never derived from anything. Every playlist and EPG request since has identified the app as 2.1.1, and the preview under Settings → General showed the same stale string from a second literal of its own
  - Both halves now come from the version in `package.json`: Rust builds the constant with `concat!` and `env!("CARGO_PKG_VERSION")`, and the frontend reads an `__APP_VERSION__` define. `dev-scripts/sync-version.cjs` already keeps `Cargo.toml` equal to `package.json`, so one bump moves both
  - `scripts/app-version.mjs` reads the version for `vite.config.ts` and `vitest.config.ts` alike; a copy in each config would be the same drift that caused the bug. `eslint.config.js` declares the injected global
  - `src/lib/userAgent.ts` replaces the literal that lived in `GeneralTab.tsx`, so the preview cannot disagree with what is sent
  - `http::tests::the_default_user_agent_carries_the_running_app_version` fails on any version that stops following the crate, which is what the old constant did silently. The built bundle was checked too: it carries the prefix plus an injected `"2.8.1"`
  - The three preset agents (TiviMate, VLC) are still written out in both languages. They are fixed strings that name other products, so they cannot go stale the same way, but the duplication is real

- **Refreshing a playlist deleted the channels it had just inserted** - step 4 of `merge_channels` in `src-tauri/src/db/mutations.rs` pruned stale rows with `id NOT IN (matched_ids)` scoped to the playlist. `matched_ids` only ever holds ids of rows that existed before the refresh, so the rows step 3 had inserted moments earlier in the same transaction satisfied the inverse match and were deleted with the stale ones
  - The `removed > 0` guard meant it only fired when at least one old row had genuinely gone, which describes most real refreshes: keep one, drop one, add two left a single channel behind while still reporting `added: 2`
  - The `matched_ids.is_empty()` branch was a second hole. When nothing matched it deleted the whole playlist, fresh rows included, and still counted them as added
  - Step 4 now builds an explicit list of stale ids (existing rows not in `matched_ids`) and deletes exactly those, still through `json_each` so a large playlist cannot trip `SQLITE_MAX_VARIABLE_NUMBER`. The `is_empty` branch is gone; the explicit list covers that case with no special handling, and `MergeResult.removed` now equals the number of rows actually deleted
  - The same fix repairs M3U series refresh. `replace_series_episodes` runs after `merge_channels` and looks up series rows by name and group; freshly added series rows used to be deleted before it ran, so a new series came through the refresh with no episodes at all. They now survive, and the episodes land
  - Three tests cover the keep-drop-add shape for Xtream and M3U matching, and a refresh that matches nothing. A fourth, `test_merge_channels_prunes_more_stale_rows_than_sqlite_variable_limit`, drops 33,000 rows in one refresh: the pre-existing large-playlist test keeps 33,000 and drops one, and once the JSON array carries stale ids instead of kept ids that test passes against a bound-parameter `IN (?, ?, ...)` regression. Verified by swapping the delete to bound parameters; the old test stayed green, the new one fails with "variable number must be between ?1 and ?32766"
  - **@andrezinhovg** found this in his fork at `904f8e0`. His fix uses a temp table because it was written against the older `channels_to_keep` version of step 4; ours is written against the `json_each` rewrite instead

- **Generic taskbar icon on KDE Plasma and GNOME Shell for installed Linux builds** - `src-tauri/templates/better-iptv.desktop` rendered `StartupWMClass` from `{{{name}}}`, the product name `Better IPTV`, while the window reports the binary name: `hyprctl clients` shows `class=better-ip-tv` for the release binary
  - KDE's libtaskmanager matches StartupWMClass against the X11 class, then the Wayland app_id case-insensitively, then app_id as a desktop-file name, desktopEntryName and Name against app_id, and last Exec by pid. Every step failed for `Better IPTV` versus `better-ip-tv`, and the pid fallback did not help because our Exec is wrapped in `env WEBKIT_DISABLE_DMABUF_RENDERER=1`. GNOME Shell uses the same StartupWMClass fallback
  - The window class is the binary name because `app.enableGTKAppId` is off, and it stays off: a real GTK application id turns on GApplication uniqueness, so a second launch would hand off to the first instance
  - The template now writes `StartupWMClass={{{exec}}}`, which is what Tauri's own default template does; our template's first commit swapped it for `{{{name}}}`, which is where the bug came from. A literal `better-ip-tv` was considered and rejected: the bundler's exec value and the window class both come from the main binary name, which equals the package name only while `Cargo.toml` declares no `[[bin]]` and `tauri.conf.json` sets no `mainBinaryName`, so a literal would go stale the moment either changed
  - `desktop_entry_tests::startup_wm_class_uses_the_exec_variable` in `src-tauri/src/lib.rs` asserts the template line is literally `StartupWMClass={{{exec}}}`, and `deb_and_rpm_bundles_render_this_template` reads `tauri.conf.json` and checks that both the deb and rpm `desktopTemplate` entries still point at the template, so the first test cannot keep passing on a file nobody renders
  - deb, rpm and the AppImage all render from this one template. The AUR `better-iptv-bin` package copies the desktop file out of the -arch AppImage and rewrites only Exec and Icon, so it inherits the fix at the next release without a PKGBUILD change
  - **@andrezinhovg** reported the symptom in his fork at `7ca4ec0` and fixed it there with deb/rpm postinst scripts symlinking `com.m0s.better-ip-tv.desktop`. Without `enableGTKAppId` that identifier is never the window class, so the symlink would have matched nothing; the fix here takes his diagnosis but not his patch

### Removed

- **The unreachable `search_channels` command** - the search bar filters client-side: `SearchBar` writes `searchQuery` into the player store and `useChannelFilter` narrows the loaded list on name and group with `includes()`. The IPC command had no caller in any layer; the `searchChannels` wrapper in `src/lib/tauri.ts` was exported but never imported, and nothing else invoked the command name
  - Tauri 2 app commands are not capability-gated and `withGlobalTauri` is off, so the command was reachable only from our own webview, and nothing in it called it
  - Removed with it: the `generate_handler!` registration in `src-tauri/src/lib.rs`, `queries::search_channels` and its two tests, `channel_domain::validate_search_query` with its two length constants and its test, and the `searchChannels` wrapper in `src/lib/tauri.ts`
  - `idx_channel_search` in `schema.rs` is deliberately left in place. Dropping a `CREATE INDEX` does not remove it from existing databases, so retiring it is a separate migration decision, and nothing shows the `ORDER BY name` paths do not benefit from it
  - **@andrezinhovg** removed the same dead code in his fork at `6bf6718`

## [2.8.1] - 2026-09-09

### Changed

- **Favicon was still the Vite scaffold logo** - `index.html` had carried `/vite.svg` since the initial commit, so the purple-and-yellow Vite mark was the page icon in every build
  - It now references `./src/assets/logo/logo-256.webp` by relative path. Vite rewrites asset URLs in `index.html` at build time, and the file is already bundled because `Setup.tsx`, `LoadingScreen.tsx` and `AboutTab.tsx` import it, so the favicon resolves to the same hashed asset instead of adding a second copy
  - `public/` held only `vite.svg` and `tauri.svg`, neither of them referenced after the swap, and is gone. `vite.config.ts` does not set `publicDir`, so the build is unaffected by its absence
  - Visible in a browser tab during `npm run dev`; the packaged app draws its window and taskbar icon from `src-tauri/icons/`, which is unchanged

### Fixed

- **macOS app icon was a 16x16 image upscaled to icon size** - `src-tauri/icons/icon.icns` was not an ICNS container at all, but a 16x16 PNG saved under the `.icns` extension (734 bytes, `icns` magic absent). macOS had nothing but those 256 pixels to draw from, so Finder, the Dock, Get Info and the Quick Look preview all showed a heavily blurred logo (Issue: #62)
  - The initial commit shipped a valid ICNS. A single logo swap on 2026-02-26 broke it twice within three minutes: `fa0a47a` replaced it with a 1024x1024 PNG and `da136a4`, the follow-up meant to correct the source image, with a 16x16 PNG - each still carrying the `.icns` name. It shipped that way in five releases, 2.5.0 through 2.8.0, because the failure is invisible on Linux and Windows
  - Regenerated with `tauri icon` from `src/assets/logo/logo-1024.png` (converted to RGBA first; the source is RGB and the CLI needs an alpha channel). The file is now a valid `icns` container of 895342 bytes carrying `ic07`-`ic14` plus the legacy `is32`/`il32`/`s8mk`/`l8mk` chunks, i.e. every size from 16x16 up to 1024x1024
  - Only `icon.icns` changed. The `.ico` and the PNG variants listed in `tauri.conf.json` were already correct, and the artwork is unchanged

- **Xtream refresh merged channels of different types that share an id** - `merge_channels` keyed Xtream rows on the bare number at the end of the stream URL, but panels number live streams, movies and series independently, so a live channel and a movie with id 500 matched the same row. Whichever came last in the playlist overwrote that row's URL and content type; the other one was left unmatched and deleted, taking any favourite on it along
  - `extract_stream_key_from_url` (was `extract_stream_id_from_url`) now keys on `{live|movie|series}:{id}`, read from the URL's content segment; an unrecognised segment falls back to the bare id so unusual URL shapes still match by number
  - `merge_channels_xtream_ids_do_not_collide_across_content_types` reproduces the loss - `removed: 1` before the fix, `0` after

- **`scripts/ci-test-local.sh` was not executable in git** - tracked as `100644`, so `./scripts/ci-test-local.sh` from a fresh clone failed with "Permission denied"; it only ran locally because of a chmod git never saw. Now `100755`
  - CONTRIBUTING.md now lists the prerequisites CI installs and points at `npm run ci:test`; it no longer suggests `npm run test` (watch mode), a bare `cargo clippy` from the repo root, or `cargo fmt`, which CI does not check

### Credits

Thanks to @KenAdamss for reporting the blurred macOS icon in Issue #62. The Get
Info screenshot showed the icon blurred at every size rather than only at large
sizes, which pointed at the source file instead of at a missing retina variant.

## [2.8.0] - 2026-09-03

### Added

- **Batched EPG lookup** - New `get_channels_epg(epg_ids)` command returns `{ current, next }` per EPG id (max 500 ids)
  - `useEpgData` now makes one IPC call for the visible grid instead of up to 100 `get_channel_epg` calls
  - `get_channel_epg` unchanged, still used by the Now Playing bar

- **Automatic EPG refresh** - Background task on the Tauri runtime
  - Checks every 15 minutes (first check 30 s after startup) whether `epg_last_fetched` is older than 6 hours and an `epg_url` is set
  - Reuses the force-refresh path and emits `epg-refreshed`; the frontend clears its EPG cache and refetches
  - `epg_domain::epg_refresh_due` is the pure decision function
  - Manual (Update Now, URL save) and automatic refreshes are serialised; the background task skips its check while another refresh is running
  - Attempts are spaced at least one hour apart via a new `epg_last_attempt` setting (`epg_domain::epg_retry_allowed`), so a broken EPG URL is not re-downloaded at every 15-minute poll

- **Xtream `epg_channel_id`** - Live streams now carry the provider's EPG id
  - Used when the Swedish name heuristic (`" SE"` suffix) yields nothing, so existing external-XMLTV setups keep matching
  - Existing profiles pick up the ids on their next playlist refresh via `merge_channels`

- **M3U series browsing** - Series in M3U playlists get the same Browse → seasons → episodes flow as Xtream
  - `series_domain::parse_episode_name` recognises `S01E02`, `1x02` and `Season 1 Episode 2` markers; `group_series` collapses episode rows into one `channels` row per `(group, series name)`
  - New `series_episodes` table (cascade on channel delete) holds season, episode, title and URL per row; `SeriesEpisode` model
  - New commands `get_local_series_info(channel_id)` and `play_series_episodes(episode_ids)`; the latter queues URLs from the database, never from the frontend
  - `SeriesView` takes a `loadSeries` callback instead of Xtream credentials; `MainScreen` picks the loader by profile type
  - Rows in a series group with no episode marker (iptv-org's "Series" category, "Game Show Network") are reclassified as `live`
  - One-time startup migration (`migrate_m3u_series`, settings key `m3u_series_grouped`) converts existing M3U profiles; a favourite on any episode row moves to the series
  - `merge_channels` now also refreshes `content_type` on matched rows; M3U refresh replaces the episode set via `replace_series_episodes`

### Changed

- **Database work off the async runtime** - `commands::with_db` runs every rusqlite call on `tokio::task::spawn_blocking`
  - Pool checkout happens inside the blocking closure
  - `parse_m3u` (local file reads) and Argon2 PIN verification also run on the blocking pool
  - `MpvPlayer` moved from `tokio::sync::Mutex` to `std::sync::Mutex` and is driven from the blocking pool (`playback::play_stream`, `stop`, `is_playing`, `check_mpv_installed`); the up-to-5 s wait in `stop` no longer stalls other commands
  - `PlaybackSettings` moved from `commands::playback` to `playback`
  - No IPC command names, arguments or return shapes changed

- **Xtream retry policy** - Only connection errors, 5xx, 408 and 429 are retried
  - 4xx (wrong credentials, missing endpoint) and undecodable JSON fail immediately instead of after 60 s of backoff

### Fixed

- **EPG rows duplicated on every refresh** - `INSERT OR REPLACE` had no unique key to conflict on
  - Migration collapses existing duplicates and adds `UNIQUE(channel_epg_id, start_time)`
  - `store_programs` now upserts (`ON CONFLICT ... DO UPDATE`) inside one transaction

- **Endless forced EPG refetch in the channel grid** - The manual-refresh effect in `useEpgData` re-fired on every completed fetch once the refresh trigger was non-zero; it now acts once per trigger

- **Saving an EPG URL did not record the fetch time** - `fetch_epg_data` now stamps `epg_last_fetched`, so the background task does not re-download right after a manual fetch

- **Series click on M3U profiles was a silent no-op** - `MainScreen` only rendered `SeriesView` for Xtream credentials and logged nothing otherwise

- **Arch AppImage Died at Startup** - Every `-arch.AppImage` from v2.6.0 through v2.7.0 crashed immediately with `Failed to spawn child process "././/lib/x86_64-linux-gnu/webkit2gtk-4.1/WebKitNetworkProcess"` (Issue: #60)
  - The repack step in `release.yml` deleted `usr/lib/x86_64-linux-gnu/webkit2gtk-4.1/` (the helper processes) but kept `usr/lib/libwebkit2gtk-4.1.so.0`. linuxdeploy had patched that library to look for its helpers at exactly that relative path, resolved against the AppDir, and the WebKit build has no `WEBKIT_EXEC_PATH` override, so the spawn could only fail
  - It went unnoticed because the AUR package never runs `AppRun`: its wrapper starts the binary with `LD_LIBRARY_PATH=/usr/lib`, i.e. system WebKit. The standalone AppImage was the only broken path
  - Removing only the WebKit libraries is not enough either: system WebKit then resolves against the bundled Ubuntu `libsharpyuv`, and `libavif.so.16` fails on `SharpYuvConvertWithOptions`
  - Fix: the `-arch` build drops `usr/lib`, `apprun-hooks` and `AppRun.wrapped` entirely and ships a plain `AppRun` that execs the binary against the system libraries, the same thing the AUR wrapper does. Asset shrinks from 90 MB to ~6 MB. `AppRun` checks for `libwebkit2gtk-4.1.so.0` first and prints the `pacman`/`dnf` command when it is missing
  - Verified on Arch (Hyprland, Wayland) by running the repacked AppImage: it spawns `/usr/lib/webkit2gtk-4.1/WebKit{Network,Web}Process` and renders the UI. The regular AppImage on the same machine opens a blank window with `EGL_BAD_PARAMETER`, so the separate build is still needed
  - The step now fails if any `usr/lib` survives in the AppDir, and selects the source AppImage with `! -name "*-arch.AppImage"` so a re-run cannot repack its own output
  - `aur-repo/PKGBUILD` no longer `chmod`s `AppRun.wrapped`, which the new build does not contain

### Credits

Thanks to @omeringen for reporting the `-arch` AppImage crash in Issue #60 with
the full error output. The relative `././/lib/x86_64-linux-gnu/webkit2gtk-4.1/`
path in that message is what made the linuxdeploy rewrite traceable.

## [2.7.0] - 2026-08-31

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
