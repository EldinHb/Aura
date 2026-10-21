import { useEffect, useMemo, useRef, useState } from "react";
import { ModalC } from "../ModalC";
import { useStore, defaultSettings, type UiSettings } from "../../state/store";
import { allCommands } from "../../lib/commands";
import { chordFromEvent, formatKeys, type Binding } from "../../lib/keymap";
import { buildBindings } from "../../hooks/useKeyboard";
import { isMac } from "../../lib/platform";
import { findConflicts, isConflicting } from "./keymapUtils";
import type { CapabilitySet, LoadBalancer, LoadBalancerUpdate, SystemPrompts } from "../../gen";
import clsx from "clsx";
import { providerChoices } from "../../lib/acp";
import { useGroups } from "../../state/groups";
import { pullFilterError } from "../../features/reviews/state";
import { PULL_CHANGE_KINDS } from "../../features/reviews/changes";

type Tab = "general" | "keymap" | "providers" | "prompts" | "orchestrators" | "groups";
const TABS: Tab[] = ["general", "keymap", "providers", "prompts", "orchestrators", "groups"];

export function SettingsDialog({ tab: initial }: { tab?: Tab }) {
  const [tab, setTab] = useState<Tab>(initial ?? "general");
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const t = (e.target as HTMLElement).tagName;
    const inField = t === "INPUT" || t === "TEXTAREA" || t === "SELECT";
    if ((e.target as HTMLElement).dataset.recording) return;
    if (e.key === "ArrowLeft" && !inField) setTab(TABS[(TABS.indexOf(tab) + TABS.length - 1) % TABS.length]);
    else if (e.key === "ArrowRight" && !inField) setTab(TABS[(TABS.indexOf(tab) + 1) % TABS.length]);
    else if (!inField && /^[1-9]$/.test(e.key) && Number(e.key) <= TABS.length) setTab(TABS[Number(e.key) - 1]);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  return (
    <ModalC
      title={
        <>
          <span>Settings</span>
          <span style={{ flex: 1 }} />
          <span className="dim" style={{ fontWeight: 400, color: "var(--fg-dim)", fontSize: 11 }}>
            <kbd>←</kbd> <kbd>→</kbd> or <kbd>1-{TABS.length}</kbd> switch tab
          </span>
        </>
      }
      width="min(900px, 92vw)"
      height="80vh"
      onKeyDown={onKeyDown}
      className="settings-modal"
    >
      <div className="tabs" role="tablist">
        {TABS.map((t, i) => (
          <button key={t} type="button" role="tab" data-hint className={clsx("tab", tab === t && "active")} onClick={() => setTab(t)}>
            {i + 1} {t[0].toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>
      <div className="settings-body">
        {tab === "general" && <GeneralTab />}
        {tab === "keymap" && <KeymapTab />}
        {tab === "providers" && <ProvidersTab />}
        {tab === "prompts" && <PromptsTab />}
        {tab === "orchestrators" && <OrchestratorsTab />}
        {tab === "groups" && <GroupsTab />}
      </div>
    </ModalC>
  );
}

// ------------------------------------------------------------------ general

function GeneralTab() {
  const settings = useStore((s) => s.settings);
  const setSettings = useStore((s) => s.setSettings);
  const providers = useStore((s) => s.providers);
  const set = <K extends keyof UiSettings>(k: K, v: UiSettings[K]) => setSettings({ [k]: v } as Partial<UiSettings>);
  return (
    <div className="settings-grid">
      <div className="field">
        <label>Theme</label>
        <select data-autofocus value={settings.theme} onChange={(e) => set("theme", e.target.value as UiSettings["theme"])}>
          <option value="dark">Dark</option>
          <option value="light">Light</option>
          <option value="system">System</option>
        </select>
      </div>
      <div className="field">
        <label>Font size</label>
        <input type="number" min={10} max={20} value={settings.fontSize} onChange={(e) => set("fontSize", Math.max(10, Math.min(20, Number(e.target.value) || 13)))} />
      </div>
      <div className="field">
        <label>Leader key</label>
        <ChordRecorder value={settings.leader} onChange={(v) => set("leader", v)} />
      </div>
      <div className="field">
        <label>Keymap preset</label>
        <select value={settings.keymapPreset} onChange={(e) => set("keymapPreset", e.target.value as UiSettings["keymapPreset"])}>
          <option value="default">Default</option>
          <option value="vim">Vim</option>
        </select>
      </div>
      <label className="check-row">
        <input type="checkbox" checked={settings.notifications} onChange={(e) => set("notifications", e.target.checked)} /> Desktop notifications
      </label>
      <div className="field wide">
        <label>Pull request changes in the inbox and notifications</label>
        {PULL_CHANGE_KINDS.map(({ kind, label }) => (
          <label key={kind} className="check-row">
            <input type="checkbox" checked={!settings.pullChangesMuted.includes(kind)} onChange={(e) => set("pullChangesMuted", e.target.checked ? settings.pullChangesMuted.filter((k) => k !== kind) : [...settings.pullChangesMuted, kind])} /> {label}
          </label>
        ))}
      </div>
      <label className="check-row">
        <input type="checkbox" checked={settings.confirmDelete} onChange={(e) => set("confirmDelete", e.target.checked)} /> Confirm before deleting a session
      </label>
      <label className="check-row">
        <input type="checkbox" checked={settings.showReasoning} onChange={(e) => set("showReasoning", e.target.checked)} /> Include reasoning in each reply's steps
      </label>
      <div className="field">
        <label>Default provider</label>
        <select value={settings.defaultProvider} onChange={(e) => set("defaultProvider", e.target.value)}>
          {!providerChoices(providers).some((c) => c.key === settings.defaultProvider) && <option value={settings.defaultProvider}>{settings.defaultProvider}</option>}
          {providerChoices(providers).map((c) => (
            <option key={c.key} value={c.key}>
              {c.label}
              {c.kind === "acp" ? " (ACP)" : ""}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label>Default directory</label>
        <input type="text" value={settings.defaultCwd} placeholder="~/Projects" onChange={(e) => set("defaultCwd", e.target.value)} />
      </div>
      <div className="field">
        <label>Summon shortcut (global, restart required)</label>
        <input type="text" value={settings.summonShortcut} onChange={(e) => set("summonShortcut", e.target.value)} />
      </div>
      <div className="field wide">
        <label htmlFor="pull-filters">Hide pull requests matching (one rule per line)</label>
        <textarea id="pull-filters" rows={4} spellCheck={false} className="mono" value={settings.pullFilters.join("\n")} placeholder="author:dependabot" onChange={(e) => set("pullFilters", e.target.value.split("\n"))} />
        {settings.pullFilters.map(pullFilterError).filter(Boolean).map((error) => <div key={error} className="dim" style={{ fontSize: 11, color: "var(--warn)" }}>{error}</div>)}
        <div className="dim" style={{ fontSize: 11 }}>
          <span className="mono">author:</span>, <span className="mono">label:</span>, <span className="mono">repo:</span>, <span className="mono">title:</span> or <span className="mono">draft</span>; <span className="mono">*</span> matches anything, e.g. <span className="mono">repo:acme/*</span>. Matching PRs are listed with Show hidden.
        </div>
      </div>
      <div>
        <button type="button" className="btn" data-hint onClick={() => setSettings(defaultSettings)}>
          Reset to defaults
        </button>
      </div>
    </div>
  );
}

/** Text field that records the next chord pressed while "recording". */
function ChordRecorder({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [recording, setRecording] = useState(false);
  return (
    <input
      type="text"
      readOnly
      data-recording={recording ? "1" : undefined}
      value={recording ? "press a chord…" : `${formatKeys(value, isMac)}  (${value})`}
      className={clsx(recording && "recording")}
      onFocus={() => setRecording(true)}
      onBlur={() => setRecording(false)}
      onKeyDown={(e) => {
        if (!recording) return;
        e.preventDefault();
        e.stopPropagation();
        if (e.key === "Escape") {
          setRecording(false);
          (e.target as HTMLInputElement).blur();
          return;
        }
        const chord = chordFromEvent(e.nativeEvent, isMac);
        if (!chord) return;
        onChange(chord);
        setRecording(false);
        (e.target as HTMLInputElement).blur();
      }}
    />
  );
}

// ------------------------------------------------------------------- keymap

type RowT = { binding: Binding; title: string; group: string; overridden: boolean };

function KeymapTab() {
  const settings = useStore((s) => s.settings);
  const setSettings = useStore((s) => s.setSettings);
  const [filter, setFilter] = useState("");
  const [idx, setIdx] = useState(0);
  const [recordingFor, setRecordingFor] = useState<string | null>(null);
  const [recorded, setRecorded] = useState<string[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const bindings = useMemo(() => buildBindings(settings.keymapPreset, settings.keymapOverrides), [settings.keymapPreset, settings.keymapOverrides]);
  const conflicts = useMemo(() => findConflicts(bindings, isMac, settings.leader), [bindings, settings.leader]);
  const cmds = useMemo(() => new Map(allCommands().map((c) => [c.id, c])), []);

  const rows: RowT[] = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const r = bindings.map((b) => {
      const c = cmds.get(b.command);
      return { binding: b, title: c?.title ?? b.command, group: c?.group ?? "Other", overridden: settings.keymapOverrides.some((o) => o.keys === b.keys && o.command === b.command) };
    });
    // unbound commands (no binding at all) appear too so they can be given one
    const bound = new Set(bindings.map((b) => b.command));
    for (const c of cmds.values()) if (!bound.has(c.id) && !c.hidden) r.push({ binding: { keys: "", command: c.id }, title: c.title, group: c.group, overridden: false });
    r.sort((a, b) => a.group.localeCompare(b.group) || a.title.localeCompare(b.title));
    return q ? r.filter((x) => `${x.group} ${x.title} ${x.binding.command} ${formatKeys(x.binding.keys, isMac)}`.toLowerCase().includes(q)) : r;
  }, [bindings, cmds, filter, settings.keymapOverrides]);

  useEffect(() => {
    if (idx >= rows.length) setIdx(Math.max(0, rows.length - 1));
    listRef.current?.querySelector<HTMLElement>(`[data-km-row="${idx}"]`)?.scrollIntoView({ block: "nearest" });
  }, [idx, rows.length]);

  const setOverride = (command: string, keys: string) => {
    const rest = settings.keymapOverrides.filter((o) => o.command !== command);
    setSettings({ keymapOverrides: [...rest, { keys, command }] });
  };
  const unbind = (row: RowT) => {
    if (!row.binding.keys) return;
    const rest = settings.keymapOverrides.filter((o) => !(o.keys === row.binding.keys && o.command === row.binding.command));
    setSettings({ keymapOverrides: [...rest, { keys: row.binding.keys, command: "" }] });
  };
  const resetRow = (row: RowT) => {
    setSettings({ keymapOverrides: settings.keymapOverrides.filter((o) => o.command !== row.binding.command && o.keys !== row.binding.keys) });
  };
  const finishRecording = () => {
    if (recordingFor && recorded.length > 0) setOverride(recordingFor, recorded.join(" "));
    setRecordingFor(null);
    setRecorded([]);
    if (timer.current) clearTimeout(timer.current);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (recordingFor) {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setRecordingFor(null);
        setRecorded([]);
        if (timer.current) clearTimeout(timer.current);
        return;
      }
      if (e.key === "Enter") {
        finishRecording();
        return;
      }
      const chord = chordFromEvent(e.nativeEvent, isMac);
      if (!chord) return;
      setRecorded((r) => [...r, chord]);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(finishRecordingRef.current, 1000);
      return;
    }
    if ((e.target as HTMLElement).tagName === "INPUT") {
      if (e.key === "ArrowDown" || e.key === "Enter") {
        (listRef.current as HTMLElement | null)?.focus();
        e.preventDefault();
        e.stopPropagation();
      }
      return;
    }
    const row = rows[idx];
    if (e.key === "j" || e.key === "ArrowDown") setIdx((i) => Math.min(rows.length - 1, i + 1));
    else if (e.key === "k" || e.key === "ArrowUp") setIdx((i) => Math.max(0, i - 1));
    else if (e.key === "Enter" && row) {
      setRecordingFor(row.binding.command);
      setRecorded([]);
    } else if ((e.key === "Backspace" || e.key === "x") && row) unbind(row);
    else if (e.key === "r" && row) resetRow(row);
    else if (e.key === "/") document.querySelector<HTMLInputElement>("[data-km-filter]")?.focus();
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  const finishRecordingRef = useRef(finishRecording);
  finishRecordingRef.current = finishRecording;

  let lastGroup = "";
  return (
    <div className="keymap-tab" onKeyDown={onKeyDown}>
      <div className="keymap-head">
        <input type="text" data-autofocus data-km-filter placeholder="Filter commands or keys… (/)" value={filter} onChange={(e) => (setFilter(e.target.value), setIdx(0))} />
        <button type="button" className="btn small" data-hint onClick={() => setSettings({ keymapOverrides: [] })}>
          Reset all
        </button>
      </div>
      <div className="dim" style={{ fontSize: 11, padding: "4px 0" }}>
        <kbd>↩</kbd> record new keys <kbd>x</kbd> unbind <kbd>r</kbd> reset row · {conflicts.length > 0 ? <span style={{ color: "var(--warn)" }}>{conflicts.length} conflict{conflicts.length === 1 ? "" : "s"}</span> : "no conflicts"}
      </div>
      <div className="list keymap-list" ref={listRef} tabIndex={0}>
        {rows.map((row, i) => {
          const header = row.group !== lastGroup ? row.group : null;
          lastGroup = row.group;
          const conflict = row.binding.keys ? isConflicting(row.binding, conflicts, isMac, settings.leader) : false;
          const recording = recordingFor === row.binding.command && i === idx;
          return (
            <div key={`${row.binding.command}|${row.binding.keys}`}>
              {header && <div className="section-title">{header}</div>}
              <button type="button" data-hint data-km-row={i} className={clsx("list-item keymap-row", i === idx && "active", conflict && "conflict")} onClick={() => setIdx(i)}>
                <span className="grow">
                  {row.title}
                  <span className="dim mono" style={{ marginLeft: 8 }}>{row.binding.command}</span>
                  {row.binding.when && <span className="dim" style={{ marginLeft: 8 }}>when {row.binding.when}</span>}
                </span>
                <span className={clsx("keys", row.overridden && "overridden")}>
                  {recording ? <span className="recording">{recorded.length ? formatKeys(recorded.join(" "), isMac) : "press keys…"}</span> : row.binding.keys ? <kbd>{formatKeys(row.binding.keys, isMac)}</kbd> : <span className="dim">unbound</span>}
                </span>
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- providers

const CAPS: (keyof CapabilitySet)[] = ["structured", "models", "effort", "fork", "steer", "interrupt", "review", "compact", "mcp_status", "skills_list", "slash_commands", "images", "diff_stream", "plan_stream", "native_sessions", "rename", "terminal_mode"];

function ProvidersTab() {
  const providers = useStore((s) => s.providers);
  const client = useStore((s) => s.client);
  const setProviders = useStore((s) => s.setProviders);
  const toast = useStore((s) => s.toast);
  const [busy, setBusy] = useState(false);
  const redetect = async () => {
    if (!client) return;
    setBusy(true);
    try {
      setProviders(await client.providers());
      toast("Providers refreshed");
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 8 }}>
        <button type="button" className="btn small" data-autofocus data-hint disabled={busy} onClick={() => void redetect()}>
          {busy ? "Detecting…" : "Re-detect"}
        </button>
      </div>
      {providers.map((p) => (
        <div key={p.kind} className="provider-card">
          <div className="provider-head">
            <span className={clsx("dot", p.available ? "ok" : "err")} />
            <span className={clsx("chip", p.kind)}>{p.kind}</span>
            <strong>{p.display_name}</strong>
            <span className="dim">{p.kind === "acp" ? `${p.agents.filter((a) => a.available).length} of ${p.agents.length} found` : p.version ?? "not found"}</span>
            <span className="dim mono" style={{ marginLeft: "auto" }}>{p.binary ?? ""}</span>
          </div>
          <div className="cap-grid">
            {CAPS.map((c) => (
              <span key={c} className="cap">
                <span className={clsx("dot", p.capabilities[c] ? "ok" : "")} /> {c.replace(/_/g, " ")}
              </span>
            ))}
            {p.capabilities.permission_modes.length > 0 && (
              <span className="cap wide">
                <span className="dot ok" /> permission modes: {p.capabilities.permission_modes.join(", ")}
              </span>
            )}
            {p.capabilities.sandbox_modes.length > 0 && (
              <span className="cap wide">
                <span className="dot ok" /> sandbox modes: {p.capabilities.sandbox_modes.join(", ")}
              </span>
            )}
          </div>
          {p.kind === "acp" && (
            <div className="acp-agents">
              {p.agents.map((a) => (
                <div key={a.id} className="acp-agent">
                  <span className={clsx("dot", a.available ? "ok" : "")} />
                  <span>{a.display_name}</span>
                  {a.source === "custom" && <span className="chip">custom</span>}
                  <span className="dim mono grow" title={a.binary ?? undefined}>{a.command.join(" ")}</span>
                  <span className="dim">{a.available ? "found" : "not installed"}</span>
                </div>
              ))}
              <div className="dim" style={{ fontSize: 11, marginTop: 4 }}>
                Add other agents, or ACP bridges for CLIs that do not speak ACP themselves, in <span className="mono">acp-agents.json</span> in Aura's data directory (<span className="mono">~/.aura</span>). See the README.
              </div>
            </div>
          )}
        </div>
      ))}
      {providers.length === 0 && <div className="empty" style={{ height: "auto", padding: 20 }}>No providers reported by the daemon.</div>}
    </div>
  );
}

// ------------------------------------------------------------------ prompts

function PromptsTab() {
  const client = useStore((s) => s.client);
  const providers = useStore((s) => s.providers);
  const toast = useStore((s) => s.toast);
  const [prompts, setPrompts] = useState<SystemPrompts | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    client?.systemPrompts().then(setPrompts, (e) => setError(e instanceof Error ? e.message : String(e)));
  }, [client]);
  // Agents a per-agent prompt can target: Claude Code, Codex, then the installed ACP agents.
  const agents = useMemo(() => {
    const out: { key: string; name: string }[] = [];
    for (const kind of ["claude", "codex"]) {
      const p = providers.find((x) => x.kind === kind);
      if (p) out.push({ key: kind, name: p.display_name });
    }
    for (const a of providers.find((x) => x.kind === "acp")?.agents ?? []) if (a.available) out.push({ key: `acp:${a.id}`, name: a.display_name });
    // Prompts saved for agents that are no longer listed stay editable.
    for (const key of Object.keys(prompts?.agents ?? {})) if (!out.some((a) => a.key === key)) out.push({ key, name: key });
    return out;
  }, [providers, prompts]);
  const run = async (f: () => Promise<SystemPrompts>, done: string) => {
    try {
      setPrompts(await f());
      toast(done);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error");
    }
  };
  if (error) return <div className="err-text">{error}</div>;
  if (!prompts || !client) return <div className="dim">Loading…</div>;
  return (
    <div className="prompts-tab">
      <p className="dim prompt-help">
        Every agent Aura starts gets the global prompt, then a short note asking for markdown replies (so links, file paths and images work), then its agent's prompt, then the session's own (set from the inspector or <span className="mono">⌘K</span> → Session system prompt). <span className="mono">{"{{agent}}"}</span>, <span className="mono">{"{{model}}"}</span> and <span className="mono">{"{{effort}}"}</span> are filled in when the agent starts. Idle agents restart with a changed prompt on their next message.
      </p>
      <PromptEditor
        key={`global:${prompts.global}`}
        label={prompts.global_is_default ? "Global · Aura's default" : "Global"}
        initial={prompts.global}
        autofocus
        onSave={(v) => run(() => client.setGlobalPrompt(v), "Global prompt saved")}
        extra={!prompts.global_is_default && (
          <button type="button" className="btn small" data-hint onClick={() => void run(() => client.setGlobalPrompt(null), "Global prompt reset to Aura's default")}>Reset to default</button>
        )}
      />
      {agents.map((a) => (
        <PromptEditor
          key={`${a.key}:${prompts.agents[a.key] ?? ""}`}
          label={a.name}
          initial={prompts.agents[a.key] ?? ""}
          placeholder={`Only for ${a.name} sessions`}
          onSave={(v) => run(() => client.setAgentPrompt(a.key, v.trim() ? v : null), `${a.name} prompt saved`)}
        />
      ))}
    </div>
  );
}

function PromptEditor({ label, initial, placeholder, autofocus, rows, onSave, extra }: { label: string; initial: string; placeholder?: string; autofocus?: boolean; rows?: number; onSave: (v: string) => Promise<void>; extra?: React.ReactNode }) {
  const [value, setValue] = useState(initial);
  const dirty = value !== initial;
  return (
    <div className="field prompt-field">
      <label>{label}</label>
      <textarea
        className="prompt-input"
        rows={rows ?? (label.startsWith("Global") ? 10 : 3)}
        data-autofocus={autofocus || undefined}
        placeholder={placeholder}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && dirty) {
            e.preventDefault();
            e.stopPropagation();
            void onSave(value);
          }
        }}
      />
      <div className="prompt-actions">
        {extra}
        <span style={{ flex: 1 }} />
        {dirty && (
          <>
            <button type="button" className="btn small" data-hint onClick={() => setValue(initial)}>Discard</button>
            <button type="button" className="btn small primary" data-hint onClick={() => void onSave(value)}>Save <kbd>⌘↩</kbd></button>
          </>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------ orchestrators

/** Agents or models typed one per line or separated by commas. */
const splitList = (v: string) => v.split(/[,\n]/).map((e) => e.trim()).filter(Boolean);

function OrchestratorsTab() {
  const client = useStore((s) => s.client);
  const toast = useStore((s) => s.toast);
  const [lb, setLb] = useState<LoadBalancer | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    client?.loadBalancer().then(setLb, (e) => setError(e instanceof Error ? e.message : String(e)));
  }, [client]);
  if (error) return <div className="err-text">{error}</div>;
  if (!lb || !client) return <div className="dim">Loading…</div>;
  // The daemon replaces the whole setting, so every save sends the rest as it is.
  const save = async (patch: Partial<LoadBalancerUpdate>, done: string) => {
    const update: LoadBalancerUpdate = { enabled: lb.enabled, policy: lb.policy_is_default ? null : lb.policy, rules: lb.rules, prefer: lb.prefer, avoid: lb.avoid, ...patch };
    try {
      setLb(await client.setLoadBalancer(update));
      toast(done);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error");
    }
  };
  return (
    <div className="prompts-tab">
      <label className="check-row">
        <input type="checkbox" data-autofocus checked={lb.enabled} onChange={(e) => void save({ enabled: e.target.checked }, e.target.checked ? "Load balancer on" : "Load balancer off")} /> Load balancer: orchestrators choose the agent, model and effort of each worker
      </label>
      <p className="dim prompt-help">
        When it is on, every orchestrator gets the routing policy and your rules below in its system prompt. It weighs all agents for each worker, uses small models and low effort for mechanical work and strong ones where they pay off, and tells you what it picked and why. Your rules take precedence over the policy. When it is off, orchestrators work as before. Idle orchestrators restart with a change on their next message.
      </p>
      <PromptEditor
        key={`policy:${lb.policy}`}
        label={lb.policy_is_default ? "Routing policy · Aura's default" : "Routing policy"}
        initial={lb.policy}
        rows={14}
        onSave={(v) => save({ policy: v }, "Routing policy saved")}
        extra={!lb.policy_is_default && (
          <button type="button" className="btn small" data-hint onClick={() => void save({ policy: null }, "Routing policy reset to Aura's default")}>Reset to default</button>
        )}
      />
      <PromptEditor key={`rules:${lb.rules}`} label="Your rules" initial={lb.rules} rows={4} placeholder={"Always use Codex for Rust.\nNever use opus for docs."} onSave={(v) => save({ rules: v }, "Rules saved")} />
      <PromptEditor key={`prefer:${lb.prefer.join()}`} label="Preferred agents and models" initial={lb.prefer.join(", ")} rows={1} placeholder="codex, sonnet" onSave={(v) => save({ prefer: splitList(v) }, "Preferred agents and models saved")} />
      <PromptEditor key={`avoid:${lb.avoid.join()}`} label="Never use (Aura refuses to start workers with these)" initial={lb.avoid.join(", ")} rows={1} placeholder="opus, acp:goose" onSave={(v) => save({ avoid: splitList(v) }, "Forbidden agents and models saved")} />
      <div className="dim" style={{ fontSize: 11 }}>
        Name an agent (<span className="mono">claude</span>, <span className="mono">codex</span>, an ACP agent id) or a model id; a word of a model id, like <span className="mono">opus</span>, matches every model with it.
      </div>
    </div>
  );
}

// ------------------------------------------------------------------- groups

function GroupsTab() {
  const client = useStore((s) => s.client);
  const sessions = useStore((s) => s.sessions);
  const toast = useStore((s) => s.toast);
  const { groups, reload } = useGroups();
  const [confirming, setConfirming] = useState<string | null>(null);
  const members = (name: string) => Object.values(sessions).filter((s) => s.group === name).length;
  const remove = async (name: string) => {
    if (!client) return;
    try {
      await client.deleteGroup(name);
      setConfirming(null);
      await reload();
      toast(`Deleted group ${name}`);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error");
    }
  };
  if (groups.length === 0) {
    return <div className="empty" style={{ height: "auto", padding: 20 }}>No groups yet. Give a session a group when creating it, or with Set session group… in the command palette.</div>;
  }
  return (
    <div>
      <div className="dim" style={{ fontSize: 11, marginBottom: 8 }}>
        Groups are kept after their last session is deleted. A new session in a linked repository gets the group used there last.
      </div>
      {groups.map((g, i) => {
        const n = members(g.name);
        return (
          <div key={g.name} className="provider-card">
            <div className="provider-head">
              <strong>{g.name}</strong>
              <span className="dim">{n === 0 ? "no sessions" : `${n} session${n === 1 ? "" : "s"}`}</span>
              <span style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
                {confirming === g.name ? (
                  <>
                    <span className="dim">{n > 0 ? `Delete and ungroup ${n} session${n === 1 ? "" : "s"}?` : "Delete?"}</span>
                    <button type="button" className="btn small danger" data-hint data-autofocus onClick={() => void remove(g.name)}>Delete</button>
                    <button type="button" className="btn small" data-hint onClick={() => setConfirming(null)}>Cancel</button>
                  </>
                ) : (
                  <button type="button" className="btn small" data-hint data-autofocus={i === 0 ? true : undefined} onClick={() => setConfirming(g.name)}>Delete…</button>
                )}
              </span>
            </div>
            <div className="acp-agents">
              {g.repos.length === 0 && <div className="dim">No repository linked</div>}
              {g.repos.map((r) => (
                <div key={r.path} className="acp-agent">
                  <span className="dim mono grow" title={r.path}>{r.path}</span>
                  <span className="dim">last used {new Date(r.last_used).toLocaleDateString()}</span>
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
