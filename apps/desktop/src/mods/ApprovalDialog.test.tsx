import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useStore } from "../state/store";
import { useThemes } from "../state/themes";
import { ApprovalDialog, openApprovalPrompt, useApproval } from "./ApprovalDialog";
import { useMods, type ModInfo } from "./loader";

afterEach(() => {
  cleanup();
  useApproval.setState({ prompt: null });
});

const mod: ModInfo = {
  id: "spy",
  name: "Spy",
  version: "1.0.0",
  source: "user",
  dir: "/data/mods/spy",
  status: { state: "needs_approval" },
  enabled: true,
  approved: false,
  hasUi: true,
  hasDaemon: true,
  permissions: { process: ["git"], sessions: "write" },
  dependsOn: {},
  settings: [],
  settingValues: {},
};

function client(isWindow = true) {
  const call = vi.fn(async (method: string) =>
    method === "mods.list"
      ? [mod]
      : method === "themes.list"
        ? { dir: "/d", themes: useThemes.getState().themes }
        : method === "daemon.window_status"
          ? { secretSet: isWindow, window: isWindow }
          : true,
  );
  useStore.setState({ client: { call, onNotification: () => () => {}, onState: () => () => {} } as never });
  return call;
}

it("is a dialog on <body>, outside the app, and only its Approve button grants", async () => {
  const call = client();
  useMods.setState({ mods: [mod] });
  const { container } = render(<ApprovalDialog />);
  act(() => openApprovalPrompt("mod", "spy"));
  const dialog = document.body.querySelector("dialog.aura-protected") as HTMLDialogElement;
  expect(dialog).not.toBeNull();
  expect(container.contains(dialog)).toBe(false);
  expect(dialog.parentElement).toBe(document.body);
  expect(dialog.hasAttribute("open")).toBe(true);
  expect(dialog.textContent).toContain("Run programs: git");
  expect(dialog.textContent).toContain("Aura's own rights");
  expect(call).not.toHaveBeenCalledWith("mods.approve", expect.anything());
  await waitFor(() => expect(dialog.querySelector("button.aura-protected-approve")?.hasAttribute("disabled")).toBe(false));
  await act(async () => {
    fireEvent.click(dialog.querySelector("button.aura-protected-approve")!);
  });
  expect(call).toHaveBeenCalledWith("mods.approve", { id: "spy" });
  expect(useApproval.getState().prompt).toBeNull();
});

it("cancel grants nothing", async () => {
  const call = client();
  useMods.setState({ mods: [mod] });
  render(<ApprovalDialog />);
  act(() => openApprovalPrompt("mod", "spy"));
  const dialog = document.body.querySelector("dialog.aura-protected")!;
  fireEvent.click([...dialog.querySelectorAll("button")].find((b) => b.textContent === "Cancel")!);
  expect(useApproval.getState().prompt).toBeNull();
  expect(call).not.toHaveBeenCalledWith("mods.approve", expect.anything());
});

it("asks for a theme's CSS, saying what it can do", async () => {
  const call = client();
  useThemes.setState({
    loaded: true,
    themes: [{ id: "neon", name: "Neon", base: "dark", tokens: {}, path: "/d/themes/neon.json", source: "user", warnings: [], approval: "needs_approval", cssBytes: 120 }],
  });
  render(<ApprovalDialog />);
  act(() => openApprovalPrompt("theme", "neon"));
  const dialog = document.body.querySelector("dialog.aura-protected")!;
  expect(dialog.textContent).toContain("/d/themes/neon.css");
  expect(dialog.textContent).toContain("can restyle every screen in Aura, including the cards where you approve what agents run");
  await waitFor(() => expect(dialog.querySelector("button.aura-protected-approve")?.hasAttribute("disabled")).toBe(false));
  await act(async () => {
    fireEvent.click(dialog.querySelector("button.aura-protected-approve")!);
  });
  expect(call).toHaveBeenCalledWith("themes.approve", { id: "neon" });
});

it("a window without the secret cannot approve, and says why", async () => {
  const call = client(false);
  useMods.setState({ mods: [mod] });
  render(<ApprovalDialog />);
  act(() => openApprovalPrompt("mod", "spy"));
  const dialog = document.body.querySelector("dialog.aura-protected")!;
  await waitFor(() => expect(dialog.textContent).toContain("This window can't approve"));
  expect([...dialog.querySelectorAll("button")].map((b) => b.textContent)).not.toContain("Approve and start");
  expect(call).not.toHaveBeenCalledWith("mods.approve", expect.anything());
});
