import { create } from "zustand";
import type { PullRequest, PreReview, ReviewInbox, ReviewResult } from "../../gen";
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
type ReviewState = {
  inbox: ReviewInbox | null; error: string | null; busy: boolean; reviewId: string | null;
  collapsed: boolean; mineCollapsed: boolean; hidden: boolean; showHidden: boolean;
  setPreference: (key: "collapsed" | "mineCollapsed" | "hidden" | "showHidden", value: boolean) => void;
  refresh: (remote?: boolean) => Promise<void>;
};
export const useReviews = create<ReviewState>((set) => ({
  inbox: null, error: null, busy: false, reviewId: null,
  collapsed: pref("collapsed"), mineCollapsed: pref("mineCollapsed"), hidden: pref("hidden"), showHidden: pref("showHidden"),
  setPreference: (key, value) => { localStorage.setItem(`aura.reviews.${key}`, String(value)); set({ [key]: value }); },
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
/** PRs listed in the sidebar, in display order: review requests, then your own. */
export function visiblePulls(s: ReviewState, rules = useStore.getState().settings.pullFilters) {
  const shown = (pulls: PullRequest[] | undefined, collapsed: boolean) => s.hidden || collapsed ? [] : (pulls ?? []).filter((p) => s.showHidden || !isPullHidden(p, rules));
  return { review: shown(s.inbox?.pulls, s.collapsed), mine: shown(s.inbox?.mine, s.mineCollapsed) };
}
/** Draft, check and review state as short labels; `tone` marks the ones that need attention or are done. */
export function pullStatus(pull: PullRequest): { label: string; tone?: "ok" | "err" }[] {
  const checks = ({ SUCCESS: { label: "checks pass", tone: "ok" }, FAILURE: { label: "checks fail", tone: "err" }, ERROR: { label: "checks fail", tone: "err" }, PENDING: { label: "checks running" }, EXPECTED: { label: "checks running" } } as const)[pull.checks as "SUCCESS"];
  const review = ({ APPROVED: { label: "approved", tone: "ok" }, CHANGES_REQUESTED: { label: "changes requested", tone: "err" }, REVIEW_REQUIRED: { label: "review required" } } as const)[pull.review_decision as "APPROVED"];
  return [...(pull.draft ? [{ label: "draft" }] : []), checks ?? { label: "no checks" }, ...(review ? [review] : [])];
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
    { id: "reviews.hide", title: "Hide / restore selected pull request", group: "Pull requests", run: async () => { const p = useStore.getState().prSelection; if (p) { const inbox = useReviews.getState().inbox; await hidePull(p, ![...(inbox?.pulls ?? []), ...(inbox?.mine ?? [])].find((x) => x.id === p.id)?.hidden); } } },
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
