/**
 * The update flow as a pure state machine: check, download in the background,
 * wait for the user to restart, install. `updates.ts` runs the side effects
 * and feeds the results back in as actions.
 */

/** Whether this copy of Aura can replace itself (decided by the shell, see src-tauri/src/update.rs). */
export type Support = { kind: "inPlace" } | { kind: "manual"; reason: string };

export type UpdateInfo = {
  version: string;
  currentVersion: string;
  notes: string | null;
  date: string | null;
  /** The release's page: notes and every installer. */
  releaseUrl: string;
  support: Support;
};

export type UpdateErrorKind = "network" | "signature" | "permission" | "daemon" | "other";
export type UpdateError = { kind: UpdateErrorKind; message: string };

/** `manual`: the user asked (the command, the tray, Settings), so the outcome is shown. */
export type Phase =
  | { kind: "idle" }
  | { kind: "checking"; manual: boolean }
  | { kind: "downloading"; manual: boolean; info: UpdateInfo; downloaded: number; total: number | null }
  /** Downloaded and verified; installs when the user restarts. */
  | { kind: "ready"; info: UpdateInfo }
  /** Newer, but this copy cannot replace itself: the user downloads it from the release page. */
  | { kind: "available"; info: UpdateInfo }
  | { kind: "installing"; info: UpdateInfo }
  | { kind: "error"; during: "check" | "download" | "install"; manual: boolean; error: UpdateError; info: UpdateInfo | null };

export type UpdateState = {
  phase: Phase;
  /** The version "Later" hid the banner for, until the next launch or a newer version. */
  dismissed: string | null;
  /** When the last check finished, in ms since the epoch. */
  lastCheck: number | null;
};

export type Action =
  | { type: "check"; manual: boolean }
  | { type: "checked"; info: UpdateInfo | null; at: number }
  | { type: "progress"; downloaded: number; total: number | null }
  | { type: "downloaded" }
  | { type: "install" }
  | { type: "failed"; error: UpdateError }
  | { type: "later" };

export const initialState = (lastCheck: number | null = null): UpdateState => ({ phase: { kind: "idle" }, dismissed: null, lastCheck });

/** The update the phase is about, if any. */
export function infoOf(phase: Phase): UpdateInfo | null {
  return "info" in phase ? phase.info : null;
}

/** A check runs unless one is under way, or a download or install is. */
export function canCheck(phase: Phase): boolean {
  return phase.kind !== "checking" && phase.kind !== "downloading" && phase.kind !== "installing";
}

function manualOf(phase: Phase): boolean {
  return phase.kind === "checking" || phase.kind === "downloading" || phase.kind === "error" ? phase.manual : false;
}

export function reduce(state: UpdateState, action: Action): UpdateState {
  const { phase } = state;
  switch (action.type) {
    case "check": {
      // Asking again shows an update "Later" hid.
      const dismissed = action.manual ? null : state.dismissed;
      if (!canCheck(phase)) {
        // Asking while a background check or download runs makes its outcome shown.
        if (action.manual && (phase.kind === "checking" || phase.kind === "downloading")) return { ...state, dismissed, phase: { ...phase, manual: true } };
        return state;
      }
      return { ...state, dismissed, phase: { kind: "checking", manual: action.manual } };
    }
    case "checked": {
      if (phase.kind !== "checking") return state;
      const { info } = action;
      if (!info) return { ...state, lastCheck: action.at, phase: { kind: "idle" } };
      if (info.support.kind === "manual") return { ...state, lastCheck: action.at, phase: { kind: "available", info } };
      return { ...state, lastCheck: action.at, phase: { kind: "downloading", manual: phase.manual, info, downloaded: 0, total: null } };
    }
    case "progress":
      if (phase.kind !== "downloading") return state;
      return { ...state, phase: { ...phase, downloaded: action.downloaded, total: action.total } };
    case "downloaded":
      if (phase.kind !== "downloading") return state;
      return { ...state, phase: { kind: "ready", info: phase.info } };
    case "install":
      if (phase.kind !== "ready") return state;
      return { ...state, phase: { kind: "installing", info: phase.info } };
    case "failed": {
      const during = phase.kind === "checking" ? "check" : phase.kind === "downloading" ? "download" : phase.kind === "installing" ? "install" : null;
      if (!during) return state;
      // The user started the install, so its failure is always shown.
      const manual = during === "install" || manualOf(phase);
      return { ...state, phase: { kind: "error", during, manual, error: action.error, info: infoOf(phase) } };
    }
    case "later": {
      const info = infoOf(phase);
      return info ? { ...state, dismissed: info.version } : state;
    }
  }
}

/** The banner: an update ready to install or to download by hand, unless "Later" hid it; and the install under way. */
export function bannerOf(state: UpdateState): Phase | null {
  const { phase } = state;
  if (phase.kind === "installing") return phase;
  if (phase.kind === "downloading" && phase.manual) return phase;
  if ((phase.kind === "ready" || phase.kind === "available") && state.dismissed !== phase.info.version) return phase;
  return null;
}

/**
 * Whether a failure is shown to the user. Automatic checks fail quietly (logged
 * only), and so does an automatic download that lost the network: the next
 * check tries again. Anything the user asked for, and a bad signature or a
 * refused install, is shown.
 */
export function showsError(phase: Phase): boolean {
  if (phase.kind !== "error") return false;
  if (phase.manual) return true;
  if (phase.during === "check") return false;
  return phase.error.kind !== "network";
}

/** The message for a failure, with what the user can do about it. */
export function errorMessage(phase: Extract<Phase, { kind: "error" }>): string {
  const what = phase.info ? `Aura ${phase.info.version}` : "the update";
  const lead =
    phase.during === "check" ? "Could not check for updates" : phase.during === "download" ? `Could not download ${what}` : `Could not install ${what}`;
  const hint =
    phase.error.kind === "signature"
      ? " Its signature did not verify, so nothing was installed."
      : phase.error.kind === "permission"
        ? " Aura is not allowed to replace itself here."
        : phase.error.kind === "network"
          ? " Check your connection and try again."
          : "";
  const message = phase.error.message.trim().replace(/\.?$/, ".");
  return `${lead}: ${message}${hint}`;
}

/** Progress as a whole percentage, or null while the size is unknown. */
export function percent(downloaded: number, total: number | null): number | null {
  if (!total || total <= 0) return null;
  return Math.min(100, Math.floor((downloaded / total) * 100));
}
