import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ModalC } from "../ModalC";
import { useStore } from "../../state/store";
import type { DiffStat, FileStatus } from "../../gen";
import { parseUnifiedDiff, type FileDiff } from "../diff/parse";
import { DiffRenderer } from "../diff/DiffRenderer";
import { CommitForm } from "./CommitDialog";
import { diffDialogIntent, registerGitCommands } from "../../commands/git";
import { basename } from "../../lib/platform";
import clsx from "clsx";

registerGitCommands();

type Base = { kind: "head" } | { kind: "staged" } | { kind: "branch"; name: string };

type Entry = { key: string; label: string; path?: string; status?: FileStatus; stat?: DiffStat; agent?: boolean };

const AGENT_KEY = "__agent_diff__";

export function DiffDialog({ sessionId, path }: { sessionId: string; path?: string }) {
  const client = useStore((s) => s.client);
  const session = useStore((s) => s.sessions[sessionId]);
  const turnDiff = useStore((s) => s.transcripts[sessionId]?.turnDiff);
  const toast = useStore((s) => s.toast);
  const cwd = session?.cwd ?? "";

  const [repoRoot, setRepoRoot] = useState<string | null | undefined>(undefined);
  const [branch, setBranch] = useState<string>("");
  const [statuses, setStatuses] = useState<FileStatus[]>([]);
  const [stats, setStats] = useState<DiffStat[]>([]);
  const [branches, setBranches] = useState<string[]>([]);
  const [base, setBase] = useState<Base>({ kind: "head" });
  const [selected, setSelected] = useState<string | null>(path ?? null);
  const [allFiles, setAllFiles] = useState(!path);
  const [diffText, setDiffText] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sideBySide, setSideBySide] = useState(false);
  const [ignoreWs, setIgnoreWs] = useState(false);
  const [pane, setPane] = useState<"files" | "diff">(diffDialogIntent.status ? "files" : "files");
  const [commitMode, setCommitMode] = useState(diffDialogIntent.commit);
  const [branchPicker, setBranchPicker] = useState(false);
  const [activeHunk, setActiveHunk] = useState(0);
  const diffRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    diffDialogIntent.commit = false;
    diffDialogIntent.status = false;
  }, []);

  const entries: Entry[] = useMemo(() => {
    const statMap = new Map(stats.map((s) => [s.path, s]));
    const list: Entry[] = statuses.map((st) => ({ key: st.path, label: st.path, path: st.path, status: st, stat: statMap.get(st.path) }));
    if (turnDiff) list.unshift({ key: AGENT_KEY, label: "Agent diff (from provider)", agent: true });
    return list;
  }, [statuses, stats, turnDiff]);

  const refresh = useCallback(async () => {
    if (!client || !cwd) return;
    setLoading(true);
    setError(null);
    try {
      const root = await client.gitRepoRoot(cwd);
      setRepoRoot(root);
      if (!root) {
        setStatuses([]);
        setStats([]);
        return;
      }
      const baseRef = base.kind === "branch" ? base.name : undefined;
      const [st, ds, br, bs] = await Promise.all([
        client.gitStatus(cwd),
        client.gitDiffStat(cwd, baseRef).catch(() => [] as DiffStat[]),
        client.gitCurrentBranch(cwd).catch(() => ""),
        client.gitBranches(cwd).catch(() => [] as string[]),
      ]);
      setStatuses(st);
      setStats(ds);
      setBranch(br);
      setBranches(bs);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [client, cwd, base]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // load diff text for the selection
  useEffect(() => {
    if (!client || !cwd || repoRoot === null) return;
    if (selected === AGENT_KEY) {
      setDiffText(turnDiff ?? "");
      return;
    }
    let cancelled = false;
    const opts: { path?: string; staged?: boolean; base?: string } = {};
    if (!allFiles && selected) opts.path = selected;
    if (base.kind === "staged") opts.staged = true;
    if (base.kind === "branch") opts.base = base.name;
    client
      .gitDiff(cwd, opts)
      .then((d) => {
        if (!cancelled) {
          setDiffText(d);
          setActiveHunk(0);
        }
      })
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
    };
  }, [client, cwd, selected, allFiles, base, repoRoot, turnDiff, statuses]);

  const files: FileDiff[] = useMemo(() => parseUnifiedDiff(diffText), [diffText]);
  const totalHunks = useMemo(() => files.reduce((n, f) => n + f.hunks.length, 0), [files]);

  useEffect(() => {
    const el = diffRef.current?.querySelector<HTMLElement>(`[data-hunk-index="${activeHunk}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [activeHunk]);

  const selectedIdx = entries.findIndex((e) => e.key === selected);

  const move = (delta: number) => {
    if (entries.length === 0) return;
    const cur = selectedIdx < 0 ? 0 : Math.max(0, Math.min(entries.length - 1, selectedIdx + delta));
    setSelected(entries[cur].key);
    setAllFiles(false);
  };

  const cycleBase = () => {
    if (base.kind === "head") setBase({ kind: "staged" });
    else if (base.kind === "staged") setBranchPicker(true);
    else setBase({ kind: "head" });
  };

  const copyDiff = async () => {
    await navigator.clipboard.writeText(diffText);
    toast(diffText ? "Diff copied" : "Nothing to copy");
  };

  const push = async () => {
    if (!client) return;
    try {
      const out = await client.gitPush(cwd, true);
      toast(out.trim() ? out.trim().split("\n").slice(-2).join(" · ") : "Pushed");
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error");
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (commitMode || branchPicker) return; // those handle their own keys
    const tag = (e.target as HTMLElement).tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return;
    const k = e.key;
    let handled = true;
    if (pane === "files" && (k === "j" || k === "ArrowDown")) move(1);
    else if (pane === "files" && (k === "k" || k === "ArrowUp")) move(-1);
    else if (pane === "files" && (k === "Enter" || k === "ArrowRight" || k === "l")) setPane("diff");
    else if (pane === "diff" && (k === "ArrowLeft" || k === "h")) setPane("files");
    else if (pane === "diff" && (k === "j" || k === "ArrowDown")) diffRef.current?.scrollBy({ top: 60 });
    else if (pane === "diff" && (k === "k" || k === "ArrowUp")) diffRef.current?.scrollBy({ top: -60 });
    else if (k === "a") {
      setAllFiles((v) => !v);
    } else if (k === "n") setActiveHunk((h) => Math.min(totalHunks - 1, h + 1));
    else if (k === "p") setActiveHunk((h) => Math.max(0, h - 1));
    else if (k === "]") move(1);
    else if (k === "[") move(-1);
    else if (k === "s") setSideBySide((v) => !v);
    else if (k === "w") setIgnoreWs((v) => !v);
    else if (k === "b") cycleBase();
    else if (k === "r") void refresh();
    else if (k === "c") setCommitMode(true);
    else if (k === "P") void push();
    else if (k === "y") void copyDiff();
    else handled = false;
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  const baseLabel = base.kind === "head" ? "working tree vs HEAD" : base.kind === "staged" ? "staged only" : `vs ${base.name}`;

  const title = (
    <>
      <span>Diff</span>
      <span className="dim" style={{ color: "var(--fg-dim)", fontWeight: 400 }}>
        {session?.title}
        {repoRoot ? ` · ${basename(repoRoot)}` : ""}
        {branch ? ` · ⎇ ${branch}` : ""}
        {` · ${baseLabel}`}
      </span>
      <span style={{ flex: 1 }} />
      <span className="diff-hints">
        <kbd>j/k</kbd> files <kbd>n/p</kbd> hunks <kbd>a</kbd> all <kbd>s</kbd> side-by-side <kbd>w</kbd> ws <kbd>b</kbd> base <kbd>c</kbd> commit <kbd>P</kbd> push <kbd>y</kbd> copy <kbd>r</kbd> refresh
      </span>
    </>
  );

  return (
    <ModalC title={title} width="min(1100px, 94vw)" height="84vh" onKeyDown={onKeyDown} className="diff-modal">
      {repoRoot === null ? (
        <div className="empty">
          <h2>Not a git repository</h2>
          <code>{cwd}</code>
        </div>
      ) : error ? (
        <div className="empty">
          <h2>Git error</h2>
          <code>{error}</code>
        </div>
      ) : commitMode ? (
        <CommitForm
          cwd={cwd}
          statuses={statuses}
          onDone={(sha) => {
            setCommitMode(false);
            if (sha) toast(`Committed ${sha.slice(0, 8)}`);
            void refresh();
          }}
          onCancel={() => setCommitMode(false)}
        />
      ) : branchPicker ? (
        <BranchPicker
          branches={branches}
          current={branch}
          suggested={session?.worktree ? "main" : undefined}
          onPick={(b) => {
            setBranchPicker(false);
            if (b) setBase({ kind: "branch", name: b });
            else setBase({ kind: "head" });
          }}
        />
      ) : (
        <div className="diff-layout" data-autofocus tabIndex={0}>
          <div className={clsx("diff-files", pane === "files" && "pane-active")}>
            {entries.length === 0 && !loading && <div className="empty" style={{ height: "auto", padding: 20 }}>No changes</div>}
            {entries.map((en) => (
              <button
                key={en.key}
                type="button"
                data-hint
                className={clsx("list-item diff-file-row", en.key === selected && !allFiles && "active")}
                onClick={() => {
                  setSelected(en.key);
                  setAllFiles(false);
                  setPane("diff");
                }}
              >
                <span className={clsx("status-letter", en.agent && "agent")}>{en.agent ? "★" : statusLetters(en.status!)}</span>
                <span className="grow" title={en.label}>
                  {en.label}
                </span>
                {en.stat && (
                  <span className="dim">
                    <span className="diff-add">+{en.stat.added}</span> <span className="diff-del">−{en.stat.deleted}</span>
                  </span>
                )}
              </button>
            ))}
            {entries.length > 0 && (
              <div className="dim" style={{ padding: "6px 10px", fontSize: 11 }}>
                {allFiles ? "showing all files" : "showing selected file"} · <kbd>a</kbd> toggle
              </div>
            )}
          </div>
          <div className={clsx("diff-pane", pane === "diff" && "pane-active")} ref={diffRef}>
            {loading && files.length === 0 && <div className="dim" style={{ padding: 10 }}>Loading…</div>}
            {!loading && files.length === 0 && (
              <div className="empty">
                <h2>No changes</h2>
                <span>{allFiles ? "Working tree is clean for this base." : "Select a file on the left."}</span>
              </div>
            )}
            {files.length > 0 && <DiffRenderer files={files} sideBySide={sideBySide} ignoreWs={ignoreWs} activeHunk={activeHunk} />}
          </div>
        </div>
      )}
    </ModalC>
  );
}

function statusLetters(s: FileStatus): string {
  const a = s.staged === " " ? "·" : s.staged;
  const b = s.unstaged === " " ? "·" : s.unstaged;
  return `${a}${b}`;
}

function BranchPicker({ branches, current, suggested, onPick }: { branches: string[]; current: string; suggested?: string; onPick: (b: string | null) => void }) {
  const [q, setQ] = useState(suggested ?? "");
  const [idx, setIdx] = useState(0);
  const list = branches.filter((b) => b !== current && b.toLowerCase().includes(q.toLowerCase()));
  return (
    <div
      className="list"
      onKeyDown={(e) => {
        if (e.key === "ArrowDown") setIdx((i) => Math.min(list.length - 1, i + 1));
        else if (e.key === "ArrowUp") setIdx((i) => Math.max(0, i - 1));
        else if (e.key === "Enter") onPick(list[idx] ?? (q || null));
        else if (e.key === "Escape") {
          e.stopPropagation();
          onPick(null);
        } else return;
        e.preventDefault();
      }}
    >
      <div className="field">
        <label>Compare against branch</label>
        <input type="text" data-autofocus autoFocus value={q} onChange={(e) => (setQ(e.target.value), setIdx(0))} placeholder="branch name…" />
      </div>
      {list.slice(0, 30).map((b, i) => (
        <button key={b} type="button" data-hint className={clsx("list-item", i === idx && "active")} onClick={() => onPick(b)}>
          <span className="grow">{b}</span>
        </button>
      ))}
      {list.length === 0 && <div className="dim" style={{ padding: 8 }}>No other branches match. Enter uses the typed name.</div>}
    </div>
  );
}
