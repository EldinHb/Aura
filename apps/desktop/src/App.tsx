import { registerScheduleCommands, useScheduleSync } from "./features/schedules/state";
import { useUpdateChecks } from "./features/updates/updates";
import "./features/schedules/schedules.css";
import "./features/usage/usage.css";
import { registerUsageCommands, useUsageSync } from "./features/usage/state";
import { useTemplateSync } from "./features/templates/state";
import { useModLoader } from "./mods/loader";
import { useThemeLoader } from "./state/themes";
import { ApprovalDialog } from "./mods/ApprovalDialog";
import { useWaitingSound } from "./state/waitingSound";
import { ModView } from "./mods/Slots";
import { MainTabs, TabPane } from "./components/MainTabs";
import { registerTabCommands } from "./commands/tabs";
import type { Tab } from "./state/tabs";
import { slots } from "./mods/registry";
import "./mods/mods.css";
import { useEffect } from "react";
import { useStore, selectSelected } from "./state/store";
import { inboxCount, quietReportTurn, useInboxCount, useMarkViewedSeen } from "./state/attention";
import { discoverDaemon, isTauri, windowClient, type ConnInfo } from "./lib/connection";
import { DaemonLink, connectWindow } from "./lib/daemonLink";
import type { RpcClient } from "./lib/rpc";
import { useKeyboard } from "./hooks/useKeyboard";
import { registerCoreCommands, setFocus } from "./commands/core";
import { registerGitCommands } from "./commands/git";
import { setCommandErrorHandler } from "./lib/commands";
import { Sidebar } from "./components/Sidebar";
import { StatusBar } from "./components/StatusBar";
import { InboxButton } from "./components/InboxButton";
import { TerminalView } from "./views/TerminalView";
import { Transcript } from "./views/Transcript";
import { Composer } from "./views/Composer";
import { Inspector } from "./views/Inspector";
import { OrchestratorTabs, WorkerThreads } from "./views/WorkerThreads";
import { TeamView } from "./views/TeamView";
import { useWorkerThreads } from "./state/workerThreads";
import { Overlays } from "./components/Overlays";
import { isMac } from "./lib/platform";
import { desktopNotify } from "./lib/notify";
import clsx from "clsx";
import type { Event } from "./gen";
import { LOCAL, computerName, useComputers, configureSync, follow, setBackgroundNotifier, startComputers, trackSessions, unfollow } from "./state/computers";
import { registerComputerCommands } from "./commands/computers";
import { RemoteUnavailable } from "./components/RemoteUnavailable";

const params = new URLSearchParams(location.search);
const windowMode = params.get("window"); // "session" for a detached single-session window
const initialSession = params.get("session");

export default function App() {
  useKeyboard();
  // Mods' interfaces: loaded once connected, followed as they change.
  useModLoader();
  // A sound when a session goes from working to waiting for you; the main window plays it.
  useWaitingSound(windowMode !== "session");
  useScheduleSync();
  useUsageSync();
  useTemplateSync();
  // Self-update: the main window checks, downloads and offers the restart.
  useUpdateChecks(windowMode !== "session");
  useMarkViewedSeen();
  const inbox = useInboxCount();
  const connection = useStore((s) => s.connection);
  const connectionError = useStore((s) => s.connectionError);
  const computer = useStore((s) => s.computer);
  const shownComputer = useComputers((s) => computerName(computer, s.remotes));
  const selected = useStore(selectSelected);
  // The main area's tabs: sessions and mods' views (a pull request, say), each kept open in its own.
  const tabs = useStore((s) => s.tabs);
  const activeTab = useStore((s) => s.activeTab);
  // A detached window shows its one session, without a tab strip.
  const shownTabs = windowMode === "session" ? tabs.filter((t) => t.key === activeTab) : tabs;
  const modViewOpen = useStore((s) => s.modView !== null);
  const sidebarCollapsed = useStore((s) => s.sidebarCollapsed) || windowMode === "session";
  const inspectorOpen = useStore((s) => s.inspectorOpen) && windowMode !== "session" && !modViewOpen;
  const focus = useStore((s) => s.focus);
  const fontSize = useStore((s) => s.settings.fontSize);

  useThemeLoader();

  useEffect(() => {
    document.documentElement.style.setProperty("--font-size", `${fontSize}px`);
  }, [fontSize]);

  useEffect(() => {
    setCommandErrorHandler((msg) => useStore.getState().toast(msg, "error"));
    registerGitCommands();
    const offCore = registerCoreCommands();
    const offTabs = registerTabCommands();
    const offSchedules = registerScheduleCommands();
    const offUsage = registerUsageCommands();
    const offComputers = registerComputerCommands();
    return () => { offCore(); offTabs(); offSchedules(); offUsage(); offComputers(); };
  }, []);

  // Connect + subscribe. The link moves the window to a new client when the
  // shell says the daemon changed (a restart, a recovery after a failed update).
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    const st = useStore.getState;
    configureSync({ initialSession, selectFirst: windowMode !== "session", onEvent: (ev) => void notifyIfNeeded(ev) });
    const link = new DaemonLink<RpcClient>({
      // Says the window secret on every (re)connection (see windowClient).
      makeClient: windowClient,
      // Subscribes and loads on the new client; it becomes the window's in
      // `commit`, once this succeeded. Events, the connection state and a
      // refresh on every reconnect are state/daemonSync.ts's; while a remote
      // computer is shown, this computer's sessions are only tracked for the
      // inbox (state/computers.ts), and followed fully on switching back.
      attach: async (client) => {
        const offTrack = trackSessions(LOCAL, client);
        if (st().computer === LOCAL) await follow(client);
        // Provider CLIs are upgraded outside Aura, so re-read them whenever the
        // window comes back rather than trusting what we saw at connect. Only
        // the provider list — a full refresh would re-apply the initial session
        // selection and yank the user off whatever they had selected.
        const onWindowFocus = () => {
          const shown = st().client;
          shown
            ?.providers()
            .then((ps) => {
              if (st().client === shown) st().setProviders(ps);
            })
            .catch(() => {});
        };
        window.addEventListener("focus", onWindowFocus);
        return () => {
          offTrack();
          unfollow(client);
          window.removeEventListener("focus", onWindowFocus);
        };
      },
      commit: (client) => {
        st().setLocalClient(client);
        if (st().computer !== LOCAL) return;
        st().setClient(client);
        st().setConnection("open");
      },
    });
    const failed = (e: unknown) => {
      if (!cancelled) st().setConnection("closed", e instanceof Error ? e.message : String(e));
    };
    st().setConnection("connecting");
    // Listen for the shell's announcements before looking for the daemon, so
    // a restart while this window opens is not missed (see connectWindow).
    const listen = async (onChange: (info: ConnInfo) => void) => {
      if (!isTauri()) return () => {};
      const { listen } = await import("@tauri-apps/api/event");
      return listen<ConnInfo>("aura://daemon-changed", (e) => onChange(e.payload));
    };
    void connectWindow({ link, listen, discover: discoverDaemon, onError: failed }).then((u) => (cancelled ? u() : (unlisten = u)));
    return () => {
      cancelled = true;
      link.close();
      unlisten?.();
    };
  }, []);

  // Remote computers: connected in the background, shown on switching (main window only).
  useEffect(() => {
    if (!isTauri() || windowMode === "session") return;
    let stop: (() => void) | undefined;
    let cancelled = false;
    setBackgroundNotifier((computer, session, ev) => {
      if (!useStore.getState().settings.notifications) return;
      const body = ev.type === "approval_requested" ? `Approval needed: ${ev.approval.title}` : "Question from the agent";
      void desktopNotify(`${session?.title ?? "Aura"} · ${computerName(computer)}`, body);
    });
    void startComputers().then((s) => (cancelled ? s() : (stop = s)));
    return () => {
      cancelled = true;
      stop?.();
      setBackgroundNotifier(null);
    };
  }, []);

  // Load history when a session is selected.
  const selectedId = selected?.id ?? null;
  useEffect(() => {
    if (selectedId) useStore.getState().loadTranscript(selectedId);
  }, [selectedId, connection]);

  // The Dock badge (the title in a browser) counts what the inbox lists, like the top bar.
  // The main window owns the badge.
  useEffect(() => {
    if (!isTauri()) {
      document.title = inbox > 0 ? `(${inbox}) Aura` : "Aura";
      return;
    }
    if (windowMode === "session") return;
    import("@tauri-apps/api/core").then(({ invoke }) => invoke("set_badge", { count: inbox })).catch(() => {});
  }, [inbox]);

  // Global summon from the tray hotkey opens the inbox when something waits. The
  // hotkey brings up the main window, so only the main window answers it.
  useEffect(() => {
    if (!isTauri() || windowMode === "session") return;
    let un: (() => void) | undefined;
    import("@tauri-apps/api/event").then(({ listen }) =>
      listen("aura://summon", () => {
        const st = useStore.getState();
        if (inboxCount(st) > 0) st.openDialog({ kind: "inbox" });
        else setFocus("sidebar");
      }).then((u) => (un = u)),
    );
    return () => un?.();
  }, []);

  return (
    <div className="app">
      <div className={clsx("titlebar", !isMac && "no-mac")} data-tauri-drag-region>
        <span className="title">Aura</span>
        {selected && <span style={{ color: "var(--fg-dim)" }}>› {selected.title}</span>}
        <span className="spacer" />
        {computer !== LOCAL && <span className="titlebar-computer" title="The computer this window shows">{shownComputer}</span>}
        <InboxButton />
        <span className="conn">
          <span className={`dot ${connection === "open" ? "ok" : connection === "connecting" ? "warn pulse" : "err"}`} />
          {connection}
        </span>
      </div>
      <div className={clsx("body", sidebarCollapsed && "no-sidebar", !inspectorOpen && "no-inspector")}>
        {!sidebarCollapsed && <Sidebar />}
        <div className={clsx("region main", (focus === "main" || focus === "composer") && "focused")} data-region="main" tabIndex={-1}>
          {windowMode !== "session" && <MainTabs />}
          {shownTabs.map((tab) => (
            <TabPane key={tab.key} tabKey={tab.key} active={tab.key === activeTab}>
              <TabContent tab={tab} active={tab.key === activeTab} />
            </TabPane>
          ))}
          {!shownTabs.some((t) => t.key === activeTab) && (connection !== "open" && computer !== LOCAL ? (
            <RemoteUnavailable id={computer} />
          ) : connection !== "open" ? (
            <div className="empty">
              <h2>{connection === "connecting" ? "Connecting to the Aura daemon…" : "Not connected"}</h2>
              {connectionError && <code>{connectionError}</code>}
              {connection === "closed" && <span>Start it with <code>aura daemon start</code>, then reload with <kbd>⌘R</kbd>.</span>}
            </div>
          ) : (
            <div className="empty">
              <h2>Aura</h2>
              <div className="hint">
                <span><kbd>⌘N</kbd> new session</span>
                <span><kbd>⌘K</kbd> commands</span>
                <span><kbd>Ctrl+Space</kbd> menu</span>
                <span><kbd>?</kbd> help</span>
              </div>
            </div>
          ))}
        </div>
        {inspectorOpen && <Inspector sessionId={selectedId} />}
      </div>
      <StatusBar />
      <Overlays />
      {/* Approval prompts: a top-layer dialog no stylesheet can hide (protected.css). */}
      <ApprovalDialog />
    </div>
  );
}

/** What a main-area tab shows. */
function TabContent({ tab, active }: { tab: Tab; active: boolean }) {
  const closeTab = useStore((s) => s.closeTab);
  if (tab.kind === "session") return <SessionPane sessionId={tab.sessionId} />;
  return <ModView modId={tab.modId} viewId={tab.viewId} props={tab.props} close={() => closeTab(tab.key)} active={active} />;
}

/** A session's tab: its terminal, or its transcript (or an orchestrator's threads, a feature owner's team) and composer. */
function SessionPane({ sessionId }: { sessionId: string }) {
  const session = useStore((s) => s.sessions[sessionId]);
  // An orchestrator showing its threads with its workers rather than its chat.
  const threads = useWorkerThreads((s) => (session?.orchestrator ? s.views[session.id]?.tab === "workers" : false));
  // A feature owner showing its team, which the user opened.
  const team = useWorkerThreads((s) => (session?.feature_owner ? s.views[session.id]?.tab === "team" : false));
  if (!session) return <div className="empty"><span>Loading session…</span></div>;
  if (session.mode === "terminal") return <TerminalView key={session.id} sessionId={session.id} />;
  return (
    <>
      {session.orchestrator && <OrchestratorTabs orchestratorId={session.id} />}
      {team ? <TeamView key={`t-${session.id}`} ownerId={session.id} /> : threads ? <WorkerThreads key={`w-${session.id}`} orchestratorId={session.id} /> : <Transcript key={session.id} sessionId={session.id} />}
      <Composer key={`c-${session.id}`} sessionId={session.id} />
    </>
  );
}

let lastNotified = 0;
async function notifyIfNeeded(ev: Event) {
  const st = useStore.getState();
  if (!st.settings.notifications) return;
  if (ev.type !== "approval_requested" && ev.type !== "user_input_requested" && ev.type !== "turn_completed") return;
  if (ev.type === "turn_completed" && ev.turn.status !== "completed") return;
  const focused = document.hasFocus();
  if (focused && ev.type === "turn_completed") return;
  // A mod may handle a turn's news itself (review activity Aura handed over, say).
  if (ev.type === "turn_completed" && st.sessions[ev.session_id] && slots.turnToastFilter.list().some((f) => { try { return f.suppress(st.sessions[ev.session_id]); } catch { return false; } })) return;
  if (ev.type === "turn_completed" && quietReportTurn(st, ev.session_id)) return;
  const now = Date.now();
  if (now - lastNotified < 1500) return;
  lastNotified = now;
  const s = st.sessions[ev.session_id];
  const title = s?.title ?? "Aura";
  const body = ev.type === "approval_requested" ? `Approval needed: ${ev.approval.title}` : ev.type === "user_input_requested" ? "Question from the agent" : "Turn finished";
  await desktopNotify(title, body);
}
