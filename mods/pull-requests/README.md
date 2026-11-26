# Pull requests

Aura's pull request inbox and pages, pre-reviews, reviewer watches and the agents that
follow up on review activity, as a bundled mod. It depends on the `github` mod.

## UI half (`src/ui.tsx`, `src/ui/**`, `src/ui.css`)

`src/ui.tsx` default-exports `activate(ctx)`. It talks to its daemon half with the former
core RPC method and notification names (`ctx.rpc("pulls.list")`, `ctx.on("reviews.changed")`,
and so on), and to the `github` mod for repositories and session links
(`pulls.sessions`, `session.prs`).

| What | Slot |
| --- | --- |
| PR list in the sidebar (needs your review, you reviewed, your PRs by group). While the list has focus it owns the plain keys: `j`/`k` or arrows open the next or previous PR, `g`/`G` the first or last, `Enter` moves to its page, `x` hides or restores it, `r` refreshes | `ctx.ui.sidebarSection` `pulls` |
| PR page (conversation, files, merge, edit, projects, sessions on the PR) and the pre-review editor | `ctx.ui.view` `pull`, opened with `{ pull }` |
| Review history | `ctx.ui.view` `history` |
| Pre-review settings, posting a review, watching a PR for reviews | `ctx.ui.dialog` `review-settings`, `review-submit`, `pr-watch` |
| Review watches of the selected session's PRs | `ctx.ui.inspectorSection` `watches` |
| PR changes in Aura's inbox (the daemon half sets the items; `data` is the PullChange) | `ctx.ui.inboxRenderer` |
| Pull filters, PR change kinds, merge method, delete branch after merge | `ctx.ui.settingsTab` `pull-requests` |

Commands (prefixed `pull-requests.`): `reviews.refresh`, `reviews.toggle`, `reviews.hidden`,
`reviews.history`, `reviews.start`, `reviews.hide`, `pr.watch`, `pr.watch-stop`,
`pr.watch-check`. `reviews.start` and `reviews.hide` act on the open PR and are available
when `mod.pull-requests.prSelected` is set; `mod.pull-requests.prId` names that PR.

The main window announces PR changes, watched reviews and follow-ups as toasts (and OS
notifications while it is in the background), and keeps Aura's own "turn finished"
notification quiet for a session handling review activity (`ctx.suppressTurnToast`).

`ctx.storage` keys: `pullFilters`, `pullChangesMuted`, `mergeMethod`,
`deleteBranchAfterMerge` (formerly Aura's UiSettings), `reviews.collapsed`,
`reviews.mineCollapsed`, `reviews.hidden`, `reviews.showHidden`, `reviews.group.<group>`
(formerly localStorage `aura.reviews.*`) and `review-draft.<id>` (formerly
`aura.review-draft.<id>`).

## Daemon half (`src/daemon.ts`, `src/daemon/**`)

The port of `crates/aura-review` (inbox, pre-reviews, PR change inbox, watches, follow-ups,
orchestrator reviews) and `aura-git/src/review.rs`. Every method and notification keeps the
name, parameters and JSON shape the Rust daemon used; on the wire they are
`mod.pull-requests.<name>`.

### RPC methods

| Method | Params | Result |
| --- | --- | --- |
| `github.status`, `pulls.list`, `reviews.list` | – | `ReviewInbox` (the current account's drafts, diffs left out) |
| `pulls.refresh` | – | `ReviewInbox`, after reading every PR again |
| `pulls.hide` / `pulls.restore` | `{account, id}` | `ReviewInbox` |
| `pulls.get` | `{repo, number, account?}` | `{pull, timeline, comments, reviews, threads, projects, project_error}` (also cached) |
| `pulls.cached` | `{account, id}` | the last `pulls.get` result |
| `pulls.diff` | `{repo, number, account?}` | `{sha, diff}` |
| `pulls.options` | `{repo, number, account?}` | `{labels, assignees, milestones}` |
| `pulls.update` | `{repo, number, account?, patch: {title?, body?, labels?, assignees?, milestone?}}` | GitHub's answer |
| `pulls.addComment` | `{repo, number, account?, body}` | GitHub's answer |
| `pulls.merge` | `{repo, number, account?, method, sha, delete_branch?}` | `{branch_deleted, branch_error}` |
| `pulls.setField` | `{repo, number, account?, project_id, item_id, field_id, value}` (`value` null clears) | GitHub's answer |
| `pulls.changes` | – | `PullChange[]`, latest first |
| `pulls.changes.read` | `{ids?}` (none: all) | `true` |
| `reviews.defaults` | – | `{instructions, config}` |
| `reviews.start` | `{repo, number, account?, config: ReviewConfig}` | `PreReview` (queued, or the one already running) |
| `reviews.get`, `reviews.diff` | `{id}` | `PreReview` with its diff |
| `reviews.cancel`, `reviews.discard`, `reviews.ready` | `{id}` | `PreReview` |
| `reviews.save` | `{id, revision, result: ReviewResult}` | `PreReview` |
| `reviews.preview` | `{id}` | `SubmissionPreview` |
| `reviews.submit` | `{id, token}` | `PreReview` |
| `reviews.reconcile` | `{id}` | `PreReview` |
| `orchestrator.reviews.list` / `get` / `create` / `update` / `add_comment` / `edit_comment` / `delete_comment` / `discard` / `start` / `hide` | the tool's arguments plus `orchestrator` (session id) | as before; the tools below call these |
| `watches.list` | – | `PrWatch[]`, newest first |
| `watches.candidates` | `{repo, number}` | `{title, url, author, state, requested, teams, reviewed, candidates, candidate_error, watch}` |
| `watches.start` | `{repo, number, reviewers?, request?}` | `PrWatch` |
| `watches.remove` | `{id}` | `true` |
| `watches.check` | – | `PrWatch[]`, after reading every active watch |

Errors are thrown with the Rust messages and a `code` (`failed`, `invalid`, `not_found`,
`permission_denied`, `unavailable`, `timeout`).

### Notifications (`aura.emit`)

| Name | Params |
| --- | --- |
| `reviews.changed` | `{}`: the inbox or a draft changed; ask `pulls.list` again |
| `pulls.activity` | `{changes: PullChange[]}`: what one refresh found (only the new events, with the inbox entry's id) |
| `pulls.changes.changed` | `{}`: `pulls.changes` changed |
| `watches.changed` | `{}` |
| `watches.review` | `{watch: PrWatch, review: WatchedReview}` |
| `follows.activity` | `{pr: {repo, number, title, url}, items: Activity[], session: {id, title} \| null}` |
| `follows.started` | `{session: {id, title}, prs: [{repo, number, title, url}]}` |
| `follows.handled` | `{session: {id, title}, prs, status: completed \| interrupted \| failed \| stopped, reply}` |

Aura's inbox (`aura.inbox.set`) gets one item per unread `PullChange` of the signed-in
account: `{id, title: "owner/repo#n title", detail: shown events, at: created_at, unread: true,
data: PullChange}`. Kinds listed in the `pullChangesMuted` setting are left out (an entry with
nothing else is not shown) but stay in `pulls.changes`.

### Orchestrator tools

`list_pull_requests`, `read_pull_review`, `create_review`, `update_review`,
`add_review_comment`, `edit_review_comment`, `delete_review_comment`, `discard_review`,
`start_pre_review`, `hide_pull_request` (offered as `pull-requests_<name>`), with the former
descriptions and input schemas. Each calls its `orchestrator.reviews.*` method for the
calling session and answers in text.

### Storage (same names and JSON as the Rust daemon, for the data migration)

| Kind | Name | Holds |
| --- | --- | --- |
| collection | `reviews` | `PreReview` by id |
| collection | `hidden:<account>` | `true`/`false` by PR id |
| collection | `details:<account>` | the `pulls.get` result by PR id |
| collection | `pull-changes:<account>` | `PullChange` by id |
| collection | `pr-watches` | `PrWatch` by id (`owner/repo#n`, lowercase) |
| collection | `pr-follows` | where follow-ups stand on a PR, by id |
| collection | `pr-follow-pending` | activity waiting for a session, by session id |
| kv | `reviews.inbox` | the `ReviewInbox` without drafts |
| kv | `pulls.snapshots.v1.<account>` | what the last refresh saw of each PR |
| session data | `branchPull` | the PR found for a worktree session's branch (looked up once) |
| files | `<dataDir>/mirrors/<account>/<owner>/<repo>.git`, `<dataDir>/workspaces/review-<id>` | partial mirrors and pre-review worktrees |

### What it uses

* GitHub through `@aura/github-client` over the `github` mod's transport (`remoteGithub`).
* From the `github` mod: `sessions.prs`, `session.followsReviews`, `pulls.record`.
* `aura.agents.runOnce` (read-only, with the review schema) for pre-reviews; `gh repo clone`
  and git for mirrors and worktrees; `aura.sessions.send(..., {whenFree: true})` for
  follow-ups; core events `turn_started`, `turn_completed`, `process_exited`,
  `approval_resolved`, `user_input_resolved`.
* Loops: the inbox refresh every 60 s (doubling to 15 min while it fails), watches and
  follow-ups every 60 s, all paced by `gh.pace`; at most two pre-reviews at once. The
  deactivate function stops them.

Daemon tests (`src/daemon/*.test.ts`, ported from the Rust tests) run on `createTestHost`
with stand-ins for the client's functions (`src/daemon/testing.ts`).

Tests: `pnpm --filter @aura-mods/pull-requests test`. UI tests run under jsdom and render
with Aura's own components (`src/ui/test/host.ts` stands in for `@aura/host`) and a fake
`ctx` (`src/ui/test/ctx.ts`).
