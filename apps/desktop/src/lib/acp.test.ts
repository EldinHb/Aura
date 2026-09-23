import { describe, expect, it } from "vitest";
import type { AgentInfo, ProviderInfo, ProviderKind } from "../gen";
import { acpChoices, acpModes, acpSessionInfo, acpSlashCommands, providerChoices, sessionProviderLabel } from "./acp";

const caps = { structured: true, models: false, effort: false, permission_modes: [], sandbox_modes: [], fork: false, steer: false, interrupt: true, review: false, compact: false, mcp_status: false, skills_list: false, slash_commands: false, images: false, diff_stream: false, plan_stream: false, native_sessions: false, rename: false, terminal_mode: false };
const provider = (kind: ProviderKind, display_name: string, available: boolean, agents: AgentInfo[] = []): ProviderInfo => ({ kind, display_name, available, version: null, binary: null, capabilities: caps, agents });
const agent = (id: string, display_name: string, available: boolean): AgentInfo => ({ id, display_name, command: [id, "--acp"], available, binary: available ? `/bin/${id}` : null, source: "builtin" });

const providers = [
  provider("terminal", "Terminal", true),
  provider("acp", "ACP agents", true, [agent("gemini", "Gemini CLI", true), agent("goose", "goose", false), agent("opencode", "OpenCode", true)]),
  provider("codex", "Codex", false),
  provider("claude", "Claude Code", true),
];

describe("providerChoices", () => {
  it("offers Claude and Codex first, then each installed ACP agent, then the terminal", () => {
    expect(providerChoices(providers).map((c) => c.key)).toEqual(["claude", "acp:gemini", "acp:opencode", "terminal"]);
    const gemini = providerChoices(providers)[1];
    expect(gemini).toMatchObject({ kind: "acp", agent: "gemini", label: "Gemini CLI" });
  });
});

describe("sessionProviderLabel", () => {
  it("names the ACP agent, falling back to its id", () => {
    expect(sessionProviderLabel({ provider: "acp", agent: "gemini" }, providers)).toBe("Gemini CLI");
    expect(sessionProviderLabel({ provider: "acp", agent: "removed-agent" }, providers)).toBe("removed-agent");
    expect(sessionProviderLabel({ provider: "claude", agent: null }, providers)).toBe("Claude Code");
    expect(sessionProviderLabel({ provider: "codex", agent: null }, [])).toBe("Codex");
  });
});

describe("acp session info", () => {
  const info = acpSessionInfo({
    init: {},
    acp_session: {
      modes: [],
      config_options: [
        { id: "m", name: "Model", category: "model", type: "select", currentValue: "pro", options: [{ group: "g", name: "Google", options: [{ value: "pro", name: "Pro" }, { value: "flash", name: "Flash" }] }] },
        { id: "mode", name: "Mode", category: "mode", type: "select", currentValue: "ask", options: [{ value: "ask", name: "Ask" }] },
        { id: "b", name: "Web", category: "model", type: "boolean", currentValue: true },
      ],
      commands: [{ name: "init", description: null, hint: "path to write" }],
    },
  });

  it("flattens grouped select options of a category", () => {
    expect(acpChoices(info, "model").map((c) => c.value)).toEqual(["pro", "flash"]);
    expect(acpChoices(info, "thought_level")).toEqual([]);
  });

  it("uses a mode config option when the agent has no session modes", () => {
    expect(acpModes(info).map((m) => m.value)).toEqual(["ask"]);
    expect(acpModes({ modes: [{ id: "yolo", name: "YOLO" }] })).toEqual([{ value: "yolo", name: "YOLO", description: undefined }]);
  });

  it("turns announced commands into slash commands", () => {
    expect(acpSlashCommands(info)).toEqual([{ name: "init", description: "path to write", source: "agent" }]);
    expect(acpSlashCommands(acpSessionInfo({}))).toEqual([]);
  });
});
