import { PullWorkspace } from "./features/reviews/PullWorkspace";
import { registerReviewCommands } from "./features/reviews/state";
import { isHandlingReview, registerWatchCommands, useWatchSync } from "./features/watches/state";
import { unreadChanges, usePullChangeSync, usePullChanges } from "./features/reviews/changes";
import "./features/reviews/reviews.css";
import { useEffect } from "react";
import { useStore, selectSelected, selectVisibleSessions } from "./state/store";
import { useDetectedLinksSync } from "./state/sessionLinkPreferences";
import { connectDaemon, isTauri } from "./lib/connection";
import { useKeyboard } from "./hooks/useKeyboard";
import { registerCoreCommands, setFocus } from "./commands/core";
import { registerGitCommands } from "./commands/git";
import { setCommandErrorHandler } from "./lib/commands";
import { Sidebar } from "./components/Sidebar";
import { StatusBar } from "./components/StatusBar";
import { TerminalView } from "./views/TerminalView";
import { Transcript } from "./views/Transcript";
import { Composer } from "./views/Composer";
import { Inspector } from "./views/Inspector";
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
  usePullChangeSync(windowMode !== "session");
  useDetectedLinksSync();
  const connection = useStore((s) => s.connection);
  const connectionError = useStore((s) => s.connectionError);
  const selected = useStore(selectSelected);
  const session = useStore((s) => s.selectedId ? s.sessions[s.selectedId] : null);
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
    const st = useStore.getState();
    if (!selectedId || !st.client) return;
    const t = st.transcripts[selectedId];
    if (t?.loaded || t?.loading) return;
    st.ensureTranscript(selectedId);
    st.markLoading(selectedId, true);
    st.client
      .history(selectedId)
      .then((events) => useStore.getState().loadHistory(selectedId, events))
      .catch((e) => {
        useStore.getState().markLoading(selectedId, false);
        useStore.getState().toast(`history: ${e instanceof Error ? e.message : e}`, "error");
      });
  }, [selectedId, connection]);

  // Badge with pending count.
  const pending = useStore((s) => Object.values(s.sessions).reduce((n, x) => n + x.pending_count, 0));
  useEffect(() => {
    if (!isTauri()) {
      document.title = pending > 0 ? `(${pending}) Aura` : "Aura";
      return;
    }
    import("@tauri-apps/api/core").then(({ invoke }) => invoke("set_badge", { count: pending })).catch(() => {});
  }, [pending]);

  // Global summon from the tray hotkey opens the inbox when something waits.
  useEffect(() => {
    if (!isTauri()) return;
    let un: (() => void) | undefined;
    import("@tauri-apps/api/event").then(({ listen }) =>
      listen("aura://summon", () => {
        const st = useStore.getState();
        const changed = unreadChanges(usePullChanges.getState().changes, st.settings.pullChangesMuted).length > 0;
        if (changed || Object.values(st.sessions).some((s) => s.pending_count > 0)) st.openDialog({ kind: "inbox" });
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
              <Transcript key={session.id} sessionId={session.id} />
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
  const now = Date.now();
  if (now - lastNotified < 1500) return;
  lastNotified = now;
  const s = st.sessions[ev.session_id];
  const title = s?.title ?? "Aura";
  const body = ev.type === "approval_requested" ? `Approval needed: ${ev.approval.title}` : ev.type === "user_input_requested" ? "Question from the agent" : "Turn finished";
  await desktopNotify(title, body);
}
