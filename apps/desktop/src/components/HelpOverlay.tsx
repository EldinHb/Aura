import { useMemo, useState } from "react";
import { Modal } from "./Modal";
import { allCommands } from "../lib/commands";
import { getKeymap } from "../hooks/useKeyboard";
import { formatKeys } from "../lib/keymap";
import { isMac } from "../lib/platform";
import { useStore } from "../state/store";
import { fuzzyScore } from "../lib/commands";

export type HelpTopic = { id: string; title: string; body: string };

export const HELP_TOPICS: HelpTopic[] = [
  { id: "leader", title: "Leader key menu", body: "Press the leader key (Ctrl+Space by default, change it in Settings) to open a which-key menu. Follow with s for session actions, g for git, m/e/p for model, effort and permission mode, a for the approvals inbox. Escape cancels a pending sequence." },
  { id: "regions", title: "Focus regions", body: "The window has four regions: sidebar, main (transcript or terminal), composer and inspector. Ctrl+H / Ctrl+L move left / right, Ctrl+J focuses the composer, Ctrl+K the main pane. ⌘E focuses the composer, ⌘L the main pane, ⌘⇧E the sidebar. The focused region shows a thin accent border." },
  { id: "lists", title: "Lists and navigation", body: "j / k or the arrow keys move, g g jumps to the first entry, G to the last, Enter opens. ⌘1–⌘9 select the first nine sessions directly, ⌘[ / ⌘] cycle sessions. In the sidebar / filters sessions. In the sidebar j / k step over the workers of other orchestrators: from an orchestrator they go through its workers and out past the last one. → (l in vim mode) shows an orchestrator's workers and steps to the first one, ← (h) steps back to the orchestrator and hides them." },
  { id: "hints", title: "Hint mode", body: "Press f outside an input to label every clickable element with a short home-row combination. Type the label to click it. Escape leaves hint mode. This is the escape hatch for anything without a dedicated key." },
  { id: "terminal", title: "Terminal sessions", body: "Keys go to the terminal. Ctrl+\\ or Escape twice quickly returns focus to Aura. The leader key and ⌘-chords keep working inside the terminal. Switch a Claude / Codex session between its TUI and the structured view with ⌘T." },
  { id: "approvals", title: "Approvals and questions", body: "When an agent asks for permission the session shows a badge. y accepts the oldest pending approval, Y accepts it for the whole session, n declines, e edits the input. ⌘I opens the inbox across all sessions. ⌘Y / ⌘⇧Y work from any region, including inputs." },
  { id: "composer", title: "Composer", body: "Enter sends, Shift+Enter inserts a newline, Ctrl+C interrupts the running turn when the box is empty, Up recalls history, / opens slash commands, @ mentions files, ⌘⇧C interrupts from anywhere." },
  { id: "palette", title: "Command palette", body: "⌘K lists every command with its shortcut. Press ⌥1–9 to run the nth result while typing. Start the query with @ to jump to a session or ? to search this help." },
  { id: "windows", title: "Windows and tray", body: "⌘⇧O opens the selected session in its own window. Closing the main window hides it; the daemon and all sessions keep running. The tray icon and the global shortcut (⌘⇧A) bring Aura back." },
];

export function HelpOverlay() {
  const [q, setQ] = useState("");
  const settings = useStore((s) => s.settings);
  const keymap = getKeymap();
  const groups = useMemo(() => {
    const rows = allCommands()
      .map((c) => ({ c, keys: keymap?.bindingsFor(c.id) ?? [] }))
      .filter((r) => r.keys.length > 0 || !r.c.hidden);
    const m = new Map<string, typeof rows>();
    for (const r of rows.sort((a, b) => a.c.group.localeCompare(b.c.group) || a.c.title.localeCompare(b.c.title))) {
      if (!m.has(r.c.group)) m.set(r.c.group, []);
      m.get(r.c.group)!.push(r);
    }
    return [...m.entries()];
  }, [keymap]);

  const query = q.trim();
  const match = (text: string) => !query || fuzzyScore(text, query) !== null;
  const topics = HELP_TOPICS.filter((t) => match(`${t.title} ${t.body}`));

  return (
    <Modal title={<><span>Keyboard help</span><span className="dim" style={{ marginLeft: "auto", fontWeight: 400 }}>leader: <kbd>{formatKeys(settings.leader, isMac)}</kbd></span></>} width={760} className="help-modal">
      <input data-autofocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search shortcuts and topics…" type="text" />
      <div className="help-columns">
        <div>
          {topics.map((t) => (
            <div key={t.id} className="help-topic">
              <h4>{t.title}</h4>
              <p>{t.body}</p>
            </div>
          ))}
        </div>
        <div>
          {groups.map(([group, rows]) => {
            const visible = rows.filter((r) => match(`${r.c.title} ${group} ${r.keys.join(" ")}`));
            if (visible.length === 0) return null;
            return (
              <div key={group} className="help-group">
                <h4>{group}</h4>
                {visible.map((r) => (
                  <div key={r.c.id} className="help-row">
                    <span className="grow">{r.c.title}</span>
                    <span className="keys">
                      {r.keys.length === 0 && <span className="dim">unbound</span>}
                      {r.keys.map((k) => (
                        <kbd key={k}>{formatKeys(k, isMac)}</kbd>
                      ))}
                    </span>
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      </div>
    </Modal>
  );
}
