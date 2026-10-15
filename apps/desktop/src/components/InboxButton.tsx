import { useInboxCount } from "../state/attention";
import { useShortcut } from "../hooks/useKeyboard";
import { runCommand } from "../lib/commands";

/** The top bar's way into the inbox. Always there; its badge counts what the inbox lists and is left out at zero. */
export function InboxButton() {
  const count = useInboxCount();
  const keys = useShortcut("inbox.open");
  const what = count > 0 ? `${count} waiting on you or unread` : "nothing waiting";
  return (
    <button
      type="button"
      className="titlebar-inbox"
      data-hint
      data-command="inbox.open"
      title={`Inbox: ${what}${keys ? ` (${keys})` : ""}`}
      aria-label={count > 0 ? `Inbox, ${count} ${count === 1 ? "item" : "items"}` : "Inbox"}
      onClick={() => void runCommand("inbox.open")}
    >
      <span className="inbox-icon" aria-hidden />
      Inbox
      {count > 0 && <span className="badge">{count}</span>}
    </button>
  );
}
