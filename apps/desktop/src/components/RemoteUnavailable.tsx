import { useEffect, useState } from "react";
import { useStore } from "../state/store";
import { LOCAL, reconnect, switchComputer, useComputers } from "../state/computers";
import { describeState, formatFingerprint, needsPairing } from "../lib/remoteComputers";

/** The main area while a remote computer is shown but not connected: why, and what to do about it. */
export function RemoteUnavailable({ id }: { id: string }) {
  const remote = useComputers((s) => s.remotes.find((r) => r.id === id));
  const openDialog = useStore((s) => s.openDialog);
  const toast = useStore((s) => s.toast);
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  if (!remote) return null;
  const s = remote.state;
  const title =
    s.kind === "cert_mismatch" ? `${remote.name} shows a different certificate` : s.kind === "revoked" ? `${remote.name} no longer accepts this computer` : s.kind === "retrying" ? `Cannot reach ${remote.name}` : `Connecting to ${remote.name}…`;
  return (
    <div className="empty remote-unavailable" role="status">
      <h2>{title}</h2>
      <span>{describeState(s)}</span>
      {s.kind === "cert_mismatch" && (
        <>
          <span>Aura never connects to a computer whose certificate changed. If it was reset on purpose, pair again with a new code from it; otherwise someone may be in between.</span>
          <code className="mono">paired: {formatFingerprint(s.expected)}</code>
          <code className="mono">now: {formatFingerprint(s.actual)}</code>
        </>
      )}
      <span className="dim mono">{remote.host}:{remote.port}</span>
      <div className="remote-unavailable-actions">
        {needsPairing(s) ? (
          <button type="button" className="btn primary" data-hint onClick={() => openDialog({ kind: "computers", repair: remote.id })}>Pair again…</button>
        ) : (
          <button type="button" className="btn" data-hint onClick={() => void reconnect(remote.id).catch((e: unknown) => toast(String(e), "error"))}>Retry now</button>
        )}
        <button type="button" className="btn" data-hint data-command="computer.local" onClick={() => void switchComputer(LOCAL)}>Show this computer</button>
      </div>
    </div>
  );
}
