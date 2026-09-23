/**
 * ACP (Agent Client Protocol) sessions: one provider kind, `acp`, fronting many
 * agents. Which agent a session runs is `session.agent`; the agents the daemon
 * found are `ProviderInfo.agents` of the `acp` provider.
 *
 * What an agent offers (models, modes, effort, slash commands) is only known
 * once its session exists. The daemon publishes it as `provider_info` with
 * `kind: "acp_session"`, which the transcript keeps under
 * `providerInfo.acp_session`.
 */
import type { ProviderInfo, ProviderKind, Session, SlashCommand } from "../gen";

export type ProviderChoice = { key: string; kind: ProviderKind; agent: string | null; label: string; version: string | null };

type Named = { id: string; name: string; description?: string | null };
type SelectValue = { value: string; name: string; description?: string | null };
type ConfigOption = {
  id: string;
  name: string;
  category?: string | null;
  type: string;
  currentValue?: string | boolean;
  options?: (SelectValue | { group: string; name: string; options: SelectValue[] })[];
};
export type AcpSessionInfo = {
  agent?: { id?: string; name?: string; info?: { name?: string; title?: string | null; version?: string } | null };
  current_mode?: string | null;
  modes?: Named[];
  config_options?: ConfigOption[];
  commands?: { name: string; description?: string | null; hint?: string | null }[];
  title?: string | null;
};

export function choiceKey(kind: ProviderKind, agent?: string | null): string {
  return kind === "acp" && agent ? `acp:${agent}` : kind;
}

/** What a new session can be: Claude Code, Codex, each installed ACP agent, then a plain terminal. */
export function providerChoices(providers: ProviderInfo[]): ProviderChoice[] {
  const out: ProviderChoice[] = [];
  for (const kind of ["claude", "codex"] as ProviderKind[]) {
    const p = providers.find((x) => x.kind === kind);
    if (p?.available) out.push({ key: kind, kind, agent: null, label: p.display_name, version: p.version });
  }
  for (const a of providers.find((x) => x.kind === "acp")?.agents ?? []) {
    if (a.available) out.push({ key: choiceKey("acp", a.id), kind: "acp", agent: a.id, label: a.display_name, version: null });
  }
  const terminal = providers.find((x) => x.kind === "terminal");
  if (terminal?.available) out.push({ key: "terminal", kind: "terminal", agent: null, label: terminal.display_name, version: terminal.version });
  return out;
}

/** "Claude Code", "Codex", "Gemini CLI", … for a session. */
export function sessionProviderLabel(session: Pick<Session, "provider" | "agent">, providers: ProviderInfo[]): string {
  if (session.provider === "acp") {
    return providers.find((p) => p.kind === "acp")?.agents.find((a) => a.id === session.agent)?.display_name ?? session.agent ?? "ACP agent";
  }
  const fixed: Partial<Record<ProviderKind, string>> = { claude: "Claude Code", codex: "Codex" };
  return fixed[session.provider] ?? providers.find((p) => p.kind === session.provider)?.display_name ?? session.provider;
}

export function acpSessionInfo(providerInfo: Record<string, unknown> | undefined): AcpSessionInfo | null {
  const info = providerInfo?.acp_session;
  return info && typeof info === "object" ? (info as AcpSessionInfo) : null;
}

/** Values of the agent's select option in `category` (`model`, `thought_level`, `mode`), groups flattened. */
export function acpChoices(info: AcpSessionInfo | null, category: string): SelectValue[] {
  const option = info?.config_options?.find((o) => o.category === category && o.type === "select");
  return (option?.options ?? []).flatMap((o) => ("group" in o ? o.options : [o]));
}

/** Modes for the permission picker: session modes, else a `mode` config option. */
export function acpModes(info: AcpSessionInfo | null): SelectValue[] {
  if (info?.modes?.length) return info.modes.map((m) => ({ value: m.id, name: m.name, description: m.description }));
  return acpChoices(info, "mode");
}

export function acpSlashCommands(info: AcpSessionInfo | null): SlashCommand[] {
  return (info?.commands ?? []).map((c) => ({ name: c.name, description: c.description ?? c.hint ?? null, source: "agent" }));
}
