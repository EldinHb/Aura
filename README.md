# Aura

Aura is a keyboard-first desktop app that runs, supervises and persists local AI coding CLI sessions (Claude Code, Codex, and any other CLI). Sessions live in a background daemon and survive the window closing, the way tmux keeps shells alive, but with a real GUI and a unified view across agents.

- **Rust** daemon (`aurad`), CLI (`aura`) and Tauri 2 shell; **React + TypeScript** frontend.
- **Structured mode**: Claude Code (stream-json) and Codex (app-server JSON-RPC) rendered as one transcript model: turns, messages, reasoning, tool calls, command output, file changes, approvals, questions, usage.
- **Terminal mode**: any CLI in a PTY with persisted scrollback; a structured session can switch to the provider's own TUI and back.
- **Keyboard only**: command palette, leader key with which-key menu, focus regions, vim-style lists, single-key approvals, hint mode for anything else, editable keymap.

See `PLAN.md` for the architecture and `docs/protocol/` for the captured CLI protocols.

## Layout

```
crates/aura-core            domain model, session manager, provider trait, in-memory store
crates/aura-store           SQLite store (rusqlite, FTS5)
crates/aura-pty             PTY spawning (portable-pty) + scrollback ring buffer
crates/aura-terminal        plain terminal provider
crates/aura-provider-claude Claude Code adapter (stream-json)
crates/aura-provider-codex  Codex adapter (app-server JSON-RPC)
crates/aura-rpc             loopback WebSocket JSON-RPC server + client
crates/aura-git             worktrees, status, diff, commit, push (shells out to git)
crates/aurad                the daemon
crates/aura-cli             the `aura` command
apps/desktop                Tauri 2 shell (src-tauri) + React frontend (src)
docs/protocol               captured Claude / Codex traffic and notes
scripts/                    export-ts.sh (Rust -> TS types), build-sidecars.sh
```

## Prerequisites

- Rust 1.89+ (stable), Node 20+, pnpm. 1.89 is where `std::fs::File::try_lock` landed; `aurad` uses it to hold a single-instance lock on its data directory.
- macOS: Xcode or the Xcode Command Line Tools (with the license accepted).
- Linux: `libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev` (Tauri 2 requirements).
- Windows: WebView2 runtime (ships with Windows 11).
- `claude` and/or `codex` installed for the AI providers. Aura checks PATH plus the usual install directories (Homebrew, `~/.local/bin`, npm/volta/bun globals); set `AURA_CLAUDE_BIN` / `AURA_CODEX_BIN` to point at a binary elsewhere.

## Build and run

```bash
# daemon + CLI (also copies them where the Tauri bundler expects sidecars)
./scripts/build-sidecars.sh            # debug
./scripts/build-sidecars.sh release    # release

# regenerate TypeScript types after changing Rust types
./scripts/export-ts.sh

# desktop app in dev mode (starts Vite, builds the shell, opens the window)
cd apps/desktop && pnpm install && pnpm tauri dev

# desktop app bundle (.app / .deb / .AppImage / .msi / NSIS depending on the host)
cd apps/desktop && pnpm tauri build
# macOS disk image (needs a logged-in GUI session; the DMG step drives Finder)
cd apps/desktop && pnpm tauri build --bundles dmg
```

On macOS, install with `./scripts/install-macos.sh` rather than copying by hand.
`pnpm tauri build` stages a real `Aura.app` in `target/release/bundle/macos/` with
the shipping identifier (`nl.havick.aura`). Launch Services registers any app
bundle it finds, and a registered bundle appears in Spotlight search, so a staged
copy shows up as a second "Aura" and `open -b nl.havick.aura` may resolve to the
build tree. The `.metadata_never_index` marker the build scripts drop in `target/`
keeps build output out of the Spotlight *content* index but does not prevent that
registration — so the install script unregisters and deletes the staging copy once
it is installed, leaving `/Applications/Aura.app` as the only Aura. It also stops
`aurad` first: the daemon outlives the app, and a stale one keeps serving the new
UI (and keeps reporting the CLI versions it detected at its own startup).

The shell starts `aurad` on demand and connects the webview to it over a token-protected loopback WebSocket. The daemon writes `~/.aura/daemon.json` (owner-only) with the port and token. Closing the main window hides it; quit from the tray. The daemon keeps running either way.

### CLI

```bash
aura daemon start|stop|status
aura ls [--all]
aura new --provider claude|codex|terminal [--cwd DIR] [--title T] [--group G] [--prompt TEXT] [--branch B] [--resume NATIVE_ID] [-- cmd args...]
aura attach <id>         # raw terminal passthrough; Ctrl+\ detaches
aura send <id> <text>
aura interrupt <id>
aura pending             # approvals and questions waiting across sessions
aura approve <session> <approval-id> [accept|session|decline|cancel]
aura mode <id> terminal|structured
aura kill <id>           # stop the process, keep the session resumable
aura rm <id> [--worktree]
aura events              # live JSON event stream
aura history <id>
```

Set `AURA_DATA_DIR` to use a different data directory (useful for tests).

## Browser dev mode

The frontend talks to the daemon directly, so it also runs in a plain browser: start `aurad`, run `pnpm dev` in `apps/desktop`, open http://localhost:1420. The Vite dev server serves `~/.aura/daemon.json` on `/__aura/daemon.json` for this purpose (dev only). Playwright end-to-end tests run against this setup (`pnpm e2e`).

## Tests

```bash
cargo test --workspace                         # unit + integration tests (no network)
AURA_LIVE_TESTS=1 cargo test -p aura-provider-claude -- --ignored   # real Claude Code round trip
AURA_LIVE_TESTS=1 cargo test -p aura-provider-codex  -- --ignored   # real Codex round trip
cd apps/desktop && pnpm test && pnpm lint      # vitest + eslint (incl. the keyboard-reachability rule)
cd apps/desktop && pnpm e2e                    # Playwright, needs a running daemon + dev server
```

## Keyboard basics

| Keys | Action |
|---|---|
| `⌘K` | Command palette (every action lives here) |
| `Ctrl+Space` | Leader menu (which-key shows what comes next) |
| `⌘N` / `⌘⇧N` | New session / new session in a git worktree |
| `⌘1…9`, `⌘[` `⌘]` | Jump between sessions |
| `Ctrl+H/J/K/L` | Move focus between sidebar, transcript, composer, inspector |
| `j` `k` `gg` `G` `Enter` | Navigate lists and transcript items |
| `y` `Y` `n` `e` | Accept / accept for session / decline / edit the oldest pending approval |
| `⌘I` | Approvals inbox across all sessions |
| `⌘T` | Toggle structured view and the provider's own TUI |
| `⌘D` | Diff of the session's working tree |
| `f` | Hint mode: label everything clickable, type the label |
| `Ctrl+\` or `Esc Esc` | Leave an embedded terminal |
| `?` | Keyboard help |

Everything is rebindable in Settings → Keymap; overrides are stored per user.

## License

MIT, see `LICENSE`.
