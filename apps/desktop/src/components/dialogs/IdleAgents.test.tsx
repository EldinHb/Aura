import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RpcClient } from "../../lib/rpc";
import { useStore } from "../../state/store";
import { SettingsDialog } from "./SettingsDialog";

const settings = new Map<string, string>();
const setSetting = vi.fn(async (k: string, v: string) => { settings.set(k, v); return true; });

beforeEach(() => {
  settings.clear();
  setSetting.mockClear();
  useStore.setState({ providers: [], dialog: { kind: "none" }, client: { getSetting: async (k: string) => settings.get(k) ?? null, setSetting } as unknown as RpcClient });
});
afterEach(cleanup);

it("shows the daemon's idle timeout for agents, 6 hours by default, and saves a new one", async () => {
  render(<SettingsDialog tab="general" />);
  const input = screen.getByLabelText(/Stop idle agents after/) as HTMLInputElement;
  await waitFor(() => expect(input.value).toBe("6"));
  fireEvent.change(input, { target: { value: "0" } });
  fireEvent.blur(input);
  await waitFor(() => expect(setSetting).toHaveBeenCalledWith("agents.idle_stop_hours", "0"));
});
