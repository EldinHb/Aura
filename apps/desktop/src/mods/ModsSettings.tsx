/**
 * Settings → Mods: what is installed, whether it runs, what it may do, its
 * settings, and its log. Approving a mod that is not bundled is done here.
 */
import { useEffect, useState } from "react";
import clsx from "clsx";
import { useStore } from "../state/store";
import { modsApi, syncMods, useMods, type ModInfo } from "./loader";
import { slots, useSlot } from "./registry";
import { ModPiece } from "./Slots";
import { describePermissions } from "./permissions";
import { openApprovalPrompt } from "./ApprovalDialog";

const STATE_LABEL: Record<string, string> = {
  running: "Running",
  stopped: "Stopped",
  disabled: "Disabled",
  needs_approval: "Needs your approval",
  starting: "Starting",
  failed: "Failed",
};

function Setting({ mod, s }: { mod: ModInfo; s: ModInfo["settings"][number] }) {
  const value = mod.settingValues?.[s.key];
  const toast = useStore((st) => st.toast);
  const save = (v: unknown) => modsApi.setSetting(mod.id, s.key, v).catch((e) => toast(String(e?.message ?? e), "error"));
  return (
    <label className="mod-setting">
      <span>{s.label}</span>
      {s.type === "boolean" ? (
        <input type="checkbox" checked={value === true} onChange={(e) => save(e.target.checked)} />
      ) : s.type === "select" ? (
        <select value={String(value ?? "")} onChange={(e) => save(e.target.value)}>
          {(s.options ?? []).map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      ) : (
        <input
          type={s.type === "number" ? "number" : "text"}
          defaultValue={Array.isArray(value) ? value.join(", ") : value === undefined || value === null ? "" : String(value)}
          onBlur={(e) => {
            const raw = e.target.value;
            save(s.type === "number" ? Number(raw) : s.type === "string[]" ? raw.split(",").map((x) => x.trim()).filter(Boolean) : raw);
          }}
        />
      )}
      {s.description && <small className="dim">{s.description}</small>}
    </label>
  );
}

function ModCard({ mod }: { mod: ModInfo }) {
  const uiError = useMods((s) => s.uiErrors[mod.id]);
  const toast = useStore((st) => st.toast);
  const [logs, setLogs] = useState<string[] | null>(null);
  const act = (f: () => Promise<unknown>) => f().then(() => syncMods()).catch((e) => toast(String(e?.message ?? e), "error"));
  const state = mod.status?.state ?? "stopped";
  return (
    <div className="mod-card list-item">
      <div className="mod-card-head">
        <strong>{mod.name}</strong> <span className="dim">{mod.version}</span>
        <span className={clsx("chip", state === "running" ? "ok" : state === "failed" ? "err" : state === "needs_approval" ? "warn" : "")}>{STATE_LABEL[state] ?? state}</span>
        <span className="chip">{mod.source}</span>
      </div>
      {mod.description && <div className="dim">{mod.description}</div>}
      {mod.status?.error && <pre className="mod-error">{mod.status.error}</pre>}
      {uiError && <pre className="mod-error">Interface: {uiError}</pre>}
      {mod.uiError && mod.uiError !== uiError && <pre className="mod-error">ui error: {mod.uiError}</pre>}
      {mod.reloadError && <pre className="mod-error">{mod.reloadError}</pre>}
      {!mod.broken && (
        <>
          <ul className="mod-perms">
            {describePermissions(mod.permissions ?? {}).map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
          {mod.settings?.length > 0 && <div className="mod-settings">{mod.settings.map((s) => <Setting key={s.key} mod={mod} s={s} />)}</div>}
          <div className="mod-actions">
            {state === "needs_approval" && (
              <button className="btn small" onClick={() => openApprovalPrompt("mod", mod.id)} data-hint>
                Review and approve…
              </button>
            )}
            {mod.enabled ? (
              <button className="btn small" onClick={() => act(() => modsApi.disable(mod.id))} data-hint>
                Disable
              </button>
            ) : (
              <button className="btn small" onClick={() => act(() => modsApi.enable(mod.id))} data-hint>
                Enable
              </button>
            )}
            <button className="btn small" onClick={() => act(() => modsApi.reload(mod.id))} data-hint>
              Reload
            </button>
            <button className="btn small" onClick={() => (logs ? setLogs(null) : modsApi.logs(mod.id).then(setLogs).catch(() => setLogs([])))} data-hint>
              {logs ? "Hide log" : "Log"}
            </button>
          </div>
          {logs && <pre className="mod-log">{logs.length ? logs.join("\n") : "Nothing logged yet."}</pre>}
        </>
      )}
      <div className="dim mod-dir">{mod.dir}</div>
    </div>
  );
}

export function ModsSettings() {
  const mods = useMods((s) => s.mods);
  const toast = useStore((st) => st.toast);
  const [dirs, setDirs] = useState<{ user: string | null; dev: string | null } | null>(null);
  useEffect(() => {
    void syncMods();
    // An older daemon has no mods.dirs; the text then names the default folder.
    modsApi.dirs().then(setDirs, () => setDirs(null));
  }, []);
  return (
    <div className="mods-settings">
      <p className="dim">
        Mods add features to Aura. Their background part runs inside Aura's daemon and can only do what is listed under each; their interface part runs in
        this window with Aura's own rights, so install mods only from people you trust. Put a mod's folder in <code className="mods-dir">{dirs?.user ?? "~/.aura/mods"}</code>: Aura finds it
        and asks you to approve it. For agents: <code>aura guide mods</code> explains how to make one, and <code>aura mods new &lt;id&gt;</code> starts one.
      </p>
      {dirs?.dev && (
        <p className="dim">
          Also loading development mods from <code>{dirs.dev}</code> (<code>AURA_MODS_DIR</code>).
        </p>
      )}
      <div className="mod-actions">
        <button className="btn small" onClick={() => modsApi.rescan().then(() => syncMods()).catch((e) => toast(String(e?.message ?? e), "error"))} data-hint>
          Rescan mod folders
        </button>
      </div>
      {mods.length === 0 ? <div className="empty">No mods installed.</div> : mods.map((m) => <ModCard key={m.dir} mod={m} />)}
    </div>
  );
}

/** Settings tabs that mods added, for the settings dialog. */
export function useModSettingsTabs() {
  return useSlot(slots.settingsTab);
}

export function ModSettingsTab({ tabKey }: { tabKey: string }) {
  const tabs = useSlot(slots.settingsTab);
  const tab = tabs.find((t) => t.key === tabKey);
  if (!tab) return null;
  return (
    <ModPiece entry={tab}>
      <tab.component />
    </ModPiece>
  );
}
