import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import QRCode from "qrcode";
import { Modal } from "../Modal";
import { useStore, selectLocalClient } from "../../state/store";
import { downloadManually } from "../../features/updates/updates";
import { exactTime, timeAgo } from "../../lib/time";
import type { PairingInfo, RemoteDevice, RemoteConfigure, RemoteStatus } from "../../gen";
import { countdown, MAX_PORT, MIN_PORT, pairingUriFor, validateRemoteForm, type RemoteForm } from "../../lib/remote";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const formOf = (s: RemoteStatus): RemoteForm => ({ serverName: s.serverName, bindAddress: s.bindAddress, port: String(s.port) });

function useCopy() {
  const toast = useStore((s) => s.toast);
  return async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast(`${what} copied`);
    } catch (e) {
      toast(`Could not copy ${what.toLowerCase()}: ${message(e)}`, "error");
    }
  };
}

/** Settings → Remote access: let remote clients (the Android app) reach this daemon, pair devices and revoke them. */
export function RemoteTab() {
  const client = useStore(selectLocalClient);
  const toast = useStore((s) => s.toast);
  const copy = useCopy();
  const [status, setStatus] = useState<RemoteStatus | null>(null);
  const [form, setForm] = useState<RemoteForm | null>(null);
  const [devices, setDevices] = useState<RemoteDevice[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pairing, setPairing] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const loadStatus = useCallback(async () => {
    if (!client) return;
    try {
      const s = await client.remoteStatus();
      setStatus(s);
      setForm(formOf(s));
      setLoadError(null);
    } catch (e) {
      setLoadError(message(e));
    }
  }, [client]);
  const loadDevices = useCallback(async () => {
    if (!client) return;
    try {
      setDevices(await client.remoteListDevices());
    } catch (e) {
      setActionError(`Could not load devices: ${message(e)}`);
    }
  }, [client]);
  useEffect(() => {
    void loadStatus();
    void loadDevices();
  }, [loadStatus, loadDevices]);

  const configure = async (config: RemoteConfigure) => {
    if (!client) return;
    try {
      const next = await client.remoteConfigure(config);
      setStatus(next);
      setForm(formOf(next));
      setActionError(null);
    } catch (e) {
      setActionError(`Could not save: ${message(e)}`);
    }
  };
  const revoke = async (device: RemoteDevice) => {
    if (!client) return;
    try {
      await client.remoteRevokeDevice(device.deviceId);
      setConfirming(null);
      setActionError(null);
      await loadDevices();
      toast(`Revoked ${device.name}`);
    } catch (e) {
      setActionError(`Could not revoke ${device.name}: ${message(e)}`);
    }
  };

  if (loadError) return <div className="err-text">Could not load remote access: {loadError}</div>;
  if (!status || !form) return <div className="dim">Loading…</div>;

  const fingerprint = status.fingerprint;
  const errors = validateRemoteForm(form);
  const invalid = Object.keys(errors).length > 0;
  const dirty = JSON.stringify(form) !== JSON.stringify(formOf(status));
  const set = (patch: Partial<RemoteForm>) => setForm({ ...form, ...patch });
  const save = () => void configure({ serverName: form.serverName.trim(), bindAddress: form.bindAddress.trim(), port: Number(form.port) });

  return (
    <div className="remote-tab">
      {actionError && <div className="err-text" role="alert" style={{ marginBottom: 8 }}>{actionError}</div>}
      <label className="check-row">
        <input type="checkbox" data-autofocus checked={status.enabled} onChange={(e) => void configure({ enabled: e.target.checked })} /> Allow remote clients
      </label>
      <div className="dim" style={{ fontSize: 11, marginBottom: 12 }}>
        Lets the Aura Android app on your network connect to this computer and work with your sessions. Only devices you pair can connect.
      </div>

      <div className="settings-grid">
        <div className="field wide">
          <label htmlFor="remote-name">Server name</label>
          <input id="remote-name" type="text" value={form.serverName} aria-invalid={!!errors.serverName} aria-describedby="remote-name-error" onChange={(e) => set({ serverName: e.target.value })} />
          {errors.serverName && <span id="remote-name-error" className="err-text" style={{ fontSize: 11 }}>{errors.serverName}</span>}
        </div>
        <div className="field">
          <label htmlFor="remote-bind">Bind address</label>
          <input id="remote-bind" type="text" value={form.bindAddress} aria-invalid={!!errors.bindAddress} aria-describedby="remote-bind-hint" onChange={(e) => set({ bindAddress: e.target.value })} />
          <span id="remote-bind-hint" className={errors.bindAddress ? "err-text" : "dim"} style={{ fontSize: 11 }}>
            {errors.bindAddress ?? "0.0.0.0 = every network interface; 127.0.0.1 = only via SSH tunnel"}
          </span>
        </div>
        <div className="field">
          <label htmlFor="remote-port">Port</label>
          <input id="remote-port" type="number" min={MIN_PORT} max={MAX_PORT} value={form.port} aria-invalid={!!errors.port} aria-describedby="remote-port-hint" onChange={(e) => set({ port: e.target.value })} />
          <span id="remote-port-hint" className={errors.port ? "err-text" : "dim"} style={{ fontSize: 11 }}>
            {errors.port ?? `${MIN_PORT}–${MAX_PORT}`}
          </span>
        </div>
        <div className="field wide">
          <div className="row-controls">
            <button type="button" className="btn primary" data-hint disabled={invalid || !dirty} onClick={save}>
              Save
            </button>
            <button type="button" className="btn" data-hint disabled={!dirty} onClick={() => setForm(formOf(status))}>
              Revert
            </button>
          </div>
        </div>
      </div>

      <div className="field" role="status">
        <label>Status</label>
        {status.enabled && status.error ? (
          <span className="err-text">{status.error}</span>
        ) : (
          <span>{!status.enabled ? "Off" : status.listening ? `Listening on ${status.bindAddress}:${status.port}` : "Not listening"}</span>
        )}
      </div>
      <div className="field">
        <label htmlFor="remote-fingerprint">Certificate fingerprint</label>
        <div className="row-controls">
          {fingerprint ? (
            <>
              <code id="remote-fingerprint" className="grow" style={{ wordBreak: "break-all", userSelect: "text" }}>{fingerprint}</code>
              <button type="button" className="btn small" data-hint onClick={() => void copy(fingerprint, "Fingerprint")}>
                Copy
              </button>
            </>
          ) : (
            <span id="remote-fingerprint" className="dim">Made the first time you allow remote clients</span>
          )}
        </div>
        <span className="dim" style={{ fontSize: 11 }}>The pairing link carries it, and the Android app only connects to a server with this certificate.</span>
      </div>

      <div className="provider-card">
        <div className="provider-head">
          <strong>Paired devices</strong>
          <span style={{ marginLeft: "auto" }}>
            <button type="button" className="btn small primary" data-hint disabled={!status.enabled} title={status.enabled ? undefined : "Allow remote clients first"} onClick={() => setPairing(true)}>
              Pair a device…
            </button>
          </span>
        </div>
        {devices === null && <div className="dim">Loading…</div>}
        {devices?.length === 0 && <div className="dim">No devices paired yet.</div>}
        {devices && devices.length > 0 && (
          <div className="acp-agents">
            {devices.map((d) => (
              <div key={d.deviceId} className="acp-agent">
                <strong>{d.name}</strong>
                <span className="dim grow" title={d.lastSeenAt ? exactTime(d.lastSeenAt) : undefined}>
                  {d.lastSeenAt ? `last seen ${timeAgo(d.lastSeenAt)}${d.lastAddress ? ` from ${d.lastAddress}` : ""}` : "never connected"}
                  {` · paired ${timeAgo(d.pairedAt)}`}
                </span>
                {confirming === d.deviceId ? (
                  <>
                    <span className="dim">Revoke access?</span>
                    <button type="button" className="btn small danger" data-hint data-autofocus onClick={() => void revoke(d)}>Revoke</button>
                    <button type="button" className="btn small" data-hint onClick={() => setConfirming(null)}>Cancel</button>
                  </>
                ) : (
                  <button type="button" className="btn small" data-hint aria-label={`Revoke ${d.name}`} onClick={() => setConfirming(d.deviceId)}>Revoke…</button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="dim" style={{ fontSize: 11 }}>
        Remote access needs the Aura Android app.{" "}
        <button type="button" className="btn small" data-hint onClick={downloadManually}>
          Get it from GitHub releases
        </button>
      </div>

      {pairing && createPortal(<PairDialog onClose={() => { setPairing(false); void loadDevices(); }} />, document.body)}
    </div>
  );
}

/** A pairing code for a new device: QR code, the code itself, the link, and when it expires. */
function PairDialog({ onClose }: { onClose: () => void }) {
  const client = useStore(selectLocalClient);
  const copy = useCopy();
  const [info, setInfo] = useState<PairingInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [host, setHost] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());

  const generate = useCallback(async () => {
    if (!client) return;
    try {
      const next = await client.remoteStartPairing();
      setInfo(next);
      setHost((h) => (h && next.addresses.includes(h) ? h : next.addresses[0] ?? null));
      setError(null);
    } catch (e) {
      setError(message(e));
    }
  }, [client]);
  useEffect(() => {
    void generate();
  }, [generate]);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const uri = info ? (host ? pairingUriFor(info.uri, host) : info.uri) : null;
  useEffect(() => {
    if (!uri) return;
    let current = true;
    QRCode.toDataURL(uri, { margin: 2, width: 232 }).then(
      (url) => current && setQr(url),
      (e: unknown) => current && setError(message(e)),
    );
    return () => {
      current = false;
    };
  }, [uri]);

  const left = info ? countdown(info.expiresAt, now) : null;
  return (
    <Modal
      title="Pair a device"
      width={440}
      onClose={onClose}
      onKeyDown={(e) => e.stopPropagation()}
      footer={
        <>
          <button type="button" className="btn" data-hint onClick={() => void generate()}>
            New code
          </button>
          <button type="button" className="btn primary" data-hint data-autofocus onClick={onClose}>
            Done
          </button>
        </>
      }
    >
      {error && <div className="err-text">{error}</div>}
      {!info && !error && <div className="dim">Creating a code…</div>}
      {info && uri && (
        <div className="pair-body">
          <div className="dim" style={{ fontSize: 11 }}>In the Aura Android app choose Add computer, then scan this code or type the code below.</div>
          {qr && <img className="pair-qr" src={qr} width={232} height={232} alt="QR code with the pairing link" />}
          <div className="pair-code" aria-label="Pairing code">{info.code}</div>
          <div className={left ? "dim" : "err-text"} role="timer">{left ? `Expires in ${left}` : "Expired: make a new code"}</div>
          {info.addresses.length > 1 && (
            <div className="field">
              <label htmlFor="pair-address">Address the device connects to</label>
              <select id="pair-address" value={host ?? ""} onChange={(e) => setHost(e.target.value)}>
                {info.addresses.map((a) => (
                  <option key={a} value={a}>{a}</option>
                ))}
              </select>
            </div>
          )}
          <div className="field">
            <label htmlFor="pair-link">Pairing link</label>
            <div className="row-controls">
              <input id="pair-link" type="text" readOnly value={uri} onFocus={(e) => e.target.select()} />
              <button type="button" className="btn small" data-hint onClick={() => void copy(uri, "Pairing link")}>
                Copy
              </button>
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}
