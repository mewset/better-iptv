# Test Scripts

CI/CD testing utilities for Better IPTV.

---

## 🧪 ci-test-local.sh

**Local CI test runner** - Runs the same checks as GitHub Actions locally to catch issues before pushing.

### Usage

```bash
# Run all CI checks (fast - no build)
./scripts/ci-test-local.sh

# Run all CI checks + build test (slower but comprehensive)
./scripts/ci-test-local.sh --with-build
```

### What It Does

Runs exactly the same checks as GitHub Actions CI:

**Frontend Checks:**

- `npm run lint` - ESLint checks
- `npm run format:check` - Prettier formatting
- `npm run test:run` - Vitest unit tests

**Rust Checks:**

- `cargo clippy --all-targets -- -D warnings -A dead_code` - Rust linting
- `cargo test` - Rust unit tests

**Optional Build Test:**

- `npm run tauri build` - Full production build (with `--with-build` flag)

### Example Output

```bash
$ ./scripts/ci-test-local.sh

🧪 Running Local CI Tests
=========================

📦 Frontend Checks
==================

▶ Running: Frontend linting
✅ PASSED: Frontend linting

▶ Running: Frontend formatting
✅ PASSED: Frontend formatting

▶ Running: Frontend tests
✅ PASSED: Frontend tests

🦀 Rust Checks
===============

▶ Running: Rust clippy
✅ PASSED: Rust clippy

▶ Running: Rust tests
✅ PASSED: Rust tests

=========================
📊 Test Summary
=========================

✅ All tests passed! (5/5)
🚀 Safe to push to GitHub!
```

### When To Use

**Before every push:**

```bash
# Quick check (recommended before every push)
./scripts/ci-test-local.sh

# If passed, push
git push
```

**Before important commits:**

```bash
# Comprehensive check including build
./scripts/ci-test-local.sh --with-build
```

**After making changes:**

- Changed TypeScript code → Run to catch lint/format errors
- Changed Rust code → Run to catch clippy warnings
- Before creating PR → Always run with `--with-build`
