import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PreReview, ProviderInfo, Session, SystemPrompts } from "../../gen";
import type { RpcClient } from "../../lib/rpc";
import { useStore } from "../../state/store";
import { agentLabel } from "../../features/reviews/ReviewEditor";
import { reviewFixture } from "../../features/reviews/fixtures";
import { SettingsDialog } from "./SettingsDialog";
import { SystemPromptDialog } from "./SystemPromptDialog";

let prompts: SystemPrompts;
const setGlobalPrompt = vi.fn(async (prompt: string | null) => {
  prompts = { ...prompts, global: prompt ?? prompts.default_global, global_is_default: prompt === null };
  return prompts;
});
const setAgentPrompt = vi.fn(async (agent: string, prompt: string | null) => {
  const agents = { ...prompts.agents };
  if (prompt) agents[agent] = prompt;
  else delete agents[agent];
  prompts = { ...prompts, agents };
  return prompts;
});
const setSystemPrompt = vi.fn(async () => ({}) as Session);

const providers = [
  { kind: "claude", display_name: "Claude Code", agents: [] },
  { kind: "acp", display_name: "ACP", agents: [{ id: "gemini", display_name: "Gemini CLI", available: true }, { id: "goose", display_name: "goose", available: false }] },
] as unknown as ProviderInfo[];

beforeEach(() => {
  prompts = { global: "Sign GitHub posts", global_is_default: true, default_global: "Sign GitHub posts", agents: { "acp:gemini": "Be brief" } };
  vi.clearAllMocks();
  useStore.setState({
    providers,
    dialog: { kind: "none" },
    sessions: { s1: { id: "s1", title: "Fix bug", status: "idle", system_prompt: "Use pnpm" } as Session },
    client: {
      systemPrompts: () => Promise.resolve(prompts),
      setGlobalPrompt,
      setAgentPrompt,
      setSystemPrompt,
      effectivePrompt: () => Promise.resolve("Sign GitHub posts\n\nUse pnpm"),
    } as unknown as RpcClient,
  });
});
afterEach(cleanup);

it("edits the global prompt, resets it to the default and sets per-agent prompts", async () => {
  render(<SettingsDialog tab="prompts" />);
  const global = (await screen.findByText("Global · Aura's default")).parentElement!.querySelector("textarea")!;
  expect(global.value).toBe("Sign GitHub posts");
  expect(screen.queryByText("Reset to default")).toBeNull();

  expect(screen.queryByText("Save")).toBeNull();
  fireEvent.change(global, { target: { value: "My rules" } });
  fireEvent.click(screen.getByText("Save"));
  await waitFor(() => expect(setGlobalPrompt).toHaveBeenCalledWith("My rules"));
  fireEvent.click(await screen.findByText("Reset to default"));
  await waitFor(() => expect(setGlobalPrompt).toHaveBeenLastCalledWith(null));

  const gemini = screen.getByText("Gemini CLI").parentElement!.querySelector("textarea")!;
  expect(gemini.value).toBe("Be brief");
  fireEvent.change(gemini, { target: { value: "" } });
  fireEvent.click(screen.getByText("Gemini CLI").parentElement!.querySelector<HTMLButtonElement>(".btn.primary")!);
  await waitFor(() => expect(setAgentPrompt).toHaveBeenCalledWith("acp:gemini", null));
  const labels = [...document.querySelectorAll(".prompt-field label")].map((l) => l.textContent);
  expect(labels).toEqual(["Global · Aura's default", "Claude Code", "Gemini CLI"]);
});

it("saves a session's own prompt and shows what its agent starts with", async () => {
  render(<SystemPromptDialog sessionId="s1" />);
  const input = screen.getByPlaceholderText(/this session only/) as HTMLTextAreaElement;
  expect(input.value).toBe("Use pnpm");
  expect(await screen.findByText(/Sign GitHub posts/)).toBeTruthy();
  fireEvent.change(input, { target: { value: "   " } });
  fireEvent.click(screen.getByText("Save"));
  await waitFor(() => expect(setSystemPrompt).toHaveBeenCalledWith("s1", null));
});

it("labels a pre-review with the agent, exact model and effort it ran with", () => {
  expect(agentLabel(reviewFixture)).toBe("Codex · model gpt-5.5-codex · effort medium");
  const claude: PreReview = { ...reviewFixture, agent: { provider: "Claude Code", model: "opus", model_id: "claude-opus-5-5", effort: null } };
  expect(agentLabel(claude)).toBe("Claude Code · model opus (claude-opus-5-5) · effort default");
  expect(agentLabel({ ...reviewFixture, agent: null })).toBe("codex · default model");
});
