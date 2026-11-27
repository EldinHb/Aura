#!/usr/bin/env bash
# End-to-end test of Aura updating itself on macOS, without touching an
# installed Aura, its daemon or ~/.aura:
#
#   1. builds version A (this tree's version) and version B (A's next patch
#      version with a "-test" suffix, signed with the updater key) as
#      "AuraUpdateTest", identifier nl.havick.aura.updatetest, with the
#      `updater-test` feature, which lets AURA_UPDATER_ENDPOINT point the
#      updater at a local manifest (release builds never have it);
#   2. serves B and a hand-made latest.json from 127.0.0.1;
#   3. runs A from $WORK/A with AURA_DATA_DIR=$WORK/data (its daemon too), and
#      AURA_UPDATER_TEST_AUTO_RESTART=1 so the app restarts once B is ready;
#   4. checks that A found, downloaded and verified B, stopped its own daemon,
#      replaced itself, relaunched as B, and that a daemon of version B runs.
#
#   scripts/test-update-macos.sh [--keep]     # --keep leaves $WORK and the test app running
#
# The signing key comes from TAURI_SIGNING_PRIVATE_KEY (default
# ~/.tauri/aura-updater.key) and its password from
# TAURI_SIGNING_PRIVATE_KEY_PASSWORD or the Keychain item "aura-updater-key".
# Building B changes the workspace version for a moment; Cargo.toml,
# Cargo.lock and the sidecar binaries are restored afterwards.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$PWD
KEEP=0
[ "${1:-}" = "--keep" ] && KEEP=1

# The real path: Tauri will not resolve (so update or relaunch) an app whose path
# goes through a symlink, and /tmp is one on macOS.
WORK=${AURA_E2E_DIR:-/private/tmp/aura-update-e2e}
ID=nl.havick.aura.updatetest
NAME=AuraUpdateTest
ARCH=$(uname -m | sed 's/arm64/aarch64/')
TRIPLE=$(rustc -vV | sed -n 's/^host: //p')
A_VERSION=$(jq -r .version apps/desktop/src-tauri/tauri.conf.json)
B_VERSION=${B_VERSION:-$(echo "$A_VERSION" | awk -F. '{print $1"."$2"."$3+1}')-test}
STAGED=target/release/bundle/macos
LSREGISTER=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
export TAURI_SIGNING_PRIVATE_KEY=${TAURI_SIGNING_PRIVATE_KEY:-$HOME/.tauri/aura-updater.key}
if [ -z "${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}" ]; then
  TAURI_SIGNING_PRIVATE_KEY_PASSWORD=$(security find-generic-password -s aura-updater-key -w)
  export TAURI_SIGNING_PRIVATE_KEY_PASSWORD
fi

case "$WORK" in /private/tmp/*) ;; *) echo "AURA_E2E_DIR must be under /private/tmp" >&2; exit 1 ;; esac
rm -rf "$WORK"
mkdir -p "$WORK/A" "$WORK/server" "$WORK/data" "$WORK/backup"
log() { printf '\n== %s\n' "$*"; }

# Restore what building B changed, also when a step fails.
cp Cargo.toml Cargo.lock "$WORK/backup/"
restore() {
  cp "$WORK/backup/Cargo.toml" "$WORK/backup/Cargo.lock" "$ROOT/"
  if [ -f "$WORK/backup/aurad-$TRIPLE" ]; then
    cp "$WORK/backup/aurad-$TRIPLE" "$WORK/backup/aura-$TRIPLE" "$ROOT/apps/desktop/src-tauri/binaries/"
  fi
}

cat > "$WORK/test.conf.json" <<EOF
{ "identifier": "$ID", "productName": "$NAME",
  "plugins": { "updater": { "dangerousInsecureTransportProtocol": true } } }
EOF

# Build the app bundle with the test config; $1 is the version.
build_app() {
  (cd apps/desktop && pnpm tauri build --bundles app --features updater-test \
    --config "$WORK/test.conf.json" --config "{\"version\":\"$1\"}") > "$WORK/build-$1.log" 2>&1 \
    || { tail -40 "$WORK/build-$1.log"; exit 1; }
}

# Take a staged bundle out of target/ so Launch Services does not keep it.
unstage() {
  "$LSREGISTER" -u "$STAGED/$NAME.app" >/dev/null 2>&1 || true
  rm -rf "$STAGED/$NAME.app" "$STAGED/$NAME.app.tar.gz" "$STAGED/$NAME.app.tar.gz.sig"
}

log "building A ($A_VERSION)"
./scripts/build-sidecars.sh release > "$WORK/sidecars-A.log" 2>&1
cp "apps/desktop/src-tauri/binaries/aurad-$TRIPLE" "apps/desktop/src-tauri/binaries/aura-$TRIPLE" "$WORK/backup/"
build_app "$A_VERSION"
ditto "$STAGED/$NAME.app" "$WORK/A/$NAME.app"
unstage

log "building B ($B_VERSION)"
trap restore EXIT
# The daemon and app report the workspace version, so B's must be B's.
sed -i '' "s/^version = \"$A_VERSION\"$/version = \"$B_VERSION\"/" Cargo.toml
grep -q "^version = \"$B_VERSION\"$" Cargo.toml
./scripts/build-sidecars.sh release > "$WORK/sidecars-B.log" 2>&1
build_app "$B_VERSION"
cp "$STAGED/$NAME.app.tar.gz" "$STAGED/$NAME.app.tar.gz.sig" "$WORK/server/"
unstage
restore
trap - EXIT

log "serving B"
PORT=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])')
# The bundle-specific entry must win over the plain one, which points nowhere.
cat > "$WORK/server/latest.json" <<EOF
{
  "version": "$B_VERSION",
  "notes": "End-to-end test",
  "pub_date": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "platforms": {
    "darwin-$ARCH-app": { "url": "http://127.0.0.1:$PORT/$NAME.app.tar.gz", "signature": "$(cat "$WORK/server/$NAME.app.tar.gz.sig")" },
    "darwin-$ARCH": { "url": "http://127.0.0.1:$PORT/missing.tar.gz", "signature": "not used" }
  }
}
EOF
python3 -m http.server "$PORT" --bind 127.0.0.1 --directory "$WORK/server" > "$WORK/server.log" 2>&1 &
SERVER=$!

APP="$WORK/A/$NAME.app"
EXE="$APP/Contents/MacOS/$(/usr/libexec/PlistBuddy -c "Print :CFBundleExecutable" "$APP/Contents/Info.plist")"
# Only processes of the test app: its path is under $WORK.
test_pids() { pgrep -f "^$WORK/A/$NAME.app/Contents/MacOS/" || true; }
cleanup() {
  [ "$KEEP" = 1 ] && { echo "left running (--keep): $(test_pids | tr '\n' ' ')"; return; }
  AURA_DATA_DIR="$WORK/data" "$APP/Contents/MacOS/aura" daemon stop >/dev/null 2>&1 || true
  for pid in $(test_pids); do
    case "$(ps -o command= -p "$pid")" in "$WORK"/*) kill "$pid" 2>/dev/null || true ;; esac
  done
  kill "$SERVER" 2>/dev/null || true
  "$LSREGISTER" -u "$APP" >/dev/null 2>&1 || true
  # The test identifier's own webview and app data; never the real Aura's.
  for d in "$HOME/Library/WebKit/$ID" "$HOME/Library/Caches/$ID" "$HOME/Library/Application Support/$ID"; do
    case "$d" in *"/$ID") rm -rf "$d" ;; esac
  done
}
trap cleanup EXIT

log "running A from $APP"
AURA_DATA_DIR="$WORK/data" AURA_UPDATER_ENDPOINT="http://127.0.0.1:$PORT/latest.json" \
  AURA_UPDATER_TEST_AUTO_RESTART=1 RUST_LOG=info \
  nohup "$EXE" > "$WORK/app.log" 2>&1 &
A_PID=$!
echo "A pid $A_PID"

daemon_field() { jq -r ".$1 // empty" "$WORK/data/daemon.json" 2>/dev/null || true; }
for _ in $(seq 1 30); do [ -n "$(daemon_field pid)" ] && break; sleep 1; done
A_DAEMON=$(daemon_field pid)
echo "A's daemon: pid $A_DAEMON, version $(daemon_field version): $(ps -o command= -p "$A_DAEMON" 2>/dev/null)"

log "waiting for the update (first check after 10 s)"
updated=0
for _ in $(seq 1 120); do
  sleep 1
  v=$(/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "$APP/Contents/Info.plist" 2>/dev/null || true)
  if [ "$v" = "$B_VERSION" ] && [ "$(daemon_field version)" = "$B_VERSION" ]; then updated=1; break; fi
done

log "results"
fail=0
check() { if eval "$2"; then echo "ok    $1"; else echo "FAIL  $1"; fail=1; fi; }
B_DAEMON=$(daemon_field pid)
check "app bundle at $APP is now $B_VERSION" '[ "$(/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "$APP/Contents/Info.plist")" = "$B_VERSION" ]'
check "A's process ($A_PID) exited" '! kill -0 "$A_PID" 2>/dev/null'
check "the app runs again from $APP" '[ -n "$(pgrep -f "^$EXE")" ]'
check "A's daemon ($A_DAEMON) stopped" '! kill -0 "$A_DAEMON" 2>/dev/null'
check "a daemon of $B_VERSION runs ($B_DAEMON)" '[ "$(daemon_field version)" = "$B_VERSION" ] && kill -0 "$B_DAEMON" 2>/dev/null'
check "the new daemon uses $WORK/data" 'ps -o command= -p "$B_DAEMON" | grep -q -- "--data-dir $WORK/data"'
check "the new daemon is B's binary" 'ps -o command= -p "$B_DAEMON" | grep -q "^$APP/Contents/MacOS/aurad"'
check "the manifest and B's package were downloaded" 'grep -q "GET /latest.json" "$WORK/server.log" && grep -q "GET /$NAME.app.tar.gz" "$WORK/server.log"'
check "the plain darwin-$ARCH entry was not used" '! grep -q "missing.tar.gz" "$WORK/server.log"'
check "the shell verified, stopped the daemon and installed" 'grep -q "update downloaded and verified" "$WORK/app.log" && grep -q "daemon stopped, installing the update" "$WORK/app.log"'
echo
echo "logs: $WORK/app.log $WORK/server.log"
[ "$updated" = 1 ] && [ "$fail" = 0 ] && echo "PASS" || { echo "FAILED"; tail -30 "$WORK/app.log"; exit 1; }
