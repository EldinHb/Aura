#!/usr/bin/env bash
# Build the macOS app and install it to /Applications as the only copy.
#
# `tauri build` stages a real Aura.app under target/, carrying the shipping
# identifier (nl.havick.aura). Launch Services registers any app bundle it
# finds, and a registered bundle shows up in Spotlight search — the
# .metadata_never_index marker keeps build output out of the Spotlight *content*
# index but does not prevent that registration. So the staging copy is
# unregistered and deleted once it has been installed, leaving exactly one Aura.
#
# --keep-daemon leaves aurad running. Use it when installing from a session
# hosted by Aura itself: stopping the daemon would kill that session mid-install.
# The new daemon binary only takes effect once aurad is restarted by hand.
set -euo pipefail
cd "$(dirname "$0")/.."

KEEP_DAEMON=0
[ "${1:-}" = "--keep-daemon" ] && KEEP_DAEMON=1

LSREGISTER=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
STAGED=target/release/bundle/macos/Aura.app
DEST=/Applications/Aura.app

./scripts/build-sidecars.sh release
(cd apps/desktop && pnpm tauri build --bundles app)
[ -d "$STAGED" ] || { echo "no bundle at $STAGED" >&2; exit 1; }

# aurad outlives the app: left running, the old binary keeps serving the new UI.
# It detects providers, so a stale one also reports stale CLI versions.
if [ "$KEEP_DAEMON" = "0" ] && [ -x "$DEST/Contents/MacOS/aura" ]; then
  "$DEST/Contents/MacOS/aura" daemon stop >/dev/null 2>&1 || true
fi
osascript -e 'quit app "Aura"' >/dev/null 2>&1 || true
for _ in $(seq 1 30); do pgrep -f "$DEST/Contents/MacOS/aura-desktop" >/dev/null || break; sleep 0.5; done

rm -rf "$DEST"
ditto "$STAGED" "$DEST"

# Leave no second bundle behind.
"$LSREGISTER" -u "$STAGED" >/dev/null 2>&1 || true
rm -rf target/release/bundle/macos target/debug/bundle/macos

# Register the installed copy now: Launch Services otherwise picks it up
# asynchronously, and the count below would read 0 on a fresh install.
"$LSREGISTER" -f "$DEST" >/dev/null 2>&1 || true
n=$("$LSREGISTER" -dump 2>/dev/null | grep -c 'path:.*Aura\.app' || true)
echo "installed $DEST (Aura.app bundles registered: $n)"
[ "$KEEP_DAEMON" = "1" ] && echo "aurad left running — restart it to pick up the new daemon binary"
[ "$n" = "1" ] || echo "warning: expected exactly 1 registered bundle, found $n" >&2
