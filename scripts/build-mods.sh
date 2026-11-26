#!/usr/bin/env bash
# Build the bundled mods (mods/*) and stage them where Tauri bundles them:
# apps/desktop/src-tauri/mods/<id>/{mod.json,daemon.js,ui.js,ui.css}.
# aurad finds them next to itself in the installed app (see aura_mods::bundled_dir_near).
#
# For development, point aurad at the sources instead and it reloads a mod when
# its dist/ changes:  AURA_MODS_DIR=$PWD/mods  plus  node packages/mod-sdk/cli.mjs build mods/<id> --watch
set -euo pipefail
cd "$(dirname "$0")/.."
DEST=apps/desktop/src-tauri/mods
rm -rf "$DEST"
mkdir -p "$DEST"
for dir in mods/*/; do
  [ -f "$dir/mod.json" ] || continue
  node packages/mod-sdk/cli.mjs build "$dir"
  id=$(basename "$dir")
  mkdir -p "$DEST/$id"
  cp -R "$dir/dist/." "$DEST/$id/"
done
echo "mods -> $DEST: $(ls "$DEST" | tr '\n' ' ')"
