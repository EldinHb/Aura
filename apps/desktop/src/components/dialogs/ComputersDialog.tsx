import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import clsx from "clsx";
import { Modal } from "../Modal";
import { useStore } from "../../state/store";
import { reconnect, switchComputer, useComputers } from "../../state/computers";
import {
  describeState,
  formatFingerprint,
  needsPairing,
  normalizeFingerprint,
  parsePairingLink,
  remotesApi,
  type RemoteComputer,
} from "../../lib/remoteComputers";
import { setFocus } from "../../commands/core";

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** A remote's state as a dot, like the connection dot in the title bar. */
export function StateDot({ remote }: { remote: RemoteComputer }) {
  const k = remote.state.kind;
  const cls = k === "online" ? "ok" : k === "connecting" ? "warn pulse" : k === "retrying" ? "warn" : needsPairing(remote.state) ? "err" : "";
  return <span className={clsx("dot", cls)} role="img" aria-label={describeState(remote.state)} />;
}

/**
 * Remote computers: the paired ones (show, rename, pair again, retry, remove)
 * and pairing a new one from its aura://pair link or by hand. `add` opens on
 * the pairing form; `repair` on pairing again with that remote.
 */
export function ComputersDialog({ add, repair }: { add?: boolean; repair?: string }) {
  const remotes = useComputers((s) => s.remotes);
  const [pairing, setPairing] = useState<{ replaces: string | null } | null>(add ? { replaces: null } : repair ? { replaces: repair } : null);
  if (pairing) return <PairForm replaces={pairing.replaces} onDone={() => setPairing(null)} remotes={remotes} startedFromList={!add && !repair} />;
  return <RemoteList remotes={remotes} onAdd={() => setPairing({ replaces: null })} onRepair={(id) => setPairing({ replaces: id })} />;
}

function RemoteList({ remotes, onAdd, onRepair }: { remotes: RemoteComputer[]; onAdd: () => void; onRepair: (id: string) => void }) {
  const closeDialog = useStore((s) => s.closeDialog);
  const openDialog = useStore((s) => s.openDialog);
  const toast = useStore((s) => s.toast);
  const shown = useStore((s) => s.computer);
  const [idx, setIdx] = useState(0);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [, tick] = useState(0);
  // The "retrying in" countdowns.
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => setIdx((i) => Math.min(i, Math.max(0, remotes.length - 1))), [remotes.length]);
  const cur = remotes[idx];

  const show = (r: RemoteComputer) => {
    closeDialog();
    void switchComputer(r.id).catch((e: unknown) => toast(errorText(e), "error"));
    setFocus("sidebar");
  };
  const remove = (r: RemoteComputer) =>
    openDialog({
      kind: "confirm",
      title: `Remove ${r.name}?`,
      message: `This computer forgets ${r.name} and its key. ${r.name} still lists this computer under its paired devices until you remove it there (Settings → Remote access).`,
      danger: true,
      confirmLabel: "Remove",
      focusCancel: true,
      onConfirm: () => {
        remotesApi.remove(r.id).then(
          () => {
            toast(`Removed ${r.name}`);
            openDialog({ kind: "computers" });
          },
          (e: unknown) => toast(`Could not remove ${r.name}: ${errorText(e)}`, "error"),
        );
      },
    });
  const saveName = async (r: RemoteComputer) => {
    try {
      await remotesApi.rename(r.id, name);
      setRenaming(null);
    } catch (e) {
      toast(errorText(e), "error");
    }
  };
  const retry = (r: RemoteComputer) => void reconnect(r.id).catch((e: unknown) => toast(errorText(e), "error"));

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (renaming || (e.target as HTMLElement).tagName === "INPUT") return;
    const k = e.key;
    if (k === "ArrowDown" || k === "j") setIdx((i) => Math.min(remotes.length - 1, i + 1));
    else if (k === "ArrowUp" || k === "k") setIdx((i) => Math.max(0, i - 1));
    else if (k === "Enter" && cur && !needsPairing(cur.state)) show(cur);
    else if (k === "r" && cur) {
      setName(cur.label ?? cur.name);
      setRenaming(cur.id);
    } else if (k === "p" && cur) onRepair(cur.id);
    else if (k === "t" && cur) retry(cur);
    else if ((k === "Delete" || k === "Backspace" || k === "x") && cur) remove(cur);
    else if (k === "a" || k === "n") onAdd();
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <Modal
      title={
        <>
          <span>Remote computers</span>
          <span className="dim" style={{ marginLeft: "auto", fontWeight: 400, fontSize: 11 }}>
            <kbd>↩</kbd> show <kbd>r</kbd> rename <kbd>p</kbd> pair again <kbd>t</kbd> retry <kbd>x</kbd> remove <kbd>a</kbd> add
          </span>
        </>
      }
      width={680}
      className="computers-dialog"
      onKeyDown={onKeyDown}
      footer={
        <>
          <button type="button" className="btn" data-command="dialog.cancel" onClick={closeDialog}>Close <kbd>Esc</kbd></button>
          <button type="button" className="btn primary" data-command="computer.add" onClick={onAdd}>Add remote computer… <kbd>a</kbd></button>
        </>
      }
    >
      <p className="dim" style={{ marginTop: 0 }}>
        Other computers running Aura, used from here as from the phone app: their sessions, transcripts and inbox. Turn on remote access there (Settings → Remote access) and pair with the link it shows. Settings, mods and terminals always stay this computer's.
      </p>
      <div className="list computers-list" data-autofocus tabIndex={0} role="listbox" aria-label="Remote computers">
        {remotes.length === 0 && (
          <div className="empty" style={{ height: "auto", padding: 24 }}>
            <span>No remote computers yet.</span>
          </div>
        )}
        {remotes.map((r, i) => (
          <div key={r.id} role="option" aria-selected={i === idx} className={clsx("list-item computer-row", i === idx && "active")} onMouseEnter={() => setIdx(i)}>
            <StateDot remote={r} />
            <span className="grow">
              {renaming === r.id ? (
                <input
                  type="text"
                  autoFocus
                  aria-label={`Name for ${r.serverName}`}
                  value={name}
                  placeholder={r.serverName}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void saveName(r);
                    else if (e.key === "Escape") setRenaming(null);
                    else return;
                    e.preventDefault();
                    e.stopPropagation();
                  }}
                />
              ) : (
                <div className="computer-title">
                  {r.name}
                  {r.label && r.label !== r.serverName && <span className="dim"> · {r.serverName}</span>}
                  {shown === r.id && <span className="chip">shown</span>}
                </div>
              )}
              <div className="dim mono computer-sub">{r.host}:{r.port}{r.alt.length > 0 ? ` (+${r.alt.length})` : ""}</div>
              <div className={clsx("computer-sub", needsPairing(r.state) ? "err-text" : "dim")}>{describeState(r.state)}</div>
              {r.state.kind === "cert_mismatch" && (
                <div className="computer-sub mono cert-diff">
                  <div>paired: {formatFingerprint(r.state.expected)}</div>
                  <div>now:&nbsp;&nbsp;&nbsp; {formatFingerprint(r.state.actual)}</div>
                </div>
              )}
            </span>
            <span className="computer-actions">
              {!needsPairing(r.state) && shown !== r.id && <button type="button" className="btn small" data-hint onClick={() => show(r)}>Show</button>}
              {r.state.kind === "retrying" && <button type="button" className="btn small" data-hint onClick={() => retry(r)}>Retry now</button>}
              <button type="button" className={clsx("btn small", needsPairing(r.state) && "primary")} data-hint onClick={() => onRepair(r.id)}>Pair again</button>
              <button type="button" className="btn small" data-hint onClick={() => { setName(r.label ?? r.name); setRenaming(r.id); }}>Rename</button>
              <button type="button" className="btn small danger" data-hint onClick={() => remove(r)}>Remove</button>
            </span>
          </div>
        ))}
      </div>
    </Modal>
  );
}

type Form = { link: string; host: string; port: string; fingerprint: string; code: string; alt: string[]; name: string | null };

const emptyForm = (): Form => ({ link: "", host: "", port: "7443", fingerprint: "", code: "", alt: [], name: null });

/** Pair with a computer: paste its aura://pair link, or enter its address, fingerprint and code. */
function PairForm({ replaces, onDone, remotes, startedFromList }: { replaces: string | null; onDone: () => void; remotes: RemoteComputer[]; startedFromList: boolean }) {
  const closeDialog = useStore((s) => s.closeDialog);
  const toast = useStore((s) => s.toast);
  const [form, setForm] = useState<Form>(() => {
    const old = replaces ? remotes.find((r) => r.id === replaces) : null;
    return old ? { ...emptyForm(), host: old.host, port: String(old.port), alt: old.alt, name: old.name } : emptyForm();
  });
  const [linkError, setLinkError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [deviceName, setDeviceName] = useState<string | null>(null);
  const linkRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    remotesApi.deviceName().then(setDeviceName, () => {});
  }, []);
  const old = replaces ? remotes.find((r) => r.id === replaces) ?? null : null;
  const fp = useMemo(() => normalizeFingerprint(form.fingerprint), [form.fingerprint]);
  const port = Number(form.port);
  const ready = !!form.host.trim() && Number.isInteger(port) && port >= 1 && port <= 65535 && !!fp && !!form.code.trim();
  const back = () => (startedFromList ? onDone() : closeDialog());

  const onLink = (text: string) => {
    setForm((f) => ({ ...f, link: text }));
    if (!text.trim()) return setLinkError(null);
    try {
      const l = parsePairingLink(text);
      setForm({ link: text, host: l.host, port: String(l.port), fingerprint: l.fingerprint, code: l.code, alt: l.alt, name: l.name });
      setLinkError(null);
    } catch (e) {
      setLinkError(errorText(e));
    }
  };

  const pair = async () => {
    if (!ready || busy || !fp) return;
    setBusy(true);
    setError(null);
    try {
      const r = await remotesApi.pair({ host: form.host.trim(), port, fingerprint: fp, code: form.code.trim(), alt: form.alt, replaces });
      toast(`Paired with ${r.name}`);
      closeDialog();
      // A computer paired from scratch is shown at once.
      if (!replaces || useStore.getState().computer === r.id) await switchComputer(r.id).catch(() => {});
      setFocus("sidebar");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={old ? `Pair again with ${old.name}` : "Add remote computer"}
      width={620}
      className="computers-dialog"
      onSubmit={() => void pair()}
      onClose={back}
      footer={
        <>
          <button type="button" className="btn" data-command="dialog.cancel" onClick={back}>{startedFromList ? "Back" : "Cancel"} <kbd>Esc</kbd></button>
          <button type="button" className="btn primary" data-command="dialog.confirm" disabled={!ready || busy} onClick={() => void pair()}>
            {busy ? "Pairing…" : "Pair"} <kbd>⌘↩</kbd>
          </button>
        </>
      }
    >
      <p className="dim" style={{ marginTop: 0 }}>
        On the other computer: Settings → Remote access, turn it on, then <b>Pair a device</b>. Copy the link it shows, or type its address, fingerprint and code.
        {old && " A new code is needed; this computer's old key there is replaced."}
      </p>
      <div className="field">
        <label htmlFor="pair-link">Pairing link</label>
        <input id="pair-link" ref={linkRef} type="text" data-autofocus value={form.link} placeholder="aura://pair?host=…" spellCheck={false} autoComplete="off" onChange={(e) => onLink(e.target.value)} />
        {linkError && <span className="err-text" role="alert">{linkError}</span>}
      </div>
      <div className="two-col">
        <div className="field">
          <label htmlFor="pair-host">Address</label>
          <input id="pair-host" type="text" value={form.host} placeholder="192.168.1.20" spellCheck={false} onChange={(e) => setForm((f) => ({ ...f, host: e.target.value }))} />
          {form.alt.length > 0 && <span className="dim" style={{ fontSize: 11 }}>Also tried: {form.alt.join(", ")}</span>}
        </div>
        <div className="field">
          <label htmlFor="pair-port">Port</label>
          <input id="pair-port" type="text" inputMode="numeric" value={form.port} onChange={(e) => setForm((f) => ({ ...f, port: e.target.value }))} />
        </div>
      </div>
      <div className="field">
        <label htmlFor="pair-fp">Certificate fingerprint (SHA-256)</label>
        <input id="pair-fp" type="text" className="mono" value={form.fingerprint} spellCheck={false} onChange={(e) => setForm((f) => ({ ...f, fingerprint: e.target.value }))} />
        {form.fingerprint && !fp && <span className="err-text">64 hexadecimal characters</span>}
      </div>
      {fp && (
        <div className="field fingerprint-confirm" role="note">
          <span>Check that {form.name ? <b>{form.name}</b> : "the other computer"} shows this fingerprint. Only that certificate will ever be accepted from it:</span>
          <code className="mono fingerprint">{formatFingerprint(fp)}</code>
        </div>
      )}
      <div className="field">
        <label htmlFor="pair-code">Pairing code</label>
        <input id="pair-code" type="text" className="mono" value={form.code} placeholder="ABCD-EFGH" spellCheck={false} autoComplete="off" onChange={(e) => setForm((f) => ({ ...f, code: e.target.value }))} />
      </div>
      {deviceName && <p className="dim" style={{ fontSize: 11 }}>This computer shows up there as “{deviceName}”.</p>}
      {error && <div className="err-text" role="alert">{error}</div>}
    </Modal>
  );
}

