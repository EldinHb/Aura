# Aura mods: design spec

Status: implemented on branch `mods` (Aura 0.3.0). Where the build differs from the first draft, the text below says so; see [WRITING.md](WRITING.md) for how to write a mod.

## Goal

Aura's core becomes the agent harness only: sessions, providers, terminal,
transcript, composer, local git, schedules, team view, worker threads and
plans. Everything GitHub- and pull-request-related leaves core and ships as
**mods**: packages written in JavaScript/TypeScript that anyone can write,
with the owner's own mods bundled in the installer.

Decisions already made:

| Question | Decision |
| --- | --- |
| Where mods run | Both: a **daemon half** inside `aurad` (keeps running with the window closed) and a **UI half** in the webview |
| How bundled mods ship | In this repo under `mods/`, shipped inside the installer, structured so each can move to its own repo later |
| What stays in core | Sessions/providers/terminal/transcript, local git (worktrees, branch status, diffs), schedules, team view / worker threads / plans |

One correction to the original scope: there is **no generic "watches"
engine** today. `features/watches` and `aura-review/src/watch.rs` are
GitHub-PR-review polling only. They move into a mod; only schedules stays in
core. A generic event-triggered automation engine is listed under
[Open questions](#open-questions).

## What moves out of core

Measured on `main` at 0.2.25.

| Area | Where it lives today | Destination |
| --- | --- | --- |
| GitHub client: `gh auth token`, REST/GraphQL, rate-limit gate, ETag cache | `crates/aura-github` (~4.1k lines) | `mods/github` |
| PR inbox, PR page, edit/merge/delete branch, PR change inbox | `crates/aura-review/src/{lib,changes}.rs`, `features/reviews/*` | `mods/pull-requests` |
| PR review watches, agents following up on review activity | `aura-review/src/{watch,follow}.rs`, `features/watches/*` | `mods/pull-requests` |
| Pre-review in a PR worktree, editing findings, posting, reconcile | `aura-review/src/{lib,runner,diff}.rs`, `aura-git/src/review.rs`, `ReviewEditor`, `ReviewSettings` | `mods/pr-review` |
| Orchestrator review MCP tools | `aura-review/src/orchestrated.rs`, `aura-cli/src/mcp/reviews.rs` | `mods/pr-review` |
| Issue/PR links on sessions, link detection, links dialog | `views/issueLinks.ts`, `state/sessionLinkPreferences.ts`, `SessionLinks*`, `Session.pulls`, `session.record_pull` | `mods/github` |
| Issue picker in the new-session dialog | `IssuePicker.tsx`, `github.issues` | `mods/github` |
| PR badge on branch status | `github.branch_pull`, `state/branchStatus.ts` (PR half), `BranchStatus.tsx` (PR half) | `mods/github` |
| Repo resolution for a folder | `git.github_repo`, `state/githubRepos.ts` | `mods/github` (core keeps a neutral `git.remotes`) |
| PR wire types | `aura-core/src/review.rs` (683 lines) + generated TS | the mods' own TS types |

After the move, the crates `aura-github` and `aura-review` are deleted and
`aura-git/src/review.rs` with them.

## Architecture

```
┌──────────────── webview ────────────────┐        ┌──────────────────── aurad ─────────────────────┐
│ core UI                                 │        │ core: Manager, Store, providers, git, schedules│
│  ├─ slot registries (sidebar, views…)   │  WS    │  ├─ notification bus (core-owned)              │
│  └─ ModLoader ── imports ui.js (blob:)  │◄──────►│  ├─ RPC dispatch ── ExtService registry        │
│       └─ mod UI half: activate(ctx)     │ JSON-  │  └─ ModHost                                    │
│            ctx.rpc ──► mod.<id>.*       │  RPC   │       ├─ mod "github"        (QuickJS, thread) │
│            ctx.on  ◄── mod.<id>.<event> │        │       ├─ mod "pull-requests" (QuickJS, thread) │
└─────────────────────────────────────────┘        │       └─ mod "pr-review"     (QuickJS, thread) │
                                                   └────────────────────────────────────────────────┘
```

* A mod is a folder with a `mod.json` manifest, a bundled `daemon.js`, a
  bundled `ui.js` and an optional `ui.css`. Either half is optional.
* `aurad` discovers mods, checks permissions, runs each daemon half in its own
  sandboxed JS runtime, and routes RPC methods `mod.<id>.*` to it.
* The desktop asks `aurad` for the list of enabled mods and loads each UI half
  into the page. The UI half talks to its own daemon half over the existing
  WebSocket.

### Daemon runtime: QuickJS via `rquickjs`

| Option | Verdict |
| --- | --- |
| **QuickJS (`rquickjs`)** | **Chosen.** ~1 MB, builds with `cc` on all four release targets with no prebuilt downloads, has no ambient file or network access (true sandbox), has per-runtime memory limits and an interrupt handler, and supports ES modules and async/await |
| V8 (`deno_core`) | Fast, but adds tens of MB to both `aurad` and the `aura` sidecar, relies on prebuilt `rusty_v8` archives, and slows CI considerably |
| Boa | Pure Rust, but slower and with weaker ES coverage |
| Node sidecar process | Requires Node on the user's machine or bundling ~80 MB, and gives no sandbox |

Consequences:

* No Node APIs and no npm packages that need them. Mods are bundled with
  esbuild into one ES module; plain-JS libraries are fine.
* QuickJS is slower than V8. That doesn't matter here: mod logic is glue, and
  network I/O, git, processes and timers run in Rust through host functions.
* Each mod gets its own runtime on its own OS thread with a current-thread
  tokio runtime. A misbehaving mod can't block core or other mods.
  * Memory limit: 256 MB per mod.
  * Interrupt: synchronous JS running longer than 5 s is aborted.
  * Crash policy: an uncaught exception in a handler fails only that call. If
    the runtime dies, it restarts with backoff, and after 5 failures in 10
    minutes the mod is marked failed and surfaced in the UI.

To verify early in Phase 2: build `rquickjs` for `x86_64-pc-windows-msvc`,
both macOS targets and Linux in CI, and measure the size added to `aurad`.

### UI runtime: ES modules from `blob:` URLs

* The desktop fetches a mod's UI bundle over RPC (`mods.ui_source {id}`),
  wraps it in a `Blob` and calls `import(URL.createObjectURL(blob))`.
* CSP change: add `script-src 'self' blob:`. A `blob:` URL can only be created
  by script already running in the page, so this doesn't let outside content
  in. The alternative, `http://127.0.0.1:*`, would trust any local server.
* `ui.css` is injected as a `<style>` tag (already allowed by
  `style-src 'unsafe-inline'`).
* The bundle must be a single file, because relative imports don't resolve
  from a `blob:` URL. The SDK build does this.
* React and zustand are shared, not bundled: the host puts its instances on
  `globalThis.__aura`, and the SDK's esbuild config aliases `react`,
  `react/jsx-runtime` and `zustand` to shims that read from it. Two copies of
  React would break hooks.
* To verify early: `import()` of a `blob:` module in macOS WKWebView (the
  build target is `safari13`) and in WebView2.

### Trust model

* **The daemon half is sandboxed.** It can only do what its manifest's
  permissions allow, and those are enforced in Rust.
* **The UI half is not sandboxed.** It runs in the same page as core, so it
  can reach the Tauri internals and the daemon socket. Nothing in the same
  JavaScript realm can prevent that. Installing a mod with a UI half means
  trusting its author, the same as with VS Code or Obsidian plugins. The
  install prompt says so plainly.
* Bundled mods are trusted. A third-party mod is approved on first load, and
  again whenever its permissions grow in an update.
* Running third-party UI in sandboxed iframes is a possible later hardening
  step. It is not in v1, because it breaks keyboard focus handling and
  theming, which matter in a keyboard-first app.

## The mod package

```
mods/github/
  mod.json
  src/daemon.ts      → dist/daemon.js
  src/ui.tsx         → dist/ui.js (+ dist/ui.css)
  package.json       (devDependency: @aura/mod-sdk)
```

```jsonc
// mod.json
{
  "id": "github",                       // [a-z0-9-]+, unique, becomes the RPC/storage namespace
  "name": "GitHub",
  "version": "1.0.0",                   // semver
  "apiVersion": 1,                      // mod API major version this mod targets
  "description": "GitHub account, issues, session links and PR badges",
  "daemon": "dist/daemon.js",
  "ui": "dist/ui.js",
  "styles": "dist/ui.css",
  "dependsOn": { "github": "^1" },      // other mods (example; github itself has none)
  "permissions": {
    "process": ["gh", "git"],           // binaries it may run (resolved with which::find_binary)
    "net": ["api.github.com", "*.githubusercontent.com"],
    "sessions": "write",                // none | read | write
    "git": true,                        // core local-git API
    "agents": false,                    // headless one-shot agent runs
    "orchestratorTools": false,         // contribute MCP tools to orchestrators
    "mods": []                          // other mods it may call
  },
  "settings": [                         // optional; rendered by core in Settings → Mods → <name>
    { "key": "host", "type": "string", "default": "github.com", "label": "GitHub host" }
  ]
}
```

Discovery order (a later entry with the same `id` overrides an earlier one, so
a user can fork a bundled mod):

1. Bundled mods: `<app resources>/mods/*`. The desktop passes the path to
   `aurad` as `--mods-dir` when it spawns the daemon.
2. User mods: `<data dir>/mods/*` (`~/.aura/mods` by default).
3. Development: `$AURA_MODS_DIR`, which also turns on file watching and
   hot reload.

Enabled/disabled state and permission approvals are stored in core settings
under `mods.state.v1`.

## Daemon API (`apiVersion: 1`)

The mod's `daemon.js` default-exports `activate(aura)`, which may return a
`deactivate` function. Every registration returns a disposer, and all of them
are disposed automatically on deactivate or reload.

```ts
export default function activate(aura: DaemonApi): void | (() => void | Promise<void>)
```

| API | Permission | Notes |
| --- | --- | --- |
| `aura.rpc.handle(name, fn)` | none | Exposes `mod.<id>.<name>` to the UI half, the CLI and other mods (if allowed). `fn(params, caller)` returns JSON |
| `aura.emit(name, payload)` | none | Broadcasts notification `mod.<id>.<name>` to UI clients |
| `aura.storage.kv` `get/set/delete/list` | none | Small values; backed by core `settings` under `mod:<id>:` |
| `aura.storage.collection(name)` `get/put/delete/all` | none | JSON documents; backed by `feature_records` namespace `mod:<id>:<name>` |
| `aura.storage.dataDir` | none | `<data dir>/mod-data/<id>/`, the mod's only writable directory (worktrees, mirrors) |
| `aura.settings.get(key)`, `onChange` | none | Values of the manifest's `settings` |
| `aura.events.on(type, fn)` | `sessions: read` | Core `Event` stream (`session_created`, `session_updated`, `turn_started`, `turn_completed`, `approval_requested`, `user_input_requested`, …) with the existing TS types |
| `aura.sessions.list/get` | `sessions: read` | |
| `aura.sessions.lastReply(id)` | `sessions: read` | |
| `aura.sessions.data(id).get/set` | `sessions: read` / `write` | Per-session, per-mod data, deleted with the session. **Replaces `Session.pulls`** |
| `aura.sessions.create(opts)` | `sessions: write` | Same options as `CreateSessionOpts` (worktree, initial prompt, provider, …) |
| `aura.sessions.send(id, text, {whenFree})` | `sessions: write` | `whenFree` maps to `Manager::send_when_free` |
| `aura.sessions.stop/interrupt(id)` | `sessions: write` | |
| `aura.git.*` | `git` | Core local-git operations: `repoRoot`, `status`, `branchStatus`, `diff`, `log`, `remotes`, `worktrees`, `worktree.create/remove` (paths limited to session cwds and the mod's `dataDir`) |
| `aura.process.run(bin, args, {cwd, env, stdin, timeoutMs})` | `process: [bin]` | `bin` must be listed. Resolved with `find_binary`, spawned with the hidden-window flags, killed on timeout. Returns `{code, stdout, stderr}` |
| `aura.http.fetch(url, init)` | `net: [hosts]` | `fetch`-like, Rust `reqwest` + rustls. Host checked against the list. Optional `cache: "etag"` gives an ETag/LRU cache in Rust (what `aura-github` does today) |
| `aura.agents.providers()` / `models(provider)` | `agents` | |
| `aura.agents.runOnce({provider, model, prompt, cwd, jsonSchema, timeoutMs})` | `agents` | Headless one-shot run with structured output. Generalizes `aura-review`'s `CliRunner` and core's suggestion runner |
| `aura.orchestrator.tool(name, schema, fn)` | `orchestratorTools` | Contributes an MCP tool to orchestrator sessions. `fn` receives the calling session's id |
| `aura.mods.call(modId, name, params)` | `mods: [modId]` | Calls another mod's `aura.rpc.handle` method |
| `aura.inbox.set(items)` | none | Items shown in core's inbox and counted in its badge, so PR changes no longer need special-casing in core |
| `aura.notify(title, body, {target})` | none | Desktop notification; clicking it routes to the mod's UI half |
| `setTimeout`, `setInterval`, `queueMicrotask`, `console.*`, `TextEncoder/Decoder`, `URL`, `crypto.randomUUID` | none | `console` goes to the daemon log, tagged with the mod id |

Every method is async (returns a Promise) unless it is obviously local.
Errors arrive as rejected promises with `{code, message}`; a permission denial
has code `permission_denied`.

## UI API (`apiVersion: 1`)

`ui.js` default-exports `activate(ctx)`. Registrations return disposers.

```ts
export default function activate(ctx: UiApi): void | (() => void)
```

**Talking to the daemon**

* `ctx.rpc(name, params)` calls the mod's own `mod.<id>.<name>`.
* `ctx.on(name, fn)` subscribes to the mod's `mod.<id>.<name>` notifications.
* `ctx.client` is the core RPC client (same object core uses).
* `ctx.storage` is `localStorage` namespaced to `aura.mod.<id>.`.

**Commands and keys**

* `ctx.commands.register({id, title, group, when, run})`. The id is
  automatically prefixed with `<modId>.`. This uses the existing
  `lib/commands.ts` registry.
* `ctx.keys.bind({keys, command, when, label})` and
  `ctx.keys.group(prefix, label)` for which-key. User overrides
  (`settings.keymapOverrides`) apply on top.
* `ctx.context.set(key, value)` sets a `when` context key, as
  `mod.<id>.<key>`.

**Slots.** Each slot takes a React component.

| Slot | Replaces today's hard-coded |
| --- | --- |
| `ctx.ui.sidebarSection({id, title, order, component})` | `<ReviewSidebar/>` in `Sidebar.tsx`, PR keyboard nav |
| `ctx.ui.view({id, title, component})` + `ctx.openView(id, props, {preview?})` | `prMode` / `PullWorkspace` in `App.tsx` |
| `ctx.ui.inspectorSection({id, order, when, component})` | `<WatchSection/>`, `<SessionLinks/>` in `Inspector.tsx` |
| `ctx.ui.sessionRowChips({component})` | `SessionRowLinks` / `BranchPullChip` in `Sidebar.tsx` |
| `ctx.ui.branchDecoration({component})` | PR half of `BranchStatus.tsx` |
| `ctx.ui.statusBarItem({id, order, component})` | |
| `ctx.ui.dialog(kind, component)` + `ctx.openDialog(kind, props)` | `review-settings`, `review-submit`, `pr-watch` in the `Dialog` union and `Overlays.tsx` |
| `ctx.ui.settingsTab({id, title, component})` | PR filters in the General tab (`SettingsDialog.tsx`). Simple settings come from `mod.json` instead |
| `ctx.ui.newSessionField({id, component})` | `<IssuePicker/>` in `NewSessionDialog.tsx` |
| `ctx.ui.inboxRenderer({component})` | PR-change rows in `InboxDialog.tsx`. Data comes from `aura.inbox.set` |
| `ctx.ui.transcriptLinkDetector(fn)` | `issueLinks.ts` scanning of transcript URLs |

**Shared building blocks**

* Components: `ctx.components.{Modal, ModalC, KeyList, Markdown,
  DiffRenderer, ExternalLink}`.
* Hooks and actions: `ctx.hooks.useListNav`, `ctx.toast(msg, level)`,
  `ctx.confirm(...)`, `ctx.focus(region)`.
* Theming: CSS variables (`--bg`, `--fg`, `--accent`, …) and utility classes
  (`.btn`, `.chip`, `.list-item`, …) are a documented, stable part of the API.
* Hint mode picks up any element with `data-hint` or `data-command`.

Every slot render is wrapped in an `ErrorBoundary`. A mod that throws shows an
inline error and never takes the app down.

## SDK and tooling

* `packages/mod-sdk` (`@aura/mod-sdk`) provides:
  * TypeScript types for both APIs, generated where possible from the Rust
    types via `ts-rs`, as the frontend does today.
  * An esbuild preset with React and zustand externals and single-file output.
  * `aura-mod build` and `aura-mod dev` commands.
* CLI additions:
  * `aura mods list|enable|disable|reload <id>|logs <id>`.
  * `aura mods test <dir>` runs a mod's daemon half in QuickJS with a fake
    host, so mod tests run in CI without a desktop.
* Bundled mods build as part of `scripts/build-sidecars.sh`. The release
  workflow adds `mods/*/dist` and the manifests to Tauri `bundle.resources`.

## Core changes required

These are behaviour-preserving refactors of today's code. They come before
any mod exists, so each one can land and be tested on its own.

1. **Core-owned notification bus.** Move `broadcast::Sender<Value>` out of
   `ReviewService` into core (`aurad/main.rs:151,181`). Replace the hard-coded
   `reviews.changed` lag fallback (`aura-rpc/src/server.rs:265`) with a
   generic `notifications.lagged` that clients answer by refreshing.
2. **ExtService registry.** Replace the hand-chained `ExtHandler` closure
   (`aurad/main.rs:156-176`) with `Vec<Arc<dyn ExtService>>` matched by method
   prefix. The mod host registers itself for `mod.*`.
3. **Per-session mod data.** Replace `Session.pulls` and `session.record_pull`
   with a namespaced `feature_records` collection that is deleted with the
   session.
4. **Headless one-shot agent run** in core, merged from `aura-review`'s
   `CliRunner` and the suggestion runner in `suggestions.rs`.
5. **Dynamic orchestrator tools.** `aura-cli`'s MCP server lists tools from
   the daemon (`mods.tools.list`) instead of the hard-coded `mcp/reviews.rs`,
   and `authorize` limits session tokens to `orchestrator.*` plus
   `mod.*.tool.*`.
6. **Neutral git remotes.** `git.github_repo` / `parse_github_remote` become
   `git.remotes` returning name and URL. Parsing `owner/repo` moves into the
   GitHub mod.
7. **UI slot registries** for every slot listed above, plus string dialog
   kinds, extensible `when` context, keybinding registration, and
   multiplexed notification-click handlers (`lib/notify.ts` holds a single
   global handler today).
8. **Shared frontend helpers.** Move `rpc()` from `features/reviews/state.ts`
   into `lib/`, so `features/schedules` no longer imports from reviews. Split
   `BranchStatus` into its local-git part (core) and its PR part (mod).
9. **Store cleanup.** Remove `prSelection`, `reviewHistoryOpen`, `pullFilters`,
   `mergeMethod`, `deleteBranchAfterMerge` and `pullChangesMuted` from core
   `store.ts`, plus the `lib/pulls` imports in `store.ts` and `rpc.ts`.

## The bundled mods

| Mod | Contents | Permissions | Depends on |
| --- | --- | --- | --- |
| `github` | Account and token handling via `gh`, a REST/GraphQL client with rate-limit gate and ETag cache, repo resolution from remotes, issue picker, session issue/PR links and detection, PR badge on branch status | `process: [gh, git]`, `net`, `sessions: write`, `git` | – |
| `pull-requests` | PR inbox sidebar, PR page (timeline, projects, edit, merge, delete branch), PR change inbox and notifications, reviewer watches, agents following up on review activity, and pre-reviews in an isolated PR worktree with Claude or Codex (finding editor, posting, reconcile, orchestrator review tools). The first draft split pre-reviews into a `pr-review` mod; the PR page and the review editor are too intertwined for that to pay off. | `process: [gh, git]`, `sessions: write`, `git`, `agents`, `orchestratorTools`, `mods: [github]` | `github` |

The GitHub client lives in the `github` mod's daemon half. The other mods
reach it through `aura.mods.call("github", …)`, so the token and rate limits
stay in one place. The token never reaches any UI half, as is the case today.

## Data migration

A one-time migration runs in `aurad` (store migration v5) and the webview
(first load after upgrade). It moves existing data into the new mods'
namespaces, so upgrading users lose nothing.

| Today | After |
| --- | --- |
| `feature_records` namespace `reviews` | `mod:pr-review:reviews` |
| `hidden:<account>`, `details:<account>`, `pull-changes:<account>` | `mod:pull-requests:<same>` |
| `pr-watches`, `pr-follows`, `pr-follow-pending` | `mod:pull-requests:<same>` |
| settings `reviews.inbox`, `pulls.snapshots.v1.<account>` | `mod:pull-requests:<same>` |
| settings `session.links.v1.*`, `session.links.detected.v1.*` | `mod:github:` session data |
| `Session.pulls` in session JSON | `mod:github` per-session data `pulls` |
| `<data>/review-workspaces/` | `<data>/mod-data/pr-review/` (moved; worktrees re-registered with `git worktree repair`) |
| localStorage `aura.reviews.*`, `aura.review-draft.*` | `aura.mod.pr-review.*` / `aura.mod.pull-requests.*` |
| UiSettings `pullFilters`, `pullChangesMuted`, `mergeMethod`, `deleteBranchAfterMerge` | the `pull-requests` mod's settings |

The migration is idempotent and keeps the old keys for one release, so a
downgrade still finds its data.

## Phases

Each phase ends with green CI on all four platforms. Nothing merges to `main`
until Phase 6.

1. **This spec.** Agree on the APIs and the open questions below.
2. **Core seams.** Core changes 1–9 above. GitHub and review features still
   live in Rust and in core UI, but now plug in through the new registries
   and slots exactly as a mod will. Includes the CI spikes for `rquickjs`
   builds and `blob:` module import on all platforms.
3. **Mod host.**
   * `ModHost` in `aurad` (discovery, manifest validation, permissions,
     QuickJS runtimes, the daemon API) and the `ModLoader` in the desktop
     (the UI API).
   * `@aura/mod-sdk`, `aura mods …` commands, and the install/approval
     prompt.
   * A small example mod (`mods/hello`) exercising every API, with tests.
4. **`mods/github`.** Port `aura-github` and the GitHub UI pieces to
   TypeScript, side by side with the Rust code behind a setting. Parity test:
   the same views render the same data from both.
5. **`mods/pull-requests`, then `mods/pr-review`.** Same approach. The review
   tests in `aura-review` are ported to `aura mods test`.
6. **Remove and migrate.** Delete `aura-github`, `aura-review`,
   `aura-git/src/review.rs`, `aura-core/src/review.rs`, `aura-cli/src/mcp/reviews.rs`
   and the old UI. Ship the data migration, update the README and release
   workflow, and merge to `main` as 0.3.0.

## Decisions

The open questions of the first draft, as decided:

1. **Rewrite or wrap?** Rewritten. The GitHub client and the review code are
   TypeScript (`packages/github-client`, `mods/github`, `mods/pull-requests`),
   so the bundled mods use exactly the API anyone else's do.
2. **Orchestrator tools in v1?** Yes: `aura.orchestrator.tool`, listed and
   called through `mods.tools.list` / `mods.tools.call` by `aura mcp`. Tool
   names are prefixed with the mod id (`pull_requests_list_pull_requests`).
3. **The AI-footer rule** stays plain default prompt text in core.
4. **Generic automations** (event-triggered, next to schedules) are later work.
5. **Distribution** of third-party mods stays "drop the folder into
   `~/.aura/mods` and approve it" for now.

What the first draft did not foresee and the build added:

- `aura.fs` (text files and folders inside the mod's data folder),
  `aura.agents.cancel`, `env`/`stdin` for `aura.git.run`, MCP annotations on
  tools, `ctx.notify` and `ctx.window` in the UI API.
- `mods.session_data.set`: a new-session field's `data` is stored on the new
  session as that mod's session data.
- `ctx.openView(id, props, { preview: false })` opens a view in a main-area tab of
  its own that stays; without it the view takes the preview tab, which the next
  preview replaces. The same view and props (or `props.key`) always shows the tab
  it already has.
- Lagging notification clients get `notifications.lagged` and refresh.
- The data migration is store migration v5 (`crates/aura-store/src/lib.rs`);
  pre-review workspaces now live in `<data dir>/mod-data/pull-requests/`, and
  the old `<data dir>/review-workspaces/` folder can be deleted.
