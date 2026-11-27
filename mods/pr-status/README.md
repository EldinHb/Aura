# PR status

A card per pull request in the Inspector (the selected session's and all its workers'),
with state, reviewers, checks and merge readiness; its title opens a GitHub-style PR page
in a main-area tab (`pr` view: conversation, commits, checks, files; `page.*` RPCs).
Self-contained: GitHub through the GitHub CLI (`gh api -i`, `gh pr list`) and git, run with
`aura.process` (permissions `process: [gh, git]`, `sessions: read`). Its one write: "Squash
and merge" on approved PRs (`PUT …/merge` with the shown head `sha`, after checking gh's login).

## Layout (Inspector section `status`, order -10: above "Issues & PRs")
```
Pull requests          updated 12s ago  [Link PR…] [↻]
┌ [Open] Add rate limiting to the public API,       ┐  title: 2 lines, then …
│        per plan and per key…                      │
│ acme/api #42                               Unlink │
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
  session: PR URLs in its transcript (`item_completed`), the user's links (minus unlinked),
  and its branch's PR (`git status`, `git remote -v`, `gh pr list --head`). Kept in the mod's
  storage (sessions, branches, last statuses ≤300): instant cards after a restart.
- Status: one batched GraphQL query (`batchNodes`, 20 PRs each), then the pages left of the
  checks and reviews (up to 10 each; beyond that GitHub's rollup state is used and the
  reviewer list is marked incomplete). Branch PRs come from a paced queue, 2 a round.
## Polling (daemon half)
The UI half `watch`es the shown session (a 90 s lease, renewed every 30 s). A 5 s tick
reads watched PRs that are due: every 60 s, 20 s while checks run or mergeability is
unknown, 15 min once closed, never once merged; paced by the X-RateLimit headers, doubling
back-off after failures. Notifications (`gh api notifications`, If-Modified-Since, ≤1/min,
only with PRs shown). gh missing, signed out or expired: a reason. Sessions open in tabs keep a background
watch: kept, not polled; their cards show at once on switching back, then refresh.
