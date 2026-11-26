/** Commands for the main area's tabs (see state/tabs.ts). Registered once from App. */
import { registerCommands, type Command } from "../lib/commands";
import { useStore } from "../state/store";
import { setFocus } from "./core";

function st() {
  return useStore.getState();
}

/** After a switch the keyboard stays in the main area: in the composer when it was there and the new tab has one. */
function keepFocus() {
  const s = st();
  const session = s.modView ? null : s.selectedId ? s.sessions[s.selectedId] : null;
  setFocus(s.focus === "composer" && session && session.mode !== "terminal" ? "composer" : "main");
}

function step(delta: number) {
  st().cycleTab(delta);
  keepFocus();
}

function moveBy(delta: number) {
  const s = st();
  const at = s.tabs.findIndex((t) => t.key === s.activeTab);
  if (at >= 0) s.moveTab(s.tabs[at].key, at + delta);
}

export const tabCommands: Command[] = [
  { id: "tab.next", title: "Next tab", group: "Tabs", when: "hasTabs", run: () => step(1) },
  { id: "tab.prev", title: "Previous tab", group: "Tabs", when: "hasTabs", run: () => step(-1) },
  {
    id: "tab.close",
    title: "Close tab",
    group: "Tabs",
    when: "hasTabs",
    run: (key) => {
      st().closeTab(typeof key === "string" ? key : undefined);
      keepFocus();
    },
  },
  {
    id: "tab.reopen",
    title: "Reopen closed tab",
    group: "Tabs",
    run: () => {
      st().reopenClosedTab();
      keepFocus();
    },
  },
  { id: "tab.keep", title: "Keep tab open (not a preview)", group: "Tabs", keywords: ["pin", "preview"], when: "previewTab", run: (key) => st().keepTab(typeof key === "string" ? key : undefined) },
  {
    id: "tab.activate",
    title: "Show tab",
    group: "Tabs",
    hidden: true,
    run: (key) => {
      if (typeof key !== "string") return;
      st().activateTab(key);
      keepFocus();
    },
  },
  {
    id: "tab.go-nth",
    title: "Go to tab by number",
    group: "Tabs",
    hidden: true,
    run: (n) => {
      st().goToTab(Number(n));
      keepFocus();
    },
  },
  {
    id: "tab.open-session",
    title: "Open session in a new tab",
    group: "Tabs",
    keywords: ["keep"],
    run: (id) => {
      const s = st();
      const sessionId = typeof id === "string" ? id : (s.focus === "sidebar" ? s.sidebarCursor : null) ?? s.selectedId;
      if (!sessionId) throw new Error("no session selected");
      s.openTab({ kind: "session", sessionId }, { preview: false });
    },
  },
  { id: "tab.move-left", title: "Move tab left", group: "Tabs", when: "hasTabs", run: () => moveBy(-1) },
  { id: "tab.move-right", title: "Move tab right", group: "Tabs", when: "hasTabs", run: () => moveBy(1) },
];

export function registerTabCommands() {
  return registerCommands(tabCommands);
}
