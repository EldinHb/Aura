/**
 * Other Aura computers this app connects to, as the desktop shell keeps them
 * (apps/desktop/src-tauri/src/remotes.rs): the types, the shell's commands,
 * and reading a pairing link. Device tokens never come here: the shell keeps
 * them in the OS keychain and authenticates on the bridge itself.
 */
import { isTauri } from "./connection";

/** Where the connection to a remote stands (the shell's `LinkState`). */
export type LinkState =
  | { kind: "idle" }
  | { kind: "connecting" }
  | { kind: "online"; serverName: string; version: string }
  /** `retryAt`: epoch milliseconds. */
  | { kind: "retrying"; reason: string; retryAt: number }
  /** The remote no longer accepts this computer. Pair again. */
  | { kind: "revoked"; reason: string }
  /** The remote showed another certificate than the paired one. Never accepted; pair again. */
  | { kind: "cert_mismatch"; expected: string; actual: string };

export type RemoteComputer = {
  /** The remote's server id. */
  id: string;
  /** The user's name for it, or its own. */
  name: string;
  label: string | null;
  serverName: string;
  host: string;
  alt: string[];
  port: number;
  fingerprint: string;
  deviceId: string;
  pairedAt: string;
  state: LinkState;
};

export type PairRequest = {
  host: string;
  port: number;
  fingerprint: string;
  code: string;
  alt: string[];
  /** Pairing again for this remote (its id). */
  replaces?: string | null;
};

/** What a pairing link carries. */
export type PairingLink = PairRequest & { name: string | null };

/** Revoked or a changed certificate: nothing works until the user pairs again. */
export function needsPairing(s: LinkState): boolean {
  return s.kind === "revoked" || s.kind === "cert_mismatch";
}

/** One line for a remote's state. */
export function describeState(s: LinkState, now = Date.now()): string {
  switch (s.kind) {
    case "idle":
      return "Not connected";
    case "connecting":
      return "Connecting…";
    case "online":
      return s.version ? `Connected · Aura ${s.version}` : "Connected";
    case "retrying": {
      const secs = Math.max(0, Math.ceil((s.retryAt - now) / 1000));
      return `Unreachable${s.reason ? `: ${s.reason}` : ""}${secs > 0 ? ` · retrying in ${secs}s` : " · retrying"}`;
    }
    case "revoked":
      return s.reason || "This computer was removed there. Pair again.";
    case "cert_mismatch":
      return "Its certificate changed. Not connected; pair again if you trust the new one.";
  }
}

/** A fingerprint in groups of four, for reading it out against the other screen. */
export function formatFingerprint(fp: string): string {
  return (fp.match(/.{1,4}/g) ?? []).join(" ");
}

/** 64 hex characters after dropping `:`, spaces and dashes, lowercased; null otherwise. */
export function normalizeFingerprint(fp: string): string | null {
  const s = fp.replace(/[:\s-]/g, "").toLowerCase();
  return /^[0-9a-f]{64}$/.test(s) ? s : null;
}

/**
 * Read `aura://pair?host=…&port=…&fp=…&code=…&name=…[&alt=…]`
 * (docs/design/remote.md §3). Throws with what is wrong.
 */
export function parsePairingLink(text: string): PairingLink {
  const raw = text.trim();
  if (!/^aura:\/\/pair\?/i.test(raw)) throw new Error("A pairing link starts with aura://pair?");
  const q = new URLSearchParams(raw.slice(raw.indexOf("?") + 1));
  const host = (q.get("host") ?? "").trim().replace(/^\[|\]$/g, "");
  if (!host) throw new Error("The link has no host");
  const port = Number(q.get("port"));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("The link has no valid port");
  const fingerprint = normalizeFingerprint(q.get("fp") ?? "");
  if (!fingerprint) throw new Error("The link has no valid fingerprint");
  const code = (q.get("code") ?? "").trim();
  if (!code) throw new Error("The link has no pairing code");
  const alt = (q.get("alt") ?? "")
    .split(",")
    .map((a) => a.trim().replace(/^\[|\]$/g, ""))
    .filter((a) => a && a !== host);
  return { host, port, fingerprint, code, alt, name: q.get("name")?.trim() || null };
}

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) throw new Error("Remote computers need the desktop app");
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

/** The shell's commands (apps/desktop/src-tauri/src/remotes.rs). */
export const remotesApi = {
  list: () => invoke<RemoteComputer[]>("remotes_list"),
  deviceName: () => invoke<string>("remote_device_name"),
  pair: (request: PairRequest) => invoke<RemoteComputer>("remote_pair", { request }),
  rename: (id: string, name: string) => invoke<RemoteComputer>("remote_rename", { id, name }),
  remove: (id: string) => invoke<void>("remote_remove", { id }),
  bridge: (id: string) => invoke<{ port: number; token: string }>("remote_bridge", { id }),
  retry: (id: string) => invoke<void>("remote_retry", { id }),
  /** Every change to the list or a state. Returns what stops listening. */
  onChange: async (f: (list: RemoteComputer[]) => void): Promise<() => void> => {
    if (!isTauri()) return () => {};
    const { listen } = await import("@tauri-apps/api/event");
    return listen<RemoteComputer[]>("aura://remotes-changed", (e) => f(e.payload));
  },
};
