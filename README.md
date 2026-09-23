<p align="center">
  <img src="apps/desktop/src-tauri/icons/128x128@2x.png" width="128" height="128" alt="Aura">
</p>

<h1 align="center">Aura</h1>

<p align="center">
  A keyboard-first desktop app for running, supervising and keeping your AI coding agents.<br>
  Claude Code, Codex and any other CLI, in one window. Sessions keep running after you close it.
</p>

<p align="center">
  <a href="https://github.com/EldinHb/Aura/releases/latest"><strong>Download</strong></a> ·
  <a href="#install">Install</a> ·
  <a href="#getting-started">Getting started</a> ·
  <a href="#keyboard-basics">Keyboard</a> ·
  <a href="#building-from-source">Build from source</a>
</p>

---

## What is Aura?

If you run several AI coding agents at once, you probably have a pile of terminal
tabs, some waiting on an approval you have not seen yet. Aura puts them in one place.

- **Sessions outlive the window.** Agents run in a background daemon (`aurad`), the
  way tmux keeps shells alive. Close Aura, reopen it, and every session is where you
  left it: output, history and pending approvals included.
- **One transcript for every agent.** Claude Code and Codex sessions are shown in the
  same structured view: messages, reasoning, tool calls, command output, file changes,
  approvals, questions and token usage.
- **Any CLI works.** Anything else runs in a real terminal with saved scrollback. A
  Claude Code or Codex session can also switch to the agent's own TUI and back.
- **An inbox for approvals.** See every session waiting on you, and approve or decline
  with a single key.
- **Git worktrees built in.** Start a session in its own worktree so parallel agents do
  not step on each other. Review the diff, commit and push from Aura.
- **Pull request reviews.** See PRs that request your review, run an agent pre-review,
  edit its findings, and post the review to GitHub yourself.
  See [Pull requests and pre-reviews](#pull-requests-and-pre-reviews).
- **Keyboard only.** Command palette, a leader key with a which-key menu, vim-style
  navigation and hint mode for everything else. Every binding can be changed.

Aura is not an agent and never calls a model API. Logins, billing and model access
stay with each CLI. Everything runs on your machine; there is no cloud service.

> **Status:** early (0.x). Things change quickly and may break between releases.
> Bug reports are welcome in [Issues](https://github.com/EldinHb/Aura/issues).

## Install

Download the file for your system from the
[latest release](https://github.com/EldinHb/Aura/releases/latest).

| System | File |
|---|---|
| macOS, Apple Silicon (M1 and later) | `Aura_<version>_aarch64.dmg` |
| macOS, Intel | `Aura_<version>_x64.dmg` |
| Windows 10/11 | `Aura_<version>_x64-setup.exe` (or the `.msi`) |
| Debian, Ubuntu | `Aura_<version>_amd64.deb` |
| Fedora, RHEL, openSUSE | `Aura-<version>-1.x86_64.rpm` |
| Any other Linux | `Aura_<version>_amd64.AppImage` |

The daemon and the `aura` command-line tool are included in every installer.

### First launch

The builds are not yet signed with an Apple or Microsoft developer certificate, so
your system will warn you the first time.

- **macOS:** open the `.dmg` and drag Aura to Applications. The first time you open
  it, macOS says it cannot verify the app. Open **System Settings → Privacy &
  Security**, scroll down and click **Open Anyway**. Or run this once in a terminal:
  ```bash
  xattr -dr com.apple.quarantine /Applications/Aura.app
  ```
- **Windows:** if SmartScreen shows "Windows protected your PC", click **More info →
  Run anyway**. Aura needs the WebView2 runtime; Windows 11 already has it, and the
  installer downloads it on Windows 10 when missing.
- **Linux:** install the `.deb` or `.rpm` with your package manager
  (`sudo apt install ./Aura_*.deb`, `sudo dnf install ./Aura-*.rpm`). For the
  AppImage, make it executable first: `chmod +x Aura_*.AppImage`.

## Getting started

1. **Install at least one agent CLI** and sign in to it:
   [Claude Code](https://docs.claude.com/en/docs/claude-code) (`claude`) and/or
   [Codex](https://github.com/openai/codex) (`codex`). Aura looks for them on your
   `PATH` and in the usual install locations (Homebrew, `~/.local/bin`, npm, volta and
   bun globals). If yours is elsewhere, set `AURA_CLAUDE_BIN` or `AURA_CODEX_BIN` to
   the full path.
2. **Open Aura.** It starts the daemon for you.
3. **Press `⌘N`** (`Ctrl+N` on Windows and Linux) to start a session, pick a provider
   and a folder, and type a prompt. `⌘⇧N` does the same in a new git worktree.
4. **Press `⌘K`** at any time for the command palette. Every action is in there, with
   its shortcut. `?` shows the keyboard help.

Closing the window hides Aura; your sessions keep running. Quit from the tray icon.
The daemon keeps running after you quit too, so agents can finish their work. Stop it
with `aura daemon stop`.

For PR reviews, also install the [GitHub CLI](https://cli.github.com) and run
`gh auth login`.

## Keyboard basics

Shortcuts are shown with macOS keys; use `Ctrl` for `⌘` on Windows and Linux.

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

## Command line

The `aura` command talks to the same daemon as the app, so sessions started in one
show up in the other.

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

On macOS the installed binary is at `/Applications/Aura.app/Contents/MacOS/aura`;
link it onto your `PATH` to use it from a terminal:

```bash
ln -s /Applications/Aura.app/Contents/MacOS/aura /usr/local/bin/aura
```

Set `AURA_DATA_DIR` to use a different data directory (useful for tests).

## How it works

```
 Aura app (Tauri 2 + React)      aura CLI
            │                        │
            └──── WebSocket (127.0.0.1, token) ────┐
                                                   ▼
                              aurad (daemon, survives the app)
                              sessions · event log (SQLite) · git · GitHub
                                                   │
                         ┌─────────────────────────┼──────────────────┐
                         ▼                         ▼                  ▼
                   claude (stream-json)   codex (app-server)   any CLI in a PTY
```

The app starts `aurad` when needed and connects to it over a loopback WebSocket
protected by a token. The daemon writes `~/.aura/daemon.json` (readable only by you)
with the port and token. Session history is stored in SQLite under `~/.aura`.

See [`PLAN.md`](PLAN.md) for the full architecture and
[`docs/protocol/`](docs/protocol) for the captured Claude Code and Codex protocols.

## Pull requests and pre-reviews

The **Needs your review** section below sessions lists open GitHub PRs requesting
**your review** (not PRs where you are merely an assignee). Install GitHub CLI and
run `gh auth login` for github.com, then refresh the section. Aura uses that
account through the daemon; it does not import Gitbuddy's credentials. Optional
`AURA_GH_BIN` selects a GitHub CLI executable outside the usual search paths.

Click a PR to open its description, conversation, existing reviews, metadata and
current diff in the main workspace. Applicable metadata and project fields can
be edited when GitHub grants access. Project fields may require additional GitHub
Projects permissions; their failure does not prevent reviewing the PR. Hide a PR
with its × control and restore it through **Show hidden**. Hiding persists per
account. **Review history** keeps results accessible after requests disappear.
The command palette also exposes refresh, hide/restore, history, and section
visibility actions. Session processes and unsent messages survive switching views.

**Pre-review…** always opens settings first: Claude Code or Codex, model, effort,
and default/add/replace review instructions. Replacement affects instructions;
PR context, the output schema and execution restrictions remain in place. The
last confirmed settings become the next default, independently of chat settings.
Current CLI versions supporting schema-constrained output and isolated settings
are required. Missing or incompatible CLIs surface an error without starting a
chat session or silently weakening the review restrictions.

Confirmed jobs run in the daemon (two at a time, with a 15-minute timeout), using
an isolated worktree at the captured commit. Shared partial mirrors are cached
under the daemon's `review-workspaces/mirrors` directory. Worktree contents are
removed on completion/cancellation and stale Git registrations are pruned on
reuse. A checkout failure can fall back to a clearly labeled diff-only review.
Closing the window does not stop jobs. A daemon restart marks interrupted jobs
as failed and resumes jobs that were still queued. Retry always reopens settings
and creates a separate attempt.

The result editor pairs a frozen diff with editable summary, verdict, risk and
findings. Add a finding from a diff line, navigate between findings and the diff,
and delete/restore findings before posting. Draft edits autosave to the daemon;
unsaved changes are also retained locally for recovery. Submitted reviews are
read-only. Provider runs use read-only policies, disable inherited integrations,
and remove GitHub token environment variables; normal chat permissions are not
inherited.

**Submit to GitHub…** saves pending edits and shows the exact review payload.
Only the explicit **Post** action sends it as your GitHub account. Findings stay
anchored to the reviewed commit; a changed PR triggers a warning and refreshed
preview. Unanchorable findings become Additional notes in the body. Deleted
findings and private agent rationale are excluded. A hidden receipt marker lets
Aura reconcile a request whose response was lost. If a submission outcome is
uncertain, use **Reconcile with GitHub**; Aura will not blindly repeat the POST.

---

## Building from source

Aura is a Rust workspace (daemon, CLI, Tauri 2 shell) with a React + TypeScript
frontend.

### Prerequisites

- Rust 1.89+ (stable), Node 20+, pnpm. 1.89 is where `std::fs::File::try_lock` landed; `aurad` uses it to hold a single-instance lock on its data directory.
- macOS: Xcode or the Xcode Command Line Tools (with the license accepted).
- Linux: `libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev` (Tauri 2 requirements).
- Windows: WebView2 runtime (ships with Windows 11).

### Build and run

```bash
# daemon + CLI (also copies them where the Tauri bundler expects sidecars)
./scripts/build-sidecars.sh            # debug
./scripts/build-sidecars.sh release    # release
TARGET_TRIPLE=x86_64-apple-darwin ./scripts/build-sidecars.sh release   # cross-compile

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

### Browser dev mode

The frontend talks to the daemon directly, so it also runs in a plain browser: start `aurad`, run `pnpm dev` in `apps/desktop`, open http://localhost:1420. The Vite dev server serves `~/.aura/daemon.json` on `/__aura/daemon.json` for this purpose (dev only). Playwright end-to-end tests run against this setup (`pnpm e2e`).

### Tests

```bash
cargo test --workspace                         # unit + integration tests (no network)
AURA_LIVE_TESTS=1 cargo test -p aura-provider-claude -- --ignored   # real Claude Code round trip
AURA_LIVE_TESTS=1 cargo test -p aura-provider-codex  -- --ignored   # real Codex round trip
cd apps/desktop && pnpm test && pnpm lint      # vitest + eslint (incl. the keyboard-reachability rule)
cd apps/desktop && pnpm e2e                    # Playwright, needs a running daemon + dev server
```

The PR review tests require no GitHub account or agent quota:

```sh
cargo test -p aura-github -p aura-review -p aura-store
cd apps/desktop && pnpm test && pnpm lint && pnpm build
# with pnpm dev running; GitHub and review providers are mocked by this spec
pnpm e2e tests/e2e/pr-review.spec.ts
```

### Project layout

```
crates/aura-core            domain model, session manager, provider trait, in-memory store
crates/aura-store           SQLite store (rusqlite, FTS5)
crates/aura-pty             PTY spawning (portable-pty) + scrollback ring buffer
crates/aura-terminal        plain terminal provider
crates/aura-provider-claude Claude Code adapter (stream-json)
crates/aura-provider-codex  Codex adapter (app-server JSON-RPC)
crates/aura-rpc             loopback WebSocket JSON-RPC server + client
crates/aura-git             worktrees, status, diff, commit, push (shells out to git)
crates/aura-github          GitHub access through the gh CLI
crates/aura-review          PR pre-review jobs
crates/aurad                the daemon
crates/aura-cli             the `aura` command
apps/desktop                Tauri 2 shell (src-tauri) + React frontend (src)
docs/protocol               captured Claude / Codex traffic and notes
scripts/                    export-ts.sh (Rust -> TS types), build-sidecars.sh, install-macos.sh
```

### Releasing

Releases are built by [`.github/workflows/release.yml`](.github/workflows/release.yml)
on macOS (Apple Silicon and Intel), Windows and Linux. To publish one:

1. Set the new version in `apps/desktop/src-tauri/tauri.conf.json` (and, to keep them
   in step, `version` in the root `Cargo.toml` and `apps/desktop/package.json`).
2. Commit, then tag and push:
   ```bash
   git tag v0.2.0 && git push origin v0.2.0
   ```

The workflow refuses a tag that does not match the version in `tauri.conf.json`. It
builds every installer into a draft release and publishes it once all platforms
succeed, with release notes generated from the commits since the previous tag.

## License

MIT, see [`LICENSE`](LICENSE).
