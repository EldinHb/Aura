/**
 * Runs the update flow (see machine.ts) in the main window: checks 10 s after
 * startup and every 6 hours while "Automatically check for updates" is on (the
 * shell sends the ticks: WebKit throttles a hidden page's own timers),
 * and when asked (command palette, tray menu, Settings); downloads in the
 * background; installs when the user restarts. The shell does the work
 * (src-tauri/src/update.rs) and stops the daemon before installing.
 */
import { useEffect } from "react";
import { create } from "zustand";
import { registerCommands } from "../../lib/commands";
import { appLog, describe } from "../../lib/appLog";
import { isTauri } from "../../lib/connection";
import { useStore } from "../../state/store";
import {
  bannerOf,
  canCheck,
  errorMessage,
  initialState,
  reduce,
  showsError,
  type Action,
  type Phase,
  type Support,
  type UpdateError,
  type UpdateInfo,
  type UpdateState,
} from "./machine";

const LAST_CHECK_KEY = "aura.updates.lastCheck";

export type UpdateConfig = {
  currentVersion: string;
  /** Release builds check by themselves; development builds only when asked. */
  autoCheck: boolean;
  support: Support;
  releasesUrl: string;
  /** Test builds only: restart as soon as the update is ready. */
  testAutoRestart: boolean;
  /** The first automatic check is already due (the page was reloaded after it). */
  firstCheckPassed: boolean;
};

/** How an install that ran without the app ended (Windows: the installer helper). */
export type InstallResult = {
  /** The version that was being installed. */
  version: string;
  /** The installer reported success. */
  ok: boolean;
  message: string | null;
  /** The version the installed app, aurad and aura all report, when they agree. */
  installed_version?: string | null;
  /** Those agree and the app's resources are there: Aura is whole. */
  complete?: boolean;
};

/** What to tell the user about an install that ran without the app: a failed
 * installer is not a rollback, so this says what the helper found installed. */
export function describeInstall(r: InstallResult): { level: "info" | "error"; message: string } {
  const why = (r.message ?? "the installer did not finish").replace(/\.?$/, ".");
  if (r.complete === false) {
    return { level: "error", message: "The update didn't finish — Aura may be incomplete. Download and run the installer again." };
  }
  const found = r.installed_version ?? null;
  if (found === r.version) return { level: "info", message: `Aura was updated to ${r.version}` };
  if (found) return { level: "error", message: `Could not install Aura ${r.version}: ${why} Aura is on version ${found}.` };
  // A result without the check (written before it existed).
  return r.ok ? { level: "info", message: `Aura was updated to ${r.version}` } : { level: "error", message: `Could not install Aura ${r.version}: ${why}` };
}

export type DownloadEvent = { event: "progress"; downloaded: number; total: number | null } | { event: "finished" };

/** The side effects, so tests can stand in for the shell. */
export type UpdaterDeps = {
  config: () => Promise<UpdateConfig>;
  check: () => Promise<UpdateInfo | null>;
  download: (onEvent: (e: DownloadEvent) => void) => Promise<void>;
  install: () => Promise<void>;
  /** How the last install that ran without the app ended, once; null if none did. */
  lastResult: () => Promise<InstallResult | null>;
  relaunch: () => Promise<void>;
  openUrl: (url: string) => Promise<void>;
  now: () => number;
  /** Call `tick` when an automatic check is due; returns what stops it. */
  onTick: (tick: () => void) => () => void;
  log: (message: string, error?: unknown) => void;
};

type UpdatesStore = { state: UpdateState; config: UpdateConfig | null };

export const useUpdates = create<UpdatesStore>(() => ({ state: initialState(loadLastCheck()), config: null }));

let deps: UpdaterDeps | null = null;

const st = () => useUpdates.getState().state;
const app = () => useStore.getState();

function dispatch(action: Action) {
  useUpdates.setState((s) => ({ state: reduce(s.state, action) }));
}

function loadLastCheck(): number | null {
  try {
    const n = Number(localStorage.getItem(LAST_CHECK_KEY));
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

function saveLastCheck(at: number | null) {
  try {
    if (at) localStorage.setItem(LAST_CHECK_KEY, String(at));
  } catch {
    /* ignore */
  }
}

/** The shell rejects with `{ kind, message }`; anything else is phrased as an unknown error. */
export function toUpdateError(e: unknown): UpdateError {
  if (e && typeof e === "object" && "message" in e && typeof (e as { message: unknown }).message === "string") {
    const kind = (e as { kind?: unknown }).kind;
    const known = ["network", "signature", "permission", "daemon", "other"] as const;
    return { kind: known.find((k) => k === kind) ?? "other", message: (e as { message: string }).message };
  }
  return { kind: "other", message: String(e) };
}

function releasesUrl(): string {
  return useUpdates.getState().config?.releasesUrl ?? "https://github.com/EldinHb/Aura/releases";
}

export function downloadManually() {
  void openUrl(`${releasesUrl()}/latest`);
}

/** The notes of the update found, or of the latest release. */
export function openReleaseNotes() {
  const phase = st().phase;
  void openUrl("info" in phase && phase.info ? phase.info.releaseUrl : `${releasesUrl()}/latest`);
}

async function openUrl(url: string) {
  try {
    await deps?.openUrl(url);
  } catch (e) {
    app().toast(`Could not open ${url}: ${String(e)}`, "error");
  }
}

function fail(e: unknown) {
  const before = st().phase;
  const error = toUpdateError(e);
  dispatch({ type: "failed", error });
  const after = st().phase;
  // A failed check with an update already downloaded goes back to it; asked for, the failure is still shown.
  const phase: Phase | null =
    after.kind === "error" ? after : before.kind === "checking" ? { kind: "error", during: "check", manual: before.manual, error, info: null } : null;
  if (phase?.kind !== "error") return;
  deps?.log(`update ${phase.during} failed (${phase.manual ? "asked" : "automatic"})`, phase.error);
  if (showsError(phase)) app().toast(errorMessage(phase), "error", { actions: [{ label: "Download manually", run: downloadManually }] });
}

/** Check for a newer version; when one is found and this copy can install it, download it in the background. */
export async function checkForUpdates(manual = false): Promise<void> {
  if (!deps) {
    if (manual) app().toast("Updates are only available in the Aura app", "warn");
    return;
  }
  const phase = st().phase;
  if (!canCheck(phase)) {
    dispatch({ type: "check", manual });
    if (manual) app().toast(phase.kind === "installing" ? "Aura is installing an update" : "Already checking for updates");
    return;
  }
  dispatch({ type: "check", manual });
  let info: UpdateInfo | null;
  try {
    info = await deps.check();
  } catch (e) {
    fail(e);
    return;
  }
  dispatch({ type: "checked", info, at: deps.now() });
  saveLastCheck(st().lastCheck);
  if (!info) {
    const current = useUpdates.getState().config?.currentVersion;
    if (st().phase.kind === "idle" && manual) app().toast(`You're up to date${current ? ` (Aura ${current})` : ""}`);
    return;
  }
  // Asked by hand while the same version waits for the restart: the banner says so.
  if (manual && st().phase.kind === "ready") app().toast(`Aura ${info.version} is ready; restart to update`);
  deps.log(`Aura ${info.version} is available`);
  if (st().phase.kind === "downloading") await download();
}

async function download() {
  if (!deps) return;
  try {
    await deps.download((e) => {
      if (e.event === "progress") dispatch({ type: "progress", downloaded: e.downloaded, total: e.total });
    });
  } catch (e) {
    fail(e);
    return;
  }
  dispatch({ type: "downloaded" });
  if (st().phase.kind === "ready" && useUpdates.getState().config?.testAutoRestart) await restartToUpdate();
}

function workingSessions(): number {
  return Object.values(app().sessions).filter((s) => s.status === "running").length;
}

/** Install the downloaded update and relaunch; asks first while sessions work. */
export async function restartToUpdate(): Promise<void> {
  const phase = st().phase;
  if (phase.kind !== "ready") {
    app().toast(
      phase.kind === "available"
        ? "This copy of Aura cannot update itself; download the update from the release page"
        : phase.kind === "checking" && phase.ready
          ? "Checking for a newer version first; try again in a moment"
          : "No update is ready to install",
      "warn",
    );
    return;
  }
  const working = workingSessions();
  if (working === 0) return install();
  app().openDialog({
    kind: "confirm",
    title: `Restart to update to Aura ${phase.info.version}?`,
    message: `${working === 1 ? "1 session is" : `${working} sessions are`} working. ${working === 1 ? "It is" : "They are"} paused while Aura updates and ${working === 1 ? "resumes" : "resume"} when Aura restarts.`,
    onConfirm: () => void install(),
  });
}

async function install() {
  if (!deps || st().phase.kind !== "ready") return;
  dispatch({ type: "install" });
  try {
    // Stops the daemon and installs. On Windows the installer takes over and Aura exits here.
    await deps.install();
  } catch (e) {
    fail(e);
    return;
  }
  try {
    await deps.relaunch();
  } catch (e) {
    fail({ kind: "other", message: `Aura was updated but could not restart (${String(e)}). Quit Aura and open it again` });
  }
}

/** After the Windows installer ran (and the helper started Aura again): say how it went. */
async function reportLastInstall(d: UpdaterDeps) {
  let result: InstallResult | null;
  try {
    result = await d.lastResult();
  } catch (e) {
    d.log("could not read the last install's result", e);
    return;
  }
  if (!result) return d.log("no install ran without the app since the last start");
  const told = describeInstall(result);
  d.log(
    `the install of Aura ${result.version}: installer ${result.ok ? "succeeded" : "failed"}, installed ${result.installed_version ?? "unknown"}, ${result.complete === false ? "incomplete" : "complete"}`,
    result.message ?? undefined,
  );
  if (told.level === "info") app().toast(told.message);
  else app().toast(told.message, "error", { actions: [{ label: "Download manually", run: downloadManually }] });
}

/** "Later": hide the banner until the next launch or a newer version. */
export function later() {
  dispatch({ type: "later" });
}

/** The updater for the app, backed by the shell. */
export function tauriDeps(): UpdaterDeps {
  const core = () => import("@tauri-apps/api/core");
  return {
    config: async () => (await core()).invoke<UpdateConfig>("update_config"),
    check: async () => (await core()).invoke<UpdateInfo | null>("update_check"),
    download: async (onEvent) => {
      const { Channel, invoke } = await core();
      const channel = new Channel<DownloadEvent>();
      channel.onmessage = onEvent;
      await invoke("update_download", { onEvent: channel });
    },
    install: async () => (await core()).invoke("update_install"),
    lastResult: async () => (await core()).invoke<InstallResult | null>("update_last_result"),
    relaunch: async () => (await import("@tauri-apps/plugin-process")).relaunch(),
    openUrl: async (url) => (await import("@tauri-apps/plugin-shell")).open(url),
    now: () => Date.now(),
    onTick: (tick) => {
      let stopped = false;
      let unlisten: (() => void) | undefined;
      void import("@tauri-apps/api/event").then(({ listen }) =>
        listen("aura://update-tick", tick).then((u) => (stopped ? u() : (unlisten = u))),
      );
      return () => {
        stopped = true;
        unlisten?.();
      };
    },
    log: (message, error) => {
      if (error === undefined) console.info(`[updates] ${message}`);
      else console.warn(`[updates] ${message}`, error);
      // Into the app's log file too: the webview's console is kept nowhere.
      appLog(error === undefined ? "info" : "warn", error === undefined ? `updates: ${message}` : `updates: ${message}: ${describe(error)}`);
    },
  };
}

/**
 * Start checking on the shell's ticks (10 s after it started, then every 6
 * hours) while the setting is on and the build allows it. Returns the cleanup.
 */
export async function startUpdates(d: UpdaterDeps): Promise<() => void> {
  deps = d;
  let config: UpdateConfig;
  try {
    config = await d.config();
  } catch (e) {
    d.log("could not read the update configuration", e);
    return () => {};
  }
  useUpdates.setState({ config });
  d.log(`Aura ${config.currentVersion}; ${config.autoCheck ? "checking for updates by itself" : "a development build: checking only when asked"}`);
  await reportLastInstall(d);
  const auto = () => config.autoCheck && app().settings.autoCheckUpdates;
  const tick = () => {
    if (!auto()) return d.log("automatic check skipped: turned off in Settings");
    d.log("automatic check");
    void checkForUpdates(false);
  };
  const stop = d.onTick(tick);
  if (config.firstCheckPassed) tick();
  return stop;
}

/** For tests: forget the updater and its state. */
export function resetUpdates() {
  deps = null;
  useUpdates.setState({ state: initialState(), config: null });
}

export function registerUpdateCommands() {
  return registerCommands([
    { id: "updates.check", title: "Check for updates", group: "Aura", keywords: ["update", "upgrade", "new version", "release"], run: () => checkForUpdates(true) },
    { id: "updates.restart", title: "Restart to update", group: "Aura", keywords: ["update", "upgrade", "install", "relaunch"], run: () => restartToUpdate() },
    { id: "updates.release-notes", title: "Release notes", group: "Aura", keywords: ["update", "changelog", "what's new", "version"], run: () => openReleaseNotes() },
    { id: "updates.later", title: "Hide the update banner until the next launch", group: "Aura", hidden: true, run: () => later() },
  ]);
}

/** Run the updater in this window: the main window, once. */
export function useUpdateChecks(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    const offCommands = registerUpdateCommands();
    if (!isTauri()) return offCommands;
    let stop: (() => void) | undefined;
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void startUpdates(tauriDeps()).then((s) => (cancelled ? s() : (stop = s)));
    // The tray's "Check for Updates…".
    void import("@tauri-apps/api/event").then(({ listen }) =>
      listen("aura://check-updates", () => void checkForUpdates(true)).then((u) => (cancelled ? u() : (unlisten = u))),
    );
    return () => {
      cancelled = true;
      offCommands();
      stop?.();
      unlisten?.();
    };
  }, [enabled]);
}

export const useUpdateBanner = () => useUpdates((s) => bannerOf(s.state));
