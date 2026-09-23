import { useEffect, useMemo, useState } from "react";
import { Modal, KeyList, useListNav } from "../Modal";
import { useStore } from "../../state/store";
import type { ModelInfo, Setting } from "../../gen";
import { filterItems } from "../palette";
import { acpChoices, acpModes, acpSessionInfo } from "../../lib/acp";

export type PickerKind = "models" | "effort" | "permission" | "sandbox";

type Option = { value: string; label: string; description?: string | null; current?: boolean; isDefault?: boolean };

const TITLES: Record<PickerKind, string> = { models: "Model", effort: "Effort", permission: "Permission mode", sandbox: "Sandbox mode" };
const SETTING_KIND: Record<PickerKind, Setting["kind"]> = { models: "model", effort: "effort", permission: "permission_mode", sandbox: "sandbox_mode" };

const PERMISSION_HELP: Record<string, string> = {
  default: "Ask before risky tools",
  acceptEdits: "Auto-approve file edits",
  plan: "Plan only, no changes",
  dontAsk: "Deny anything that would prompt",
  auto: "Classifier reviews actions",
  bypassPermissions: "Never ask (dangerous)",
  untrusted: "Ask for every command",
  "on-request": "Ask when the agent requests",
  "on-failure": "Ask only after a sandbox failure",
  never: "Never ask",
  "read-only": "No writes",
  "workspace-write": "Write inside the workspace",
  "danger-full-access": "Unrestricted (dangerous)",
};

export function PickerDialog({ kind, sessionId }: { kind: PickerKind; sessionId: string }) {
  const session = useStore((s) => s.sessions[sessionId]);
  const providers = useStore((s) => s.providers);
  const acpInfo = useStore((s) => acpSessionInfo(s.transcripts[sessionId]?.providerInfo));
  const client = useStore((s) => s.client);
  const closeDialog = useStore((s) => s.closeDialog);
  const toast = useStore((s) => s.toast);
  const [models, setModels] = useState<ModelInfo[] | null>(null);
  const [q, setQ] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // ACP agents publish their choices per session (see lib/acp.ts).
    if (!client || !session || session.provider === "acp" || (kind !== "models" && kind !== "effort")) return;
    client
      .models(session.provider)
      .then(setModels)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [client, session, kind]);

  const options = useMemo<Option[]>(() => {
    if (!session) return [];
    if (session.provider === "acp") {
      const current = { models: session.model, effort: session.effort, permission: session.permission_mode, sandbox: null }[kind];
      const values = kind === "models" ? acpChoices(acpInfo, "model") : kind === "effort" ? acpChoices(acpInfo, "thought_level") : kind === "permission" ? acpModes(acpInfo) : [];
      return values.map((v) => ({ value: v.value, label: v.name || v.value, description: v.description, current: current === v.value }));
    }
    const caps = providers.find((p) => p.kind === session.provider)?.capabilities;
    switch (kind) {
      case "models":
        return (models ?? []).map((m) => ({ value: m.id, label: m.display_name || m.id, description: m.description, current: session.model === m.id || session.model === m.display_name, isDefault: m.is_default }));
      case "effort": {
        const current = (models ?? []).find((m) => m.id === session.model || m.display_name === session.model);
        const fromModel = current?.efforts?.length ? current.efforts : (models ?? []).find((m) => m.is_default)?.efforts;
        const fallback = session.provider === "codex" ? ["low", "medium", "high", "xhigh"] : ["low", "medium", "high", "xhigh", "max"];
        return (fromModel?.length ? fromModel : fallback).map((e) => ({ value: e, label: e, current: session.effort === e, isDefault: current?.default_effort === e }));
      }
      case "permission":
        return (caps?.permission_modes ?? []).map((p) => ({ value: p, label: p, description: PERMISSION_HELP[p], current: session.permission_mode === p }));
      case "sandbox":
        return (caps?.sandbox_modes ?? []).map((p) => ({ value: p, label: p, description: PERMISSION_HELP[p], current: session.sandbox_mode === p }));
    }
  }, [kind, models, providers, session, acpInfo]);

  const filtered = useMemo(() => filterItems(options, q, (o) => `${o.label} ${o.description ?? ""}`), [options, q]);

  const apply = async (i: number) => {
    const o = filtered[i];
    if (!o || !client) return;
    try {
      await client.set(sessionId, { kind: SETTING_KIND[kind], value: o.value } as Setting);
      toast(`${TITLES[kind]}: ${o.label}`);
      closeDialog();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error");
    }
  };
  const nav = useListNav(filtered.length, (i) => void apply(i));
  useEffect(() => {
    const cur = filtered.findIndex((o) => o.current);
    if (cur >= 0) nav.setIndex(cur);
  }, [filtered.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const loading = session?.provider !== "acp" && (kind === "models" || kind === "effort") && models === null && !error;
  return (
    <Modal title={`${TITLES[kind]} · ${session?.title ?? ""}`} width={560} onKeyDown={(e) => nav.onKeyDown(e)}>
      <input type="text" data-autofocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter…" />
      <div style={{ marginTop: 8 }}>
        {error && <div className="dim" style={{ color: "var(--err)" }}>{error}</div>}
        {loading ? (
          <div className="dim">Loading…</div>
        ) : (
          <KeyList
            items={filtered.map((o) => ({
              id: o.value,
              command: "picker.apply",
              render: (
                <>
                  <span className="grow">
                    {o.label}
                    {o.current && <span className="chip" style={{ marginLeft: 8 }}>current</span>}
                    {o.isDefault && <span className="chip" style={{ marginLeft: 6 }}>default</span>}
                  </span>
                  {o.description && <span className="dim">{o.description}</span>}
                </>
              ),
            }))}
            index={nav.index}
            onSelect={nav.setIndex}
            onActivate={(i) => void apply(i)}
            empty={`No ${TITLES[kind].toLowerCase()} options for this provider`}
          />
        )}
      </div>
    </Modal>
  );
}
