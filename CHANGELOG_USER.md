# What's New in Better IPTV

A simple overview of new features and improvements.

---

## Unreleased

### New Features

**Video Playback Settings**
- New settings in the Playback tab to customize how video plays:
  - **Video Output** - switch renderer if you get a black screen or visual glitches
  - **Deinterlacing** - fixes jagged lines on live TV channels (especially 1080i broadcasts like SVT)
  - **Start in Fullscreen** - open the player in fullscreen automatically
  - **Start Volume** - choose the volume level when playback starts
  - **Cache Duration** - increase buffering if your connection is unstable
- Audio and subtitle language settings moved here from General for easier access
- Hardware acceleration toggle now actually takes effect

**Reorganized Settings**
- Settings are now split into 6 tabs for easier navigation
- EPG settings have their own tab
- Playback tab contains all video and audio settings in one place

**Channel Logo Fallback**
- Channel logos that fail to load now show the channel's initial letter on a colored background instead of a broken image

**Next Program on Channel Cards**
- Channel cards now show what's coming up next, so you can see both the current and the next program at a glance

### Bug Fixes

**Theme Switcher Now Works**
- Switching between Light, Dark, and System theme in Settings now actually changes the app's appearance
- "System" follows your OS preference and updates automatically if you change it
- Your theme choice is applied instantly when you click it

### Improvements

**Smoother Scrolling on Slower Hardware**
- Scrolling through large channel lists (50,000+ channels) should feel significantly smoother, especially on older computers with integrated graphics
- Reduced unnecessary work when scrolling - the app now skips re-drawing cards that haven't changed

---

## Version 2.6.1 (March 10, 2026)

### Improvements

**Smoother Scrolling**
- Scrolling through large channel lists is now noticeably smoother - this fix should have been included in 2.6.0 but didn't make it in time

---

## Version 2.6.0 (March 9, 2026)

### New Features

**About Tab**
- New "About" tab in Settings with app version, donation links, and a button to open the log folder

### Improvements

**Faster Backend**
- The app now handles multiple operations at once instead of queuing them one by one
- Browsing channels while loading EPG data no longer causes delays

**Better Logging**
- More detailed logging for easier troubleshooting

**Smoother Channel Browsing**
- Searching channels is now faster and smoother, especially with large playlists (10,000+ channels)
- Switching between Live TV, Movies, Series, and Favorites tabs feels more responsive
- Toggling favorites no longer causes the channel list to briefly flicker
- The app makes fewer background requests while watching, reducing unnecessary work

---

## Version 2.5.0 (February 26, 2026)

### New Features

**Favorites**
- New **Favorites** tab next to Live TV, Movies, and Series
- Click the **star** on any channel card to add it to your favorites
- Stars appear when you hover over a channel - click to save it
- Your favorites include all types: live channels, movies, and series in one place
- Search works within your favorites too
- Favorites are saved and survive playlist refreshes

**Custom User-Agent for Playlist Requests**
- New setting in **Settings > General > Playlist Requests**
- Choose between **Default**, **TiviMate**, **VLC**, or **Custom** User-Agent
- Add your own User-Agent string when a provider requires it
- See a live preview of the exact header that will be sent

### Improvements

**Smarter EPG User-Agent Handling**
- If your EPG comes from your active Xtream provider, the same selected User-Agent is used
- If your EPG is from an external URL, the app does **not** force your custom/preset User-Agent

### Bug Fixes

---

## Version 2.4.0 (January 27, 2026)

### New Features

**Keyboard Shortcuts**
- Press **Space** to play or stop the current channel
- Press **/** to jump to the search bar instantly
- Press **Escape** to stop playback
- Shortcuts are disabled while typing in search or other input fields

**Playlist Auto-Refresh**
- The app now checks if your playlist is older than 7 days and offers to refresh it on startup
- New **Refresh** button in Settings > General to manually update your channel list
- Smart merge: new channels are added, removed channels are cleaned up, and your **favorites are preserved**
- Shows a progress summary with how many channels were added, updated, or removed

**Better EPG (TV Guide) Experience**
- **Automatic setup for Xtream providers** - When you add an Xtream Codes playlist, the app now automatically configures your TV guide! No more manually finding and entering EPG URLs.
- **Smart default** - If you clear the EPG URL field, it automatically falls back to your Xtream provider's TV guide. The EPG is always configured for Xtream users!
- **Manual refresh button** - New "Update Now" button in Settings > General lets you refresh EPG data anytime without changing settings.
- **EPG status display** - See at a glance when your TV guide was last updated and how many programs are loaded.
- You can still use a custom EPG source if you prefer - just enter a different URL in Settings.

### Improvements

### Bug Fixes

---

## Version 2.3.1 (December 29, 2025)

### Bug Fixes

**Fixed Crash on Arch Linux / Manjaro**
- Fixed a startup crash that showed "Could not create default EGL display" error
- This affected users on Arch Linux, Manjaro, and other rolling-release distros using Wayland
- The app now provides a special Arch-compatible version that works perfectly with your system

### What's New for Linux Users

**Two AppImage Options:**
- **Arch/Manjaro/Fedora users**: Download the `*-arch.AppImage` version
- **Ubuntu/Debian users**: Download the regular `.AppImage` version

The Arch version uses your system's graphics libraries instead of bundled ones, which fixes the compatibility issue on newer Linux systems.

**AUR users**: The package has been updated to use the Arch-compatible version automatically!

---

## Version 2.3.0 (December 23, 2025)

### New Features

**Parental Controls 🔒**
- Protect your family with PIN-protected content restrictions
- **Set a secure PIN** (4-6 digits) to control access to restricted content
- **Block specific channels** - Choose exactly which channels to restrict
  - Easy-to-use channel selection with search
  - Works smoothly even with thousands of channels
- **Auto-detect adult content** - Automatically blocks channels with +18, XXX, or Adult in the name
  - Now actually adds channels to your blocked list when you save settings!
- **Block entire categories** - Block all channels in categories like "Adult" at once
- **Three viewing modes**:
  - Hide blocked channels completely (default)
  - Show with a lock icon - Click the lock to unlock with PIN
  - Show blurred with a lock icon - Click to unlock with PIN
- **PIN required to watch blocked content** - Enter your PIN before any blocked channel can play
- **Secure PIN reset** - Must enter current PIN before you can reset parental controls
- **Temporary unlock** - Enter PIN to temporarily access blocked content (locks again when you restart the app)
- All settings easily managed from the Settings menu

Perfect for families who want to ensure kids only see appropriate content!

### Improvements

**Smoother User Experience 🎨**
- **Professional modal dialogs** - Replaced old-style browser popups with beautiful custom dialogs
  - All confirmation and error messages now appear in sleek, modern modals
  - Consistent design across the entire app
  - Works great in both light and dark modes
- **Clearer EPG setup** - EPG URL field is now empty by default with a helpful recommendation link to iptv-epg.org
  - No more confusing pre-filled URLs
  - Easy to find EPG sources if your provider doesn't include them

**Parental Controls Work Better Now! 🔧**
- **Auto-detect actually works** - When you enable auto-detect and save, the app now scans all your channels and adds adult content to the blocked list (it didn't do this before!)
- **Lock and Blur modes now show channels** - Previously these modes would hide channels just like "Hide" mode. Now they actually show the channels with a lock icon or blur effect, and you can click them to unlock!
- **Easier to unlock channels** - Just click anywhere on a locked channel card to enter your PIN and watch
- **PIN modal works smoothly** - Fixed a bug where the PIN entry would get stuck on "Processing..." if you unlocked multiple channels in a row

**No More MPV Installation on Windows! 🎉**
- Windows users no longer need to install MPV separately
- Everything you need is included in the installer
- Just download, install, and start watching - that's it!
- The app will automatically use the included video player
- If you already have MPV installed, the app will still work perfectly

**Note for Mac and Linux users**: You'll still install MPV the usual way (via Homebrew on Mac or your package manager on Linux). This change only affects Windows.

**Fixed Linux Wayland Display Issue 🐧**
- Fixed crash on startup for Linux users with Wayland display server
- The app now automatically works around a WebKit bug that caused "EGL_BAD_PARAMETER" errors
- No configuration needed - it just works!

**Better Settings Organization 📑**
- Settings menu now uses clean tabs instead of a long scrolling list
- Four organized tabs: General, Playback, Parental, and Profiles
- Much easier to find what you're looking for!
- Smooth navigation with keyboard shortcuts (Ctrl+1, Ctrl+2, Ctrl+3, Ctrl+4)

---

## Version 2.2.0 (December 17, 2025)

### New Features

**Category Quick-Access Bar**
- New horizontal scrollable bar showing provider categories (Sweden, Norway, F1, etc.)
- Click any category chip to instantly filter channels
- Categories update automatically based on your selected content type (Live TV, Movies, Series)
- "All" button to show all channels in the current tab
- Categories now appear in your provider's original order (not alphabetically)

This makes it much faster to find channels from your favorite categories without having to search!

**Note**: If you had the app before this update, please re-import your playlist in Settings to see categories.

---

## Version 2.1.1 (December 2, 2025)

### Improvements

**Better Error Handling**
- Clearer and more informative error messages
- Errors in one part of the app no longer crash the whole application

**Faster Performance**
- Improved database performance for large channel lists
- Optimized code for a smoother experience

**Higher Quality**
- 76 new automated tests for improved stability
- Restructured code for easier maintenance and fewer bugs

---

## Version 2.1.0 (November 21, 2025)

### New Features

**Multiple Profiles**
- Add and manage multiple IPTV playlists as separate profiles
- Easily switch between different providers or setups
- Each profile keeps its own channels and favorites

**Language Preferences**
- Set your preferred audio language (19 languages available)
- Set your preferred subtitle language
- Includes Swedish, English, Norwegian, Danish, Finnish, German, French, Spanish, Italian, Portuguese, Dutch, Polish, Russian, Arabic, Turkish, Japanese, Chinese, and Korean

**Responsive Layout**
- Channel cards now adapt to your screen size
- Better experience on everything from phones to 8K monitors

### Improvements

**Better Compatibility**
- Fixed crashes on Wayland systems (Arch Linux with Hyprland, etc.)
- Works better with more IPTV providers

**Usability**
- Live TV is now the default view when opening the app
- Dark mode now works properly in all dropdown menus
- Removed confusing "Remember Position" setting that didn't work

**Privacy**
- Log files now hide your login credentials automatically
- Safe to share logs when reporting bugs

---

## Version 2.0.1 (November 15, 2025)

### Fixes
- Fixed AppImage not launching on some systems
- Fixed display errors on Wayland

---

## Version 2.0.0 (November 10, 2025)

### First Stable Release

- Import M3U/M3U8 playlists or use Xtream Codes
- Live TV, Movies, and TV Series support
- Electronic Program Guide (EPG)
- Mark channels as favorites
- Dark and light themes
- Works on Linux, Windows, and macOS
