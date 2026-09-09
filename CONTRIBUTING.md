# Contributing to Better IPTV

## Report Bugs

[Create an issue](https://github.com/mewset/better-iptv/issues/new) with:

- Detailed description
- Steps to reproduce
- OS and app version
- Screenshots if applicable
- Log file (see [Troubleshooting](README.md#%EF%B8%8F-troubleshooting))

## Suggest Features

[Open a feature request](https://github.com/mewset/better-iptv/issues/new) describing:

- What you want
- Why it's useful
- How it should work

## Development Setup

### Prerequisites

- [Rust](https://rustup.rs/) (stable) and Node.js 20
- MPV, so there is something to play with
- The Tauri system libraries for your platform, see the
  [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/).
  On Ubuntu/Debian this is what CI installs:

  ```bash
  sudo apt-get install -y libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf
  ```

### Setup

```bash
# Fork & clone
git clone https://github.com/YOUR-USERNAME/better-iptv.git
cd better-iptv

# Install dependencies
npm install

# Run dev server
npm run tauri dev

# Run tests
npm run test:run            # Frontend tests (npm run test starts watch mode)
cd src-tauri && cargo test  # Rust tests
```

### Run the CI checks locally

```bash
npm run ci:test                  # lint, format, tests and clippy, same steps and flags as GitHub Actions
npm run ci:test -- --with-build  # also the full Tauri build that CI runs
```

Run it before opening a PR. Details in [scripts/README.md](scripts/README.md).

### Build from Source

```bash
npm run tauri build
# Output: src-tauri/target/release/bundle/
```

## Code Standards

- **TypeScript**: Follow ESLint config (`npm run lint`)
- **Rust**: Format with rustfmt and keep clippy clean, with the flags CI uses
  ```bash
  cd src-tauri && cargo fmt
  cd src-tauri && cargo clippy --all-targets -- -D warnings -A dead_code
  ```
- **Commits**: Use [Conventional Commits](https://www.conventionalcommits.org/)
  ```
  feat: add category quick-access bar
  fix: resolve EPG timezone bug
  docs: update README installation steps
  ```

## Versioning

Better IPTV follows [Semantic Versioning](https://semver.org/): `MAJOR.MINOR.PATCH`.
Your commit type decides which kind of release your change lands in.

| Commit type                                                            | Release               |
| ---------------------------------------------------------------------- | --------------------- |
| A breaking change, marked `feat!:` or with a `BREAKING CHANGE:` footer | MAJOR                 |
| `feat:`                                                                | MINOR                 |
| `fix:`, `perf:`                                                        | PATCH                 |
| `ci:`, `style:`, `chore:`, `docs:`, `refactor:`, `test:`               | No release of its own |

The highest class among the changes decides the whole release, and it never
moves more than one step. A single `feat:` alongside a dozen `fix:` commits
still makes it a MINOR. Changes in the last row ride along with the next
release rather than justifying one.

A breaking change means people have to redo something to keep using the app,
such as their profiles, playlists or parental PIN. Mark it even when the commit
itself is a fix.

**Do not bump the version in your pull request.** `package.json`,
`src-tauri/Cargo.toml`, `src-tauri/Cargo.lock` and `src-tauri/tauri.conf.json`
all carry the version, and the maintainer bumps them together at release time.
A bump in a PR only creates a conflict.

## Pull Request Process

1. Create feature branch: `git checkout -b feature/my-feature`
2. Make changes with tests
3. Run the CI checks: `npm run ci:test`
4. Commit: `git commit -m "feat: description"`
5. Push: `git push origin feature/my-feature`
6. Open PR on GitHub with detailed description

## Community Guidelines

- Be respectful and inclusive
- Provide constructive feedback
- Help other users in issues/discussions
- Document your changes clearly
