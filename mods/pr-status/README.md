# PR status

A card per pull request in the Inspector: the PRs the selected session and all its
workers work on, with their state, reviewers, checks and whether they can be merged.
Read-only on GitHub. Depends on the `github` mod (token, rate limits, session links).

## Layout (Inspector section `status`, order -10: above "Issues & PRs")
```
Pull requests                         updated 12s ago  [↻]
┌ [Open] Add rate limiting ↗                          ┐
│ acme/api #42 · from Worker: API limits              │
│ ● Not ready: Checks failing · Required reviews       │
│ ▸ ✗ Checks failing · 1 failing, 1 pending, 7 passed │  (expands: failing + pending, linked)
│ Reviewed       (A) alice   Approved                  │
│ Still to review (B) bob     Pending                  │
│                 (T) acme/core Pending (team)         │
└──────────────────────────────────────────────────────┘
```

The section is hidden while the session tree has no PRs. States: chip Draft / Open /
Merged / Closed; readiness "Ready to merge" or "Not ready: <reasons>" (open PRs only);
checks passing / failing / pending / none. Every colour comes with its text label.
GitHub blocked (`api.blocked`): one inline reason, the cards stay, dated.

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
`refresh`. Unseen data is forgotten after 10 min. Nothing is read while `api.blocked`.
