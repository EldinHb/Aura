/**
 * Session templates live in the daemon, shared with paired phones. The app
 * mirrors the list of the computer the window shows (a remote's templates
 * name its folders) and keeps it current through `templates_changed`. A
 * template fills the new-session dialog; the session is still created by
 * `session.create` with what the dialog then holds.
 */
import { useEffect } from "react";
import { create } from "zustand";
import type { Autonomy, SessionMode, SessionTemplate, TemplateInput, TemplateKind } from "../../gen";
import { shownRpc as rpc } from "../../lib/call";
import { useStore } from "../../state/store";

type TemplateState = { templates: SessionTemplate[]; loaded: boolean; error: string | null; refresh: () => Promise<void> };

export const useTemplates = create<TemplateState>((set) => ({
  templates: [], loaded: false, error: null,
  refresh: async () => {
    try {
      const list = await rpc<SessionTemplate[] | null>("template.list");
      set({ templates: Array.isArray(list) ? list : [], loaded: true, error: null });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e), loaded: true });
    }
  },
}));

export const templates = {
  create: (input: TemplateInput) => rpc<SessionTemplate>("template.create", input),
  update: (id: string, input: TemplateInput) => rpc<SessionTemplate>("template.update", { id, ...input }),
  remove: (id: string) => rpc<boolean>("template.delete", { id }),
};

/** Keep the template list current. Mount once per window. */
export function useTemplateSync() {
  const client = useStore((s) => s.client);
  useEffect(() => {
    if (!client) return;
    // Another computer: its own templates, not the last one's.
    useTemplates.setState({ templates: [], loaded: false, error: null });
    void useTemplates.getState().refresh();
    const off = client.onEvent((ev) => {
      if (ev.type === "templates_changed") useTemplates.setState({ templates: ev.templates, loaded: true, error: null });
    });
    const offState = client.onState((s) => { if (s === "open") void useTemplates.getState().refresh(); });
    return () => { off(); offState(); };
  }, [client]);
}

export const DEFAULT_BRANCH_PATTERN = "aura/{slug}-{date}";

export function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
}

/** A branch name from a template's pattern: `{slug}` (the title, else the template's name), `{date}` (YYYYMMDD), `{time}` (HHMM). */
export function expandBranch(pattern: string | null, title: string, name: string, now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}`;
  return (pattern || DEFAULT_BRANCH_PATTERN)
    .replaceAll("{slug}", slug(title) || slug(name) || date)
    .replaceAll("{date}", date)
    .replaceAll("{time}", time)
    .replace(/\s+/g, "-");
}

/** What the new-session dialog holds, as far as a template is concerned. */
export type SessionForm = {
  /** A provider kind, or `acp:<agent>`. */
  choiceKey: string;
  kind: TemplateKind;
  /** Empty: none of its own (an orchestrator) or the dialog's default. */
  dir: string;
  /** An orchestrator with a folder of its own. */
  ownFolder: boolean;
  title: string;
  group: string;
  mode: SessionMode;
  command: string;
  model: string;
  effort: string;
  permission: string;
  sandbox: string;
  worktree: boolean;
  branchPattern: string;
  autonomy: Autonomy | null;
  systemPrompt: string;
  prompt: string;
  workspace: string | null;
};

export function choiceKeyOf(t: Pick<TemplateInput, "provider" | "agent">): string {
  return t.provider === "acp" && t.agent ? `acp:${t.agent}` : t.provider;
}

/** The dialog's options as a template called `name`. */
export function templateOf(name: string, f: SessionForm): TemplateInput {
  const [provider, agent] = f.choiceKey.startsWith("acp:") ? (["acp", f.choiceKey.slice(4)] as const) : ([f.choiceKey, null] as const);
  const terminal = provider === "terminal" || f.mode === "terminal";
  const orchestrates = f.kind !== "agent" && !terminal;
  const folder = orchestrates && !f.ownFolder ? null : f.dir.trim().replace(/\/+$/, "") || null;
  const v = (s: string) => s.trim() || null;
  return {
    name: name.trim(),
    kind: terminal ? "agent" : f.kind,
    provider: provider as TemplateInput["provider"],
    agent,
    cwd: folder,
    worktree: !!folder && f.worktree,
    branch_pattern: folder && f.worktree ? v(f.branchPattern) : null,
    workspace: f.workspace,
    group: v(f.group),
    mode: orchestrates ? "structured" : f.mode,
    command: terminal && f.command.trim() ? f.command.trim().split(/\s+/) : null,
    model: v(f.model),
    effort: v(f.effort),
    permission_mode: v(f.permission),
    sandbox_mode: v(f.sandbox),
    autonomy: f.kind === "feature_owner" ? f.autonomy : null,
    system_prompt: terminal ? null : v(f.systemPrompt),
    prompt: terminal ? null : v(f.prompt),
  };
}

/** A template's options for the dialog. What it leaves out keeps `base`'s value. */
export function formOf(t: TemplateInput, base: SessionForm): SessionForm {
  return {
    ...base,
    choiceKey: choiceKeyOf(t),
    kind: t.kind,
    dir: t.cwd ?? base.dir,
    ownFolder: t.kind !== "agent" && !!t.cwd,
    group: t.group ?? "",
    mode: t.mode ?? (t.provider === "terminal" ? "terminal" : "structured"),
    command: (t.command ?? []).join(" "),
    model: t.model ?? "",
    effort: t.effort ?? "",
    permission: t.permission_mode ?? "",
    sandbox: t.sandbox_mode ?? "",
    worktree: t.worktree,
    branchPattern: t.branch_pattern ?? (t.worktree ? DEFAULT_BRANCH_PATTERN : ""),
    autonomy: t.autonomy,
    systemPrompt: t.system_prompt ?? "",
    prompt: t.prompt ?? "",
    workspace: t.workspace ?? base.workspace,
  };
}

/** One line on what a template starts. */
export function describeTemplate(t: TemplateInput, folderName: (p: string) => string): string {
  const who = t.provider === "acp" ? t.agent ?? "acp" : t.provider;
  const kind = t.kind === "feature_owner" ? "feature owner" : t.kind === "orchestrator" ? "orchestrator" : t.provider === "terminal" ? "terminal" : "agent";
  const parts = [`${who} ${kind}`];
  if (t.cwd) parts.push(`in ${folderName(t.cwd)}`);
  else if (t.kind !== "agent") parts.push("no folder");
  if (t.worktree) parts.push(`worktree ${t.branch_pattern ?? DEFAULT_BRANCH_PATTERN}`);
  if (t.model) parts.push(t.model);
  if (t.effort) parts.push(`${t.effort} effort`);
  if (t.permission_mode) parts.push(t.permission_mode);
  if (t.prompt) parts.push("with a prompt");
  return parts.join(" · ");
}
