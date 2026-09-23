import { useEffect, useMemo, useState } from "react";
import { Modal, KeyList, useListNav } from "../Modal";
import { useStore } from "../../state/store";
import type { SlashCommand } from "../../gen";
import { filterItems } from "../palette";
import { setFocus } from "../../commands/core";
import { acpSessionInfo, acpSlashCommands } from "../../lib/acp";

export function SlashDialog({ sessionId }: { sessionId: string }) {
  const session = useStore((s) => s.sessions[sessionId]);
  const client = useStore((s) => s.client);
  const acpInfo = useStore((s) => acpSessionInfo(s.transcripts[sessionId]?.providerInfo));
  const closeDialog = useStore((s) => s.closeDialog);
  const toast = useStore((s) => s.toast);
  const [q, setQ] = useState("");
  const [cmds, setCmds] = useState<SlashCommand[] | null>(null);
  const [args, setArgs] = useState("");

  useEffect(() => {
    if (!client || !session) return;
    if (session.provider === "acp") {
      setCmds(acpSlashCommands(acpInfo));
      return;
    }
    client.commands(session.provider, session.cwd).then(setCmds).catch(() => setCmds([]));
  }, [client, session, acpInfo]);

  const filtered = useMemo(() => filterItems(cmds ?? [], q, (c) => `${c.name} ${c.description ?? ""}`), [cmds, q]);
  const run = async (i: number) => {
    const c = filtered[i] ?? (q.trim() ? { name: q.trim().replace(/^\//, ""), description: null, source: null } : null);
    if (!c || !client) return;
    try {
      await client.send(sessionId, { text: `/${c.name}${args.trim() ? " " + args.trim() : ""}` });
      closeDialog();
      setFocus("main");
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error");
    }
  };
  const nav = useListNav(Math.max(filtered.length, 1), (i) => void run(i));
  useEffect(() => nav.setIndex(0), [q]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Modal title={`Slash command · ${session?.title ?? ""}`} width={600} onKeyDown={(e) => nav.onKeyDown(e)}>
      <div className="two-col">
        <input type="text" data-autofocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="/command" spellCheck={false} />
        <input type="text" value={args} onChange={(e) => setArgs(e.target.value)} placeholder="arguments" spellCheck={false} />
      </div>
      <div style={{ marginTop: 8 }}>
        {cmds === null ? (
          <div className="dim">Loading…</div>
        ) : (
          <KeyList
            items={filtered.map((c) => ({
              id: c.name,
              command: "slash.run",
              render: (
                <>
                  <span className="grow mono">/{c.name}</span>
                  {c.description && <span className="dim">{c.description}</span>}
                  {c.source && <span className="chip">{c.source}</span>}
                </>
              ),
            }))}
            index={nav.index}
            onSelect={nav.setIndex}
            onActivate={(i) => void run(i)}
            empty={q ? `Press ↩ to send /${q.replace(/^\//, "")}` : "No commands known yet — send one message first"}
          />
        )}
      </div>
    </Modal>
  );
}
