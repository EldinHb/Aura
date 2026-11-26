# github mod

GitHub for Aura: the one GitHub client every mod shares (gh's token, the
rate-limit gate, budgets and pacing, notifications, ETag-cached reads), the
issue picker in the new-session dialog, issue and PR links on sessions, and the
pull request next to a session's branch.

The GitHub reads themselves live in `@aura/github-client`
(`packages/github-client`); this mod's daemon half owns the transport they run
on and serves it over RPC.

## Layout

| Path | What |
| --- | --- |
| `src/daemon.ts` | Daemon half: registers every RPC method below |
| `src/daemon/transport.ts` | `GhTransport` (former `GhCli`): token from `gh auth token`, the gate (4 at a time, rate-limit pause, retries of reads on 5xx), budgets and `pace`, sign-out and login re-checks, notifications, the memo |
| `src/daemon/repo.ts` | `owner/repo` of a folder from its git remotes (former `git.github_repo`) |
| `src/daemon/links.ts` | Per-session links, detected links and branch PRs |
| `src/shared/links.ts` | Link parsing and detection, used by both halves |
| `src/ui.tsx`, `src/ui/*` | UI half: issue picker, Inspector section, links dialog and command, sidebar chips, branch decoration, transcript links |
| `src/ui.css` | Styles moved out of the app's `styles.css` |

## RPC surface (`mod.github.*`)

Errors are thrown with a string `code` and, for GitHub's refusals, `data`:
`{kind: "rejected"}` or `{kind: "rate_limited", waitMs, resourceOnly}` (see
`errorData` / `reviveError` in `@aura/github-client`). Other codes: `invalid`
(bad parameters), `not_found`, `failed`.

### The transport (for other mods, through `remoteGithub(call)`)

| Method | Params | Result |
| --- | --- | --- |
| `api.request` | `{method, path, body?, account?}` | GitHub's JSON body (`null` for an empty one). `path` is a REST path, `"graphql"` or a full https URL. With `account` (`"host:login"`), the request is sent with that account's own token after checking it is that login (former `request_for`) |
| `api.diff` | `{repo, base, head}` | The unified diff of `base...head` (40-char SHAs) |
| `api.account` | `{}` | `"github.com:<login>"` of gh's active account |
| `api.blocked` | `{}` | Why GitHub is left alone now (expired login, no gh, rate-limit pause), or `null` |
| `api.pace` | `{baseMs}` | How long a loop polling every `baseMs` should wait now (longer as the budget runs low) |
| `api.notified` | `{}` | `Notified.toJSON()` (`{pulls, completeSince}`) of recent PR notifications, or `null` |

### Reads for the UI (former core methods)

| Method | Params | Result | Former |
| --- | --- | --- | --- |
| `issues` | `{repo, query?}` | `RepoIssue[]` | `github.issues` |
| `branch_pull` | `{repo, head_repo, branch}` | `BranchPull \| null` | `github.branch_pull` |
| `repo` | `{cwd}` | `"owner/repo" \| null`: the folder's GitHub repository, from its `upstream`, `github` or `origin` remote | `git.github_repo` |

### Session links

Kept as this mod's per-session data (deleted with the session), in the shapes
of the settings and session field they replace, so a migration copies them as
they are (JSON text of the former settings is read too):

| Key | Shape | Replaces |
| --- | --- | --- |
| `links` | `{issues?: string[], prs?: string[], reviews?: false}`; a missing list means automatic, a list (even empty) is fixed. The older `{issue, pr}` form is read too | setting `session.links.v1.<sid>` |
| `detected` | `string[]` of issue and PR URLs detected in the conversation | setting `session.links.detected.v1.<sid>` |
| `pulls` | `string[]` of PR URLs opened from the session's branch | `Session.pulls` |

| Method | Params | Result |
| --- | --- | --- |
| `links.get` | `{sessionId}` | `{links, detected, pulls}` as stored (`links`/`detected` `null` when unset) |
| `links.all` | `{}` | `Record<sessionId, {links, detected, pulls}>` for every session with any of them |
| `links.set` | `{sessionId, links}` | Validates and saves the user's choice (URLs of the right kind on github.com, deduplicated); returns what was saved. `invalid` otherwise |
| `detected.set` | `{sessionId, urls}` | Saves the detected links (issue and PR URLs); returns them |
| `pulls.record` | `{sessionId, url}` | Remembers a PR of the session's branch, once (case-insensitive); returns the session's `pulls` (former `session.record_pull`) |
| `session.pulls` | `{sessionId}` | The session's `pulls` |
| `session.prs` | `{sessionId, following?}` | PR URLs linked to the session: the chosen `prs`, else the older `pr`, else the detected PRs; deduplicated, as `https://github.com/<repo>/pull/<n>` (former `session_prs`). With `following: true`, none when the user turned follow-ups off (former `linked_prs`). Branch PRs are not included: add `session.pulls` for the former `followed_prs` |
| `sessions.prs` | `{following?}` | `Record<sessionId, string[]>`: `session.prs` of every session that links any PR |
| `session.followsReviews` | `{sessionId}` | `false` only when the user turned review follow-ups off (`links.reviews === false`; former `follows_reviews`) |
| `pulls.sessions` | `{url}` | Session ids that worked on the PR: linking it (as `session.prs`) or with it among their `pulls`. Any host's PR URL is accepted |

### Notifications

| Name | Payload | When |
| --- | --- | --- |
| `links.changed` | `{sessionId, links, detected, pulls}` (as `links.get`) | After `links.set`, a `detected.set` that changed something, or a `pulls.record` that added a PR |

## UI contributions

| Slot | Id | What |
| --- | --- | --- |
| `newSessionField` | `issues` | Issue picker; contributes `{data: {links: {issues: [...]}}}` for the new session |
| `inspectorSection` | `links` | "Issues & PRs" of the selected session |
| `dialog` | `links` | "Edit issues & PRs" (props `{sessionId}`) |
| command | `github.session.links` | Opens the dialog for the selected session (`when: hasSelection`) |
| `sessionRowChips` | `links` | The branch's PR chip with its state, then the issue and PR chips, "+N" when they do not fit |
| `branchDecoration` | `pull` | The branch's PR and its state as a link (status bar, inspector); in a row it only keeps core's branch status for the chips |
| `transcriptLinks` | `github` | Issue and PR URLs in transcript text, labelled `#12` in the session's own repository, else `owner/repo#12` |

## Tests

`pnpm --filter @aura-mods/github test`. Daemon tests use `createTestHost`; UI
tests run in jsdom against the real daemon half on a test host
(`src/test/ctx.ts`), with a small stand-in for `@aura/host`
(`src/test/host.tsx`). React DOM and Testing Library come from the desktop
app's `node_modules` (see `vitest.config.ts`).
