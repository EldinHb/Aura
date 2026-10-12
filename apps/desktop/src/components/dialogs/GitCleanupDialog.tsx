import { useEffect, useMemo, useState } from "react";
import type { CleanupReport, ProviderKind } from "../../gen";
import { Modal } from "../Modal";
import { useStore } from "../../state/store";

type Repo = { root: string; github: string | null };

/** First message of the agent session that cleans up a repository. */
export const CLEANUP_PROMPT = `Clean up this local git repository. Work carefully and show me what you plan to remove before removing it.

1. Run \`git fetch --all --prune\` so deleted remote branches are known.
2. List local branches whose upstream is gone or that are fully merged into the default branch. Squash and rebase merges rewrite commits, so also check whether a gone branch's pull request was merged (for example with \`gh pr list --state merged --head <branch>\`).
3. List worktrees whose directory no longer exists, and stashes older than a month.
4. Delete the branches that are clearly finished and run \`git worktree prune\`. Ask me first about anything with work that is not on a remote or not merged, and about stashes.

Never touch the current branch, the default branch, a branch checked out in another worktree, or uncommitted changes. Finish with a short summary of what you removed and what you left.`;

const name = (r: Repo) => r.github ?? r.root.split("/").filter(Boolean).pop() ?? r.root;

/** Lists stale local branches of a repository and deletes the selected ones, or hands the job to an agent. */
export function GitCleanupDialog({ cwd, repo }: { cwd?: string; repo?: string }) {
  const client = useStore((s) => s.client);
  const sessions = useStore((s) => s.sessions);
  const close = useStore((s) => s.closeDialog);
  const toast = useStore((s) => s.toast);
  const provider = useStore((s) => s.settings.defaultProvider);
  const [repos, setRepos] = useState<Repo[] | null>(null);
  const [root, setRoot] = useState("");
  const [report, setReport] = useState<CleanupReport | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [prune, setPrune] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // The repositories Aura knows are the ones sessions run in.
  const cwds = useMemo(() => [...new Set([cwd, ...Object.values(sessions).map((s) => s.cwd)].filter((c): c is string => !!c))], [cwd, sessions]);
  useEffect(() => {
    if (!client) return;
    let active = true;
    void Promise.all(cwds.map(async (c) => {
      const root = await client.gitMainRepoRoot(c).catch(() => null);
      return root ? { root, cwd: c, github: await client.gitGithubRepo(root).catch(() => null) } : null;
    })).then((found) => {
      if (!active) return;
      const list: Repo[] = [];
      for (const f of found) if (f && !list.some((r) => r.root === f.root)) list.push({ root: f.root, github: f.github });
      list.sort((a, b) => name(a).localeCompare(name(b)));
      setRepos(list);
      const start = found.find((f) => f && cwd && f.cwd === cwd)?.root
        ?? list.find((r) => repo && r.github?.toLowerCase() === repo.toLowerCase())?.root
        ?? list[0]?.root ?? "";
      setRoot(start);
    });
    return () => { active = false; };
  }, [client, cwds, cwd, repo]);

  useEffect(() => {
    if (!client || !root) return;
    let active = true;
    setReport(null);
    setError("");
    client.gitCleanupCandidates(root).then((r) => {
      if (!active) return;
      setReport(r);
      setPicked(r.branches.map((b) => b.name));
    }).catch((e) => { if (active) setError(String(e)); });
    return () => { active = false; };
  }, [client, root]);

  const toggle = (branch: string) => setPicked((cur) => cur.includes(branch) ? cur.filter((b) => b !== branch) : [...cur, branch]);
  const pruning = prune && !!report?.prunable_worktrees.length;
  const clean = async () => {
    if (!client || !report || busy || (!picked.length && !pruning)) return;
    setBusy(true);
    setError("");
    try {
      const result = await client.gitCleanup(report.root, picked, pruning);
      const done = [result.deleted.length && `Deleted ${result.deleted.length} branch${result.deleted.length === 1 ? "" : "es"}`, result.pruned_worktrees && `pruned ${result.pruned_worktrees} worktree${result.pruned_worktrees === 1 ? "" : "s"}`].filter(Boolean).join(", ");
      if (result.failed.length) {
        setError(result.failed.map(([b, why]) => `${b}: ${why}`).join("\n"));
        setReport(await client.gitCleanupCandidates(report.root, false));
        setPicked([]);
        if (done) toast(done);
      } else {
        toast(done || "Nothing to clean up");
        close();
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  const delegate = async () => {
    if (!client || !root || busy) return;
    setBusy(true);
    try {
      const target = repos?.find((r) => r.root === root);
      // Terminal and ACP sessions cannot take a first prompt without more setup.
      const agent: ProviderKind = provider === "codex" ? "codex" : "claude";
      const s = await client.createSession({ provider: agent, cwd: root, title: `Clean up ${target ? name(target) : root}`, initial_prompt: CLEANUP_PROMPT });
      useStore.getState().select(s.id);
      close();
      useStore.getState().setFocus("main");
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };

  return (
    <Modal title="Clean up local branches" width={620} onClose={busy ? () => {} : close} onSubmit={() => void clean()}
      footer={<>
        <button type="button" className="btn" data-command="dialog.cancel" disabled={busy} onClick={close}>Cancel</button>
        <button type="button" className="btn" data-command="git-cleanup.agent" disabled={busy || !root} title="Start a session that inspects the repository and cleans it up with you" onClick={() => void delegate()}>Let an agent clean up</button>
        <button type="button" className="btn danger" data-command="dialog.confirm" disabled={busy || !report || (!picked.length && !pruning)} onClick={() => void clean()}>
          {busy ? "Working…" : `Delete ${picked.length} branch${picked.length === 1 ? "" : "es"}${pruning ? " and prune" : ""}`} <kbd>⌘↩</kbd>
        </button>
      </>}>
      <div className="field">
        <label htmlFor="cleanup-repo">Repository</label>
        <select id="cleanup-repo" value={root} disabled={busy || !repos?.length} onChange={(e) => setRoot(e.target.value)}>
          {repos?.map((r) => <option key={r.root} value={r.root}>{name(r)} · {r.root}</option>)}
        </select>
      </div>
      {repos && !repos.length && <p className="dim">No session runs in a git repository yet.</p>}
      {root && !report && !error && <p className="dim" role="status">Fetching and looking for stale branches…</p>}
      {report && <>
        {report.fetch_error && <p className="dim">Could not fetch, so recently deleted remote branches may be missing: {report.fetch_error}</p>}
        <p className="dim">Branches whose remote branch was deleted, as happens when a pull request is merged, or that are fully merged into {report.base ?? "the default branch"}. The current branch, the default branch and branches checked out in a worktree are never listed.</p>
        <div className="watch-people" role="group" aria-label="Stale branches">
          {report.branches.map((b) => (
            <label key={b.name} className="watch-person" title={`${b.subject}\n${new Date(b.date).toLocaleString()}`}>
              <input type="checkbox" checked={picked.includes(b.name)} onChange={() => toggle(b.name)} />
              <span className="grow">{b.name}</span>
              <span className="chip">{b.reason === "gone" ? "remote deleted" : "merged"}</span>
              {b.reason === "gone" && b.unmerged > 0 && <span className="chip" title="Expected after a squash or rebase merge. Otherwise this is work that exists only here.">{b.unmerged} commit{b.unmerged === 1 ? "" : "s"} not in {report.base ?? "base"}</span>}
            </label>
          ))}
          {report.branches.length === 0 && <p className="dim">No stale branches.</p>}
        </div>
        {report.prunable_worktrees.length > 0 && (
          <label className="watch-person">
            <input type="checkbox" checked={prune} onChange={(e) => setPrune(e.target.checked)} />
            <span className="grow">Prune {report.prunable_worktrees.length} worktree{report.prunable_worktrees.length === 1 ? "" : "s"} whose folder is gone</span>
          </label>
        )}
      </>}
      {error && <p role="alert" className="err-text" style={{ whiteSpace: "pre-wrap" }}>{error}</p>}
    </Modal>
  );
}
