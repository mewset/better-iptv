<div align="center">
  <img src="src/assets/logo/logo-256.png" alt="Better IPTV Logo" width="200"/>

  # Better IPTV

  **Modern, cross-platform IPTV player built with Rust and Tauri**

  [![Test Build](https://github.com/mewset/better-iptv/workflows/Test%20Build/badge.svg)](https://github.com/mewset/better-iptv/actions)
  [![Platform](https://img.shields.io/badge/platform-Linux%20%7C%20Windows%20%7C%20macOS-blue.svg)](#-installation)
  [![AUR](https://img.shields.io/aur/version/better-iptv-bin?logo=archlinux&label=AUR)](https://aur.archlinux.org/packages/better-iptv-bin)
  [![License: GPL v2](https://img.shields.io/badge/License-GPL%20v2-blue.svg)](LICENSE)
  [![Website](https://img.shields.io/badge/website-better--iptv.vercel.app-informational)](https://better-iptv.vercel.app)

  [Website](https://better-iptv.vercel.app) • [Features](#-features) • [Installation](#-installation) • [Quick Start](#-quick-start) • [FAQ](#-faq) • [Contributing](#-contributing)
</div>

> **Note:** Better IPTV is not affiliated with any IPTV provider. Users are responsible for compliance with local laws and provider terms.

---

## 📺 Overview

Better IPTV is a desktop IPTV player that combines the performance of Rust with a modern web UI. Built on MPV for video playback, it handles live TV, movies, and series across Linux, Windows, and macOS.

**Why Better IPTV?**
- **Fast & Efficient** - Rust backend handles 100,000+ channels smoothly
- **Smart Features** - EPG, parental controls, multi-profile support, and more
- **Modern UI** - Clean, responsive interface with dark/light themes
- **Privacy First** - All data stored locally, credentials never leave your device
- **Cross-Platform** - One app for Linux, Windows, and macOS

---

## ✨ Features

### 🎬 Content Library
- **Live TV** - Stream live channels with real-time Electronic Program Guide (EPG)
- **Movies (VOD)** - Browse and watch on-demand movies
- **TV Series** - Season/episode organization with automatic episode queuing
- **Smart Search** - Instant filtering across all content types
- **Virtual Scrolling** - Smooth performance even with 100K+ channels

### 🔒 Parental Controls
- PIN protection (4-6 digits) with manual or automatic channel blocking
- Auto-detection of adult content (+18, XXX, Adult markers)
- Category-level blocking for entire channel groups
- Three viewing modes: Hide, Lock Icon, or Blur
- Session-based unlock that re-locks on restart

### 📋 Playlist Management
- **M3U/M3U8** import from local files or URLs
- **Xtream Codes** integration with your IPTV provider
- **Multi-Profile System** - Switch between multiple providers/playlists
- **Favorites** - Star any channel and find them in a dedicated tab
- **Custom User-Agent** - Presets for TiviMate, VLC, or enter your own
- **Category Quick-Access** - Horizontal bar for instant category filtering

### 🌐 Language Support
19 languages for audio and subtitle preferences (Scandinavian, European, and International), configurable per profile.

---

## 📥 Installation

### MPV Media Player

Better IPTV uses MPV for video playback. Installation varies by platform:

**Linux:**
```bash
# Ubuntu/Debian
sudo apt install mpv

# Arch Linux
sudo pacman -S mpv

# Fedora
sudo dnf install mpv
```

**macOS:**
```bash
brew install mpv
```

**Windows:**
> **New in v2.3.0:** MPV is bundled with the installer. No separate installation needed.

If you prefer a manual installation: download from [mpv.io](https://mpv.io/installation/) or use `choco install mpv`.

### Download Better IPTV

1. Visit [Releases](https://github.com/mewset/better-iptv/releases/latest)
2. Download for your platform:
   - **Linux (Ubuntu/Debian)**: `.AppImage`, `.deb`
   - **Linux (Arch/Manjaro)**: `-arch.AppImage` or install via AUR (see below)
   - **Linux (Fedora/RHEL)**: `.rpm`
   - **Windows**: `.msi` installer or `.exe` portable
   - **macOS**: `.dmg` disk image

**Linux AppImage (Ubuntu/Debian):**
```bash
chmod +x Better-IPTV_*_amd64.AppImage
./Better-IPTV_*_amd64.AppImage
```

**Linux AppImage (Arch/Manjaro):**

> **Important:** Use the `-arch.AppImage` variant on Arch-based distros. The standard AppImage bundles WebKit libraries from Ubuntu that conflict with newer system libraries on rolling-release distros and will cause a crash on startup.

```bash
chmod +x Better-IPTV_*_amd64-arch.AppImage
./Better-IPTV_*_amd64-arch.AppImage
```

Alternatively, install via the AUR:
```bash
yay -S better-iptv-bin
# or
paru -S better-iptv-bin
```

---

## 🚀 Quick Start

### 1. Import Playlist

On first launch, choose your import method:

**Option A: M3U/M3U8 File**
1. Click **"Import M3U Playlist"**
2. Enter a profile name (e.g., "My IPTV")
3. Choose source: **Local File** or **URL**
4. Click **"Import"** and wait for channels to load

**Option B: Xtream Codes**
1. Click **"Import Xtream Playlist"**
2. Enter a profile name
3. Fill in your server URL, username, and password
4. Click **"Import"** (loads Live TV, Movies, and Series)

### 2. Configure EPG (Optional)

1. Open **Settings** (gear icon) → **General** → **EPG Settings**
2. Enter your XMLTV EPG URL (Xtream users get this automatically)
3. Click **"Update Now"** — EPG updates automatically going forward

### 3. Start Watching

- Use tabs (All / Live TV / Movies / Series / Favorites) and the category bar to browse
- Type in the search box for instant filtering
- Click play on any channel — MPV opens in a separate window

**Series:** Select a series → choose season → click Play on any episode. Remaining episodes auto-queue.

**Favorites:** Hover over any channel card and click the star to add or remove.

**Multiple Profiles:** Import additional playlists as separate profiles and switch between them from the setup screen.

---

## 🎮 Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Space` | Play/Stop current channel |
| `/` | Focus search bar |
| `Escape` | Stop playback |
| `Ctrl+1-4` | Switch settings tabs |

For MPV player controls (fullscreen, volume, seek, etc.), see the [MPV keyboard documentation](https://mpv.io/manual/stable/#keyboard-control).

---

## ❓ FAQ

<details>
<summary><strong>Why won't MPV open?</strong></summary>

MPV must be installed on your system (except Windows v2.3.0+ which includes it bundled).

Verify installation:
```bash
mpv --version
```

See [Installation](#-installation) for platform-specific instructions.
</details>

<details>
<summary><strong>Can I watch channels directly in the app?</strong></summary>

No, Better IPTV uses MPV as an external player. This provides broad codec support and hardware acceleration, but video displays in a separate window.
</details>

<details>
<summary><strong>EPG data not showing?</strong></summary>

Check:
1. Playlist contains EPG identifiers (`tvg-id` or `tvg-name`)
2. EPG URL configured in Settings → EPG Settings
3. EPG data fetched (click "Fetch EPG" button)
4. Wait a minute for EPG refresh cycle
</details>

<details>
<summary><strong>How many channels can it handle?</strong></summary>

Better IPTV has been tested with 150,000+ channels during development without issues.
</details>

<details>
<summary><strong>Does it work with VPN?</strong></summary>

Yes. Ensure your VPN is active before launching streams.
</details>

<details>
<summary><strong>Are my Xtream credentials secure?</strong></summary>

Yes. All credentials are stored locally on your device. Nothing is sent to external servers. Logs automatically mask sensitive data.
</details>

<details>
<summary><strong>Can I play local video files?</strong></summary>

No, Better IPTV is designed for IPTV streams. Use MPV directly for local media.
</details>

---

## 🛠️ Troubleshooting

### Channels Buffering
- **Check internet connection** - Run speed test
- **Try another channel** - May be provider/server issue
- **Adjust MPV cache** - Advanced users: edit MPV config

### Series Not Importing (Xtream)
- **Verify credentials** - Double-check username/password
- **Check provider support** - Not all Xtream providers offer series
- **Retry import** - Network issues may cause partial imports

### App Won't Start
- **Linux**: Ensure `.AppImage` has execute permissions (`chmod +x`)
- **Windows**: Run as administrator or check Windows Defender
- **macOS**: Allow app in **System Preferences → Security & Privacy**

### Parental Controls Issues
- **Auto-detect not working?** - Re-save settings to trigger channel scan
- **Lock mode not showing channels?** - Update to v2.3.0+ (bug fixed)
- **PIN modal stuck?** - Restart app, issue resolved in v2.3.0

### Logs

**Linux**: `~/.local/share/better-ip-tv/logs/better-ip-tv.log`
**Windows**: `%APPDATA%\com.m0s.better-ip-tv\logs\better-ip-tv.log`
**macOS**: `~/Library/Application Support/com.m0s.better-ip-tv/logs/better-ip-tv.log`

Credentials are automatically masked in logs.

---

## 🤝 Contributing

Contributions are welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, code standards, and PR guidelines.

- [Report a bug](https://github.com/mewset/better-iptv/issues/new)
- [Request a feature](https://github.com/mewset/better-iptv/issues/new)
- [Join discussions](https://github.com/mewset/better-iptv/discussions)

---

## 📝 Changelog

See [CHANGELOG_USER.md](CHANGELOG_USER.md) for version history and release notes.

---

## 📄 License

[GNU General Public License v2.0](LICENSE) — MPV is GPL v2+ licensed, and we chose GPL v2.0 for compatibility.

---

## 🙏 Acknowledgments

- **[MPV Project](https://mpv.io/)** - Media player with comprehensive codec support
- **[Tauri](https://tauri.app/)** - Cross-platform framework enabling this project
- **[Open TV](https://github.com/Fredolx/open-tv)** - Architectural inspiration
- **IPTV Community** - Standards, protocols, and ongoing support

---

## 💖 Support the Project

If you find Better IPTV useful, consider supporting its development:

- **Ko-fi**: [ko-fi.com/R6R21I53PD](https://ko-fi.com/R6R21I53PD)
- **GitHub Sponsors**: [Sponsor on GitHub](https://github.com/sponsors/mewset)

**Crypto donations:**

| Currency | Address |
|----------|---------|
| ETH | `0x47183F4e4FEAeE4BF52d95E68893e950125b1B44` |
| BTC | `bc1qth40h9t8r7hvp4czqvf20f3w72jdg4epd5mjq8` |
| SOL | `3waxf6r2tmaaADuBGYoVD5qz4z8VnFNEGGafbXZ6Jf2j` |

---

<div align="center">

  **Made for IPTV enthusiasts**

</div>
