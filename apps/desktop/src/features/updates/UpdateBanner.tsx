import type { Phase } from "./machine";
import { percent } from "./machine";
import { downloadManually, later, openReleaseNotes, restartToUpdate } from "./updates";

/**
 * The update banner, at the top of the toast stack: an update ready to
 * install, one to download by hand, or the install under way. Non-blocking;
 * "Later" hides it until the next launch or a newer version.
 */
export function UpdateBanner({ phase }: { phase: Phase }) {
  if (phase.kind === "installing") {
    return (
      <div className="toast update-banner" data-update="installing">
        <span className="toast-msg">Installing Aura {phase.info.version}… Aura restarts by itself.</span>
      </div>
    );
  }
  if (phase.kind === "downloading") {
    const p = percent(phase.downloaded, phase.total);
    return (
      <div className="toast update-banner" data-update="downloading">
        <span className="toast-msg">
          Downloading Aura {phase.info.version}
          {p === null ? "…" : `… ${p}%`}
        </span>
      </div>
    );
  }
  if (phase.kind !== "ready" && phase.kind !== "available") return null;
  const { info } = phase;
  return (
    <div className="toast update-banner" data-update={phase.kind}>
      <div className="update-text">
        {phase.kind === "ready" ? (
          <span className="toast-msg">
            Aura {info.version} is ready —{" "}
            <button type="button" className="toast-action strong" data-command="updates.restart" onClick={() => void restartToUpdate()}>
              Restart to update
            </button>
          </span>
        ) : (
          <>
            <span className="toast-msg">Update available: Aura {info.version}</span>
            {info.support.kind === "manual" && <span className="update-reason">{info.support.reason}</span>}
          </>
        )}
        <span className="update-actions">
          {phase.kind === "available" && (
            <button type="button" className="toast-action strong" data-hint onClick={downloadManually}>
              Download
            </button>
          )}
          <button type="button" className="toast-action" data-command="updates.release-notes" onClick={openReleaseNotes}>
            Release notes
          </button>
          <button type="button" className="toast-action" data-command="updates.later" onClick={later}>
            Later
          </button>
        </span>
      </div>
    </div>
  );
}
