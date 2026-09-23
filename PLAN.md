# Aura — Project Plan

Aura is a keyboard-first desktop app that runs, supervises and persists local AI coding CLI sessions (Claude Code, Codex, and any other CLI) the way Agent of Empires does in the terminal, but with a real GUI and a unified model across agents.

Stack: Rust backend, Tauri 2 shell, React + TypeScript frontend.

Status: plan only. Nothing is built yet. Written 2026-09-17, revised the same day to move from Go/Wails to Rust/Tauri.

---

## 1. Goals and non-goals

**Goals**

1. Sessions survive the GUI. Close the window, restart the app, the agents keep running and you reattach exactly where you were.
2. Real-time, structured view of Claude Code and Codex sessions: streaming text, tool calls, approvals, questions, diffs, plans, token usage.
3. Feature parity with the underlying CLIs, exposed through one unified UI. Anything Aura cannot map structurally is still reachable through an embedded terminal for the same session.
4. Keyboard-only operation. Every action has a binding, every list is navigable, no mouse-only affordance exists.
5. Manage many sessions: grouping, status at a glance, an inbox of sessions waiting for approval or input, git worktree per session.

**Non-goals (for v1)**

- Aura is not an agent itself and never talks to model APIs. Authentication, billing and model access stay inside each CLI.
- No cloud sync, no remote access, no web dashboard.
- No mobile.

---

## 2. Stack decision: Rust + Tauri 2

**Decision: Tauri 2 for the shell and Rust for the entire backend.** Go was a nice-to-have, not a requirement, and the alternative (Wails v3) is still in beta with 27 blocking gates and no GA date. Tauri 2 has been stable since late 2024 and its bundler, signing, updater, tray, multi-window, single-instance and global-shortcut support are mature.

Consequences of going all-Rust rather than Rust shell plus Go daemon:

- One language, one toolchain, one Cargo workspace. The daemon, the CLI and the shell share the same core crate.
- No sidecar cross-compilation dance. The daemon is a bin target in the same workspace and is bundled by Tauri as an external binary.
- Codex's app-server protocol and the Codex TUI are themselves Rust, and there is an existing typed Rust crate for the protocol, so the Codex adapter has a head start.
- PTY handling uses the crate WezTerm is built on, which already abstracts Unix PTYs and Windows ConPTY.

Costs: Rust compile times, a steeper curve for contributors who only know Go or TypeScript, and stricter discipline around async and ownership in the adapter code. None of these are unsupported-scenario risks; they are effort.

Tauri uses the system webview on every platform (WKWebView, WebView2, WebKitGTK 4.1), so React and xterm.js behave the same as in any other webview-based app.

---

## 3. Architecture

```
┌────────────────────────────────────────────────────────────────┐
│  aura-app (Tauri 2 shell, Rust)                                │
│  windows · tray · global hotkey · single instance · updater    │
│  spawns/adopts aurad, hands the webview a connection token     │
│                                                                │
│  React + TS frontend  ──── WebSocket (127.0.0.1, token) ────┐  │
└─────────────────────────────────────────────────────────────┼──┘
                                                              │
┌─────────────────────────────────────────────────────────────┴──┐
│  aurad (Rust daemon, tokio, survives GUI exit)                 │
│                                                                │
│  Session manager ── Event log (SQLite) ── Settings/keymaps     │
│        │                                                       │
│  ┌─────┴─────────┬──────────────────┬──────────────────┐       │
│  │ Claude adapter│  Codex adapter   │  Terminal adapter │      │
│  │ stream-json   │  app-server RPC  │  PTY + scrollback │      │
│  └───────┬───────┴────────┬─────────┴─────────┬─────────┘      │
│          │                │                   │                │
│   claude -p ...     codex app-server     any CLI in a PTY      │
└────────────────────────────────────────────────────────────────┘
```

**Why a daemon.** This is the tmux role. tmux itself is optional and Linux/macOS only. Owning PTYs and adapter processes in `aurad` gives the same persistence on all three platforms, lets the GUI restart freely, and lets a CLI (`aura attach <id>`) share the same sessions.

**Why the frontend talks to the daemon directly.** Webviews cannot open Unix sockets, and routing every PTY byte and stream delta through Tauri IPC adds a hop for nothing. The daemon listens on a loopback TCP port chosen at start and writes `{port, token}` to `~/.aura/daemon.json` with owner-only permissions. The shell reads that file and injects the token into the webview at startup. Tauri IPC is used only for things that need the native shell: windows, tray, hotkeys, dialogs, clipboard, notifications, updater.

**Process model.** One `aurad` per user, spawned detached (setsid on Unix, detached process flags on Windows) so it outlives the shell. Optional install as a launchd or systemd user service. One child process per structured Claude session, one shared `codex app-server` for all Codex sessions since it multiplexes threads, one PTY per terminal session.

**Transport.** JSON-RPC 2.0 over WebSocket for control and events, with binary WebSocket frames for PTY bytes. The same endpoint serves the shell, the CLI and any future client.

### Cargo workspace

```
aura/
  Cargo.toml                workspace
  crates/
    aura-core/              domain model, session manager, event log, provider trait
    aura-store/             SQLite (rusqlite bundled, FTS5), migrations
    aura-pty/               portable-pty wrapper, scrollback ring buffer
    aura-provider-claude/   stream-json adapter
    aura-provider-codex/    app-server JSON-RPC adapter, generated types
    aura-rpc/               daemon WebSocket server, JSON-RPC types, TS type export
    aura-git/               worktrees, diff, status (shells out to git)
    aurad/                  daemon binary
    aura-cli/               aura ls | new | attach | kill
  apps/
    desktop/                Tauri 2 app: src-tauri/ (Rust shell) + src/ (React)
  docs/                     protocol captures, keymap reference
  PLAN.md
```

Key crates: `tokio`, `serde`/`serde_json`, `tokio-tungstenite` or `axum` for the WebSocket server, `portable-pty`, `rusqlite` with `bundled` and FTS5, `typify` or `schemars` for generated Codex types, `ts-rs` or `specta` to export the RPC types to TypeScript so the frontend never hand-writes them, `notify` for file watching, `tracing` for logs.

Tauri plugins: `shell` (spawn daemon), `single-instance`, `global-shortcut`, `window-state`, `notification`, `updater`, `dialog`, `clipboard-manager`, `os`. Tray via the core `tray-icon` feature.

---

## 4. Unified domain model

The whole point of "unified" is one set of types the UI renders regardless of provider. These live in `aura-core` and are exported to TypeScript.

```
Session      id, provider, native_id, cwd, worktree?, title, group,
             status: Idle | Running | WaitingApproval | WaitingInput | Error | Exited,
             mode: Structured | Terminal, model, effort, permission_mode, created_at, last_activity
Turn         id, session_id, status: Running | Completed | Interrupted | Failed, usage
Item         id, turn_id, kind:
               UserMessage | AgentMessage | Reasoning | ToolCall | CommandExec |
               FileChange | Plan | Subagent | WebSearch | McpCall | Error | System
             plus streaming deltas and final state
Approval     id, session_id, kind: Command | FileChange | Permission | Tool | Generic,
             payload, options: [Accept, AcceptForSession, Decline, Cancel, EditInput?]
UserInput    id, session_id, questions[] (1..n), options per question, free text allowed?
Capability   set per provider: models, effort_levels, permission_modes, fork, steer,
             review, compact, mcp_status, skills_list, images, background_terminals, diff_stream
```

Every provider implements one trait:

```rust
#[async_trait]
pub trait Provider: Send + Sync {
    fn capabilities(&self) -> CapabilitySet;
    async fn list_native(&self) -> Result<Vec<NativeSession>>;      // discover existing sessions
    async fn start(&self, opts: StartOpts) -> Result<Session>;
    async fn resume(&self, native_id: &str, opts: ResumeOpts) -> Result<Session>;
    async fn fork(&self, native_id: &str, opts: ForkOpts) -> Result<Session>;
    async fn send(&self, session: SessionId, input: Input) -> Result<()>;   // text, images, slash commands
    async fn interrupt(&self, session: SessionId) -> Result<()>;
    async fn respond(&self, response: Response) -> Result<()>;      // approval or user input
    async fn set(&self, session: SessionId, setting: Setting) -> Result<()>; // model, effort, permission mode
    fn events(&self) -> broadcast::Receiver<Event>;                 // normalized stream
}
```

The UI reads `capabilities()` and shows, hides or greys features per session. That is how "everything the CLIs support" and "unified" coexist: common things look identical, provider-only things appear only where supported, and terminal mode is the fallback for anything not yet modelled.

### Structured ⇄ terminal switching

A session runs in exactly one mode at a time; two processes on one native session would corrupt it. Switching mode stops the current child and reopens the same native session ID in the other one (`claude --resume <id>` in a PTY, or `codex resume <id>`). This gives full-fidelity access to every CLI feature from day one and lets structured coverage grow without ever blocking the user.

---

## 5. Provider adapters

### 5.1 Claude Code (verified against v2.1.274 locally)

Launch per session with `tokio::process`:

```
claude -p --input-format stream-json --output-format stream-json --verbose \
  --include-partial-messages --replay-user-messages --forward-subagent-text \
  --permission-prompt-tool stdio [--resume <id> | --session-id <uuid>] [--fork-session]
```

Mapping:

| Aura concept | Claude stream-json |
|---|---|
| Session start metadata | `system/init` (model, tools, MCP servers, plugins, `capabilities[]`) |
| Streaming text, reasoning | `stream_event` deltas, `assistant` messages |
| Tool call / result | `tool_use` and `tool_result` blocks; subagents via `parent_tool_use_id` |
| Approval | `control_request` subtype `can_use_tool` → answer with `control_response` (allow, allow with updated input, deny) |
| User question | `AskUserQuestion` arrives as a `can_use_tool` request; Aura renders it as UserInput and answers via updated input |
| Interrupt | `control_request` interrupt from the host; feature-detect with `interrupt_receipt_v1` |
| Model, effort, permission mode | `/model x`, `/effort x` in the prompt; `set_permission_mode` control request |
| Slash commands, skills | Pass `/name args` through in the prompt text; Claude expands them in `-p` mode |
| Retries, denials | `system/api_retry`, `permission_denied`, `result.permission_denials` |
| Cost, usage | `result` message fields |
| Discovery of existing sessions | Read `~/.claude/projects/<slug>/*.jsonl`; resume by ID from any directory (v2.1.223+) |
| Hooks, MCP, agents, plugins | Load from user and project config as normal; surface `system/init` status |

Notes: the bidirectional stdin protocol is only partially documented, so M0 includes a protocol spike that records real traffic into `docs/protocol/claude/`. Terminal-only commands such as `/login` are handled by switching the session to terminal mode. Message types are modelled as serde enums with an `Unknown` catch-all so a new Claude release never crashes the adapter.

### 5.2 Codex (verified against codex-cli 0.151.0 locally)

Launch one shared `codex app-server` over stdio, JSON-RPC 2.0 as JSONL. Aura can also attach to the user's existing `codex app-server daemon` if present. Types come from `codex app-server generate-json-schema --out ...`, pinned to the installed version and turned into Rust with `typify`. M0 also evaluates the existing `codex-codes` crate (typed protocol models plus async client) as an alternative to generating our own.

| Aura concept | Codex app-server |
|---|---|
| Handshake | `initialize`, `initialized` |
| Session list / resume / fork / archive | `thread/list`, `thread/resume`, `thread/fork`, `thread/archive`, `thread/delete`, `thread/read` |
| Send / steer / interrupt | `turn/start`, `turn/steer`, `turn/interrupt` |
| Streaming | `item/started`, `item/*/delta`, `item/completed`, `turn/completed` |
| Approval | server requests `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `item/permissions/requestApproval` → decision accept / acceptForSession / decline / cancel / execpolicy amendment |
| User question | `item/tool/requestUserInput` |
| Diff, plan, usage | `turn/diff/updated`, `turn/plan/updated`, `thread/tokenUsage/updated` |
| Status | `thread/status/changed` |
| Models, effort | `model/list` with `supportedReasoningEfforts`; per-turn overrides |
| Sandbox / approval policy | `sandboxPolicy`, `approvalPolicy` on thread/turn |
| Review | `review/start` |
| Compaction, naming, goals | `thread/compact/start`, `thread/name/set`, `thread/goal/*` |
| Skills, MCP, plugins, apps | `skills/list`, `mcpServerStatus/list`, `mcpServer/tool/call`, `plugin/*`, `app/*` |
| Account, limits | `account/read`, `account/rateLimits/read`, `account/login/*` |
| File search for `@` mentions | `fuzzyFileSearch/*` |
| Hooks | `hook/started`, `hook/completed` |

Notes: the app-server is marked experimental by OpenAI but is what the Codex VS Code extension and desktop app use. Threads are persisted server-side as rollout files and unload after 30 minutes without subscribers, so Aura keeps a subscription for every session it shows.

### 5.3 Terminal (generic PTY)

Any command in a PTY: plain shells, `claude` or `codex` interactive TUIs, Gemini CLI, OpenCode, anything. Built on `portable-pty`, which covers Unix PTYs and Windows ConPTY. The daemon keeps a scrollback ring buffer on disk so reattach restores the screen. Rendered with xterm.js with the WebGL addon. Optional tmux backend for people who want their sessions visible in tmux too.

Status detection for unknown CLIs mirrors Agent of Empires: output-activity heuristics plus per-agent regex profiles for "waiting for input" prompts, so even non-structured sessions show idle / running / waiting in the sidebar.

### 5.4 Later providers

Gemini CLI, OpenCode, Copilot CLI and others start in terminal mode on day one. Structured adapters follow the same trait when their protocols justify it (OpenCode has an HTTP server, Gemini has ACP).

Update: `aura-provider-acp` now covers every agent that speaks the Agent Client Protocol (Gemini CLI, Copilot, OpenCode, goose, Cursor, Qwen Code and others) with one adapter. Claude Code and Codex keep their native adapters, which expose more than ACP does.

---

## 6. Persistence

- **Native transcripts stay the source of truth for resume**: Claude `.jsonl` files and Codex rollouts. Aura never rewrites them.
- **Aura's SQLite database** (`~/.aura/aura.db`, rusqlite bundled, WAL mode): session registry, groups, titles, worktree links, normalized event log (append-only, replayed to rebuild the UI on attach), PTY scrollback pointers, settings, keymaps, FTS5 full-text search over messages.
- **Import**: on first run, list existing Claude and Codex sessions so the user can adopt them into Aura.
- **Crash safety**: event log writes are batched per turn but flushed on approvals and turn end. Daemon restart re-resumes structured sessions by native ID and marks terminal sessions as exited.

---

## 7. Keyboard-only design

Principles: modal where it pays off, discoverable everywhere, configurable.

- **Command palette** (`Cmd/Ctrl+K`): fuzzy search over every action, every session, every setting. Any feature added must register a command here; the UI has no action without a command.
- **Leader key** (`Ctrl+Space` default) with a which-key style overlay showing the next keys. Examples: `Space s n` new session, `Space s w` new session in worktree, `Space g d` diff, `Space a` approvals inbox.
- **Focus regions** sidebar / transcript / composer / inspector, cycled with `Ctrl+H/J/K/L`, and `Cmd/Ctrl+1..9` jumps straight to a session.
- **Lists** navigate with `j/k` or arrows, `gg`/`G`, `/` to filter, `Enter` to open.
- **Approvals** answered with `y` accept, `Y` accept for session, `n` decline, `e` edit input, `Esc` cancel. A global approvals inbox queues requests across all sessions and `Space a` jumps to the oldest.
- **Composer**: `Enter` send, `Shift+Enter` newline, `Ctrl+C` interrupt, `Up` history, `/` slash menu, `@` file picker, `Ctrl+Enter` steer while running.
- **Hint mode** (`f`): Vimium-style labels appear on anything focusable not otherwise reachable, so no feature is ever mouse-only.
- **Terminal sessions** pass keys through; a single configurable escape (`Ctrl+\`) returns focus to Aura.
- **Global hotkey** (Tauri global-shortcut plugin) summons Aura from anywhere, straight into the approvals inbox if something is waiting.
- **Keymap** is a JSON file with a built-in editor. Presets: default, vim, emacs-ish.
- **Enforcement**: an ESLint rule fails CI on any `onClick` without a registered command, and a Playwright suite (driving the Tauri app via WebDriver) exercises every screen with keyboard only.

---

## 8. Feature list for v1

**Session management**: create, resume, fork, rename, group, archive, kill; per-session cwd, git worktree and branch creation; status badges; last-activity sort; multi-window and split view; system tray with waiting-count badge; global hotkey to summon Aura; desktop notifications when a session needs you.

**Conversation view**: virtualized transcript, streaming text and reasoning, collapsible tool calls with live command output, file change cards with inline diff, plan view, subagent trees, token and cost meters, search within and across sessions.

**Control**: approvals inbox, user-input prompts, interrupt and steer, model and effort pickers, permission and sandbox mode pickers, slash commands and skills menu populated per provider, `@` file mentions, image paste, MCP server status panel.

**Git**: worktree lifecycle, diff viewer for the session's changes, quick commit and push from the palette.

**Terminal**: embedded xterm.js for any CLI, mode switch on structured sessions, scrollback persistence.

**Import**: adopt existing Claude and Codex sessions.

---

## 9. Milestones

Each milestone ends with a runnable build. Sizes are rough and assume one developer with agent assistance.

**M0 Spikes and skeleton**, about 1 week
- Install the Tauri CLI and platform deps; Tauri 2 hello world with React, Vite and xterm.js on macOS.
- Workspace skeleton with all crates compiling and `cargo clippy` clean.
- Claude protocol spike: stream-json round trip including one approval and one AskUserQuestion, traffic captured to `docs/protocol/claude/`.
- Codex spike: app-server round trip including approval, `thread/list` and resume; generated types checked in; decide between generated types and the `codex-codes` crate.
- PTY persistence spike: daemon holds a PTY via `portable-pty`, GUI process exits and reattaches with scrollback intact; frontend connects to the daemon directly over the token-protected WebSocket.

**M1 Daemon and terminal sessions**, about 2 weeks
- `aurad` with WebSocket JSON-RPC, SQLite store, session registry, PTY adapter, scrollback, detached spawn from the shell.
- Shell: session sidebar, terminal view, command palette, leader key, focus regions, keymap file, single instance, tray.
- CLI: `aura ls | new | attach | kill`.
- Result: Agent of Empires parity minus worktrees, with a GUI.

**M2 Claude Code structured adapter**, about 2 weeks
- Full stream-json adapter, transcript view, approvals, user input, interrupt, model and effort, slash commands, session import and resume, structured ⇄ terminal switch.

**M3 Codex structured adapter**, about 2 weeks
- App-server adapter with typed protocol, threads list/resume/fork, approvals, requestUserInput, steer, diff and plan streams, model list, review, MCP status.

**M4 Unified control layer**, about 2 weeks
- Approvals inbox across sessions, notifications, tray badge, global hotkey, cross-session search, capability-driven UI, hint mode, keyboard-only Playwright suite and ESLint rule.

**M5 Git and workspace**, about 1.5 weeks
- Worktree creation per session, diff viewer, quick commit, groups and multi-window.

**M6 Hardening and release**, about 2 weeks
- Linux (WebKitGTK 4.1) and Windows (ConPTY, WebView2) passes, crash recovery, settings and keymap editor, Tauri bundler packaging, signing and notarization, updater with signed manifests, docs.

---

## 10. Risks and how they are handled

| Risk | Handling |
|---|---|
| Codex app-server marked experimental, protocol may change | Types pinned to the installed Codex version; adapter fails loudly on schema mismatch and offers terminal mode. |
| Claude stream-json control protocol partly undocumented | M0 spike records actual traffic; feature detection via `system/init.capabilities`; serde `Unknown` variants; terminal mode fallback. |
| Two processes on one native session | Enforced single mode per session; mode switch is stop then resume. |
| Windows PTY and process detachment differences | `portable-pty` for ConPTY; detached spawn behind one interface; Windows pass in M6, not left to chance. |
| CLI upgrades change flags | Adapters check CLI version at start and record the tested version range; mismatches show a warning, never a silent failure. |
| Daemon crash loses live processes | Structured sessions resume by native ID automatically; terminal sessions restore scrollback and mark as exited. |
| Loopback WebSocket reachable by other local processes | Random port, per-start token, owner-only permissions on the token file, token required in the handshake. |
| Rust compile times slow iteration | Workspace split into small crates, `cargo watch` for the daemon, Vite HMR for the frontend, shell rebuilt rarely. |

---

## 11. Open decisions for Eldin

1. Should terminal sessions default to a tmux backend when tmux exists, so they are also visible from a plain terminal? Plan assumes native PTY by default with tmux as an option.
2. Default leader key. Plan assumes `Ctrl+Space`.
3. Daemon lifecycle: spawn on demand only, or offer launchd/systemd user-service install so it is up before the GUI? Plan assumes on demand with the service install as an option in settings.
4. License and repo location.

---

## 12. Local environment as found on 2026-09-17

| Tool | Found |
|---|---|
| Rust | rustc 1.96.1, cargo 1.96.1, rustup 1.29.0 |
| Tauri CLI | not installed (`cargo install tauri-cli --version "^2"`) |
| Xcode command line tools | present |
| Node | v25.9.0 |
| pnpm | 10.33.2 |
| Claude Code | 2.1.274 at ~/.local/bin/claude |
| Codex | codex-cli 0.151.0 at /opt/homebrew/bin/codex |
| tmux | present |

## Sources

- Tauri 2: https://v2.tauri.app/
- Wails v3 beta status (rejected option): https://github.com/wailsapp/wails/issues/5844 , https://v3.wails.io/status/
- Codex app-server protocol: https://learn.chatgpt.com/docs/app-server , https://openai.com/index/unlocking-the-codex-harness/ , https://crates.io/crates/codex-codes
- Claude Code headless and stream-json: https://code.claude.com/docs/en/headless , https://github.com/anthropics/claude-code/issues/24594
- Agent of Empires: https://github.com/agent-of-empires/agent-of-empires , https://www.agent-of-empires.com/docs/

---

## 13. Implementation status (2026-09-17)

Everything below is built, compiles, and is covered by tests unless marked otherwise.

**Backend (Rust workspace, 75 tests passing, `cargo clippy` clean)**

| Crate | Status |
|---|---|
| `aura-core` | Domain model, events, provider trait, session manager with lazy resume, mode switching, pending approvals/inputs, live-item replay for late attachers, worktree hook. Manager integration tests with a scripted fake provider. |
| `aura-store` | SQLite (WAL, FTS5 search over messages, scrollback blobs, settings, per-session event log with sequence numbers). |
| `aura-pty` | portable-pty spawn, output fan-out, 4 MiB scrollback ring, exit tracking. |
| `aura-terminal` | Plain terminal provider (any command in a PTY). |
| `aura-provider-claude` | stream-json driver: turns, streamed text/thinking, tool items by tool name, approvals incl. AskUserQuestion, interrupt, permission mode, `/model` `/effort`, native session discovery from `~/.claude/projects`, slash-command catalogue. Fixture replay test from the real capture plus a live test (`AURA_LIVE_TESTS=1`) that passed against Claude Code 2.1.274. |
| `aura-provider-codex` | Shared `codex app-server` client (JSON-RPC over JSONL, routing by thread id, server-request replies), per-thread driver: start/resume/fork, turn start/steer/interrupt, command/file/permission approvals, requestUserInput, deltas, token usage, diff/plan streams, compact/review/rename actions, `thread/list`, `model/list`, `skills/list`. Fixture replay plus live test that passed against codex-cli 0.151.0. |
| `aura-rpc` | Loopback WebSocket JSON-RPC server (random port, per-start token, owner-only `daemon.json`), binary PTY frames, filesystem helpers (dir listing, gitignore-aware fuzzy file search), client library. Round-trip integration test over a real socket. |
| `aura-git` | Worktree create/remove (with `.git/info/exclude`), status, diff (incl. untracked), diff stat, branches, commit, push, log, worktree list. Tests on temp repos. |
| `aurad` | Daemon: single-instance check, SQLite store, provider registration, restore on start, graceful shutdown on signals, git RPC methods. |
| `aura-cli` | `aura ls/new/attach/send/interrupt/kill/rm/mode/pending/approve/events/history/providers/daemon`; auto-starts the daemon detached; raw-mode attach with `Ctrl+\` detach. |

**Desktop (Tauri 2 + React 19, tsc/eslint clean, 34 vitest + 2 Playwright e2e passing)**

- Shell: ensures the daemon, hands the webview the token, tray with show/quit, global summon hotkey (`Cmd/Ctrl+Shift+A`), single instance, window-state, dock badge with pending count, close-to-hide, `open_session_window` for detached session windows, `restart_daemon`.
- Frontend: sidebar with groups/pins/status/pending badges/filter, transcript with turn dividers, streamed markdown, collapsible tool/command/file-change/plan/subagent cards, approval and question cards, composer with `/` command popover, `@` file picker, image paste, steer, history; inspector with session/model/usage/provider info/pending/actions; embedded xterm.js terminal with scrollback replay and `Ctrl+\` / `Esc Esc` escape; command palette (commands, `@` sessions, `?` help, recents); leader key with which-key overlay; hint mode; help overlay; new-session dialog with directory browser and worktree option; import of existing Claude/Codex sessions; model/effort/permission/sandbox pickers; rename/group/confirm dialogs; approvals inbox; cross-session search; diff dialog with side-by-side, hunk navigation, base cycling, commit and push; settings with theme, leader key, keymap editor (record, unbind, conflicts), provider capability grid; toasts and desktop notifications.
- Enforcement: ESLint rule `local/require-data-command` fails the build on any clickable element that hint mode and the palette cannot reach.

**Verified end to end** (this machine, real CLIs): daemon started from the CLI, Claude session created from the UI composer, Bash approval surfaced as a card, accepted with `y`, command ran, turn completed with cost; same via the CLI for Codex including the `acceptWithExecpolicyAmendment`-style approval; structured → terminal (`claude --resume` TUI in xterm) → structured switch; terminal session create/type/exit/restart/delete; history replay after daemon restart; PTY scrollback persistence across daemon restarts.

**Not done / known gaps**

- Linux and Windows have code paths (ConPTY via portable-pty, named-pipe-free loopback TCP, detached spawn flags) but have not been run. Milestone M6 items still open: platform passes, signing/notarization, updater manifests (`tauri-plugin-updater` is not configured because it needs a signing key from Eldin).
- The global summon shortcut is fixed at startup; the settings field is informational until the shell re-registers it at runtime.
- Codex `item/permissions/requestApproval` accept sends the requested profile as-is; there is no UI to narrow it.
- Claude `AcceptForSession` relies on the SDK field `updatedPermissions`, which the capture did not exercise.
- `apps/desktop/src/components/ModalC.tsx` duplicates `Modal.tsx` (kept for its height option); fold into one.
- Only one live approval/turn per provider was exercised in the UI; longer multi-tool sessions, subagent nesting and image input have unit coverage but no live run.
