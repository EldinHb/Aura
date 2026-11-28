import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderInfo, SessionTemplate } from "../../gen";
import type { RpcClient } from "../../lib/rpc";
import { useStore } from "../../state/store";
import { LOCAL } from "../../state/computers";
import { NewSessionDialog } from "../../components/dialogs/NewSessionDialog";
import { TemplatesTab } from "./TemplatesTab";
import { expandBranch, formOf, templateOf, useTemplates, type SessionForm } from "./state";

const template = (over: Partial<SessionTemplate> = {}): SessionTemplate => ({
  id: "t1", created_at: "", updated_at: "", name: "Review PRs", kind: "agent", provider: "codex", agent: null, cwd: "/repo", worktree: true,
  branch_pattern: "review/{slug}-{date}", workspace: null, group: "backend", mode: null, command: null, model: "gpt-5", effort: "high",
  permission_mode: null, sandbox_mode: "workspace-write", autonomy: null, system_prompt: "Be brief.", prompt: "Review the open pull requests", ...over,
});
const blank: SessionForm = {
  choiceKey: "claude", kind: "agent", dir: "/home/me", ownFolder: false, title: "", group: "", mode: "structured", command: "", model: "", effort: "",
  permission: "", sandbox: "", worktree: false, branchPattern: "", autonomy: null, systemPrompt: "", prompt: "", workspace: null,
};

describe("templates and the dialog's options", () => {
  it("expand a branch pattern from the title, else the template's name", () => {
    const at = new Date(2026, 10, 3, 9, 5);
    expect(expandBranch("review/{slug}-{date}", "Fix login", "Review PRs", at)).toBe("review/fix-login-20261103");
    expect(expandBranch(null, "", "Review PRs", at)).toBe("aura/review-prs-20261103");
    expect(expandBranch("x/{time} {date}", "", "", at)).toBe("x/0905-20261103");
  });

  it("go both ways without losing an option", () => {
    const t = template();
    const f = formOf(t, blank);
    expect(f).toMatchObject({ choiceKey: "codex", dir: "/repo", model: "gpt-5", effort: "high", sandbox: "workspace-write", worktree: true, prompt: "Review the open pull requests" });
    const { id: _i, created_at: _c, updated_at: _u, ...input } = t;
    expect(templateOf("Review PRs", f)).toEqual({ ...input, mode: "structured" });
  });

  it("keep only what fits the kind of session", () => {
    const owner = templateOf("Owner", { ...blank, kind: "feature_owner", autonomy: { level: "autonomous", checkpoints: [] }, prompt: "Ship it", worktree: true });
    expect(owner).toMatchObject({ kind: "feature_owner", cwd: null, worktree: false, branch_pattern: null, autonomy: { level: "autonomous" } });
    const term = templateOf("Shell", { ...blank, choiceKey: "terminal", mode: "terminal", command: "htop -d 5", prompt: "ignored", kind: "orchestrator" });
    expect(term).toMatchObject({ kind: "agent", command: ["htop", "-d", "5"], prompt: null });
    expect(templateOf("A", { ...blank, choiceKey: "acp:gemini" })).toMatchObject({ provider: "acp", agent: "gemini" });
  });
});

const providers = [
  { kind: "claude", display_name: "Claude Code", available: true, version: "2", capabilities: { permission_modes: ["default"], sandbox_modes: [], effort: true }, agents: [] },
  { kind: "codex", display_name: "Codex", available: true, version: "1", capabilities: { permission_modes: [], sandbox_modes: ["read-only", "workspace-write"], effort: true }, agents: [] },
] as unknown as ProviderInfo[];
const call = vi.fn();
const createSession = vi.fn();
const offsetParent = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetParent");
beforeAll(() => Object.defineProperty(HTMLElement.prototype, "offsetParent", { configurable: true, get: () => document.body }));
afterAll(() => offsetParent && Object.defineProperty(HTMLElement.prototype, "offsetParent", offsetParent));
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  call.mockReset();
  createSession.mockReset().mockResolvedValue({ id: "new" });
  useTemplates.setState({ templates: [template()], loaded: true, error: null });
  useStore.setState({
    client: {
      call, createSession,
      home: () => Promise.resolve("/home/me"),
      listDir: () => Promise.resolve([]),
      gitRepoRoot: (d: string) => Promise.resolve(d.startsWith("/repo") ? "/repo" : null),
      groups: () => Promise.resolve([]),
      groupForDir: () => Promise.resolve(null),
      models: (p: string) => Promise.resolve(p === "codex" ? [{ id: "gpt-5", display_name: "GPT-5", is_default: true, efforts: ["low", "high"], default_effort: "low", description: null }] : []),
    } as unknown as RpcClient,
    computer: LOCAL, localClient: null,
    providers, selectedId: null, settings: { ...useStore.getState().settings, defaultProvider: "claude" },
  });
});
afterEach(cleanup);

describe("the new-session dialog", () => {
  it("fills every option from a template and starts the session with them", async () => {
    render(<NewSessionDialog />);
    await act(async () => { fireEvent.click(screen.getByRole("radio", { name: "Review PRs" })); });
    await waitFor(() => expect((screen.getByDisplayValue("Review the open pull requests") as HTMLTextAreaElement)).toBeTruthy());
    await waitFor(() => expect(screen.getByRole("radio", { name: /Codex/ }).getAttribute("aria-checked")).toBe("true"));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Create/ })); });
    expect(createSession).toHaveBeenCalledWith(expect.objectContaining({
      provider: "codex", cwd: "/repo", model: "gpt-5", effort: "high", sandbox_mode: "workspace-write", group: "backend",
      initial_prompt: "Review the open pull requests", system_prompt: "Be brief.",
      worktree: expect.objectContaining({ branch: expect.stringMatching(/^review\/review-prs-\d{8}$/) }),
    }));
  });

  it("saves its options as a template", async () => {
    call.mockImplementation(async (_m: string, p: { name: string }) => template({ id: "t2", name: p.name }));
    render(<NewSessionDialog />);
    fireEvent.click(screen.getByRole("button", { name: /Save as template/ }));
    fireEvent.change(screen.getByRole("textbox", { name: "Template name" }), { target: { value: "Quick claude" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save" })); });
    expect(call).toHaveBeenCalledWith("template.create", expect.objectContaining({ name: "Quick claude", provider: "claude", kind: "agent" }));
  });
});

describe("Settings → Templates", () => {
  it("renames and deletes", async () => {
    call.mockResolvedValue(template());
    render(<TemplatesTab />);
    expect(screen.getByText(/codex agent · in repo · worktree review/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Rename…" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Template name" }), { target: { value: "Reviews" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save" })); });
    expect(call).toHaveBeenCalledWith("template.update", expect.objectContaining({ id: "t1", name: "Reviews", provider: "codex", prompt: "Review the open pull requests" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete…" }));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Delete" })); });
    expect(call).toHaveBeenCalledWith("template.delete", { id: "t1" });
  });
});

describe("on a remote computer", () => {
  it("are that computer's, edited there", async () => {
    const localCall = vi.fn();
    useStore.setState({ computer: "remote-1", localClient: { call: localCall } as unknown as RpcClient });
    call.mockResolvedValue(true);
    render(<TemplatesTab />);
    expect(screen.getByText(/the computer this window shows/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Delete…" }));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Delete" })); });
    expect(call).toHaveBeenCalledWith("template.delete", { id: "t1" });
    expect(localCall).not.toHaveBeenCalled();
  });
});
