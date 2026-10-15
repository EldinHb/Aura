import { useStore, selectPendingCount, selectSelected } from "../state/store";
import { formatKeys } from "../lib/keymap";
import { isMac, fmtTokens } from "../lib/platform";
import { StatusBarBranch } from "./BranchStatus";
import { useShortcut } from "../hooks/useKeyboard";

export function StatusBar() {
  const connection = useStore((s) => s.connection);
  const pending = useStore(selectPendingCount);
  const s = useStore(selectSelected);
  const leader = useStore((s) => s.settings.leader);
  const focus = useStore((s) => s.focus);
  const version = useStore((s) => s.daemonVersion);
  const inboxKeys = useShortcut("inbox.open");
  const paletteKeys = useShortcut("palette.open");
  const helpKeys = useShortcut("help.open");
  return (
    <div className="statusbar" data-region="statusbar">
      <span className={`dot ${connection === "open" ? "ok" : connection === "connecting" ? "warn pulse" : "err"}`} title={`daemon ${connection}`} />
      <span>{connection === "open" ? `daemon ${version ?? ""}` : connection}</span>
      {pending > 0 && (
        <span>
          <span className="badge">{pending}</span> waiting {inboxKeys && <kbd>{inboxKeys}</kbd>}
        </span>
      )}
      {s && (
        <span>
          {s.agent ?? s.provider} · {s.mode} · {s.status}
          {s.model ? ` · ${s.model}` : ""}
          {s.effort ? ` · ${s.effort}` : ""}
          {s.permission_mode ? ` · ${s.permission_mode}` : ""}
          {s.usage.context_used ? ` · ctx ${fmtTokens(s.usage.context_used)}${s.usage.context_window ? `/${fmtTokens(s.usage.context_window)}` : ""}` : ""}
          {s.usage.total_cost_usd ? ` · $${s.usage.total_cost_usd.toFixed(2)}` : ""}
        </span>
      )}
      {s && <StatusBarBranch session={s} />}
      <span className="spacer" />
      <span>focus: {focus}</span>
      <span>
        <kbd>{formatKeys(leader, isMac)}</kbd> menu {paletteKeys && <><kbd>{paletteKeys}</kbd> commands </>}{helpKeys && <><kbd>{helpKeys}</kbd> help</>}
      </span>
    </div>
  );
}
