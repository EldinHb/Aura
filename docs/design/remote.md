# Remote access — design and protocol

Status: implemented (released in 0.6.0). This file is the
contract for remote clients (the Android app first). Field names below are
exactly what goes over the wire.

## 1. What it is

Aura's daemon (`aurad`) serves its JSON-RPC 2.0 API on a loopback WebSocket
for the desktop app and the CLI. Remote access adds an **opt-in second
listener**: a TLS WebSocket, `wss://<host>:<port>/`, off by default, that
speaks the same JSON-RPC protocol to paired devices, limited to an explicit
allowlist of methods.

- Default bind address `0.0.0.0`, default port `7443`.
- Self-signed certificate made on first enable, kept in the data directory
  (`<data_dir>/remote/cert.pem`, `key.pem`, 0600) and reused after that.
  Clients **pin its SHA-256 fingerprint** (lowercase hex of the DER
  certificate, no separators). There is no CA and the certificate's host name
  is not meaningful: clients must skip host name verification and check the
  fingerprint instead.
- Config and paired devices live in `<data_dir>/remote/config.json` and
  `devices.json` (0600). Changing the config starts, stops or rebinds the
  listener at once; no daemon restart.
- `serverId` is a random UUID made once per installation and kept in
  `config.json`.

Turning it on, from a terminal (the desktop UI uses the same RPCs):

```bash
aura remote on [--bind 0.0.0.0] [--port 7443] [--name "Studio Mac"]
aura remote pair       # prints the code, fingerprint, addresses and the aura:// link
aura remote devices    # aura remote revoke <deviceId>; aura remote off
```

`aura remote on` and `aura remote pair` ask for confirmation at a terminal
and refuse to run inside an Aura session (when `AURA_SESSION_ID` or
`AURA_SESSION` is set, which Aura sets for every agent and terminal it
starts) or without a terminal on stdin.

## 2. Threat model (short)

- **Network attacker** (same Wi-Fi, café, LAN): sees only TLS. Without the
  pinned fingerprint a client refuses the connection, so no MITM. Without a
  valid pair code or device token the attacker can only call `remote.pair` /
  `remote.auth`, which are rate limited (5 failures per minute per IP, then
  every attempt is refused and the connection closed). Pair codes are 8 chars
  from a 31-character alphabet (`A–Z` and `2–9` without `I`, `L`, `O`) (~8.5·10¹¹), live 5 minutes and work once.
- **Lost or stolen phone**: the user revokes the device on the desktop
  (`remote.revokeDevice`); its live connections drop at once and its token is
  refused from then on. Tokens are 32 random bytes and the daemon stores only
  their SHA-256 hash.
- **A paired device is the user** for what the allowlist permits: it can read
  every session and send agents messages, and agents can run commands. It can
  not change settings, read the file system directly, manage mods, delete
  sessions, update Aura or manage remote access itself.
- **An agent on the desktop opening remote access**: a session's tools
  (session tokens) may only turn remote access off and revoke devices;
  enabling, moving (bind/port) and pairing are refused with -32003. The CLI
  refuses `on`/`pair` inside an Aura session and without a terminal. This
  raises the bar; it is not a hard boundary against an agent that runs as the
  user, strips its environment and reads `daemon.json` itself.
- Out of scope: a process running as the same user on the desktop (it can
  read the data directory and the local token anyway).

## 3. Pairing flow

1. On the desktop, the user enables remote access (`remote.configure
   {enabled: true}`) and starts pairing (`remote.startPairing`). The app shows
   the returned `uri` as a QR code plus the code, the fingerprint and the
   addresses to pick from.
2. The phone scans `aura://pair?host=<ip>&port=<port>&fp=<fingerprint>&code=<code>&name=<server name>[&alt=<other addresses>]`.
   Every value is percent-encoded (an IPv6 host's colons as `%3A`, a space in
   the name as `%20`). `host` is the first of `addresses` (a bare IP, IPv6
   not bracketed).
   `alt` is optional: the rest of `addresses`, comma separated, IPv6 ones in
   brackets (`100.75.1.9,[2001:db8::5]`, sent as
   `100.75.1.9%2C%5B2001%3Adb8%3A%3A5%5D`). It is left out when there is only
   one address (e.g. the listener is bound to one IP). Decode the value, split
   on `,`, strip the brackets; try `host` first, then each `alt` in order,
   always with the same `port` and `fp`.
3. The phone opens `wss://host:port/` with TLS, accepting exactly the
   certificate whose SHA-256 is `fp`.
4. It calls `remote.pair {code, deviceName}` and gets
   `{deviceId, token, serverId, serverName, version}`. It stores
   `serverId, deviceId, token, host, port, fp` securely. The connection is now
   authenticated as that device.
5. On every later connection the phone calls `remote.auth {deviceId, token}`
   first. A new `remote.startPairing` replaces the previous code.

Before `remote.pair` or `remote.auth` succeeds, every other method is answered
with **-32010** and the connection is closed. A connection must have
authenticated 30 seconds after the TCP connect, TLS handshake and WebSocket
upgrade included; otherwise it is closed at whatever stage it is. At most 32
connections may be unauthenticated at once; more are closed right after
connect (the TLS handshake fails), so retry a little later. A failed pair/auth answers with the
error and closes the connection.

## 4. Transport details

- URL path: `/` (also accepted: `/ws`). Text frames carry JSON-RPC: requests
  `{"id": 1, "method": "...", "params": {...}}`, responses
  `{"id": 1, "result": ...}` or `{"id": 1, "error": {"code", "message", "data"?}}`,
  notifications `{"method": "...", "params": ...}` (no `id`). The
  `"jsonrpc": "2.0"` member is optional on requests and is not sent back,
  same as the loopback API.
- Message (and frame) limit: 16 MB. Before authentication, any message over
  64 KB closes the connection without an answer.
- The server answers WebSocket pings with pongs. There is no app-level
  heartbeat; use WebSocket pings (e.g. OkHttp `pingInterval`).
- The server never sends binary (PTY) frames to remote clients, and ignores
  binary frames from them.

## 5. Error codes

| code    | meaning | connection |
|---------|---------|------------|
| -32700  | parse error | stays |
| -32601  | unknown method | stays |
| -32602  | bad params (message says what) | stays |
| -32000  | internal / the operation failed (message says why) | stays |
| -32003  | forbidden: method not allowed for remote clients, or a parameter not allowed (e.g. `session.create` outside a known project) | stays |
| -32010  | not authenticated yet: call `remote.pair` or `remote.auth` first | **closed** |
| -32011  | auth failed: unknown or revoked device, or wrong token | **closed** |
| -32012  | pair code invalid, expired or already used | **closed** |
| -32013  | rate limited: too many failed pair/auth attempts from this IP; `data.retryAfterSecs` | **closed** |

## 6. Pre-auth methods (remote listener only)

### `remote.pair`
params `{code: string, deviceName: string}` — `code` compared
case-insensitively, spaces and dashes ignored. `deviceName` trimmed and
truncated to 64 characters; empty becomes `"Device"`.
result `{deviceId: string, token: string, serverId: string, serverName: string, version: string}`
— `token` is 64 lowercase hex characters, shown only this once.

### `remote.auth`
params `{deviceId: string, token: string}`
result `{serverId: string, serverName: string, version: string}`

Both are refused with -32003 on the loopback listener.

## 7. Local management methods (loopback only)

Refused with -32003 on the remote listener. A session's tools (session
tokens) may only call `remote.configure {enabled: false}` (also with
`serverName`) and `remote.revokeDevice`; enabling, `bindAddress`, `port`,
`remote.startPairing`, `remote.status` and `remote.listDevices` are refused
for them with -32003.

### `remote.status` → `RemoteStatus`
```ts
{ enabled: boolean, bindAddress: string, port: number, serverName: string,
  serverId: string, fingerprint: string | null, listening: boolean,
  error: string | null, addresses: string[] }
```
`fingerprint` is null until the certificate exists (first enable).
`error` says why the listener is not up (e.g. the port is taken).
`addresses` are the machine's non-loopback IP addresses, IPv4 first.

### `remote.configure` → `RemoteStatus`
params `{enabled?: boolean, bindAddress?: string, port?: number, serverName?: string}`
— omitted fields keep their value. `bindAddress` must be an IP address,
`port` 1–65535, `serverName` 1–64 characters after trimming. Applied at once.
A bind failure does not fail the call: it shows in `error`, `listening: false`.

### `remote.startPairing` → `PairingInfo`
```ts
{ code: string, expiresAt: string /* RFC 3339 */, uri: string,
  fingerprint: string, addresses: string[] }
```
Fails (-32000) when remote access is off.

### `remote.listDevices` → `RemoteDevice[]`
```ts
{ deviceId: string, name: string, pairedAt: string, lastSeenAt: string | null,
  lastAddress: string | null }
```

### `remote.revokeDevice` → `true`
params `{deviceId: string}` — forgets the device and closes its live
connections. Unknown id: -32000.

## 8. Methods allowed for remote clients

The single source of truth is `REMOTE_ALLOWED_METHODS` in
`crates/aura-rpc/src/remote.rs`. Everything else gets -32003. Shapes are the
ts-rs types in `apps/desktop/src/gen/` (`Session.ts`, `Event.ts`, …);
snake_case field names unless noted.

| method | params | result |
|---|---|---|
| `daemon.ping` | `{}` | `"pong"` |
| `daemon.info` | `{}` | `{version, pid, started_at}` (redacted: no token, port or data dir) |
| `provider.list` | `{}` | `ProviderInfo[]` — the agents: `kind`, `display_name`, `available`, `capabilities`, `agents` (ACP agents) |
| `provider.models` | `{provider}` | `ModelInfo[]` |
| `orchestrator.projects` | `{}` | `Project[]` — `{path, repo, groups, sessions, last_used}` |
| `workspace.list` | `{}` | `Workspace[]` |
| `workspace.create` | `{name}` | `Workspace` — `name` 1–40 characters, unique ignoring case |
| `workspace.rename` | `{id, name}` | `Workspace` |
| `session.set_workspace` | `{id, workspace}` | `Session[]` — the session and its workers, moved; a worker alone is refused (it stays with its orchestrator) |
| `session.list` | `{}` | `Session[]` — includes `status` (`idle`/`running`/`waiting_approval`/`waiting_input`/`error`/`exited`), `pending_count`, `attention` (`done`/`failed`/`waiting`/null) |
| `session.get` | `{id}` | `Session` |
| `session.history` | `{id, after_seq?: number = 0, limit?: number = 5000}` | `StoredEvent[]` — `{seq, ts, event}`; page with the last `seq` |
| `session.pending` | `{}` | `{approvals: Approval[], inputs: UserInputRequest[]}` |
| `session.attachment` | `{id, attachment}` | `{data: base64, media_type}` — images referenced from a transcript |
| `session.send` | `{id, input: {text, images?: ImageInput[], steer?: bool}}` | `true` (starts the agent if it is not running). Images must carry `data` (base64) + `media_type`; an image with a `path` is refused with -32003. Refused (-32003) for sessions with `mode: "terminal"` |
| `session.interrupt` | `{id}` | `true`. Refused (-32003) for `mode: "terminal"` sessions |
| `session.stop` | `{id}` | `true` |
| `session.respond_approval` | `{id, approval_id, decision: {option, updated_input?, message?}}` | `true` — `option`: `accept`/`accept_for_session`/`decline`/`cancel`/`edit_input` |
| `session.respond_input` | `{id, response: {request_id, answers: {[questionId]: string[]}, declined?: bool}}` | `true` |
| `session.mark_seen` | `{id}` | `Session` (clears `attention`) |
| `session.create` | see below | `Session` |
| `session.git_status` | `{id}` | `SafeStatus` — `{files: FileStatus[], truncated}` for the session's own folder (its worktree when it has one); `{files: [], truncated: false}` when it is no repository |
| `session.git_diff_stat` | `{id, base?}` | `SafeDiffStat` — `{files: DiffStat[], truncated}`, each `{path, added, deleted}` against HEAD (or `base`) |
| `session.git_diff` | `{id, path?, staged?, base?}` | unified diff text, untracked files included; `""` when no repository. When cut, it ends with a line `# aura: truncated: …` |
| `feature.list` | `{}` | `Feature[]` — a feature owner's questions to the user are in `questions` |
| `feature.get` | `{id}` | `Feature` |
| `feature.answer` | `{id, question, option?, text?}` | `Feature` — answer a feature owner's question (`id` is the owner session) |
| `usage.summary` | `{from?, to?, groupBy?: "day"\|"session"\|"feature"\|"project"\|"agent"\|"model" = "day", splitBy?, timeZone?: string, tzOffsetMinutes?: number = 0, limit?: number = 50}` | `UsageSummary` (camelCase) — turns that ended in `[from, to)` (RFC 3339), summed: `totals` and `groups` (days in order with empty days filled in; else largest cost first, `more` = groups cut by `limit`). `splitBy` splits each group into `parts` (stacked bars). Send `timeZone` (IANA, e.g. `Europe/Amsterdam`) so days follow daylight saving; `tzOffsetMinutes` is the fallback. Input tokens are uncached input for every agent |
| `usage.session` | `{id, includeWorkers?: bool}` | `SessionUsage` (camelCase) — the session's `turns` (per turn: tokens, cache read/write, context after it, cost and whether `estimated`), `totals`, `allTotals` with its workers, `models`, `workers` |
| `usage.report` | `{from, to, title?, timeZone?, tzOffsetMinutes?}` | `UsageReport` (camelCase) — a summary of the period in Markdown, against the period of the same length before; made from the data, no model call |
| `usage.reports` | `{}` | `UsageReport[]` — the daily summaries Aura wrote (latest first, at most 30) |
| `template.list` | `{}` | `SessionTemplate[]` by name |
| `template.create` | `TemplateInput` | `SessionTemplate` — a preset of `session.create`'s options; `name` 1–60 characters, unique ignoring case. A session started from it is still a remote `session.create`, with every check below (a template's folder outside the known projects is refused then) |
| `template.update` | `{id, ...TemplateInput}` | `SessionTemplate` |
| `template.delete` | `{id}` | `true` |

### Git, read-only, for remote clients
The session's changes, read in its own folder only: the device names a
session, never a folder. `path` must be relative and stay inside it (no `..`,
not absolute) and `base` a plain ref (letters, digits, `/ . _ - ~ ^`, not
starting with `-`, no `..`); otherwise -32003. Unknown params (a `cwd`) are
-32602. The desktop's `git.*` methods, and every git write, stay refused.

These do **not** run `git status` or `git diff`: those read working-tree
files through the repository's own config (`core.fsmonitor`, clean/process
filters, external diff drivers, textconv, hooks), which would run commands
the repository — any agent in it — chose. `aura_git::safe` asks git only
for metadata from the index and object store (`rev-parse`, `ls-files
--stage`, `ls-files --others`, `ls-tree`, `cat-file --batch`), with
`core.fsmonitor`, hooks, external diff, `core.sshCommand` and transports
overridden, no system config, no optional locks, no lazy fetch and literal
pathspecs. It reads the working-tree side itself and computes the diff
in-process. Tests run it against a repository configured to touch a marker
file from every one of those settings and assert the marker never appears.

- **Scope**: only the session's folder. In `repo/sub`, `repo/outside.txt` is
  never listed or read. Paths in results are relative to the session's
  folder (`a.txt`, not `sub/a.txt`), in diff headers too. A `path` starting
  with `:` (pathspec magic such as `:(top)x`) is refused with -32003.
- **Symlinks**: never followed. A tracked symlink shows as its link text, as
  git stores it; untracked symlinks and special files are left out; a file
  under a folder that is a symlink is not read (it shows as deleted).
- **Limits**: 300 files; 512 KB of diff per file, 4 MB in total; files and
  blobs over 8 MB are named, not diffed (`# aura: not shown: N bytes is too
  large`); 15 s per call, a git process still running then is killed. What
  is cut sets `truncated` (status, stat) or adds a `# aura: truncated` line
  (diff). At most 2 of these calls at a time per connection (8 for all remote
  connections): more get -32000 with `data.code: "busy"`; retry after one
  finishes.
- **What it costs**: no clean filters or end-of-line conversion are applied,
  so a file only git's filter would call unchanged (LFS, CRLF normalisation)
  shows as changed; renames are not detected (a delete plus an add);
  submodules are left out.

### `session.create` for remote clients
What the desktop's new-session dialog offers. Only these params are accepted
(unknown ones: -32602):
```ts
{ provider: "claude" | "codex" | "acp", agent?: string, cwd: string,
  title?: string, group?: string, workspace?: string, model?: string,
  effort?: string, permission_mode?: string, sandbox_mode?: string,
  system_prompt?: string, mode?: "structured", initial_prompt?: string,
  worktree?: { branch: string, base?: string },
  orchestrator?: boolean, feature_owner?: boolean, feature_goal?: string,
  autonomy?: { level: "autonomous" | "blocking_decisions" | "checkpoints",
               checkpoints: ("after_design" | "before_implementation" | "before_delivery")[] } }
```
`cwd` must be an existing folder that, with symlinks resolved, is the `path`
of a project from `orchestrator.projects` (also resolved) or lies inside one;
otherwise -32003. The session runs in the resolved folder, so its `cwd` may
differ from what was sent. An orchestrator (`orchestrator`, or
`feature_owner`, which makes one) may instead send an empty `cwd`: the daemon
makes it a folder of its own (`folderless`), as the desktop does; a worktree
then is refused (-32003). `worktree.branch` may not contain `..` or start
with `/`, `\` or `-` (-32003). `mode: "terminal"` and the terminal provider
are refused (-32003). Custom commands, resuming or forking native sessions,
making a session another one's worker (`orchestrator_id`) and custom worktree
paths are not available remotely (-32602).

### Notifications
After authentication the connection receives, unasked:

- `event` — `params` is an `Event` (tagged by `type`, all but `workspaces_changed`, `templates_changed`, `usage_report` and `specialist_suggestions_updated` with a
  `session_id`): `session_created`, `session_updated` (status, pending count,
  attention changes), `session_removed`, `turn_started`, `turn_completed`,
  `item_started`, `item_delta`, `item_completed`, `approval_requested`,
  `approval_resolved`, `user_input_requested`, `user_input_resolved`,
  `notice`, `usage`, `process_exited`, `feature_updated`, `workspaces_changed`,
  `templates_changed` (`{templates}`, all of them), `usage_report`
  (`{report}`, the daily usage summary when the user turned it on: worth a
  notification), and a few more a client may ignore. `turn_completed`'s
  `turn.usage` is what that turn spent; `usage.session` has it with costs.
- `lagged` — `{count}`: the client fell behind and events were dropped;
  re-fetch `session.list` and the open session's `session.history`.

A typical client: `remote.auth` → `session.list` + `session.pending` →
keep the list fresh from `session_*` events (terminal-mode sessions are listed and can be stopped,
but not typed into); for an open session,
`session.history {id}` then apply that session's item/turn events; show
`approval_requested` / `user_input_requested` (and `session_updated` with
`attention: "waiting"`) as notifications.

## 9. Not allowed remotely (examples)

`daemon.shutdown`, `daemon.window_hello`, `usage.daily`, `usage.set_daily`, `settings.*`, `fs.*`, `pty.*`,
`mods.*`, `git.*`, `session.delete`, `session.delete_many`, `workspace.delete`, `workspace.touch`, `session.set`,
`session.set_system_prompt`, `prompts.*`, `specialists.*`, `schedules.*`,
`autonomy.set`, `remote.configure` and the other `remote.*` management
methods, the update methods, and session-tool methods (`orchestrator.*`
except `orchestrator.projects`, `owner.*`, `team.*`).

## 10. Without the app: SSH tunnel

The remote listener is a plain TLS WebSocket, so an SSH tunnel to it works
too: `ssh -L 7443:127.0.0.1:7443 user@desktop`, then connect to
`wss://127.0.0.1:7443/` with the same fingerprint. Bind address `127.0.0.1`
keeps the listener off the network entirely in that setup.
