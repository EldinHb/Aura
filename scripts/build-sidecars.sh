#!/usr/bin/env bash
# Build aurad + aura and place them where Tauri expects sidecars:
# apps/desktop/src-tauri/binaries/<name>-<target-triple>
set -euo pipefail
cd "$(dirname "$0")/.."
# Keep build output out of Spotlight: target/ holds real .app bundles, and an
# indexed copy shows up in Spotlight/Launch Services alongside the installed
# app. cargo clean removes the marker, so re-create it on every build.
mkdir -p target && touch target/.metadata_never_index
PROFILE="${1:-debug}"
# TARGET_TRIPLE cross-compiles (e.g. x86_64-apple-darwin on an Apple Silicon
# host); cargo then writes to target/<triple>/<profile> instead.
TRIPLE="${TARGET_TRIPLE:-$(rustc -vV | sed -n 's/^host: //p')}"
FLAGS=()
SRC=target
if [ -n "${TARGET_TRIPLE:-}" ]; then
  FLAGS+=(--target "$TARGET_TRIPLE")
  SRC="target/$TARGET_TRIPLE"
fi
if [ "$PROFILE" = "release" ]; then
  cargo build --release -p aurad -p aura-cli ${FLAGS[@]+"${FLAGS[@]}"}
  SRC="$SRC/release"
else
  cargo build -p aurad -p aura-cli ${FLAGS[@]+"${FLAGS[@]}"}
  SRC="$SRC/debug"
fi
DEST=apps/desktop/src-tauri/binaries
mkdir -p "$DEST"
EXT=""
case "$TRIPLE" in *windows*) EXT=".exe";; esac
cp "$SRC/aurad$EXT" "$DEST/aurad-$TRIPLE$EXT"
cp "$SRC/aura$EXT" "$DEST/aura-$TRIPLE$EXT"
echo "sidecars -> $DEST ($TRIPLE, $PROFILE)"
