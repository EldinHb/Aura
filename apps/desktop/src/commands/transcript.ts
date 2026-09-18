/**
 * Transcript navigation commands. `nav.*` ids are shared with the sidebar:
 * when the sidebar has focus we delegate to `sidebar.nav.*`.
 */
import { registerCommands, runCommand } from "../lib/commands";
import { useStore } from "../state/store";
import { requestEditApproval } from "../views/transcript/ApprovalCard";

export type TranscriptHandle = {
  visibleIds: () => string[];
  toggle: (id: string) => void;
  expand: (id: string) => void;
  scrollBy: (dy: number) => void;
  scrollToBottom: () => void;
  copyCursor: () => Promise<void>;
};

let handle: TranscriptHandle | null = null;
export function setTranscriptHandle(h: TranscriptHandle | null) {
  handle = h;
}

function st() {
  return useStore.getState();
}

function move(delta: number) {
  if (st().focus === "sidebar") {
    void runCommand(delta > 0 ? (delta > 1 ? "sidebar.nav.last" : "sidebar.nav.down") : delta < -1 ? "sidebar.nav.first" : "sidebar.nav.up");
    return;
  }
  if (!handle) return;
  const ids = handle.visibleIds();
  if (ids.length === 0) return;
  const cur = ids.indexOf(st().cursorItemId ?? "");
  let next: number;
  if (Math.abs(delta) > 1) next = delta > 0 ? ids.length - 1 : 0;
  else next = cur < 0 ? (delta > 0 ? 0 : ids.length - 1) : Math.max(0, Math.min(ids.length - 1, cur + delta));
  st().setCursorItem(ids[next]);
}

export function registerTranscriptCommands() {
  return registerCommands([
    { id: "nav.down", title: "Move down", group: "Navigation", hidden: true, run: () => move(1) },
    { id: "nav.up", title: "Move up", group: "Navigation", hidden: true, run: () => move(-1) },
    { id: "nav.first", title: "Go to first", group: "Navigation", hidden: true, run: () => move(-1e9) },
    { id: "nav.last", title: "Go to last", group: "Navigation", hidden: true, run: () => move(1e9) },
    {
      id: "nav.activate",
      title: "Open / toggle current item",
      group: "Navigation",
      hidden: true,
      run: () => {
        if (st().focus === "sidebar") {
          const id = st().sidebarCursor ?? st().selectedId;
          if (id) {
            st().select(id);
            void import("./core").then((m) => m.setFocus("main"));
          }
          return;
        }
        const id = st().cursorItemId;
        if (id && handle) handle.toggle(id);
      },
    },
    {
      id: "nav.toggle",
      title: "Expand / collapse current item",
      group: "Navigation",
      hidden: true,
      run: () => {
        const id = st().cursorItemId;
        if (id && handle) handle.toggle(id);
      },
    },
    { id: "nav.copy", title: "Copy current item", group: "Transcript", run: async () => { await handle?.copyCursor(); } },
    { id: "nav.page-down", title: "Scroll down a page", group: "Navigation", hidden: true, run: () => handle?.scrollBy(0.8) },
    { id: "nav.page-up", title: "Scroll up a page", group: "Navigation", hidden: true, run: () => handle?.scrollBy(-0.8) },
    { id: "transcript.scroll-bottom", title: "Scroll to latest output", group: "Transcript", run: () => handle?.scrollToBottom() },
    {
      id: "transcript.toggle-reasoning",
      title: "Show / hide reasoning",
      group: "Transcript",
      run: () => st().setSettings({ showReasoning: !st().settings.showReasoning }),
    },
    {
      id: "transcript.expand-all",
      title: "Expand all tool cards",
      group: "Transcript",
      run: () => handle?.visibleIds().forEach((id) => handle?.expand(id)),
    },
    {
      id: "approval.edit-oldest",
      title: "Edit oldest pending approval",
      group: "Approvals",
      when: "pending",
      hidden: true,
      run: () => {
        const s = st();
        const sid = s.selectedId;
        const t = sid ? s.transcripts[sid] : null;
        const oldest = Object.values(t?.approvals ?? {}).sort((a, b) => a.created_at.localeCompare(b.created_at))[0];
        if (!oldest) throw new Error("nothing pending in this session");
        if (oldest.options.includes("edit_input")) requestEditApproval(oldest.id);
        else s.toast("This approval cannot be edited", "warn");
        s.setCursorItem(`approval:${oldest.id}`);
      },
    },
  ]);
}
