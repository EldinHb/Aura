import { useEffect, useMemo, useState } from "react";
import { physicalKey } from "../../lib/keymap";
import { Modal, KeyList, useListNav } from "../Modal";
import { useStore } from "../../state/store";
import type { NativeSession, ProviderKind, SessionMode } from "../../gen";
import { filterItems } from "../palette";
import { relTime, basename } from "../../lib/platform";
import { setFocus } from "../../commands/core";
import clsx from "clsx";

const TABS: ProviderKind[] = ["claude", "codex"];

export function ImportDialog() {
  const client = useStore((s) => s.client);
  const providers = useStore((s) => s.providers);
  const sessions = useStore((s) => s.sessions);
  const closeDialog = useStore((s) => s.closeDialog);
  const toast = useStore((s) => s.toast);
  const select = useStore((s) => s.select);
  const [tab, setTab] = useState<ProviderKind>("claude");
  const [q, setQ] = useState("");
  const [list, setList] = useState<NativeSession[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const tabs = TABS.filter((t) => providers.some((p) => p.kind === t && p.available));

  useEffect(() => {
    if (!client) return;
    setList(null);
    setError(null);
    let cancelled = false;
    client
      .nativeSessions(tab)
      .then((l) => !cancelled && setList(l))
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
    };
  }, [client, tab]);

  const imported = useMemo(() => new Set(Object.values(sessions).map((s) => s.native_id).filter(Boolean)), [sessions]);
  const filtered = useMemo(() => filterItems(list ?? [], q, (n) => `${n.title ?? ""} ${n.preview ?? ""} ${n.cwd ?? ""} ${n.native_id}`), [list, q]);

  const doImport = async (i: number, mode: SessionMode) => {
    const n = filtered[i];
    if (!n || !client || busy) return;
    setBusy(true);
    try {
      const existing = Object.values(sessions).find((s) => s.native_id === n.native_id);
      if (existing) {
        select(existing.id);
        closeDialog();
        setFocus("main");
        return;
      }
      const home = (await client.home()) ?? "/";
      const s = await client.createSession({ provider: tab, cwd: n.cwd ?? home, title: n.title ?? null, resume_native_id: n.native_id, mode });
      select(s.id);
      closeDialog();
      setFocus("main");
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error");
    } finally {
      setBusy(false);
    }
  };
  const nav = useListNav(filtered.length, (i) => void doImport(i, "structured"));
  useEffect(() => nav.setIndex(0), [q, tab]); // eslint-disable-line react-hooks/exhaustive-deps

  const cycleTab = (d: number) => {
    const i = tabs.indexOf(tab);
    setTab(tabs[(i + d + tabs.length) % tabs.length] ?? tab);
  };

  return (
    <Modal
      title={
        <>
          <span>Import existing sessions</span>
          <div className="tabs inline" style={{ marginLeft: "auto" }}>
            {tabs.map((t, i) => (
              <button key={t} type="button" className={clsx("tab", tab === t && "active")} data-command="import.tab" onClick={() => setTab(t)}>
                {t} <kbd>{i + 1}</kbd>
              </button>
            ))}
          </div>
        </>
      }
      width={720}
      onKeyDown={(e) => {
        const inInput = (e.target as HTMLElement).tagName === "INPUT";
        // Option rewrites e.key on macOS (⌥1 is "¡", ⌥T is "†"), so read the physical key there.
        const k = e.altKey ? physicalKey(e) : e.key;
        if (e.key === "ArrowLeft" && !inInput) return cycleTab(-1);
        if (e.key === "ArrowRight" && !inInput) return cycleTab(1);
        if ((k === "1" || k === "2") && (e.altKey || !inInput)) {
          const t = tabs[Number(k) - 1];
          if (t) {
            e.preventDefault();
            setTab(t);
          }
          return;
        }
        if (k === "t" && (e.altKey || !inInput)) {
          e.preventDefault();
          void doImport(nav.index, "terminal");
          return;
        }
        if (e.key === "Enter" && e.altKey) {
          e.preventDefault();
          void doImport(nav.index, "terminal");
          return;
        }
        nav.onKeyDown(e);
      }}
      footer={
        <>
          <span className="dim" style={{ marginRight: "auto", alignSelf: "center" }}>
            <kbd>↩</kbd> import (structured) · <kbd>⌥↩</kbd>/<kbd>⌥T</kbd> import into terminal · <kbd>←→</kbd> provider
          </span>
          <button type="button" className="btn" data-command="dialog.cancel" onClick={closeDialog}>Close</button>
        </>
      }
    >
      <input type="text" data-autofocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter by title, path…" />
      <div style={{ marginTop: 8 }}>
        {error && <div style={{ color: "var(--err)" }}>{error}</div>}
        {list === null && !error ? (
          <div className="dim">Loading {tab} sessions…</div>
        ) : (
          <KeyList
            items={filtered.map((n) => ({
              id: n.native_id,
              command: "import.session",
              render: (
                <>
                  <div className="grow" style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{n.title || n.preview || n.native_id}</span>
                    <span className="dim">{n.cwd ? basename(n.cwd) + " · " + n.cwd : n.native_id}</span>
                  </div>
                  {imported.has(n.native_id) && <span className="chip">imported</span>}
                  <span className="dim">{n.updated_at ? relTime(n.updated_at) : ""}</span>
                </>
              ),
            }))}
            index={nav.index}
            onSelect={nav.setIndex}
            onActivate={(i) => void doImport(i, "structured")}
            empty={q ? "No sessions match" : `No ${tab} sessions found on this machine`}
          />
        )}
      </div>
    </Modal>
  );
}
