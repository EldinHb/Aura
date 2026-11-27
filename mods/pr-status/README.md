# PR status

A card per pull request in the Inspector (the selected session's and all its workers'),
with state, reviewers, checks and merge readiness; its title opens a GitHub-style PR page
in a main-area tab (`pr` view: conversation, commits, checks, files; `page.*` RPCs).
Its one write: "Squash and merge" on approved PRs (`merge` RPC: `PUT …/merge` with the shown
head `sha`; then the head branch is deleted if asked and in the same repository). Depends
on the `github` mod (token, rate limits, session links); writes go through its transport.

## Layout (Inspector section `status`, order -10: above "Issues & PRs")
```
Pull requests                     updated 12s ago  [↻]
┌ [Open] Add rate limiting to the public API,       ┐  title: 2 lines, then …
│        per plan and per key…                      │
│ acme/api #42                                      │
│ from this session + 3 workers                     │  (unfolds to the sessions)
│ ● Not ready: Checks failing · Required reviews    │
│ ▸ ● Checks failing · 1 failing · 7 passing        │  (unfolds: failing + pending)
│ Reviewed         (A) alice Approved               │  reviewer chips wrap
│ Still to review  (B) bob Pending  (T) acme/core … │
└───────────────────────────────────────────────────┘
▸ Merged & closed (6)                                  folded; a row each: chip, title, #n
```
Hidden without PRs. Open PRs first: not ready, ready, drafts. Chips: Material 3 containers;
status words --md-success/-tertiary/-error; classes `prs-`. Blocked: a reason, cards dated.
## Data
- PRs: the session plus every session whose `orchestrator_id` chain leads to it. Per
  session: github `sessions.prs` (chosen `links.prs`, else `detected`), `links.all` →
  `pulls`, and `branch_pull` of its branch (`git.branchStatus` + github `repo`).
  Deduplicated by URL; each card lists the sessions it came from.
- Status: one batched GraphQL query (`batchNodes`, 20 PRs each), then the pages left of the
  checks and reviews (up to 10 each; beyond that GitHub's rollup state is used and the
  reviewer list is marked incomplete). Branch PRs come from a paced queue, 2 a round.
## Polling (daemon half)
The UI half `watch`es the shown session (a 90 s lease, renewed every 30 s). A 5 s tick
reads watched PRs that are due: every 60 s, 20 s while checks run or mergeability is
unknown, 15 min once closed, never once merged; at least `api.pace`, and after failures
a doubling back-off up to 15 min. Once per new `api.notified` entry, on `watch` and on
`refresh`. Nothing is read while `api.blocked`. Sessions open in tabs keep a background
watch: kept, not polled; their cards show at once on switching back, then refresh.
