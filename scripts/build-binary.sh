#!/usr/bin/env bash
# Build webmux as a standalone binary using `bun build --compile`.
#
# Produces a self-contained executable at ./dist/webmux that bundles:
#   - The CLI entry point (bin/src/webmux.ts)
#   - The backend server (backend/src/server.ts)
#   - The frontend static assets (frontend/dist/)
#
# Usage:
#   ./scripts/build-binary.sh           # build for current platform
#   ./scripts/build-binary.sh --target=  # override bun compile target
#
# Prerequisites:
#   - bun >= 1.0
#   - Node.js (for vite build)

set -euo pipefail
cd "$(dirname "$0")/.."

# ── Configuration ─────────────────────────────────────────────────────────────

VERSION=$(node -p "require('./package.json').version")
OUTPUT_DIR="dist"
BINARY_NAME="webmux"
TARGET_FLAG=()

# Allow --target=<bun-target> override (e.g. bun-linux-x64, bun-darwin-arm64)
for arg in "$@"; do
  case "$arg" in
    --target=*)
      TARGET_FLAG=("$arg")
      ;;
    *)
      echo "Unknown argument: $arg" >&2
      exit 1
      ;;
  esac
done

echo "==> Building webmux v${VERSION} standalone binary"
echo ""

# ── Step 1: Install dependencies ─────────────────────────────────────────────

echo "==> Installing dependencies..."
bun install --frozen-lockfile 2>/dev/null || bun install

# ── Step 2: Build frontend ───────────────────────────────────────────────────

echo "==> Building frontend..."
cd frontend
bun run build
cd ..

# ── Step 3: Bundle backend ───────────────────────────────────────────────────

echo "==> Bundling backend..."
mkdir -p backend/dist
bun build backend/src/server.ts --target=bun --outfile=backend/dist/server.js

# ── Step 4: Bundle CLI ───────────────────────────────────────────────────────

echo "==> Bundling CLI..."
bun build bin/src/webmux.ts --target=bun --outfile=bin/webmux.js

# ── Step 5: Embed static assets ──────────────────────────────────────────────
# The server reads WEBMUX_STATIC_DIR at runtime, and the CLI in serve mode
# locates frontend/dist/ relative to the package root. For a compiled binary
# we embed the static files so the binary is self-contained.

echo "==> Preparing embedded assets..."

# Create a temporary asset manifest that the server can use when running
# inside the compiled binary (import.meta.url resolves to /$bunfs/).
STATIC_DIR="frontend/dist"

if [ ! -d "$STATIC_DIR" ]; then
  echo "Error: $STATIC_DIR not found. Frontend build may have failed." >&2
  exit 1
fi

# Count files for feedback
ASSET_COUNT=$(find "$STATIC_DIR" -type f | wc -l | tr -d ' ')
echo "    Bundling ${ASSET_COUNT} static assets from ${STATIC_DIR}"

# ── Step 6: Compile standalone binary ────────────────────────────────────────

echo "==> Compiling standalone binary..."
mkdir -p "$OUTPUT_DIR"

COMPILE_ARGS=(
  build
  bin/src/webmux.ts
  --compile
  --outfile="${OUTPUT_DIR}/${BINARY_NAME}"
)
if [ ${#TARGET_FLAG[@]} -gt 0 ]; then
  COMPILE_ARGS+=("${TARGET_FLAG[@]}")
fi

bun "${COMPILE_ARGS[@]}"

# ── Step 7: Verify ───────────────────────────────────────────────────────────

BINARY_PATH="${OUTPUT_DIR}/${BINARY_NAME}"
if [ -f "$BINARY_PATH" ]; then
  BINARY_SIZE=$(du -h "$BINARY_PATH" | cut -f1)
  echo ""
  echo "==> Build complete!"
  echo "    Binary:  ./${BINARY_PATH}"
  echo "    Size:    ${BINARY_SIZE}"
  echo "    Version: ${VERSION}"
  echo ""
  echo "    Usage: ./${BINARY_PATH} --help"
else
  echo "Error: Binary not found at ${BINARY_PATH}" >&2
  exit 1
fi
