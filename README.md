<div align="center">
  <img src="src/assets/logo/logo-256.png" alt="Better IPTV Logo" width="200"/>

  # Better IPTV

  **Modern, cross-platform IPTV player built with Rust and Tauri**

  [![Test Build](https://github.com/mewset/better-iptv/workflows/Test%20Build/badge.svg)](https://github.com/mewset/better-iptv/actions)
  [![Platform](https://img.shields.io/badge/platform-Linux%20%7C%20Windows%20%7C%20macOS-blue.svg)](#-installation)
  [![AUR](https://img.shields.io/aur/version/better-iptv?logo=archlinux&label=AUR)](https://aur.archlinux.org/packages/better-iptv)
  [![License: GPL v2](https://img.shields.io/badge/License-GPL%20v2-blue.svg)](LICENSE)
  [![Website](https://img.shields.io/badge/website-better--iptv.vercel.app-informational)](https://better-iptv.vercel.app)

  [Website](https://better-iptv.vercel.app) • [Features](#-features) • [Installation](#-installation) • [Quick Start](#-quick-start) • [FAQ](#-faq) • [Contributing](#-contributing)
</div>

> **Note:** Better IPTV is not affiliated with any IPTV provider. Users are responsible for compliance with local laws and provider terms.

---

## 📺 Overview

Better IPTV is a desktop IPTV player that combines the performance of Rust with a modern web UI. Built on MPV for video playback, it handles live TV, movies, and series across Linux, Windows, and macOS.

**Why Better IPTV?**
- **Fast & Efficient** - Rust backend stays smooth on playlists of 150,000+ channels
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
- **Virtual Scrolling** - Smooth performance even on 150,000-channel playlists

### 🔒 Parental Controls
- PIN protection (4-6 digits) with manual or automatic channel blocking
- Auto-detection of adult content (+18, XXX, Adult markers)
- Category-level blocking for entire channel groups
- Three viewing modes: Hide, Lock Icon, or Blur
- Session-based unlock that re-locks on restart

### 📋 Playlist Management
- **M3U/M3U8** import from a URL or a path to a local file
- **Xtream Codes** integration with your IPTV provider
- **Multi-Profile System** - Switch between multiple providers/playlists
- **Favorites** - Star any channel and find them in a dedicated tab
- **Custom User-Agent** - Presets for TiviMate, VLC, or enter your own
- **Category Quick-Access** - Horizontal bar for instant category filtering

### 🎚️ Playback Settings
- Video output renderer, deinterlacing and hardware acceleration
- Start volume, start-in-fullscreen and stream cache duration
- All handed to MPV, all saved per install

### 🌐 Language Support
18 languages for audio and subtitle preferences (Scandinavian, European, and International), configurable per profile.

---

## 📥 Installation

### MPV Media Player

Better IPTV plays video through MPV.

**Windows:** nothing to do — MPV ships inside the installer.

**Linux and macOS:** install MPV first.

```bash
sudo apt install mpv      # Ubuntu/Debian
sudo pacman -S mpv        # Arch Linux
sudo dnf install mpv      # Fedora
brew install mpv          # macOS
```

### Download Better IPTV

Grab your file from [Releases](https://github.com/mewset/better-iptv/releases/latest):

| Platform | File |
|----------|------|
| Windows | `Better.IPTV_<version>_x64_en-US.msi`, or `Better.IPTV_<version>_x64-setup.exe` |
| Ubuntu/Debian | `Better.IPTV_<version>_amd64.deb` or `Better.IPTV_<version>_amd64.AppImage` |
| Fedora/RHEL | `Better.IPTV-<version>-1.x86_64.rpm` |
| Arch/Manjaro | AUR, or `Better.IPTV_<version>_amd64-arch.AppImage` |
| macOS (Apple Silicon) | `Better.IPTV_<version>_aarch64.dmg` |

**Two AppImages — pick the right one.** The standard AppImage carries WebKit
libraries built against Ubuntu. On a distro shipping a current `webkit2gtk`
those clash and the app opens a white window or dies at startup with
`Could not create default EGL display`. The `-arch` build uses your system's
`webkit2gtk` instead, so despite the name it is the right file on **any**
distro with recent libraries — Arch and Manjaro, but Fedora too.

```bash
chmod +x Better.IPTV_*_amd64-arch.AppImage
./Better.IPTV_*_amd64-arch.AppImage
```

**Arch/Manjaro via the AUR:**
```bash
yay -S better-iptv-bin   # prebuilt, the quick one
yay -S better-iptv       # builds from source
```

---

## 🚀 Quick Start

### 1. Import Playlist

On first launch you get two tabs, **M3U URL** and **Xtream Codes**.

**M3U URL**
1. Enter a playlist name (e.g. "My IPTV")
2. Paste your M3U/M3U8 URL — or the path to a local `.m3u` file
3. Click **"Add Playlist"** and wait for the channels to load

**Xtream Codes**
1. Enter a playlist name
2. Fill in your server URL, username and password
3. Click **"Add Playlist"** — Live TV, Movies and Series all import together

### 2. Configure EPG (Optional)

1. Open **Settings** (gear icon) → **EPG**
2. Enter your XMLTV EPG URL (Xtream users get this automatically)
3. Click **"Update Now"** — from then on the guide re-downloads itself every 6 hours while the app is running

### 3. Start Watching

- Use tabs (All / Live TV / Movies / Series / Favorites) and the category bar to browse
- Type in the search box for instant filtering
- Click a channel — anywhere on the card — and MPV opens in a separate window

**Series:** Select a series → choose season → click Play on any episode. Remaining episodes auto-queue.

**Favorites:** Hover over any channel card and click the star to add or remove.

**Multiple Profiles:** Add more playlists in **Settings → Profiles**, and switch between them from the same place.

---

## 🎮 Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Space` | Play/Stop current channel |
| `/` | Focus search bar |
| `Escape` | Stop playback |
| `Ctrl+1-6` | Switch settings tabs |

For MPV player controls (fullscreen, volume, seek, etc.), see the [MPV keyboard documentation](https://mpv.io/manual/stable/#keyboard-control).

---

## ❓ FAQ

<details>
<summary><strong>Why won't MPV open?</strong></summary>

On Linux and macOS, MPV has to be installed on your system. On Windows it comes bundled, so this should not happen.

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
2. EPG URL configured in Settings → EPG
3. EPG data fetched (Settings → EPG → **"Update Now"**)
4. Wait a minute for the channel cards to pick up the new data (they re-read the guide every 5 minutes, and immediately after a download)
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
- **Check your connection** - Run a speed test
- **Try another channel** - It is often the provider's server, not you
- **Raise the cache** - Settings → Playback → Cache Duration

### Series Not Importing (Xtream)
- **Verify credentials** - Double-check username/password
- **Check provider support** - Not all Xtream providers offer series
- **Retry import** - Network issues may cause partial imports

### App Won't Start
- **Linux**: Ensure the `.AppImage` has execute permissions (`chmod +x`). White window or an `EGL_BAD_PARAMETER` crash means you want the `-arch` AppImage — see [Installation](#-installation)
- **Windows**: Run as administrator or check Windows Defender
- **macOS**: Allow app in **System Preferences → Security & Privacy**

### Parental Controls Issues
- **Auto-detect not working?** - Re-save settings to trigger a channel scan
- **Forgot your PIN?** - Delete `better-ip-tv.db` from the data folder below and re-import your playlist

### Where your files live

Playlists, channels, settings and EPG cache all sit in one SQLite database,
`better-ip-tv.db`. Logs are written somewhere else — on Windows and macOS the
two are not in the same place, which trips people up.

| | Data (`better-ip-tv.db`) | Log (`better-ip-tv.log`) |
|---|---|---|
| Linux | `~/.local/share/com.m0s.better-ip-tv/` | `~/.local/share/com.m0s.better-ip-tv/logs/` |
| Windows | `%APPDATA%\com.m0s.better-ip-tv\` | `%LOCALAPPDATA%\com.m0s.better-ip-tv\logs\` |
| macOS | `~/Library/Application Support/com.m0s.better-ip-tv/` | `~/Library/Logs/com.m0s.better-ip-tv/` |

Credentials are masked in logs, so a log file is safe to attach to a bug report.

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
