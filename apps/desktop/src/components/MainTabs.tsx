/**
 * The tab strip across the top of the main area, and the panes below it: every
 * open session and mod view keeps its own tab (state/tabs.ts). Each tab's
 * action is a command (`tab.*`), so the keyboard and hint mode reach them all.
 */
import { useState, type ReactNode } from "react";
import clsx from "clsx";
import { useStore } from "../state/store";
import type { Tab } from "../state/tabs";
import { runCommand } from "../lib/commands";
import { statusClass } from "../lib/sessionStatus";
import { useModViewTitle } from "../mods/Slots";
import { useShortcut } from "../hooks/useKeyboard";
import { TabActiveContext } from "./tabActive";
import "./tabs.css";

/** What a tab is called: its session's title, or the mod view's own title (`props.title`), else the view's registered title. */
export function useTabTitle(tab: Tab): string {
  const sessionTitle = useStore((s) => (tab.kind === "session" ? s.sessions[tab.sessionId]?.title : undefined));
  const viewTitle = useModViewTitle(tab.kind === "mod" ? tab.modId : "", tab.kind === "mod" ? tab.viewId : "");
  if (tab.kind === "session") return sessionTitle ?? "Session";
  return tab.title ?? viewTitle ?? tab.viewId;
}

export function MainTabs() {
  const tabs = useStore((s) => s.tabs);
  const activeTab = useStore((s) => s.activeTab);
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<number | null>(null);
  if (tabs.length === 0) return null;
  const drop = (index: number) => {
    if (dragging) useStore.getState().moveTab(dragging, index);
    setDragging(null);
    setOver(null);
  };
  return (
    <div className="main-tabs" role="tablist" aria-label="Open tabs">
      {tabs.map((tab, i) => (
        <MainTab
          key={tab.key}
          tab={tab}
          active={tab.key === activeTab}
          dragging={dragging === tab.key}
          dropTarget={over === i && dragging !== null && dragging !== tab.key}
          onDragStart={() => setDragging(tab.key)}
          onDragOver={() => setOver(i)}
          onDrop={() => drop(i)}
          onDragEnd={() => {
            setDragging(null);
            setOver(null);
          }}
        />
      ))}
    </div>
  );
}

function MainTab(props: {
  tab: Tab;
  active: boolean;
  dragging: boolean;
  dropTarget: boolean;
  onDragStart(): void;
  onDragOver(): void;
  onDrop(): void;
  onDragEnd(): void;
}) {
  const { tab, active } = props;
  const title = useTabTitle(tab);
  const session = useStore((s) => (tab.kind === "session" ? s.sessions[tab.sessionId] : undefined));
  const closeKeys = useShortcut("tab.close");
  return (
    <div
      className={clsx("main-tab", active && "active", tab.preview && "preview", props.dragging && "dragging", props.dropTarget && "drop-target")}
      data-tab-key={tab.key}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", title);
        props.onDragStart();
      }}
      onDragOver={(e) => {
        e.preventDefault();
        props.onDragOver();
      }}
      onDrop={(e) => {
        e.preventDefault();
        props.onDrop();
      }}
      onDragEnd={props.onDragEnd}
      // Middle click closes, as in browsers; the mouse-down would otherwise start autoscroll.
      onMouseDown={(e) => {
        if (e.button === 1) e.preventDefault();
      }}
      onAuxClick={(e) => {
        if (e.button !== 1) return;
        e.preventDefault();
        void runCommand("tab.close", tab.key);
      }}
    >
      <button
        type="button"
        role="tab"
        aria-selected={active}
        className="main-tab-label"
        data-hint
        data-command="tab.activate"
        title={tab.preview ? `${title} (preview: double-click to keep it open)` : title}
        onClick={() => void runCommand("tab.activate", tab.key)}
        onDoubleClick={() => void runCommand("tab.keep", tab.key)}
      >
        {session && <span className={clsx("dot", statusClass(session))} aria-hidden />}
        <span className="main-tab-title">{title}</span>
      </button>
      <button
        type="button"
        className="main-tab-close"
        data-hint
        data-command="tab.close"
        aria-label={`Close ${title}`}
        title={closeKeys ? `Close tab (${closeKeys})` : "Close tab"}
        onClick={() => void runCommand("tab.close", tab.key)}
      >
        ×
      </button>
    </div>
  );
}

/**
 * A tab's content. Every open tab stays mounted, so scroll positions, drafts and
 * a mod view's state survive switching; only the active one shows. Hidden panes
 * are `inert`, so neither focus nor hint mode lands in them.
 */
export function TabPane({ tabKey, active, children }: { tabKey: string; active: boolean; children: ReactNode }) {
  return (
    <div className="main-tab-pane" role="tabpanel" data-tab-pane={tabKey} hidden={!active} inert={!active}>
      <TabActiveContext.Provider value={active}>{children}</TabActiveContext.Provider>
    </div>
  );
}
