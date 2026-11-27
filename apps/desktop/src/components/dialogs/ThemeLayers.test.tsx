import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { RpcClient } from "../../lib/rpc";
import { useStore } from "../../state/store";
import { NO_LAYERS_NOTE, useThemes } from "../../state/themes";
import { SettingsDialog } from "./SettingsDialog";

const g = globalThis as { CSSLayerBlockRule?: unknown };

beforeEach(() => {
  useStore.setState({
    providers: [],
    dialog: { kind: "none" },
    settings: { ...useStore.getState().settings, theme: "neon" },
    client: { getSetting: async () => null, setSetting: async () => true } as unknown as RpcClient,
  });
  useThemes.setState({
    loaded: true,
    dir: "/d/themes",
    themes: [{ id: "neon", name: "Neon", base: "dark", tokens: {}, css: ".a{}", path: "/d/themes/neon.json", source: "user", warnings: [], approval: "approved" }],
  });
});
afterEach(() => {
  cleanup();
  delete g.CSSLayerBlockRule;
});

it("says why a theme's CSS is not used where cascade layers are missing (macOS 12.0–12.2)", () => {
  delete g.CSSLayerBlockRule;
  render(<SettingsDialog tab="general" />);
  expect(screen.getByText(NO_LAYERS_NOTE)).toBeTruthy();
  expect(NO_LAYERS_NOTE).toBe("This system can't protect approval prompts from theme CSS, so only its colours are used.");
});

it("says nothing of the kind where they exist", () => {
  g.CSSLayerBlockRule = class {};
  render(<SettingsDialog tab="general" />);
  expect(screen.queryByText(NO_LAYERS_NOTE)).toBeNull();
});
