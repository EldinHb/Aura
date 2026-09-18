/** Git commands: diff/status/commit/push. Registered from DiffDialog's module and exported for App. */
import { registerCommands } from "../lib/commands";
import { useStore, selectSelected } from "../state/store";

/** Read by DiffDialog on mount: open straight into the commit form / status tab. */
export const diffDialogIntent: { commit: boolean; status: boolean } = { commit: false, status: false };

function st() {
  return useStore.getState();
}

function openDiff(opts: { commit?: boolean; status?: boolean } = {}) {
  const s = selectSelected(st());
  if (!s) {
    st().toast("Select a session first", "warn");
    return;
  }
  diffDialogIntent.commit = !!opts.commit;
  diffDialogIntent.status = !!opts.status;
  st().openDialog({ kind: "diff", sessionId: s.id });
}

let registered: (() => void) | null = null;

export function registerGitCommands(): () => void {
  if (registered) return registered;
  registered = registerCommands([
    { id: "git.diff", title: "Git: show diff", group: "Git", when: "hasSelection", run: () => openDiff() },
    { id: "git.status", title: "Git: status", group: "Git", when: "hasSelection", run: () => openDiff({ status: true }) },
    { id: "git.commit", title: "Git: commit…", group: "Git", when: "hasSelection", run: () => openDiff({ commit: true }) },
    {
      id: "git.push",
      title: "Git: push",
      group: "Git",
      when: "hasSelection",
      run: async () => {
        const s = selectSelected(st());
        const c = st().client;
        if (!s || !c) throw new Error("not connected");
        const out = await c.gitPush(s.cwd, true);
        st().toast(out.trim() ? out.trim().split("\n").slice(-2).join(" · ") : "Pushed", "info");
      },
    },
    {
      id: "git.copy-diff",
      title: "Git: copy diff to clipboard",
      group: "Git",
      when: "hasSelection",
      run: async () => {
        const s = selectSelected(st());
        const c = st().client;
        if (!s || !c) throw new Error("not connected");
        const diff = await c.gitDiff(s.cwd, {});
        await navigator.clipboard.writeText(diff);
        st().toast(diff ? "Diff copied" : "No changes to copy");
      },
    },
  ]);
  return registered;
}
