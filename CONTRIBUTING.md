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

```bash
# Fork & clone
git clone https://github.com/YOUR-USERNAME/better-iptv.git
cd better-iptv

# Install dependencies
npm install

# Run dev server
npm run tauri dev

# Run tests
npm run test          # Frontend tests
cd src-tauri && cargo test  # Rust tests
```

### Build from Source

```bash
npm run tauri build
# Output: src-tauri/target/release/bundle/
```

## Code Standards

- **TypeScript**: Follow ESLint config (`npm run lint`)
- **Rust**: Use `rustfmt` and `clippy`
  ```bash
  cargo fmt
  cargo clippy
  ```
- **Commits**: Use [Conventional Commits](https://www.conventionalcommits.org/)
  ```
  feat: add category quick-access bar
  fix: resolve EPG timezone bug
  docs: update README installation steps
  ```

## Pull Request Process

1. Create feature branch: `git checkout -b feature/my-feature`
2. Make changes with tests
3. Run linters: `npm run lint && cargo clippy`
4. Commit: `git commit -m "feat: description"`
5. Push: `git push origin feature/my-feature`
6. Open PR on GitHub with detailed description

## Community Guidelines

- Be respectful and inclusive
- Provide constructive feedback
- Help other users in issues/discussions
- Document your changes clearly
