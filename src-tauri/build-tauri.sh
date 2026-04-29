#!/usr/bin/env bash
# build-tauri.sh — produce release bundles via Tauri v2 (macOS / Linux).
# Output: target/release/bundle/{macos,dmg,deb,...}/AppLogsViewer.{app,dmg,deb,...}
#
# Usage:  bash build-tauri.sh
# Prereqs: rustup + cargo + cargo-tauri (one-time install via:
#          curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
#          cargo install tauri-cli --version "^2.0" --locked
# )

set -euo pipefail

cd "$(dirname "$0")"

echo ""
echo "╔══════════════════════════════════════╗"
echo "║   AppLogsViewer (Tauri) — release    ║"
echo "╚══════════════════════════════════════╝"
echo ""

if ! command -v cargo >/dev/null 2>&1; then
  if [ -f "$HOME/.cargo/env" ]; then
    # shellcheck disable=SC1091
    . "$HOME/.cargo/env"
  fi
fi

if ! command -v cargo >/dev/null 2>&1; then
  echo "[error] cargo not found. Install via:"
  echo "  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"
  exit 1
fi

if ! cargo tauri --version >/dev/null 2>&1; then
  echo "[setup] installing cargo-tauri (one-time)…"
  cargo install tauri-cli --version "^2.0" --locked
fi

# Refresh the bundled adb + libimobiledevice tooling drop so the .app /
# .dmg ships standalone (no `brew install` needed on QA machines). On a
# host without Homebrew this step is skipped — fall back to documenting
# the manual install in the README.
if command -v idevicesyslog >/dev/null 2>&1 && command -v adb >/dev/null 2>&1; then
  echo "[setup] vendoring tooling for the .app bundle…"
  bash scripts/bundle-tooling-macos.sh
else
  echo "[warn] idevicesyslog / adb not found — skipping tooling bundle."
  echo "       Users will need to install adb + libimobiledevice manually."
fi

echo "[build] cargo tauri build (release mode)…"
cargo tauri build

echo ""
echo "╔══════════════════════════════════════╗"
echo "║   Build complete!                    ║"
echo "╚══════════════════════════════════════╝"
echo ""
echo "  Artifacts:"
find target/release/bundle -type f \( -name "*.dmg" -o -name "*.app" -o -name "*.deb" -o -name "*.AppImage" \) 2>/dev/null | sort | sed 's|^|    |'
echo ""
