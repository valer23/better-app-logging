#!/usr/bin/env bash
# Bundle adb + libimobiledevice (idevice_id, ideviceinfo, idevicesyslog) and
# all their non-system dylibs into `vendor/macos-aarch64/` as a self-contained
# tooling drop. Tauri's bundle.resources picks the directory up and copies it
# into the .app's Contents/Resources/ at build time.
#
# Each binary is patched so its dylib references use @loader_path/<basename>,
# which resolves to the same directory the binary lives in at runtime — so
# the .app stays portable across machines that have no Homebrew install.
#
# Run on a Homebrew-equipped Apple Silicon Mac before `bash build-tauri.sh`.
# Re-run whenever you bump libimobiledevice / android-platform-tools versions.
#
# Code signing:
#   By default the bundled binaries are re-signed ad-hoc (`-`), which is
#   adequate for local/dev builds but is flagged by Gatekeeper on systems
#   with strict notarization policy and raises red flags in enterprise
#   environments. To produce a Developer ID-signed drop, export:
#
#     export APPLE_SIGNING_IDENTITY="Developer ID Application: Bragi GmbH (XXXXXXXXXX)"
#
#   before running this script. When set, the script signs with the hardened
#   runtime (`--options runtime`) and a secure timestamp (`--timestamp`),
#   which are required for notarization. See `src-tauri/README.md#code-signing`
#   for the full signing/notarization workflow.

set -euo pipefail

cd "$(dirname "$0")/.."

VENDOR="vendor/macos-aarch64"
mkdir -p "$VENDOR"
rm -f "$VENDOR"/*

# Tools to bundle (must already be installed via Homebrew).
declare -a BINARIES=(adb idevice_id ideviceinfo idevicesyslog)

# ──────────────────────────────────────────────────────────────────────────
# 1. Copy the binaries (resolving symlinks to the actual Mach-O files).
# ──────────────────────────────────────────────────────────────────────────
for b in "${BINARIES[@]}"; do
  src="$(command -v "$b" || true)"
  if [ -z "$src" ]; then
    echo "[error] '$b' not on PATH. Install via:"
    echo "  brew install --cask android-platform-tools   # for adb"
    echo "  brew install libimobiledevice                # for idevice*"
    exit 1
  fi
  real="$(readlink -f "$src" 2>/dev/null || python3 -c "import os,sys;print(os.path.realpath(sys.argv[1]))" "$src")"
  cp "$real" "$VENDOR/$b"
  chmod +w "$VENDOR/$b"
  echo "[bin] $b   <- $real"
done

# ──────────────────────────────────────────────────────────────────────────
# 2. Walk the dylib graph (BFS). Anything under /opt/homebrew or /usr/local
#    that is not a system framework gets copied next to the binaries.
# ──────────────────────────────────────────────────────────────────────────
# bash 3.2 (the macOS default) has no associative arrays; track SEEN as a
# space-separated indexed array of basenames instead.
SEEN_LIST=()
QUEUE=()
for b in "${BINARIES[@]}"; do QUEUE+=("$VENDOR/$b"); done

is_third_party() {
  case "$1" in
    /opt/homebrew/*|/usr/local/*) return 0 ;;
    *) return 1 ;;
  esac
}

contains() {
  # contains <needle> <element>... → 0 if needle is in the list, 1 otherwise
  local needle="$1"; shift
  for x in "$@"; do [ "$x" = "$needle" ] && return 0; done
  return 1
}

while [ ${#QUEUE[@]} -gt 0 ]; do
  cur="${QUEUE[0]}"; QUEUE=("${QUEUE[@]:1}")
  while IFS= read -r line; do
    dep="$(echo "$line" | awk '{print $1}')"
    [ -z "$dep" ] && continue
    [ "$dep" = "$cur" ] && continue
    is_third_party "$dep" || continue
    base="$(basename "$dep")"
    if ! contains "$base" "${SEEN_LIST[@]:-}"; then
      SEEN_LIST+=("$base")
      real_dep="$(readlink -f "$dep" 2>/dev/null || python3 -c "import os,sys;print(os.path.realpath(sys.argv[1]))" "$dep")"
      if [ ! -f "$real_dep" ]; then
        echo "[warn] missing dylib: $dep"
        continue
      fi
      cp "$real_dep" "$VENDOR/$base"
      chmod +w "$VENDOR/$base"
      echo "[lib] $base   <- $real_dep"
      QUEUE+=("$VENDOR/$base")
    fi
  done < <(otool -L "$cur" | tail -n +2)
done

# ──────────────────────────────────────────────────────────────────────────
# 3. Patch every Mach-O so its references use @loader_path/<basename>.
#    Set each dylib's own install_name to @rpath/<basename>.
# ──────────────────────────────────────────────────────────────────────────
echo "[patch] rewriting install names..."
for f in "$VENDOR"/*; do
  [ -f "$f" ] || continue
  case "$f" in
    *.dylib)
      install_name_tool -id "@rpath/$(basename "$f")" "$f" 2>/dev/null || true
      ;;
  esac
  while IFS= read -r line; do
    dep="$(echo "$line" | awk '{print $1}')"
    [ -z "$dep" ] && continue
    is_third_party "$dep" || continue
    base="$(basename "$dep")"
    if [ -f "$VENDOR/$base" ]; then
      install_name_tool -change "$dep" "@loader_path/$base" "$f" 2>/dev/null || true
    fi
  done < <(otool -L "$f" | tail -n +2)
done

# ──────────────────────────────────────────────────────────────────────────
# 4. Re-codesign each modified file. Required after install_name_tool.
#    Defaults to ad-hoc (`-`); set APPLE_SIGNING_IDENTITY to a Developer ID
#    string to produce a notarization-ready signature with the hardened
#    runtime + secure timestamp. Those flags are NOT compatible with the
#    ad-hoc identity on some macOS versions, so they are only added when a
#    real identity is configured.
# ──────────────────────────────────────────────────────────────────────────
SIGN_IDENTITY="${APPLE_SIGNING_IDENTITY:--}"
SIGN_FLAGS=(--force --sign "$SIGN_IDENTITY")
if [ "$SIGN_IDENTITY" != "-" ]; then
  echo "[sign] resigning with Developer ID: $SIGN_IDENTITY"
  SIGN_FLAGS+=(--options runtime --timestamp)
else
  echo "[sign] ad-hoc resigning (set APPLE_SIGNING_IDENTITY for Developer ID)..."
fi
for f in "$VENDOR"/*; do
  [ -f "$f" ] || continue
  codesign "${SIGN_FLAGS[@]}" "$f" 2>/dev/null || echo "[warn] codesign failed for $f"
done

echo
echo "Vendored tooling at $VENDOR/:"
ls -lh "$VENDOR" | awk 'NR>1 {printf "   %s  %s\n", $5, $9}'
echo
echo "Next: run \`bash build-tauri.sh\` -- Tauri will copy this folder into"
echo "      AppLogsViewer.app/Contents/Resources/$VENDOR/ at bundle time."
