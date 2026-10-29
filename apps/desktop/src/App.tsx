import { PullWorkspace } from "./features/reviews/PullWorkspace";
import { registerReviewCommands } from "./features/reviews/state";
import { isHandlingReview, registerWatchCommands, useWatchSync } from "./features/watches/state";
import { usePullChangeSync } from "./features/reviews/changes";
import "./features/reviews/reviews.css";
import { useEffect } from "react";
import { useStore, selectSelected, selectVisibleSessions } from "./state/store";
import { useDetectedLinksSync } from "./state/sessionLinkPreferences";
import { inboxCount, quietReportTurn, useInboxCount, useMarkViewedSeen } from "./state/attention";
import { connectDaemon, isTauri } from "./lib/connection";
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
import { setFeatures, setRoleSuggestions } from "./state/features";
import { Overlays } from "./components/Overlays";
import { isMac } from "./lib/platform";
import { desktopNotify } from "./lib/notify";
import clsx from "clsx";
import type { Event } from "./gen";

const params = new URLSearchParams(location.search);
const windowMode = params.get("window"); // "session" for a detached single-session window
const initialSession = params.get("session");

export default function App() {
  useKeyboard();
  // Detached session windows would announce every review a second time.
  useWatchSync(windowMode !== "session");
  // Every window keeps the changes for its inbox count; only the main one announces them.
  usePullChangeSync(windowMode !== "session");
  useDetectedLinksSync();
  useMarkViewedSeen();
  const inbox = useInboxCount();
  const connection = useStore((s) => s.connection);
  const connectionError = useStore((s) => s.connectionError);
  const selected = useStore(selectSelected);
  const session = useStore((s) => s.selectedId ? s.sessions[s.selectedId] : null);
  // An orchestrator showing its threads with its workers rather than its chat.
  const threads = useWorkerThreads((s) => (session?.orchestrator ? s.views[session.id]?.tab === "workers" : false));
  // A feature owner showing its team, which the user opened.
  const team = useWorkerThreads((s) => (session?.feature_owner ? s.views[session.id]?.tab === "team" : false));
  const prMode = useStore((s) => !!s.prSelection || s.reviewHistoryOpen);
  const sidebarCollapsed = useStore((s) => s.sidebarCollapsed) || windowMode === "session";
  const inspectorOpen = useStore((s) => s.inspectorOpen) && windowMode !== "session" && !prMode;
  const focus = useStore((s) => s.focus);
  const theme = useStore((s) => s.settings.theme);
  const fontSize = useStore((s) => s.settings.fontSize);

  useEffect(() => {
    // Native controls (select menus, scrollbars, checkboxes) follow the window appearance, not our CSS, so pin the
    // window to the chosen theme; "system" releases it and then tracks the OS as it changes.
    if (isTauri()) import("@tauri-apps/api/window").then(({ getCurrentWindow }) => getCurrentWindow().setTheme(theme === "system" ? null : theme)).catch(() => {});
    const media = matchMedia("(prefers-color-scheme: light)");
    const apply = () => { document.documentElement.dataset.theme = theme === "system" ? (media.matches ? "light" : "dark") : theme; };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme]);

  useEffect(() => {
    document.documentElement.style.setProperty("--font-size", `${fontSize}px`);
  }, [fontSize]);

  useEffect(() => {
    setCommandErrorHandler((msg) => useStore.getState().toast(msg, "error"));
    registerGitCommands();
    const offCore = registerCoreCommands();
    const offReviews = registerReviewCommands();
    const offWatches = registerWatchCommands();
    return () => { offCore(); offReviews(); offWatches(); };
  }, []);

  // Connect + subscribe.
  useEffect(() => {
    let cancelled = false;
    let offEvent: (() => void) | null = null;
    let offState: (() => void) | null = null;
    let offFocus: (() => void) | null = null;
    const st = useStore.getState;
    (async () => {
      try {
        st().setConnection("connecting");
        const client = await connectDaemon();
        if (cancelled) return client.close();
        st().setClient(client);
        st().setConnection("open");
        const refresh = async () => {
          const [providers, sessions, info] = await Promise.all([client.providers(), client.sessions(), client.daemonInfo()]);
          st().setProviders(providers);
          st().setSessions(sessions);
          useStore.setState({ daemonVersion: info.version });
          // A daemon from before feature owners has none to list.
          client.features().then(setFeatures, () => {});
          client.roleSuggestions().then(setRoleSuggestions, () => {});
          if (initialSession && sessions.some((s) => s.id === initialSession)) st().select(initialSession);
          else if (!st().selectedId && !st().prSelection && !st().reviewHistoryOpen && sessions.length > 0 && windowMode !== "session") { const first = selectVisibleSessions(st())[0]; if (first) st().select(first.id); }
        };
        await refresh();
        offEvent = client.onEvent((ev: Event) => {
          st().applyEvent(ev);
          notifyIfNeeded(ev);
        });
        offState = client.onState((s) => {
          st().setConnection(s);
          if (s === "open") void refresh();
        });
        // Provider CLIs are upgraded outside Aura, so re-read them whenever the
        // window comes back rather than trusting what we saw at connect. Only
        // the provider list — a full refresh would re-apply the initial session
        // selection and yank the user off whatever they had selected.
        const onWindowFocus = () => {
          client
            .providers()
            .then((ps) => st().setProviders(ps))
            .catch(() => {});
        };
        window.addEventListener("focus", onWindowFocus);
        offFocus = () => window.removeEventListener("focus", onWindowFocus);
      } catch (e) {
        st().setConnection("closed", e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
      offEvent?.();
      offState?.();
      offFocus?.();
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
        <InboxButton />
        <span className="conn">
          <span className={`dot ${connection === "open" ? "ok" : connection === "connecting" ? "warn pulse" : "err"}`} />
          {connection}
        </span>
      </div>
      <div className={clsx("body", sidebarCollapsed && "no-sidebar", !inspectorOpen && "no-inspector")}>
        {!sidebarCollapsed && <Sidebar />}
        <div className={clsx("region main", (focus === "main" || focus === "composer") && "focused")} data-region="main" tabIndex={-1}>
          {prMode && <PullWorkspace />}
          <div className="session-workspace" hidden={prMode}>
          {connection !== "open" && !session ? (
            <div className="empty">
              <h2>{connection === "connecting" ? "Connecting to the Aura daemon…" : "Not connected"}</h2>
              {connectionError && <code>{connectionError}</code>}
              {connection === "closed" && <span>Start it with <code>aura daemon start</code>, then reload with <kbd>⌘R</kbd>.</span>}
            </div>
          ) : !session ? (
            <div className="empty">
              <h2>Aura</h2>
              <div className="hint">
                <span><kbd>⌘N</kbd> new session</span>
                <span><kbd>⌘K</kbd> commands</span>
                <span><kbd>Ctrl+Space</kbd> menu</span>
                <span><kbd>?</kbd> help</span>
              </div>
            </div>
          ) : session.mode === "terminal" ? (
            <TerminalView key={session.id} sessionId={session.id} />
          ) : (
            <>
              {session.orchestrator && <OrchestratorTabs orchestratorId={session.id} />}
              {team ? <TeamView key={`t-${session.id}`} ownerId={session.id} /> : threads ? <WorkerThreads key={`w-${session.id}`} orchestratorId={session.id} /> : <Transcript key={session.id} sessionId={session.id} />}
              <Composer key={`c-${session.id}`} sessionId={session.id} />
            </>
          )}
          </div>
        </div>
        {inspectorOpen && <Inspector sessionId={selectedId} />}
      </div>
      <StatusBar />
      <Overlays />
    </div>
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
  // A turn on review activity Aura handed over gets its own notification.
  if (ev.type === "turn_completed" && isHandlingReview(ev.session_id)) return;
  if (ev.type === "turn_completed" && quietReportTurn(st, ev.session_id)) return;
  const now = Date.now();
  if (now - lastNotified < 1500) return;
  lastNotified = now;
  const s = st.sessions[ev.session_id];
  const title = s?.title ?? "Aura";
  const body = ev.type === "approval_requested" ? `Approval needed: ${ev.approval.title}` : ev.type === "user_input_requested" ? "Question from the agent" : "Turn finished";
  await desktopNotify(title, body);
}
