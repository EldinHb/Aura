# Aura for Android

A native Android client for Aura. It connects to `aurad`'s remote listener on
your computer, shows your sessions and their transcripts, and lets you answer
what waits on you: send messages, approve or decline, answer questions,
interrupt or stop an agent, and start new sessions.

Kotlin, Jetpack Compose and Material 3 (Material You: dynamic color on
Android 12+, light and dark following the system). Android 8.0 (API 26) and
later.

The protocol it speaks is in [`docs/design/remote.md`](../../docs/design/remote.md)
(on the remote-access branch until that merges).

## Build

You need JDK 17 or later (Android Studio's bundled JDK works) and the Android
SDK with platform 36.

```bash
cd apps/android
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"   # macOS, Android Studio's JDK
echo "sdk.dir=$HOME/Library/Android/sdk" > local.properties                      # where your SDK is; not committed

./gradlew assembleDebug            # app/build/outputs/apk/debug/app-debug.apk
./gradlew testDebugUnitTest lint   # unit tests and lint
./gradlew assembleRelease          # app/build/outputs/apk/release/app-release.apk
```

Or open `apps/android` in Android Studio.

### Release signing

`assembleRelease` signs with the keystore given in the environment:

| variable | value |
|---|---|
| `AURA_ANDROID_KEYSTORE` | the keystore file, base64-encoded (`base64 -i release.jks`) |
| `AURA_ANDROID_KEYSTORE_PASSWORD` | the keystore's password |
| `AURA_ANDROID_KEY_ALIAS` | the key's alias |
| `AURA_ANDROID_KEY_PASSWORD` | the key's password |

Without `AURA_ANDROID_KEYSTORE` the release APK is signed with the debug key,
so it still installs (but cannot update an APK signed with the release key,
or the other way round).

## Install

With the phone connected over USB (USB debugging on) or an emulator running:

```bash
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

Or copy the APK to the phone and open it (allow installing from that source
when Android asks).

## Pair with your computer

1. On the computer, turn on remote access and start pairing. From a terminal
   of your own (not inside an Aura session; it asks for confirmation):

   ```bash
   aura remote on            # listens on 0.0.0.0:7443; --bind/--port/--name to change
   aura remote pair          # prints a QR code link, the code, the fingerprint and the addresses
   ```

   Aura's settings do the same.
2. In the app, tap **Add server**, then either
   - **Scan QR code** and point the camera at the code Aura shows,
   - paste the `aura://pair?…` link, or
   - enter the host, port, certificate fingerprint and pairing code by hand.

   Opening an `aura://pair` link on the phone (from a message, say) opens the
   app on the same screen.
3. Check that the fingerprint the app shows is the one Aura shows, then tap
   **Pair**. Pairing codes last 5 minutes and work once.

The phone must reach the computer: the same Wi-Fi, a VPN such as Tailscale,
or an SSH tunnel to the listener.

### Security

- The server's certificate is self-signed. The app trusts exactly the
  certificate whose SHA-256 fingerprint you confirmed when pairing, and no
  other. If the server later shows a different certificate the app refuses to
  connect and says so; it never accepts the new one silently. Pair again if
  you reinstalled Aura or reset its remote access.
- The device token is encrypted with an AES-GCM key kept in the Android
  Keystore. Nothing is backed up or moved to another phone; on a new phone,
  pair again.
- Revoke a lost phone on the computer: `aura remote devices`, then
  `aura remote revoke <deviceId>`. The app then tells you the device is no
  longer paired.

## How it works

- `net/`: JSON-RPC 2.0 over an OkHttp WebSocket (`JsonRpcClient`,
  `RpcSocket`), certificate pinning (`PinnedTls`), and `ServerConnection`,
  which authenticates, keeps the session list fresh from the server's events
  and reconnects with backoff (1 s doubling to 30 s, or what a rate limit
  asks). Connections run while the app is in the foreground and retry at once
  when the network comes back.
- `data/`: the saved servers (DataStore) and the Keystore cipher.
- `protocol/` and `transcript/`: the daemon's types and the transcript built
  from a session's events.
- `ui/`: one screen per package, each with a `ViewModel`.

## Screenshots

See [`docs/screenshots/`](docs/screenshots/).
