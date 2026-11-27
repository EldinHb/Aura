# Creating an Aura mod

This guide is for coding agents asked to extend Aura. It assumes you have a
terminal on a machine where Aura is installed, and nothing else: no Aura source
code, no npm, no build step. Everything here is plain files and the `aura`
command. Print it again any time with `aura guide mods`.

## What a mod is

A mod is a folder with a `mod.json` and up to three plain JavaScript or CSS
files. Aura loads it while running; you never rebuild or restart Aura.

| | Daemon half: `daemon.js` | UI half: `ui.js` (+ `ui.css`) |
| --- | --- | --- |
| Runs | inside Aura's background daemon (`aurad`), in a QuickJS sandbox | in Aura's window, with Aura's own React |
| Lives | as long as the daemon, window open or closed | while a window is open |
| May do | only what the `permissions` in `mod.json` allow | anything Aura's interface can (not sandboxed) |
| Receives | `aura` (`Aura.DaemonApi`) | `ctx` (`Aura.UiApi`) |
| Use it for | background work, storage, network, running programs, secrets | panels, chips, commands, dialogs, views |

A mod may have either half or both. The UI half talks to its daemon half with
`ctx.rpc(name, params)` and hears what the daemon half broadcasts with
`ctx.on(name, fn)`.

## Quick start

```sh
aura mods new hello-world          # writes ~/.aura/mods/hello-world/ (both halves); Aura lists it at once
aura mods approve hello-world      # shows the approval prompt in Aura; the user clicks Approve
aura mods logs hello-world -f      # follow its log in a second terminal
aura mods call hello-world hello '{"name":"Ada"}'
```

The new mod adds a section to the bottom of the sidebar with a "Say hello"
button that calls the daemon half, a section at the top of the inspector, and
a "Hello world: say hello" command in the command palette (`⌘K` / `Ctrl+K`).
Open any file in it, change it, save: Aura reloads the half you changed within
a second (see "The edit loop").

`aura mods new <id>` options: `--ui` (UI half only), `--daemon` (daemon half
only; with neither flag it gets both), `--name "Display name"`, `--force`
(overwrite an existing folder's files).

## Where mods live

Aura's data folder is `~/.aura` on every OS (`%USERPROFILE%\.aura` on
Windows), unless the environment variable `AURA_DATA_DIR` points elsewhere.
`aura` uses the same rule, and `aura --data-dir <dir> …` overrides it for one
command.

| Folder | What |
| --- | --- |
| `<data dir>/mods/<id>/` | the user's mods. Aura watches this folder: new, changed and removed mods are picked up by themselves |
| `<data dir>/mod-data/<id>/` | a mod's own writable folder (`aura.mod.dataDir`), made on first use |
| bundled with the app | Aura's own mods (`github`, `pull-requests`). A user mod with the same `id` replaces a bundled one |
| `$AURA_MODS_DIR` | an extra folder for development, also watched |

A mod folder:

```
<data dir>/mods/hello-world/
  mod.json              the manifest (required)
  daemon.js             daemon half (optional)
  ui.js                 UI half (optional)
  ui.css                styles for the UI half (optional)
  themes/*.json         themes the mod ships (optional; see `aura guide themes`)
  types/aura-mod.d.ts   the whole API with types (written by `aura mods new`; Aura ignores it)
  jsconfig.json         lets editors type-check the .js files (Aura ignores it)
```

Each JS file must be a single ES module: no `import` of other files or
packages. Put helpers in the same file.

## mod.json

```json
{
  "id": "hello-world",
  "name": "Hello world",
  "version": "0.1.0",
  "apiVersion": 1,
  "description": "What this mod does, in one line.",
  "author": "Ada",
  "daemon": "daemon.js",
  "ui": "ui.js",
  "styles": "ui.css",
  "dependsOn": { "github": "^1" },
  "permissions": {
    "process": ["git"],
    "net": ["api.example.com", "*.example.org"],
    "sessions": "read",
    "git": true,
    "agents": false,
    "orchestratorTools": false,
    "mods": ["github"]
  },
  "settings": [
    { "key": "greeting", "type": "string", "label": "Greeting", "default": "Hello" },
    { "key": "loud", "type": "boolean", "label": "Shout", "default": false },
    { "key": "mode", "type": "select", "label": "Mode", "default": "a",
      "options": [{ "value": "a", "label": "A" }, { "value": "b", "label": "B" }] }
  ]
}
```

| Field | Required | Meaning |
| --- | --- | --- |
| `id` | yes | Lowercase letters, digits and dashes, at most 64. Unique. Becomes the RPC namespace (`mod.<id>.*`), the storage namespace and the command prefix |
| `name` | yes | Shown in Settings › Mods |
| `version` | yes | Semver, like `0.1.0` |
| `apiVersion` | yes | Always `1` |
| `description`, `author` | no | Shown in Settings › Mods |
| `daemon` | one of `daemon`/`ui` | Path of the daemon half, inside the folder |
| `ui` | one of `daemon`/`ui` | Path of the UI half, inside the folder |
| `styles` | no | Path of a CSS file loaded with the UI half |
| `dependsOn` | no | Other mods this one needs, with a semver range. They start first; if one is missing this mod fails with a clear error |
| `permissions` | no | What the daemon half may do; see below. Leave out what you do not need |
| `settings` | no | Settings the user edits in Settings › Mods. `type`: `string`, `number`, `boolean`, `select` (with `options`) or `string[]`. Optional `description`, `default` |

Paths must stay inside the mod's folder. A manifest error (bad JSON, missing
file, wrong id) shows in `aura mods list` with the reason.

### Permissions

Every permission is enforced by Aura in Rust; a call without it rejects with
`code: "permission_denied"`.

| Permission | Grants |
| --- | --- |
| `process: ["git", "gh"]` | `aura.process.run` for exactly these programs (found on `PATH` and the usual install folders) |
| `net: ["api.example.com", "*.example.org"]` | `aura.http.fetch` to these hosts. `*.example.org` matches subdomains, not `example.org` itself |
| `sessions: "read"` | `aura.events.on`, `aura.sessions.list/get/lastReply/data().get` |
| `sessions: "write"` | the above, plus `aura.sessions.create/send/interrupt/stop/data().set` |
| `git: true` | `aura.git.*` |
| `agents: true` | `aura.agents.runOnce` (headless, read-only agent runs) |
| `orchestratorTools: true` | `aura.orchestrator.tool`: MCP tools for orchestrator sessions |
| `mods: ["other-id"]` | `aura.mods.call/on` for those mods |

Without any permission a mod still has: RPC, `emit`, storage, settings, its
own files (`aura.fs`), the inbox, notifications and timers.

## Approval

Aura asks the user to approve every mod it did not ship with, the first time
it sees it, and again whenever a new version asks for more permissions. Until
then the mod's state is `needs_approval` and none of its code runs.

- **Only the user approves, by clicking in Aura.** `aura mods approve <id>`
  does not approve anything: it makes Aura's window show the approval prompt
  for that mod (what it may do, where it lives), and prints "Approve it in
  Aura". The prompt also opens from Settings › Mods ("Review and approve…").
  If Aura is not open, the mod waits until it is.
- Tell the user what you made and that Aura is asking. Never try to approve
  around the prompt.
- An approval belongs to the mod's id **and its folder**. Moving or renaming
  the folder, or a different folder claiming the same id, asks again. An id
  cannot change in place: a `mod.json` with a new id is a new mod, which
  needs approval (and an id another folder already uses is refused).
- The UI half is not sandboxed: it runs in Aura's window with Aura's own
  rights and can change any screen. That is why approval matters, and why the
  prompt says so. Say so too when you hand a mod to someone else.

## The daemon half

```js
/** @param {Aura.DaemonApi} aura */
export default function activate(aura) {
  aura.rpc.handle("hello", async ({ name }) => `Hello, ${name}!`);
  return () => {}; // optional: runs when the mod stops or reloads
}
```

`activate` may be `async`. Everything registered through `aura` is removed for
you when the mod stops; stop your own timers in the returned function.

Rules:

- **No Node, no browser.** No `require`, `process`, `fs`, `Buffer`, `fetch`,
  `XMLHttpRequest`, `window` or `document`. No `import` at all.
- Globals you do have: `console` (`log/info/warn/error/debug`), `setTimeout`,
  `setInterval`, `clearTimeout`, `clearInterval`, `queueMicrotask`,
  `TextEncoder`, `TextDecoder`, `URL`, `URLSearchParams`, `atob`, `btoa`,
  `structuredClone`, `crypto.randomUUID()`.
- Every `aura.*` call that touches the outside world returns a Promise.
  Errors are `Error`s with a string `code`: `permission_denied`, `not_found`,
  `invalid`, `timeout`, `failed` or `unavailable`.
- Synchronous code that runs longer than 5 seconds is interrupted; memory is
  capped at 256 MB. Keep loops async.
- Values passed to and from RPC handlers must be JSON.

### API

| Call | Permission | What it does |
| --- | --- | --- |
| `aura.mod` | | `{ id, version, dataDir, platform }`, platform is `"macos"`, `"windows"` or `"linux"` |
| `aura.rpc.handle(name, fn)` | | Expose `mod.<id>.<name>`. `fn(params, caller)` returns (or resolves to) JSON. `caller.kind` is `"user"` (the app or CLI), `"mod"` or `"session"` |
| `aura.emit(name, payload)` | | Broadcast `mod.<id>.<name>` to every open window (and to mods that listen) |
| `aura.storage.kv.get/set/delete/keys(prefix?)` | | Small JSON values, kept across restarts |
| `aura.storage.collection(name).get/put/delete/all/clear` | | Named sets of JSON documents |
| `aura.settings.get(key)` / `all()` / `set(key, v)` / `onChange(fn)` | | The `settings` of `mod.json` (defaults filled in) |
| `aura.fs.exists/readText/writeText/mkdir/remove/rename/list` | | Files inside `aura.mod.dataDir` only; relative paths are relative to it |
| `aura.events.on(type, fn)` | `sessions` | Core events: `session_created`, `session_updated`, `session_removed`, `turn_started`, `turn_completed`, `item_started`, `item_completed`, `approval_requested`, `approval_resolved`, `user_input_requested`, `user_input_resolved`, `usage`, `notice`, … or `"*"` for all |
| `aura.sessions.list()` / `get(id)` / `lastReply(id)` | `sessions` | Sessions (`id`, `title`, `cwd`, `provider`, `status`, …) |
| `aura.sessions.data(id).get/set/delete/all` | `sessions` (`set`: write) | Data this mod keeps per session, deleted with the session |
| `aura.sessions.withData(key)` | `sessions` | `[sessionId, value]` pairs of sessions that have `key` |
| `aura.sessions.create(opts)` | `sessions: "write"` | Start a session: `{ provider: "claude", cwd, title?, initial_prompt?, worktree?: { branch } }` |
| `aura.sessions.send(id, text, { whenFree })` | `sessions: "write"` | Message an agent; `whenFree` waits until its turn ends |
| `aura.sessions.interrupt(id)` / `stop(id)` | `sessions: "write"` | |
| `aura.git.repoRoot/mainRepoRoot/currentBranch/remotes/branchStatus(cwd)` | `git` | |
| `aura.git.run(cwd, args, { okCodes, timeoutMs, env, stdin })` | `git` | Run git; resolves with stdout |
| `aura.process.run(bin, args, { cwd, env, stdin, timeoutMs })` | `process: [bin]` | Resolves `{ code, stdout, stderr }`; default timeout 60 s |
| `aura.http.fetch(url, { method, headers, body, timeoutMs, cache: "etag" })` | `net` | Resolves `{ status, ok, headers, text, json(), cached }`; bodies are text |
| `aura.agents.providers()` / `models(p)` / `runOnce(opts)` / `cancel(id)` | `agents` | One headless, read-only agent run: `{ provider, prompt, cwd, model?, jsonSchema?, timeoutMs? }` resolves `{ output, text, modelId }` |
| `aura.orchestrator.tool(def, fn)` | `orchestratorTools` | An MCP tool `<id>_<name>` for orchestrator sessions; `fn(args, { sessionId })` |
| `aura.mods.call(modId, name, params)` / `on(modId, name, fn)` | `mods: [modId]` | Use another mod's daemon methods and broadcasts |
| `aura.inbox.set(items)` | | Replace this mod's items in Aura's inbox: `[{ id, title, detail?, at, unread, data? }]` |
| `aura.notify({ title, body, target })` | | A desktop notification; a click calls the UI half's `ctx.onNotificationClick(fn)` with `target` |

Examples:

```js
// Poll a web API every 5 minutes (needs "net": ["api.example.com"]).
const poll = async () => {
  try {
    const res = await aura.http.fetch("https://api.example.com/status", { cache: "etag" });
    if (res.ok && !res.cached) aura.emit("status", res.json());
  } catch (e) {
    console.warn("poll failed", e.code, e.message);
  }
};
poll();
const timer = setInterval(poll, 5 * 60 * 1000);
return () => clearInterval(timer);
```

```js
// Run a program (needs "process": ["git"]).
const { code, stdout } = await aura.process.run("git", ["--version"]);
```

```js
// React to agents finishing a turn (needs "sessions": "read").
aura.events.on("turn_completed", async (ev) => {
  const s = await aura.sessions.get(ev.session_id);
  console.log(`${s?.title} finished a turn`);
});
```

## The UI half

```js
const React = __aura.modules.react;
const h = React.createElement;

/** @param {Aura.UiApi} ctx */
export default function activate(ctx) {
  ctx.ui.statusBarItem({ id: "hi", component: () => h("span", null, "hi") });
}
```

How it loads: Aura reads `ui.js` through the daemon and imports it as an ES
module. So:

- **Use Aura's React**: `__aura.modules.react`. Never bundle or load another
  copy; two Reacts break hooks. Hooks (`useState`, `useEffect`, …) are on it.
- **No JSX without a build**: write `h(type, props, ...children)` where
  `h = React.createElement`. `h("div", { className: "x", onClick }, "text", h(Other, { a: 1 }))`.
- **No imports**: everything comes from `ctx` and `__aura.modules`:
  `react`, `react-dom`, `react/jsx-runtime`, `zustand`, `clsx` and
  `@aura/host` (Aura's components, below).
- `ui.css` is added to the page while the mod is loaded. Prefix every selector
  with something unique (`.mod-<id>`), and use Aura's CSS tokens
  (`var(--fg)`, `var(--accent)`, …; `aura guide themes` lists them all) so
  the mod follows the user's theme.
- Each slot component is wrapped in an error boundary: a component that throws
  shows an inline error instead of breaking Aura, and the error is written to
  `aura mods logs <id>`.

### ctx

| Member | What it does |
| --- | --- |
| `ctx.mod` | `{ id, version }` |
| `ctx.rpc(name, params)` | Call this mod's `mod.<id>.<name>`; a Promise |
| `ctx.on(name, fn)` | Listen to this mod's `aura.emit(name, …)`; returns an unsubscribe function (return it from `useEffect`) |
| `ctx.call(modId, name, params)` / `ctx.onMod(modId, name, fn)` | The same for another mod |
| `ctx.onConnection(fn)` | `"open"` every time the daemon connection (re)opens: refetch there |
| `ctx.client.call(method, params)` | Aura's own RPC (`session.list`, `git.status`, …) |
| `ctx.storage.get/set/delete` | `localStorage`, namespaced to this mod |
| `ctx.settings.get/set/onChange` | The mod's settings, live |
| `ctx.commands.register({ id, title, group, keywords?, when?, run })` | A command in the palette; its id becomes `<mod id>.<id>` |
| `ctx.commands.run(id, arg)` | Run any command |
| `ctx.keys.bind({ keys, command, when?, label? })` | A key binding: `"mod+shift+h"`, `"g h"` (a sequence), `"leader h"` (after the leader key). The user's own overrides win |
| `ctx.keys.group(prefix, label)` | Name a sequence prefix in the which-key popup |
| `ctx.context.set(key, value)` | A `when` key, read as `mod.<id>.<key>` |
| `ctx.toast(message, "info" \| "warn" \| "error")` | A snackbar |
| `ctx.confirm({ title, message, danger })` | Resolves `true` or `false` |
| `ctx.notify(title, body, target)` / `ctx.onNotificationClick(fn)` | Desktop notifications |
| `ctx.openView(id, props)` / `ctx.closeView()` / `ctx.activeView()` | Open a registered view in a main-area tab |
| `ctx.openDialog(id, props)` | Open a registered dialog |
| `ctx.window` | `"main"` or `"session"` (a detached session window); announce things from `"main"` only |
| `ctx.suppressTurnToast(fn)` | Hide Aura's "turn finished" toast for sessions `fn(session)` returns true for |

`when` expressions are comma-separated terms that must all hold:
`focus:sidebar`, `focus:sidebar|main`, `!inputFocused`, `hasSelection`,
`provider:claude`, `running`, `dialogOpen`, `mod.<id>.<key>`.

### Slots: where a mod's UI appears

Each takes a component and returns a function that removes it.

| Slot | Component props | Where |
| --- | --- | --- |
| `ctx.ui.sidebarSection({ id, title?, order?, component })` | `{ focused }` | Bottom of the sidebar. `title`: Aura draws it as the section's heading, like its own sections (leave it out to draw your own or none). `order`: lower first |
| `ctx.ui.inspectorSection({ id, order?, component })` | `{ session }` | Top of the inspector, for the selected session |
| `ctx.ui.sessionRowChips({ id, order?, component })` | `{ session, selected }` | Chips on every session row in the sidebar; keep them tiny |
| `ctx.ui.branchDecoration({ id, component })` | `{ cwd, status, place, session }` | Next to a session's git branch (`place`: `"statusbar"`, `"inspector"` or `"row"`) |
| `ctx.ui.statusBarItem({ id, order?, component })` | `{}` | The status bar at the bottom |
| `ctx.ui.settingsTab({ id, title, component })` | `{}` | A tab of its own in Settings. `title`: the tab's label |
| `ctx.ui.newSessionField({ id, component })` | `{ cwd, onChange }` | A field in the New session dialog; `onChange({ prompt?, data? })` adds text to the first prompt and stores `data` on the new session |
| `ctx.ui.inboxRenderer({ component, open? })` | `{ item }` | How this mod's inbox items (`aura.inbox.set`) look; `open(item)` runs on Enter or click |
| `ctx.ui.transcriptLinks({ id, detect })` | `detect(text, session)` returns `[{ label, url, kind }]` | Link chips found in agent replies |
| `ctx.ui.view({ id, title, component })` | `{ props, close, active }` | A full main-area view, opened with `ctx.openView(id, props)`. `title`: the label of its tab |
| `ctx.ui.dialog({ id, component })` | `{ props, close }` | A dialog, opened with `ctx.openDialog(id, props)` |

### Aura's components and look

`__aura.modules["@aura/host"]` holds Aura's own building blocks: `Modal`,
`ModalC`, `KeyList`, `useListNav`, `ExternalLink`, `Markdown`, `DiffRenderer`,
`diff`, `timeAgo`, `exactTime`, `relTime`, `isMac`, `modLabel`, `shortId`,
`basename`, `useStore`, `setFocus` and `openExternal(url)`.

Aura's CSS classes are part of the API too: `btn` (`btn small`), `chip`,
`dim`, `section-title`, `inspector-section` (with an `h4` heading),
`list-item` (`list-item active`), `empty`. Add `data-hint` to a clickable
element so Aura's hint mode can reach it from the keyboard.

## The edit loop

1. Save a file. After half a second without further changes (so a save in
   several steps, or a build, is seen once, finished), Aura reloads **only the
   half that changed**:

   | You changed | What reloads | State kept |
   | --- | --- | --- |
   | `ui.js` or `ui.css` | the UI half, in every window | the daemon half keeps running, with its in-memory state |
   | `daemon.js` | the daemon half restarts | the UI half stays loaded |
   | `mod.json` | both halves | none |
   | anything else (`types/`, `jsconfig.json`, notes) | nothing | everything |

   A restart of the daemon half loses whatever it kept in variables. Keep
   what must survive in `aura.storage` (kv and collections), and data about a
   session in `aura.sessions.data(id)`; both are kept across reloads and
   restarts of Aura.
2. Aura checks the new files before it stops anything. A `daemon.js` or
   `mod.json` that does not load leaves the previous version running, and
   `aura mods list` shows the reason as `reload error`. A `ui.js` that does
   not parse is reported with its line and column, for example
   `ui error: ui.js:12:5: SyntaxError: unexpected token in expression: '<'`,
   in `aura mods list`, in `aura mods logs <id>` and in Settings › Mods. Errors
   the window hits while loading or rendering the UI half appear in the log
   as `ui error` lines, with `ui.js:line:column` when the browser gives one.
3. Read the result: `aura mods logs <id>` (`-f` follows it and shows every
   line, repeats included). It holds the daemon half's `console` output,
   start-up errors, uncaught errors, reload messages, and the UI half's
   reports (at most 20 per 10 seconds per mod; the log notes how many were
   dropped).
4. Check the state: `aura mods list` shows each mod's state (`running`,
   `needs_approval`, `failed`, `disabled`) and its errors.
5. Exercise the daemon half directly: `aura mods call <id> <method> '<json>'`.

Other commands: `aura mods reload <id>` restarts both halves (for example
after editing a file the watcher cannot see), `aura mods rescan` looks for
added, removed and moved mod folders, `aura mods disable <id>` stops a mod
and keeps it off across restarts, and `aura mods enable <id>` turns it back
on. A change that adds permissions puts the mod back to `needs_approval`.

The daemon half's `console` lines also go to `<data dir>/aurad.log`; the UI
half's reports go only to the mod's own log (`aura mods logs`).

To check the files against the API types without running anything, open the
folder in an editor that understands `jsconfig.json` (VS Code does), or run
`npx -p typescript tsc -p .` in the mod folder if Node is available.

### Seeing the UI half

There is no separate preview: the UI half runs only inside Aura's own window,
where its sidebar section, inspector section and commands appear as soon as
it loads. Keep Aura open while you work; each save shows there at once. If you
cannot see the window, rely on `aura mods list` (state and `ui error`) and
`aura mods logs <id>`, and ask the user to look.

### Testing events

`turn_started`, `turn_completed`, `item_*`, `approval_*` and `usage` come from
**agent sessions** (Claude, Codex or an ACP agent). A terminal session
(`aura new --provider terminal`) only produces `session_*` and
`process_exited` events. To fire a turn cheaply, start a small agent session
with a one-line prompt in an empty folder, and watch the events:

```sh
mkdir -p /tmp/aura-event-test
aura events | grep --line-buffered turn_completed &     # watch (Ctrl+C to stop)
aura new --provider claude --cwd /tmp/aura-event-test --prompt "Reply with the single word: ok"
aura send <session id> "Again: reply ok"               # one more turn
aura rm <session id>                                   # clean up
```

Each turn uses a little of the user's agent quota; ask before you run many.
To test handler logic without any session, call it: `aura mods call <id> …`.

## Limits

- Daemon half: QuickJS (modern JavaScript: async/await, classes, modules), no Node or browser APIs, 256 MB memory, 5 s
  of uninterrupted synchronous work, single file, JSON in and out of RPC.
- RPC calls time out after 15 minutes.
- UI half: a single ES module file, no imports, Aura's React only.
- The daemon half is sandboxed: it reaches only what its permissions allow,
  and no files outside its data folder.
- The UI half is **not** sandboxed. The slots above are where Aura offers
  room, but code in `ui.js` runs with the same rights as Aura's own window
  and could change any screen. That is why every mod Aura did not ship with
  needs the user's approval, given in a prompt no mod or theme stylesheet can
  hide or reword.
- The log keeps the last 300 lines per mod.

## TypeScript and a bundler (optional)

For a bigger mod you can write TypeScript and JSX and bundle each half into one
file with esbuild (`npm i -D esbuild @types/react`). Map Aura's shared modules
to `globalThis.__aura`, never bundle React:

```js
// build.mjs: node build.mjs → daemon.js and ui.js next to mod.json
import { build } from "esbuild";

const SHARED = /^(react|react\/jsx-runtime|react-dom|zustand|zustand\/shallow|clsx|@aura\/host)$/;
const shared = {
  name: "aura-shared",
  setup(b) {
    b.onResolve({ filter: SHARED }, (a) => ({ path: a.path, namespace: "aura" }));
    b.onLoad({ filter: /.*/, namespace: "aura" }, (a) => ({
      contents: `module.exports = globalThis.__aura.modules[${JSON.stringify(a.path)}];`,
      loader: "js",
    }));
  },
};
await build({ entryPoints: ["src/daemon.ts"], outfile: "daemon.js", bundle: true, format: "esm", platform: "neutral", target: "es2022" });
await build({
  entryPoints: ["src/ui.tsx"], outfile: "ui.js", bundle: true, format: "esm", platform: "browser",
  target: ["chrome105", "safari15"], jsx: "automatic", plugins: [shared],
});
```

Reference the API types with `/// <reference path="../types/aura-mod.d.ts" />`
and use them as `Aura.DaemonApi`, `Aura.UiApi`, `Aura.InspectorSectionProps`.
Do not bundle Node built-ins or packages that need them into `daemon.js`.

## A complete example: turn counter

A mod that counts how many turns each agent session has finished, shows the
count as a chip on every session row and in the inspector (with a reset
button), and the total in the status bar. It needs to read session events, so
it asks for `sessions: "read"`.

`~/.aura/mods/turn-counter/mod.json`:

```json
{
  "id": "turn-counter",
  "name": "Turn counter",
  "version": "1.0.0",
  "apiVersion": 1,
  "description": "Counts the turns each session has finished.",
  "daemon": "daemon.js",
  "ui": "ui.js",
  "styles": "ui.css",
  "permissions": { "sessions": "read" }
}
```

`~/.aura/mods/turn-counter/daemon.js`:

```js
/** @param {Aura.DaemonApi} aura */
export default async function activate(aura) {
  /** @type {Aura.Collection<number>} */
  const counts = aura.storage.collection("counts");

  const all = async () => Object.fromEntries(await counts.all());

  aura.events.on("turn_completed", async (ev) => {
    const n = Number((await counts.get(ev.session_id)) ?? 0) + 1;
    await counts.put(ev.session_id, n);
    aura.emit("changed", await all());
  });
  // Forget sessions that are deleted.
  aura.events.on("session_removed", async (ev) => {
    await counts.delete(ev.session_id);
    aura.emit("changed", await all());
  });

  aura.rpc.handle("counts", all);
  aura.rpc.handle("reset", async ({ sessionId }) => {
    if (sessionId) await counts.delete(sessionId);
    else await counts.clear();
    aura.emit("changed", await all());
    return true;
  });
  console.log("turn-counter ready");
}
```

`~/.aura/mods/turn-counter/ui.js`:

```js
const React = __aura.modules.react;
const { create } = __aura.modules.zustand;
const h = React.createElement;

// One store shared by every component of this mod.
const useCounts = create(() => ({ counts: /** @type {Record<string, number>} */ ({}) }));

/** @param {Aura.SessionRowProps} props */
function RowChip({ session }) {
  const n = useCounts((s) => s.counts[session.id] ?? 0);
  return n ? h("span", { className: "chip mod-turn-counter-chip", title: `${n} turns finished` }, `${n}↻`) : null;
}

/** @param {Aura.InspectorSectionProps & { ctx: Aura.UiApi }} props */
function Inspector({ session, ctx }) {
  const n = useCounts((s) => s.counts[session.id] ?? 0);
  return h(
    "div",
    { className: "inspector-section" },
    h("h4", null, "Turns"),
    h(
      "div",
      { className: "mod-turn-counter-row" },
      h("span", null, `${n} finished`),
      h("button", { className: "btn small", "data-hint": true, onClick: () => ctx.rpc("reset", { sessionId: session.id }) }, "Reset"),
    ),
  );
}

function Total() {
  const total = useCounts((s) => Object.values(s.counts).reduce((a, b) => a + b, 0));
  return h("span", { className: "dim" }, `${total} turns`);
}

/** @param {Aura.UiApi} ctx */
export default function activate(ctx) {
  const load = () => ctx.rpc("counts").then((counts) => useCounts.setState({ counts })).catch(() => {});
  load();
  ctx.onConnection((state) => state === "open" && load());
  ctx.on("changed", (counts) => useCounts.setState({ counts }));

  ctx.ui.sessionRowChips({ id: "count", component: RowChip });
  ctx.ui.inspectorSection({ id: "turns", order: 50, component: (p) => h(Inspector, { ...p, ctx }) });
  ctx.ui.statusBarItem({ id: "total", component: Total });
  ctx.commands.register({
    id: "reset-all",
    title: "Turn counter: reset all counts",
    group: "Turn counter",
    run: async () => {
      if (await ctx.confirm({ title: "Reset all counts?", message: "Every session's count goes back to 0.", danger: true })) {
        await ctx.rpc("reset", {});
      }
    },
  });
}
```

`~/.aura/mods/turn-counter/ui.css`:

```css
.mod-turn-counter-chip { color: var(--accent); border-color: var(--accent); }
.mod-turn-counter-row { display: flex; align-items: center; gap: var(--space-2); }
```

Install and try it:

```sh
aura mods list                                  # turn-counter: needs_approval
aura mods approve turn-counter                  # Aura shows the prompt; the user clicks Approve
aura mods logs turn-counter                     # "turn-counter ready"
aura mods call turn-counter counts              # {}  (then finish a turn in an agent session; see "Testing events")
```

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| Not in `aura mods list` | The folder is not in `<data dir>/mods/` (check `AURA_DATA_DIR`), or `mod.json` is missing. Run `aura mods rescan` |
| `its id "x" is already used by …` | Another folder holds that id; pick another id |
| No `turn_completed` events | The session is a terminal session; events come from agent sessions (see "Testing events") |
| Listed with an error, `broken` | `mod.json` does not parse or names a missing file; the error says which |
| `needs_approval` | Not approved yet, its permissions grew, or its folder moved. See "Approval" |
| `needs_window` error | Something tried to approve outside Aura's window. Use `aura mods approve <id>`, which shows the prompt in Aura |
| `reload error` in `aura mods list` | The new `daemon.js` or `mod.json` does not load; the previous version keeps running until you fix it |
| `ui error: ui.js:LINE:COL` | `ui.js` does not parse there (often JSX or an `import`; use `h(...)` and `__aura.modules`) |
| `failed` | The daemon half threw while loading or in `activate`; `aura mods logs <id>` has the stack |
| `permission_denied` | Add the permission to `mod.json` (the mod then needs approval again) |
| UI shows nothing | `aura mods logs <id>` for `ui error` lines. Check `export default function activate(ctx)` and that you used `__aura.modules.react` |
| `Invalid hook call` | A second React: use `__aura.modules.react` only |
| `X is not defined` in the daemon | A Node or browser API (`fetch`, `require`, `process`); use the `aura.*` equivalent |
| `the mod ran too long and was interrupted` | A synchronous loop ran over 5 s; make it async or smaller |
| A change does not show | Check the log for a reload line (`UI files changed…`, `daemon files changed…`, `mod.json changed…`) or a `reload error`; otherwise `aura mods reload <id>` |
