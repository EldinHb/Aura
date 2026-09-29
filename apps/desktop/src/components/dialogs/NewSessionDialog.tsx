import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Modal } from "../Modal";
import { useStore } from "../../state/store";
import type { DirEntry, ModelInfo, SessionMode } from "../../gen";
import { setFocus } from "../../commands/core";
import { basename } from "../../lib/platform";
import { physicalKey } from "../../lib/keymap";
import clsx from "clsx";
import { providerChoices } from "../../lib/acp";

const RECENT_DIRS_KEY = "aura.recentDirs";
/** Rows the directory browser renders; the arrow keys stay within them. */
const MAX_DIR_ROWS = 12;

function loadRecentDirs(): string[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT_DIRS_KEY) ?? "[]") as string[];
  } catch {
    return [];
  }
}
function pushRecentDir(dir: string) {
  const next = [dir, ...loadRecentDirs().filter((d) => d !== dir)].slice(0, 8);
  try {
    localStorage.setItem(RECENT_DIRS_KEY, JSON.stringify(next));
  } catch {
    /* ignore */
  }
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}
function caretAtEnd(input: HTMLInputElement): boolean {
  return input.selectionStart === input.value.length && input.selectionEnd === input.value.length;
}
function parentDir(p: string): string {
  const t = p.replace(/\/+$/, "");
  const i = t.lastIndexOf("/");
  return i <= 0 ? "/" : t.slice(0, i);
}

export function NewSessionDialog({ preset, cwd: presetCwd }: { preset?: string; cwd?: string }) {
  const client = useStore((s) => s.client);
  const providers = useStore((s) => s.providers);
  const sessions = useStore((s) => s.sessions);
  const settings = useStore((s) => s.settings);
  const selected = useStore((s) => (s.selectedId ? s.sessions[s.selectedId] : null));
  const closeDialog = useStore((s) => s.closeDialog);
  const toast = useStore((s) => s.toast);
  const select = useStore((s) => s.select);

  const available = useMemo(() => providerChoices(providers), [providers]);
  // A choice key: a provider kind, or `acp:<agent>` for an ACP agent.
  const [choiceKey, setChoiceKey] = useState<string>(() => {
    const want = preset === "worktree" ? settings.defaultProvider : preset ?? settings.defaultProvider;
    return available.some((c) => c.key === want) ? want : available[0]?.key ?? "terminal";
  });
  const choice = available.find((c) => c.key === choiceKey) ?? { key: "terminal", kind: "terminal" as const, agent: null, label: "Terminal", version: null };
  const provider = choice.kind;
  // ACP agents only report their models and modes once a session exists, and
  // have no terminal mode Aura could switch to.
  const isAcp = provider === "acp";
  const [dir, setDir] = useState(presetCwd ?? selected?.cwd ?? settings.defaultCwd ?? "");
  const [home, setHome] = useState<string>("");
  const [entries, setEntries] = useState<DirEntry[]>([]);
  const [dirIndex, setDirIndex] = useState(0);
  const [title, setTitle] = useState("");
  const [group, setGroup] = useState(selected?.group ?? "");
  const [mode, setMode] = useState<SessionMode>(provider === "terminal" ? "terminal" : "structured");
  const [command, setCommand] = useState("");
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [model, setModel] = useState("");
  const [permission, setPermission] = useState("");
  const [sandbox, setSandbox] = useState("");
  const [repoRoot, setRepoRoot] = useState<string | null>(null);
  const [worktree, setWorktree] = useState(preset === "worktree");
  const [branch, setBranch] = useState("");
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const dirInput = useRef<HTMLInputElement>(null);
  const dirBrowser = useRef<HTMLDivElement>(null);

  const caps = providers.find((p) => p.kind === provider)?.capabilities;
  const groups = useMemo(() => [...new Set(Object.values(sessions).map((s) => s.group).filter((g): g is string => !!g))].sort(), [sessions]);

  useEffect(() => {
    client?.home().then((h) => {
      if (h) {
        setHome(h);
        setDir((d) => d || h);
      }
    });
  }, [client]);

  useEffect(() => {
    setMode(provider === "terminal" ? "terminal" : "structured");
    setModel("");
    setPermission("");
    setSandbox("");
    if (client && provider !== "terminal" && provider !== "acp") client.models(provider).then(setModels).catch(() => setModels([]));
    else setModels([]);
  }, [provider, choiceKey, client]);

  // Directory browser
  const expandedDir = useMemo(() => (dir === "~" ? home : dir.startsWith("~/") ? home + dir.slice(1) : dir), [dir, home]);
  const listBase = useMemo(() => {
    if (!expandedDir) return "";
    return expandedDir.endsWith("/") ? expandedDir : parentDir(expandedDir);
  }, [expandedDir]);
  const partial = useMemo(() => (expandedDir.endsWith("/") ? "" : basename(expandedDir)), [expandedDir]);

  useEffect(() => {
    if (!client) return;
    if (!expandedDir) {
      setEntries([]);
      return;
    }
    let cancelled = false;
    client
      .listDir(listBase || "/", partial.startsWith("."))
      .then((es) => {
        if (cancelled) return;
        setEntries(es.filter((e) => e.is_dir && e.name.toLowerCase().startsWith(partial.toLowerCase())));
        setDirIndex(0);
      })
      .catch(() => !cancelled && setEntries([]));
    return () => {
      cancelled = true;
    };
  }, [client, listBase, partial, expandedDir]);

  useEffect(() => {
    if (!client || !expandedDir) return;
    let cancelled = false;
    client
      .gitRepoRoot(expandedDir)
      .then((r) => !cancelled && setRepoRoot(r))
      .catch(() => !cancelled && setRepoRoot(null));
    return () => {
      cancelled = true;
    };
  }, [client, expandedDir]);

  const recentDirs = useMemo(() => loadRecentDirs(), []);
  const showRecent = !partial && recentDirs.length > 0 && (dir === "" || dir === home || dir === home + "/");
  type BrowserRow = { path: string; label: string; git: boolean; recent?: boolean };
  const browserRows = useMemo<BrowserRow[]>(() => {
    const rows: BrowserRow[] = showRecent ? recentDirs.map((p) => ({ path: p, label: home ? p.replace(home, "~") : p, git: false, recent: true })) : [];
    return rows.concat(entries.map((e) => ({ path: e.path, label: e.name, git: e.is_git_repo }))).slice(0, MAX_DIR_ROWS);
  }, [showRecent, recentDirs, entries, home]);

  useEffect(() => {
    dirBrowser.current?.querySelector<HTMLElement>(".list-item.active")?.scrollIntoView({ block: "nearest" });
  }, [dirIndex, browserRows]);

  useEffect(() => {
    if (!branch && (title || worktree)) setBranch(`aura/${slug(title) || new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")}`);
  }, [title, worktree]); // eslint-disable-line react-hooks/exhaustive-deps

  const descend = (path: string) => {
    setDir(path.replace(/\/+$/, "") + "/");
    setDirIndex(0);
  };

  const submit = useCallback(async () => {
    if (!client || busy) return;
    const cwd = expandedDir.replace(/\/+$/, "") || home || "/";
    setBusy(true);
    try {
      const argv = command.trim() ? command.trim().split(/\s+/) : null;
      const s = await client.createSession({
        provider,
        agent: choice.agent,
        cwd,
        title: title.trim() || null,
        group: group.trim() || null,
        mode,
        command: provider === "terminal" && argv ? argv : null,
        model: model || null,
        permission_mode: permission || null,
        sandbox_mode: sandbox || null,
        worktree: worktree && repoRoot && branch.trim() ? { branch: branch.trim(), base: null, path: null } : null,
        initial_prompt: mode === "structured" && prompt.trim() ? prompt.trim() : null,
      });
      pushRecentDir(cwd);
      select(s.id);
      closeDialog();
      setFocus("main");
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error");
    } finally {
      setBusy(false);
    }
  }, [client, busy, expandedDir, home, command, provider, choice.agent, title, group, mode, model, permission, sandbox, worktree, repoRoot, branch, prompt, select, closeDialog, toast]);

  const onDirKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setDirIndex((i) => Math.min(browserRows.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setDirIndex((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter" && !(e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      const row = browserRows[dirIndex];
      if (row) descend(row.path);
    } else if (e.key === "Tab" && !e.shiftKey && browserRows[dirIndex] && partial) {
      e.preventDefault();
      descend(browserRows[dirIndex].path);
    } else if (e.key === "ArrowRight" && browserRows[dirIndex] && caretAtEnd(e.currentTarget)) {
      e.preventDefault();
      descend(browserRows[dirIndex].path);
    } else if (e.key === "Backspace" && !partial && expandedDir && expandedDir !== "/") {
      e.preventDefault();
      setDir(parentDir(expandedDir) === "/" ? "/" : parentDir(expandedDir) + "/");
    }
  };

  return (
    <Modal
      title={
        <>
          <span>New session</span>
          <span className="dim" style={{ marginLeft: "auto", fontWeight: 400 }}>
            <kbd>⌘↩</kbd> create
          </span>
        </>
      }
      width={720}
      className="new-session"
      onKeyDown={(e) => {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          void submit();
        } else if (e.altKey && /^[1-9]$/.test(physicalKey(e))) {
          const c = available[Number(physicalKey(e)) - 1];
          if (c) {
            e.preventDefault();
            setChoiceKey(c.key);
          }
        }
      }}
      footer={
        <>
          <button type="button" className="btn" data-command="dialog.cancel" onClick={closeDialog}>Cancel <kbd>Esc</kbd></button>
          <button type="button" className="btn primary" data-command="dialog.confirm" disabled={busy} onClick={() => void submit()}>
            {busy ? "Creating…" : "Create"} <kbd>⌘↩</kbd>
          </button>
        </>
      }
    >
      <div className="field">
        <label>Provider {available.length > 1 && <span className="dim">(⌥1–{Math.min(9, available.length)})</span>}</label>
        <div className="radio-row" role="radiogroup">
          {available.map((c, i) => (
            <button key={c.key} type="button" role="radio" aria-checked={choiceKey === c.key} className={clsx("btn", choiceKey === c.key && "primary")} data-command="new-session.provider" data-autofocus={i === 0 ? true : undefined} onClick={() => setChoiceKey(c.key)}>
              {c.label} {i < 9 && <kbd>{i + 1}</kbd>}
              {c.version && <span className="dim">{c.version}</span>}
              {c.kind === "acp" && <span className="dim">ACP</span>}
            </button>
          ))}
          {available.length === 0 && <span className="dim">No providers detected.</span>}
        </div>
      </div>

      <div className="field">
        <label>Directory {repoRoot && <span className="chip">⎇ git repo</span>}</label>
        <input ref={dirInput} type="text" value={dir} onChange={(e) => setDir(e.target.value)} onKeyDown={onDirKey} placeholder="~/projects/…" spellCheck={false} autoComplete="off" />
        {browserRows.length > 0 && (
          <div className="dir-browser" ref={dirBrowser}>
            {browserRows.map((row, i) => (
              <button key={row.path} type="button" className={clsx("list-item", i === dirIndex && "active")} data-hint data-command="new-session.dir" tabIndex={-1} onMouseEnter={() => setDirIndex(i)} onClick={() => descend(row.path)}>
                <span className="grow">{row.recent ? "⟲ " : ""}{row.label}/</span>
                {row.git && <span className="dim">⎇</span>}
              </button>
            ))}
            <div className="dim" style={{ padding: "4px 10px", fontSize: 11 }}>
              <kbd>↑↓</kbd> pick <kbd>↩</kbd>/<kbd>⇥</kbd>/<kbd>→</kbd> descend <kbd>⌫</kbd> up
            </div>
          </div>
        )}
      </div>

      <div className="two-col">
        <div className="field">
          <label>Title (optional)</label>
          <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} placeholder={`${choice.agent ?? provider} · ${basename(expandedDir || "")}`} />
        </div>
        <div className="field">
          <label>Group (optional)</label>
          <input type="text" list="aura-groups-new" value={group} onChange={(e) => setGroup(e.target.value)} />
          <datalist id="aura-groups-new">
            {groups.map((g) => (
              <option key={g} value={g} />
            ))}
          </datalist>
        </div>
      </div>

      {isAcp ? (
        <div className="field">
          <span className="dim">Model and mode can be changed once the session has started, if the agent offers them (⌘K → Model, Permission mode).</span>
        </div>
      ) : provider !== "terminal" ? (
        <>
          <div className="field">
            <label>Mode</label>
            <div className="radio-row" role="radiogroup">
              {(["structured", "terminal"] as SessionMode[]).map((m) => (
                <button key={m} type="button" role="radio" aria-checked={mode === m} className={clsx("btn", mode === m && "primary")} data-command="new-session.mode" onClick={() => setMode(m)}>
                  {m === "structured" ? "Structured view" : "Native TUI in terminal"}
                </button>
              ))}
            </div>
          </div>
          <div className="two-col">
            <div className="field">
              <label>Model</label>
              <select value={model} onChange={(e) => setModel(e.target.value)}>
                <option value="">provider default</option>
                {models.map((m) => (
                  <option key={m.id} value={m.id}>{m.display_name || m.id}{m.is_default ? " (default)" : ""}</option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>Permission mode</label>
              <select value={permission} onChange={(e) => setPermission(e.target.value)}>
                <option value="">provider default</option>
                {(caps?.permission_modes ?? []).map((p) => (
                  <option key={p} value={p}>{p}</option>
                ))}
              </select>
            </div>
            {(caps?.sandbox_modes.length ?? 0) > 0 && (
              <div className="field">
                <label>Sandbox</label>
                <select value={sandbox} onChange={(e) => setSandbox(e.target.value)}>
                  <option value="">provider default</option>
                  {caps!.sandbox_modes.map((p) => (
                    <option key={p} value={p}>{p}</option>
                  ))}
                </select>
              </div>
            )}
          </div>
        </>
      ) : (
        <div className="field">
          <label>Command (empty = login shell)</label>
          <input type="text" value={command} onChange={(e) => setCommand(e.target.value)} placeholder="/bin/zsh -l" spellCheck={false} />
        </div>
      )}

      {repoRoot && (
        <div className="field">
          <label>
            <input type="checkbox" checked={worktree} onChange={(e) => setWorktree(e.target.checked)} style={{ marginRight: 6 }} />
            Create a git worktree for this session
          </label>
          {worktree && <input type="text" value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="branch name" spellCheck={false} />}
          {worktree && <span className="dim" style={{ fontSize: 11 }}>Worktree under {repoRoot}/.aura-worktrees/</span>}
        </div>
      )}

      {mode === "structured" && provider !== "terminal" && (
        <div className="field">
          <label>Initial prompt (optional)</label>
          <textarea rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="First message to the agent… (⌘↩ to create)" />
        </div>
      )}
    </Modal>
  );
}
