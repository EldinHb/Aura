/** Git commands: diff/status/commit/push. Registered from DiffDialog's module and exported for App. */
import { registerCommands } from "../lib/commands";
import { useStore, selectSelected } from "../state/store";
import { folderOf } from "../lib/sessionFolder";
import type { Session } from "../gen";

/** Read by DiffDialog on mount: open straight into the commit form / status tab. */
export const diffDialogIntent: { commit: boolean; status: boolean } = { commit: false, status: false };

function st() {
  return useStore.getState();
}

/** The selected session's folder, or a warning when there is no session or it has no folder. */
function selectedFolder(): { s: Session; cwd: string } | null {
  const s = selectSelected(st());
  if (!s) {
    st().toast("Select a session first", "warn");
    return null;
  }
  const cwd = folderOf(s);
  if (cwd === null) {
    st().toast("This orchestrator belongs to no folder; its workers have the changes", "warn");
    return null;
  }
  return { s, cwd };
}

function openDiff(opts: { commit?: boolean; status?: boolean } = {}) {
  const s = selectedFolder()?.s;
  if (!s) return;
  diffDialogIntent.commit = !!opts.commit;
  diffDialogIntent.status = !!opts.status;
  st().openDialog({ kind: "diff", sessionId: s.id });
}

let registered: (() => void) | null = null;

export function registerGitCommands(): () => void {
  if (registered) return registered;
  registered = registerCommands([
    { id: "git.diff", title: "Git: show diff", group: "Git", when: "hasSelection,hasFolder", run: () => openDiff() },
    { id: "git.status", title: "Git: status", group: "Git", when: "hasSelection,hasFolder", run: () => openDiff({ status: true }) },
    { id: "git.commit", title: "Git: commit…", group: "Git", when: "hasSelection,hasFolder", run: () => openDiff({ commit: true }) },
    {
      id: "git.push",
      title: "Git: push",
      group: "Git",
      when: "hasSelection,hasFolder",
      run: async () => {
        const c = st().client;
        if (!c) throw new Error("not connected");
        const target = selectedFolder();
        if (!target) return;
        const out = await c.gitPush(target.cwd, true);
        st().toast(out.trim() ? out.trim().split("\n").slice(-2).join(" · ") : "Pushed", "info");
      },
    },
    {
      id: "git.cleanup",
      title: "Git: clean up local branches…",
      group: "Git",
      run: () => {
        const s = selectSelected(st());
        st().openDialog({ kind: "git-cleanup", cwd: (s && folderOf(s)) ?? undefined });
      },
    },
    {
      id: "git.copy-diff",
      title: "Git: copy diff to clipboard",
      group: "Git",
      when: "hasSelection,hasFolder",
      run: async () => {
        const c = st().client;
        if (!c) throw new Error("not connected");
        const target = selectedFolder();
        if (!target) return;
        const diff = await c.gitDiff(target.cwd, {});
        await navigator.clipboard.writeText(diff);
        st().toast(diff ? "Diff copied" : "No changes to copy");
      },
    },
  ]);
  return registered;
}
