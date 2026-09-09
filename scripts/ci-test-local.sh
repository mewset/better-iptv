#!/bin/bash
# Local CI Test Runner
# Runs the same checks as GitHub Actions locally to catch issues before pushing

set -e  # Exit on error

# Get script directory and project root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Change to project root
cd "$PROJECT_ROOT"

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}🧪 Running Local CI Tests${NC}"
echo -e "${BLUE}=========================${NC}\n"

# Track failures
FAILED=0
TOTAL=0

# Helper function to run a test
run_test() {
    local name=$1
    local command=$2

    TOTAL=$((TOTAL + 1))
    echo -e "${BLUE}▶ Running: ${name}${NC}"

    if eval "$command"; then
        echo -e "${GREEN}✅ PASSED: ${name}${NC}\n"
    else
        echo -e "${RED}❌ FAILED: ${name}${NC}\n"
        FAILED=$((FAILED + 1))
    fi
}

# Frontend Tests
echo -e "${YELLOW}📦 Frontend Checks${NC}"
echo -e "${YELLOW}==================${NC}\n"

run_test "Frontend linting" "npm run lint"
run_test "Frontend formatting" "npm run format:check"
run_test "Frontend tests" "npm run test:run"

# Rust Tests
echo -e "${YELLOW}🦀 Rust Checks${NC}"
echo -e "${YELLOW}===============${NC}\n"

run_test "Rust clippy" "(cd src-tauri && cargo clippy --all-targets -- -D warnings -A dead_code)"
run_test "Rust tests" "(cd src-tauri && cargo test)"

# Optional: Build test (takes longer)
if [ "$1" == "--with-build" ]; then
    echo -e "${YELLOW}🏗️  Build Test${NC}"
    echo -e "${YELLOW}=============${NC}\n"
    run_test "Tauri build" "npm run tauri build -- --verbose"
fi

# Summary
echo -e "${BLUE}=========================${NC}"
echo -e "${BLUE}📊 Test Summary${NC}"
echo -e "${BLUE}=========================${NC}\n"

if [ $FAILED -eq 0 ]; then
    echo -e "${GREEN}✅ All tests passed! ($TOTAL/$TOTAL)${NC}"
    echo -e "${GREEN}🚀 Safe to push to GitHub!${NC}\n"
    exit 0
else
    echo -e "${RED}❌ $FAILED/$TOTAL tests failed${NC}"
    echo -e "${RED}⚠️  Fix errors before pushing${NC}\n"
    exit 1
fi
