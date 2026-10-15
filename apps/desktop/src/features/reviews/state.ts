import { create } from "zustand";
import type { PullRequest, PreReview, ReviewInbox, ReviewResult, SubmittedReview } from "../../gen";
import { useStore } from "../../state/store";
import { registerCommands } from "../../lib/commands";

export function rpc<T>(method: string, params: unknown = {}): Promise<T> {
  const client = useStore.getState().client;
  if (!client) return Promise.reject(new Error("Not connected to the daemon"));
  return client.call<T>(method, params);
}
export function report(error: unknown) { useStore.getState().toast(String(error), "error"); }
export function openPull(pull: PullRequest, reviewId: string | null = null) {
  useStore.setState({ prSelection: pull, reviewHistoryOpen: false, focus: "main" });
  useReviews.setState({ reviewId });
}
export function openHistory() { useStore.setState({ prSelection: null, reviewHistoryOpen: true, focus: "main" }); }
export function startReview(pull: PullRequest, previous?: PreReview) {
  useStore.getState().openDialog({ kind: "review-settings", pull, config: previous?.config });
}
const pref = (key: string) => { try { return localStorage.getItem(`aura.reviews.${key}`) === "true"; } catch { return false; } };
/** Groups of the sidebar list besides the two top ones, each collapsed on its own. */
export type PullGroupKey = "you-reviewed" | MineGroup;
type ReviewState = {
  inbox: ReviewInbox | null; error: string | null; busy: boolean; reviewId: string | null;
  collapsed: boolean; mineCollapsed: boolean; hidden: boolean; showHidden: boolean;
  groupsCollapsed: Partial<Record<PullGroupKey, boolean>>;
  setPreference: (key: "collapsed" | "mineCollapsed" | "hidden" | "showHidden", value: boolean) => void;
  toggleGroup: (key: PullGroupKey) => void;
  refresh: (remote?: boolean) => Promise<void>;
};
const GROUP_KEYS: PullGroupKey[] = ["you-reviewed", "respond", "ready", "waiting", "reviewed"];
export const useReviews = create<ReviewState>((set, get) => ({
  inbox: null, error: null, busy: false, reviewId: null,
  collapsed: pref("collapsed"), mineCollapsed: pref("mineCollapsed"), hidden: pref("hidden"), showHidden: pref("showHidden"),
  groupsCollapsed: Object.fromEntries(GROUP_KEYS.map((key) => [key, pref(`group.${key}`)])),
  setPreference: (key, value) => { localStorage.setItem(`aura.reviews.${key}`, String(value)); set({ [key]: value }); },
  toggleGroup: (key) => {
    const value = !get().groupsCollapsed[key];
    localStorage.setItem(`aura.reviews.group.${key}`, String(value));
    set((s) => ({ groupsCollapsed: { ...s.groupsCollapsed, [key]: value } }));
  },
  refresh: async (remote = false) => {
    if (remote) set({ busy: true });
    try {
      const inbox = await rpc<ReviewInbox>(remote ? "pulls.refresh" : "pulls.list");
      const app = useStore.getState();
      if (app.prSelection && inbox.account && app.prSelection.account !== inbox.account) {
        app.select(app.selectedId);
        if (app.dialog.kind === "review-settings" || app.dialog.kind === "review-submit") app.closeDialog();
        app.toast("GitHub account changed. Earlier reviews remain in that account's history.");
      }
      set({ inbox, error: null });
    }
    catch (e) { set({ error: String(e) }); }
    finally { if (remote) set({ busy: false }); }
  },
}));
export const PULL_FILTER_KINDS = ["author", "label", "repo", "title", "draft"] as const;
/** Why a rule line cannot be used, or undefined when it is valid. Blank lines and `#` comments are valid. */
export function pullFilterError(rule: string): string | undefined {
  const r = rule.trim();
  if (!r || r.startsWith("#") || r.toLowerCase() === "draft") return undefined;
  const [kind, ...rest] = r.split(":");
  if (!(PULL_FILTER_KINDS as readonly string[]).includes(kind.trim().toLowerCase())) return `Unknown rule "${kind.trim()}"; use ${PULL_FILTER_KINDS.map((k) => k === "draft" ? k : `${k}:`).join(", ")}`;
  if (!rest.join(":").trim()) return `"${kind.trim()}:" needs a value`;
  return undefined;
}
/** `*` matches any run of characters; everything else literally, ignoring case. */
const glob = (pattern: string, value: string) =>
  new RegExp(`^${pattern.split("*").map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`, "i").test(value);
/**
 * The first rule that hides `pull`, or undefined. Rules: `author:<login>` (a bot's
 * `[bot]` suffix is optional), `label:<name>`, `repo:<owner/name>`, `title:<text>`, and
 * `draft`. Values may use `*` wildcards, e.g. `repo:acme/*` or `title:*chore*`.
 */
export function pullFilter(pull: PullRequest, rules: string[]): string | undefined {
  const bare = (login: string) => login.replace(/\[bot\]$/i, "");
  return rules.find((rule) => {
    const r = rule.trim();
    if (pullFilterError(r) || !r || r.startsWith("#")) return false;
    if (r.toLowerCase() === "draft") return pull.draft;
    const i = r.indexOf(":");
    const kind = r.slice(0, i).trim().toLowerCase(), value = r.slice(i + 1).trim();
    if (kind === "author") return glob(bare(value), bare(pull.author));
    if (kind === "label") return pull.labels.some((l) => glob(value, l));
    if (kind === "repo") return glob(value, pull.repo);
    return glob(value, pull.title);
  })?.trim();
}
/** Hidden by hand or by a rule; such PRs are listed only with "Show hidden". */
export const isPullHidden = (pull: PullRequest, rules: string[]) => pull.hidden || !!pullFilter(pull, rules);
/** PRs listed in the sidebar, in display order: review requests and the PRs you reviewed, then your own by group. */
export function visiblePulls(s: ReviewState, rules = useStore.getState().settings.pullFilters) {
  const shown = (pulls: PullRequest[] | undefined, collapsed = false) => s.hidden || collapsed ? [] : (pulls ?? []).filter((p) => s.showHidden || !isPullHidden(p, rules));
  const requested = shown(s.inbox?.pulls, s.collapsed), reviewed = sortReviewed(shown(s.inbox?.reviewed));
  const groups = s.mineCollapsed ? [] : groupMine(shown(s.inbox?.mine));
  return {
    requested, reviewed, groups,
    review: [...requested, ...(s.groupsCollapsed["you-reviewed"] ? [] : reviewed)],
    mine: groups.flatMap((g) => s.groupsCollapsed[g.key] ? [] : g.pulls),
  };
}
/** New commits arrived since `review`. */
export const isStale = (review: Pick<SubmittedReview, "commit_sha">, headSha: string) => !!review.commit_sha && review.commit_sha !== headSha;
/** PRs you reviewed: the ones with new commits since your review first, then the latest updated. */
export const sortReviewed = (pulls: PullRequest[]) => [...pulls].sort((a, b) =>
  Number(!!b.my_review && isStale(b.my_review, b.head_sha)) - Number(!!a.my_review && isStale(a.my_review, a.head_sha)) || b.updated_at.localeCompare(a.updated_at));
export type MineGroup = "respond" | "ready" | "waiting" | "reviewed";
export const MINE_GROUPS: { key: MineGroup; title: string }[] = [
  { key: "respond", title: "Needs your response" }, { key: "ready", title: "Ready to merge" },
  { key: "waiting", title: "Waiting for review" }, { key: "reviewed", title: "Reviewed" },
];
type GroupedPull = Pick<PullRequest, "review_decision" | "reviews" | "unanswered_threads" | "head_sha" | "state" | "can_merge" | "merge_blocked_by">;
/**
 * The one group a PR of yours goes in, the first that applies: changes were requested or a
 * review thread waits on you; it can be merged; nobody (no bot) reviewed it, or there are new
 * commits since every review; else reviewed.
 */
export function mineGroup(pull: GroupedPull): MineGroup {
  if (reviewStatus(pull)?.label === "changes requested" || pull.unanswered_threads > 0) return "respond";
  if (mergeStatus(pull).length) return "ready";
  const people = pull.reviews.filter((r) => !r.bot);
  if (people.every((r) => isStale(r, pull.head_sha))) return "waiting";
  return "reviewed";
}
/** Your PRs by group in display order, the latest updated first; groups without PRs are left out. */
export function groupMine(pulls: PullRequest[]) {
  const sorted = [...pulls].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  return MINE_GROUPS.map((g) => ({ ...g, pulls: sorted.filter((p) => mineGroup(p) === g.key) })).filter((g) => g.pulls.length);
}
const MARKS: Record<string, { mark: string; verdict: string; tone?: "ok" | "err" }> = {
  CHANGES_REQUESTED: { mark: "✗", verdict: "requested changes", tone: "err" }, APPROVED: { mark: "✓", verdict: "approved", tone: "ok" }, COMMENTED: { mark: "✎", verdict: "commented" },
};
export type ReviewerEntry = { name: string; mark: string; tone?: "ok" | "err"; bot: boolean; pending: boolean; stale: boolean; describe: string };
/**
 * Who reviewed and who is asked to, for the reviewer line: people by verdict (changes requested,
 * approved, commented), then pending requests, then bots. Someone asked again keeps their verdict.
 */
export function reviewerEntries(pull: Pick<PullRequest, "reviews" | "requested" | "head_sha">): ReviewerEntry[] {
  const order = Object.keys(MARKS);
  const asked = (name: string) => pull.requested.some((r) => r.name.toLowerCase() === name.toLowerCase());
  const reviews = [...pull.reviews].sort((a, b) => Number(a.bot) - Number(b.bot) || order.indexOf(a.state) - order.indexOf(b.state)).map((r): ReviewerEntry => {
    const m = MARKS[r.state] ?? { mark: "·", verdict: r.state.toLowerCase() };
    const stale = isStale(r, pull.head_sha), pending = asked(r.reviewer);
    return { name: r.reviewer, mark: m.mark, tone: m.tone, bot: r.bot, pending, stale,
      describe: `${r.reviewer}${r.bot ? " (bot)" : ""}: ${m.verdict}${stale ? ", new commits since" : ""}${pending ? ", asked again" : ""}` };
  });
  const requests = pull.requested.filter((r) => !pull.reviews.some((v) => v.reviewer.toLowerCase() === r.name.toLowerCase())).map((r): ReviewerEntry => ({
    name: r.kind === "team" ? `@${r.name.split("/").pop()}` : r.name, mark: "…", bot: r.kind === "bot", pending: true, stale: false,
    describe: `${r.kind === "team" ? `team ${r.name}` : r.name}${r.kind === "bot" ? " (bot)" : ""}: review requested`,
  }));
  return [...reviews.filter((r) => !r.bot), ...requests.filter((r) => !r.bot), ...reviews.filter((r) => r.bot), ...requests.filter((r) => r.bot)];
}
/**
 * Where reviews stand: GitHub's decision when it made one, else what other people's latest
 * reviews say. GitHub only decides on approvals and change requests, but a comment-only
 * review counts as reviewed, as it does on GitHub. A bot's review never counts.
 */
export function reviewStatus(pull: { review_decision: string; reviews: Pick<SubmittedReview, "state" | "bot">[] }): { label: string; tone?: "ok" | "err" } | undefined {
  if (pull.review_decision === "APPROVED") return { label: "approved", tone: "ok" };
  if (pull.review_decision === "CHANGES_REQUESTED") return { label: "changes requested", tone: "err" };
  const states = pull.reviews.filter((r) => !r.bot).map((r) => r.state);
  if (states.includes("CHANGES_REQUESTED")) return { label: "changes requested", tone: "err" };
  // Without a decision nothing more is needed; with one, the approvals do not suffice yet.
  if (states.includes("APPROVED")) return pull.review_decision ? { label: "approved, review required" } : { label: "approved", tone: "ok" };
  if (states.includes("COMMENTED")) return { label: "commented" };
  return pull.review_decision === "REVIEW_REQUIRED" ? { label: "review required" } : undefined;
}
/** Draft, check and review state as short labels; `tone` marks the ones that need attention or are done. */
export function pullStatus(pull: Pick<PullRequest, "draft" | "checks" | "review_decision" | "reviews">): { label: string; tone?: "ok" | "err" }[] {
  const checks = ({ SUCCESS: { label: "checks pass", tone: "ok" }, FAILURE: { label: "checks fail", tone: "err" }, ERROR: { label: "checks fail", tone: "err" }, PENDING: { label: "checks running" }, EXPECTED: { label: "checks running" } } as const)[pull.checks as "SUCCESS"];
  const review = reviewStatus(pull);
  return [...(pull.draft ? [{ label: "draft" }] : []), checks ?? { label: "no checks" }, ...(review ? [review] : [])];
}
/** "ready to merge" for an open PR you may merge and GitHub reports nothing blocking. */
export const mergeStatus = (pull: Pick<PullRequest, "state" | "can_merge" | "merge_blocked_by">): { label: string; tone?: "ok" }[] =>
  pull.state === "open" && pull.can_merge && !pull.merge_blocked_by ? [{ label: "ready to merge", tone: "ok" }] : [];
const verdict: Record<string, string> = { APPROVED: "you approved", CHANGES_REQUESTED: "you requested changes", COMMENTED: "you commented", DISMISSED: "your review was dismissed" };
/** True when your review was requested again after your latest review was submitted. */
export const isRerequested = (pull: Pick<PullRequest, "my_review" | "review_requested_at">) =>
  !!pull.my_review && !!pull.review_requested_at && Date.parse(pull.review_requested_at) > Date.parse(pull.my_review.submitted_at);
/** Where you stand on a PR that asks for your review: asked again since you reviewed, or already reviewed. */
export function reviewRound(pull: Pick<PullRequest, "my_review" | "review_requested_at" | "head_sha">): { label: string; tone?: "new" | "ok" }[] {
  if (!pull.my_review) return [];
  if (!isRerequested(pull)) return [{ label: verdict[pull.my_review.state] ?? "you reviewed", tone: "ok" }];
  return [{ label: "re-review requested", tone: "new" }, ...(pull.my_review.commit_sha && pull.my_review.commit_sha !== pull.head_sha ? [{ label: "changed since your review" }] : [])];
}
export async function hidePull(pull: PullRequest, hidden: boolean) {
  await rpc(hidden ? "pulls.hide" : "pulls.restore", { id: pull.id, account: pull.account });
  await useReviews.getState().refresh();
}
export function registerReviewCommands() {
  return registerCommands([
    { id: "reviews.refresh", title: "Refresh pull requests", group: "Pull requests", run: () => useReviews.getState().refresh(true) },
    { id: "reviews.toggle", title: "Show / hide pull requests section", group: "Pull requests", run: () => { const s = useReviews.getState(); s.setPreference("hidden", !s.hidden); } },
    { id: "reviews.hidden", title: "Show / hide hidden pull requests", group: "Pull requests", run: () => { const s = useReviews.getState(); s.setPreference("showHidden", !s.showHidden); s.setPreference("hidden", false); s.setPreference("collapsed", false); s.setPreference("mineCollapsed", false); } },
    { id: "reviews.history", title: "Open review history", group: "Pull requests", run: openHistory },
    { id: "reviews.start", title: "Pre-review selected pull request…", group: "Pull requests", run: () => { const p = useStore.getState().prSelection; if (p) startReview(p); } },
    { id: "reviews.hide", title: "Hide / restore selected pull request", group: "Pull requests", run: async () => { const p = useStore.getState().prSelection; if (p) { const inbox = useReviews.getState().inbox; await hidePull(p, ![...(inbox?.pulls ?? []), ...(inbox?.reviewed ?? []), ...(inbox?.mine ?? [])].find((x) => x.id === p.id)?.hidden); } } },
  ]);
}

type Draft = { result: ReviewResult; revision: number; version: number; savedVersion: number; saving: boolean; error: string | null };
export const useReviewDrafts = create<{ drafts: Record<string, Draft> }>(() => ({ drafts: {} }));
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const requests = new Map<string, Promise<PreReview | undefined>>();
const draftKey = (id: string) => `aura.review-draft.${id}`;
export function ensureDraft(review: PreReview) {
  const existing = useReviewDrafts.getState().drafts[review.id];
  if (existing) {
    if (!existing.saving && existing.version === existing.savedVersion && review.revision > existing.revision) reloadDraft(review);
    return;
  }
  let draft: Draft = { result: review.result, revision: review.revision, version: 0, savedVersion: 0, saving: false, error: null };
  try { const raw = localStorage.getItem(draftKey(review.id)); if (raw && review.status === "ready") draft = { ...JSON.parse(raw), saving: false }; } catch { /* use server state */ }
  useReviewDrafts.setState((s) => ({ drafts: { ...s.drafts, [review.id]: draft } }));
}
function setDraft(id: string, draft: Draft) {
  if (draft.version !== draft.savedVersion) localStorage.setItem(draftKey(id), JSON.stringify(draft));
  else localStorage.removeItem(draftKey(id));
  useReviewDrafts.setState((s) => ({ drafts: { ...s.drafts, [id]: draft } }));
}
export function editDraft(id: string, result: ReviewResult) {
  const draft = useReviewDrafts.getState().drafts[id];
  setDraft(id, { ...draft, result, version: draft.version + 1, error: null });
  clearTimeout(timers.get(id));
  timers.set(id, setTimeout(() => { void flushDraft(id).catch(() => {}); }, 500));
}
export async function flushDraft(id: string): Promise<PreReview | undefined> {
  clearTimeout(timers.get(id));
  const inflight = requests.get(id);
  if (inflight) { await inflight; return flushDraft(id); }
  const draft = useReviewDrafts.getState().drafts[id];
  if (!draft || draft.version === draft.savedVersion) return undefined;
  const request = (async () => {
    setDraft(id, { ...draft, saving: true });
    try {
      const review = await rpc<PreReview>("reviews.save", { id, revision: draft.revision, result: draft.result });
      const current = useReviewDrafts.getState().drafts[id];
      setDraft(id, { ...current, result: current.version === draft.version ? review.result : current.result, revision: review.revision, savedVersion: draft.version, saving: false, error: null });
      return review;
    } catch (error) {
      setDraft(id, { ...useReviewDrafts.getState().drafts[id], saving: false, error: String(error) });
      throw error;
    } finally { requests.delete(id); }
  })();
  requests.set(id, request);
  const result = await request;
  const current = useReviewDrafts.getState().drafts[id];
  if (current.version !== current.savedVersion) return (await flushDraft(id)) ?? result;
  return result;
}
export function reloadDraft(review: PreReview) {
  setDraft(review.id, { result: review.result, revision: review.revision, version: 0, savedVersion: 0, saving: false, error: null });
}
