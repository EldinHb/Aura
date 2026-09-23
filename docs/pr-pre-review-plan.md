# PR inbox and pre-review implementation plan

Status: implemented in the working tree. Deterministic backend, frontend, and browser validation covers the workflow. Live agent execution and posting to a real GitHub PR remain an optional smoke test requiring a designated test PR. See README.md for setup and behavior.

Prepared from the local Aura and `../Gitbuddy` source trees on 2026-09-22. Existing uncommitted Aura changes must be preserved during implementation.

## 1. Outcome and source of truth

Show pull requests awaiting my review beneath my sessions. Let me hide and restore them. Open a PR inside Aura's main content area. Let me configure an AI pre-review before starting it, edit the resulting review in Gitbuddy's diff/editor layout, and explicitly submit it to GitHub as myself.

Use Gitbuddy's actual implementation as the reference for behavior and information hierarchy, with Aura's colors, typography, spacing, controls, focus handling, and keyboard commands.

**Source discrepancy:** this Gitbuddy checkout does not contain a standalone embedded PR detail page. `PullInboxView.tsx` opens PR rows on github.com. `ItemDetail.tsx` is a project-item modal that can display PR metadata; `ReviewEditor.tsx` is the embedded pre-review page. The proposed Aura detail page combines those surfaces. If another Gitbuddy version is the intended reference, inspect it before implementing the detail UI. This assumption does not affect the rest of the plan.

Reference implementation map:

| Behavior | Gitbuddy source under `src/` |
|---|---|
| Review-request inbox, badges, rerun entry points | `renderer/features/pulls/PullInboxView.tsx`, `main/github/sync/pulls.ts` |
| Description, comments, metadata edits | `renderer/features/issues/ItemDetail.tsx`, `main/github/items.ts` |
| Results, progress, comment edits, submission preview | `renderer/features/prereview/ReviewEditor.tsx` |
| Diff rendering and linked finding navigation | `renderer/features/prereview/DiffViewer.tsx`, `badges.tsx` |
| Queue, lifecycle, posting | `main/prereview/service.ts`, `store.ts` |
| Checkout, prompt, output schema, position validation | `main/ai/workspace.ts`, `prompt.ts`, `schema.ts`, `validate.ts`, `diff.ts`, `runner.ts` |

## 2. User experience

### Sidebar and navigation

- Add a **Needs your review** section below the session list, with count, refresh, collapse, and review-status badges.
- Use Gitbuddy's direct review-request semantics: `is:pr is:open archived:false review-requested:@me`. PR assignees and requested reviewers are different; this is the latter. Authored PRs and team-only review requests are outside the initial inbox scope.
- Show title, repository/number, author, draft status, checks/review decision, and pre-review status compactly. Preserve session grouping and session-number shortcuts.
- Provide **Hide PR**, **Show hidden**, and **Restore**. Persist hiding per GitHub host/account/PR until explicitly restored; new commits do not silently unhide a PR. Hiding does not cancel or delete a review.
- Also allow the entire section to collapse or be hidden, with a discoverable command/settings action to restore it.
- Keep the section accessible with many sessions, using bounded scroll areas. Keyboard navigation reaches both sessions and PRs.
- Clicking a PR replaces the central transcript/composer or terminal presentation with the PR workspace. Selecting a session restores its draft, transcript position, and normal inspector. Switching views must not stop running session processes.
- In PR mode, suppress the session inspector and session-only commands; the PR page owns its metadata/editor panel. Detached single-session windows retain their existing behavior.
- Include **Review history** access from the section so saved results remain reachable after a PR closes or no longer requests my review.

### Embedded PR detail

- Header: title, repository/number, author, timestamps, state/draft, base/head branches, checks, review decision, change counts, refresh, and **Open on GitHub**.
- Overview: Markdown description, conversation comments, assignees, labels, milestone, and associated project fields where present and accessible.
- Carry over applicable Gitbuddy item edits: title, description, assignees, labels, milestone, project fields, and adding a conversation comment. Respect per-field permissions/capabilities and refresh after writes. Issue-only actions must not appear on PRs.
- Files view: current PR diff and file list, available before running an AI review. Distinguish it from a historical review's frozen diff.
- Show existing review summaries/threads as part of PR context; paginate comments, threads, files, and project associations rather than presenting a partial response as complete.
- Primary action: **Pre-review**, **Open pre-review**, or **Pre-review again**, reflecting the latest run and whether the PR changed.
- This is an embedded adaptation of Gitbuddy's available features, not a promise to reproduce every github.com action. Merge controls, check reruns, and a full project-board UI are separate work.

### Pre-review settings modal

Every start, retry, and rerun opens this modal. Opening a PR or this modal never creates a job or starts an agent.

| Control | Proposed behavior |
|---|---|
| Provider | Available Aura review-capable providers; initially Claude Code and Codex |
| Model | Provider model list; retain supported custom model entry where applicable |
| Effort | Choices supported by the selected provider/model, including provider default |
| Prompt mode | **Use default**, **Add to default**, **Replace default** |
| Prompt editor | Optional extra instructions in Add mode; required instructions in Replace mode |
| Prompt preview | Show the effective review instructions; disclose runtime PR/diff context |
| Actions | **Cancel** and **Start pre-review** |

“Replace” replaces the review instructions, not the required PR context, result schema, or read-only execution policy. Those remain enforced separately so the result editor always receives the expected data. This definition deliberately makes the user's per-run control clearer than Gitbuddy's global prompt/system-prompt settings.

Default to the last successfully confirmed configuration, stored separately from chat settings. Switching provider/model resets incompatible effort choices. Save the resolved configuration and prompt version with the job so later settings edits cannot change an already queued run.

Cancel, Escape, and closing the modal have no execution side effects. Disable Start for missing providers, invalid options, empty replacement instructions, or unavailable PR context. Deduplicate repeated Start clicks in the backend as well as the UI.

### Progress and results

- Match Gitbuddy's progress phases: preparing, fetching the branch, agent reviewing, validating findings. Show bounded output tail, elapsed time, cancel, and useful failure details.
- Work continues in the daemon when the user switches sessions or closes the window. Reopening the page restores the current snapshot and progress.
- Match the result layout: diff on the left, editable summary/verdict/risk and findings on the right, submission actions at the bottom. Stack panes or provide a pane switcher at narrow widths.
- Preserve collapsed files, additions/deletions and old/new line numbers, inline finding markers, two-way finding/diff navigation, and adding comments from a diff line.
- Preserve verdicts (approve/comment/request changes), risk, confidence display, severity, context mode, model/run metadata, edited/user-authored indicators, position warnings, private rationale, delete/restore, and discard.
- Autosave edits with visible saving/error state. Flush and await outstanding saves before preview/submission or navigation that would lose them. Keep unsaved text recoverable after a transient connection failure.
- A rerun opens settings and creates a new attempt, retaining previous results and edits. This is an intentional improvement over Gitbuddy's in-place retry behavior.
- Submitted attempts become read-only and retain the GitHub review link. Keep their original diff available.

### Submit to GitHub

1. Flush edits, refresh PR state, and validate all retained comment positions against the reviewed diff.
2. Open Gitbuddy-style preview: target PR/account, event, final body, inline comments, and a warning if the head changed.
3. Post only when the user explicitly confirms **Post approval**, **Post comment**, or **Post changes requested**.
4. Use the reviewed commit SHA. Exclude deleted comments and private rationale; include unanchorable retained findings in the review body using Gitbuddy's Additional notes format.
5. Record the returned review ID/URL and refresh the inbox/PR state.

Preserve Gitbuddy's stale-review behavior: warn, offer rerun, and permit an explicit submission against the reviewed commit when GitHub allows it. Recheck at submission; if the preview's relevant state changed, refresh the preview before sending. Never silently move findings onto a new revision.

Serialize submissions for each attempt. A timeout after a possible successful POST must enter an uncertain state and reconcile with GitHub before retrying, preventing accidental duplicate reviews. GitHub validation or permission errors keep the local draft intact.

## 3. Architecture

Keep the existing React → authenticated WebSocket RPC → Rust daemon architecture. Port Gitbuddy's domain behavior; do not embed its Electron main process or add a second Node service.

| Area | Planned changes |
|---|---|
| `crates/aura-core` | PR/review DTOs, run configuration, progress/lifecycle events, review store/provider contracts |
| New `crates/aura-github` | Account/auth abstraction, PR queries/detail edits, pagination, polling, GitHub submission |
| New `crates/aura-review` | Persistent job orchestration, prompt/schema, workspace lifecycle, diff validation, preview assembly |
| `crates/aura-store` | Additive migrations and storage for inbox cache, hidden preferences, attempts, comments, submissions |
| `crates/aura-git` | Reusable isolated mirror/worktree and revision-pinned diff operations |
| Provider crates | Typed review execution with structured output, read-only policy, model/effort, progress, cancellation |
| `crates/aurad`, `crates/aura-rpc` | Service wiring, background synchronization, RPC methods/events and reconnect snapshots |
| `apps/desktop/src` | PR state, sidebar section, PR workspace, start modal, editor, preview, commands, Aura styles |

Generate TypeScript DTOs through Aura's existing export script. Keep GitHub credentials and network writes in the daemon. Preserve existing session/event contracts; introduce separate review events rather than pretending every PR is a chat session.

**Authentication default:** use the installed GitHub CLI's authenticated account through a daemon-owned `gh api` adapter for the initial implementation, with clear connection status/setup instructions in Aura. This avoids borrowing Gitbuddy credentials or requiring an OAuth application just to run the feature. This is a proposed setup difference, not something Aura already supports. Keep the transport behind an interface so Gitbuddy-style device login plus OS credential storage can be added if desired. Account changes must partition cached data and disable posting an old account's draft under another account without an explicit switch.

**Provider execution:** reuse provider detection/model discovery and common process/event handling. Add a dedicated bounded review operation returning validated structured output; the current generic chat `Driver` contract is insufficient by itself. Adapt Gitbuddy's schema-constrained CLI invocation when the current provider protocol does not expose equivalent output controls. Do not parse arbitrary chat transcript text as a successful review or inherit permissive chat-session permissions.

**Persistence:** store account/host identity, stable PR identity and metadata snapshot, inbox membership separately from historical data, per-PR hidden state, attempt status/configuration, base/head/merge-base SHAs, frozen diff, context/fallback note, summary/verdict/risk/confidence, comments and edit state, bounded diagnostics, and submission receipt/uncertain state. Use draft revisions to reject conflicting edits from multiple windows and bind previews to an exact saved draft.

Proposed RPC families: `github.status`; `pulls.list/get/refresh/hide/restore/update/addComment`; `reviews.list/get/start/cancel/discard/diff/updateHeader/addComment/updateComment/deleteComment/restoreComment/preview/submit`. Retry uses `reviews.start` with previous settings after modal confirmation. Publish inbox, PR, review, progress, and connection changes; reconnect reloads authoritative snapshots rather than depending on missed events.

## 4. Execution correctness

- All runs are manual. Do not carry over Gitbuddy's automatic review-on-request scheduler.
- Cache and refresh the inbox on startup, periodically, on demand, and after relevant writes. Honor rate limits/backoff and show last-sync/error state. A failed or partial sync must not clear the inbox.
- Capture immutable head/base revision data when preparing a job. Fetch fork PR refs into an isolated workspace; never check out a PR over a user's session worktree.
- Run read-only with no GitHub write credentials or posting tools available to the reviewing agent. Treat PR text and repository instructions as review input. Use argv-based process execution and restrict checkout operations to service-owned paths.
- Match Gitbuddy's diff-only fallback with a visible reason when a checkout cannot be prepared. Distinguish unsupported/no-text changes and truncated context from a clean review; never label missing analysis as approval.
- Validate schema and comment positions, including renamed/deleted files, LEFT/RIGHT sides, ranges, and binary files. Preserve Gitbuddy's relocation notices and body fallback; ambiguous file matches must remain unanchored.
- Persist the exact reviewed diff before execution. Never replace a missing historical artifact with the latest PR diff under old findings.
- Use a bounded queue, timeout, and cancellation throughout fetch/agent/validation. A cancelled or discarded attempt cannot become ready due to a late completion callback.
- Recover queued jobs after daemon restart; mark interrupted running jobs explicitly and offer retry through settings. Clean up worktrees on every terminal path while retaining artifacts needed by saved reviews.
- Inbox refresh/removal, hiding, account switching, and PR closure must not cascade-delete review history. This preserves the scenario covered by Gitbuddy's store regression tests.

## 5. Delivery sequence and acceptance gates

1. **Contracts, storage, GitHub access.** Add DTOs/migrations, account status, inbox/detail transport, cache and polling. Gate: fixture-backed paginated inbox/detail reads survive restart and failed sync; hidden/history records remain intact.
2. **Sidebar and PR workspace.** Add mixed navigation, hide/restore, overview/files, applicable metadata edits, and history entry. Gate: a PR opens centrally, all controls are keyboard-reachable, and switching back restores session state without interrupting it.
3. **Settings and provider contract.** Build the modal and immutable run configuration, then provider review capability. Gate: every entry point opens settings; cancellation starts nothing; selected prompt/model/effort reach the confirmed job exactly.
4. **Review runner.** Add isolated checkout, diff snapshot, schema/position validation, persistent queue, progress, cancel, timeout, restart recovery. Gate: mocked providers exercise success, malformed output, failure, cancellation, fork checkout, and diff-only fallback.
5. **Gitbuddy result editor in Aura.** Port the pane layout and all editing/navigation states, autosave, historical attempts, and responsive styling. Gate: side-by-side behavior checklist against Gitbuddy; no lost edits on navigation or reconnect.
6. **Preview, posting, and final verification.** Add revision-bound preview, stale warning, explicit post, receipt and uncertain-request reconciliation. Gate: mocked requests prove exact payload and no duplicate/post-without-confirmation path; one authorized test-PR smoke run verifies actual posting during implementation validation.

Stages are implementation checkpoints, not reductions of the requested scope. Complete all six before calling the feature finished.

## 6. Validation and definition of done

- Rust unit/integration tests: migrations, account separation, inbox reconciliation, queue deduplication and cancellation races, prompt composition, immutable settings, structured output, frozen revisions, position mapping, payload construction, and restart/submission recovery.
- Frontend tests: hide/restore/collapse, PR/session selection, session-command guards, all start/retry paths, provider/model/effort validation, autosave-before-preview, finding navigation/delete/restore, error recovery, and explicit submission.
- Playwright flows with mocked GitHub/provider services: inbox → PR → settings → progress → edit → preview → submitted; cancellation at settings; hide/restart/restore; switch back to a session with an unsent draft; PR head changes; offline/reconnect; light/dark and narrow layouts; keyboard-only operation.
- Reuse Gitbuddy's meaningful schema/diff/store/tuning fixtures, porting them to the owning Aura layer. Do not copy implementation-specific tests blindly.
- Run `cargo test --workspace`, desktop `pnpm test`, `pnpm lint`, `pnpm build`, and relevant `pnpm e2e` flows; regenerate/check exported types. Live provider/GitHub validation is separate from deterministic CI and uses a designated test PR.
- Confirm that installed app packaging includes the new daemon functionality and communicates the GitHub CLI prerequisite.
- Finish with a feature-level checklist matching every user interaction above, test results, and any remaining limitations. No Gitbuddy source modifications are needed.

## 7. Instruction for a future implementation turn

> Implement `docs/pr-pre-review-plan.md` in full. Use the local `../Gitbuddy` checkout as the behavioral reference, resolving the documented PR-detail reference assumption first if I supply a different version. Follow the six delivery stages, preserve existing uncommitted Aura changes, use Aura's styling and keyboard conventions, and keep all review starts behind the settings modal and all GitHub review submissions behind the exact-payload preview. Complete the tests and report the final behavior and validation results.

## 8. Implementation and validation notes

The implementation uses `aura-github` for GitHub transport, `aura-review` for job
orchestration and schema-constrained CLI execution, and `aura-git::review` for
shared partial mirrors and isolated worktrees. Model discovery still comes from
Aura's existing providers. Review execution is deliberately a separate runner
contract rather than an extension of the interactive chat driver.

An additive `feature_records` SQLite migration stores account-scoped PR details,
hiding preferences, and independent review documents. Review edits use a single
revision-checked `reviews.save` RPC; the proposed per-field mutation endpoints
were consolidated so autosave and preview operate on an atomic draft revision.

Validated: 112 Rust tests passed (3 existing tests ignored), 92 frontend tests
passed, all 6 browser tests passed, frontend lint and production build passed,
and TypeScript contracts were regenerated. PR browser scenarios mock GitHub and
providers; existing keyboard and terminal scenarios ran against an isolated
local daemon with GitHub disabled. Dark/light and narrow-window rendering were
inspected. Desktop sidecars were rebuilt with the new daemon functionality.

No real GitHub review was posted and no live AI review was run. A live smoke test
still needs a designated disposable PR and authorization to post there. Setup
requires `gh auth login` and a current installed Claude Code or Codex CLI; see
README.md. Existing unrelated working-tree changes were preserved.
