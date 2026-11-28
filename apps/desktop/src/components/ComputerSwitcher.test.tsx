import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Session } from "../gen";
import type { RemoteComputer } from "../lib/remoteComputers";

const switched = vi.hoisted(() => [] as string[]);
vi.mock("../state/computers", async (orig) => ({
  ...(await orig<typeof import("../state/computers")>()),
  switchComputer: (id: string) => {
    switched.push(id);
    return Promise.resolve();
  },
}));

const { ComputerSwitcher, useComputerMenu } = await import("./ComputerSwitcher");
const { LOCAL, localName, useComputers } = await import("../state/computers");
const { useStore } = await import("../state/store");
const { registerComputerCommands } = await import("../commands/computers");

const remote = (id: string, name: string, state: RemoteComputer["state"]): RemoteComputer => ({
  id, name, label: null, serverName: name, host: "10.0.0.2", alt: [], port: 7443, fingerprint: "ab".repeat(32), deviceId: "d", pairedAt: "", state,
});
const session = (id: string, pending = 0) => ({ id, title: id, pending_count: pending }) as Session;

let offCommands: () => void;
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  switched.length = 0;
  offCommands = registerComputerCommands();
  useComputerMenu.setState({ open: false });
  useStore.setState({ computer: LOCAL, connection: "open", sessions: { a: session("a", 1) }, dialog: { kind: "none" }, sidebarCollapsed: false });
  useComputers.setState({
    remotes: [
      remote("srv", "Home server", { kind: "online", serverName: "Home server", version: "0.6.3" }),
      remote("old", "Old laptop", { kind: "revoked", reason: "Old laptop no longer accepts this computer" }),
      remote("moved", "Attic", { kind: "cert_mismatch", expected: "a".repeat(64), actual: "b".repeat(64) }),
    ],
    sessions: { srv: { x: session("x", 2) } },
  });
});
afterEach(() => {
  cleanup();
  offCommands();
});

const options = () => screen.getAllByRole("option").map((o) => o.textContent);

it("names the computer shown and counts what waits on the others", () => {
  render(<ComputerSwitcher />);
  expect(screen.getByRole("button", { name: `Computer: ${localName()}. Switch computer` })).toBeTruthy();
  expect(document.querySelector(".workspace-others .badge")?.textContent).toBe("2");
});

it("lists this computer and every remote with its state, and switches by keyboard", async () => {
  render(<ComputerSwitcher />);
  fireEvent.click(screen.getByRole("button", { name: /Switch computer/ }));
  const list = options();
  expect(list[0]).toContain(localName());
  expect(list[0]).toContain("1"); // its own waiting count
  expect(list[1]).toContain("Home server");
  expect(list[1]).toContain("2");
  expect(list[2]).toContain("pair again");
  expect(list[3]).toContain("certificate changed");
  expect(list.slice(-2)).toEqual(["+Add remote computer…", "Manage remote computers…"]);

  const menu = screen.getByRole("dialog", { name: "Switch computer" });
  fireEvent.keyDown(menu, { key: "ArrowDown" });
  await act(async () => fireEvent.keyDown(menu, { key: "Enter" }));
  expect(switched).toEqual(["srv"]);
  expect(useComputerMenu.getState().open).toBe(false);
});

it("a remote that needs pairing again opens the remote computers instead of switching", async () => {
  render(<ComputerSwitcher />);
  fireEvent.click(screen.getByRole("button", { name: /Switch computer/ }));
  await act(async () => fireEvent.keyDown(screen.getByRole("dialog", { name: "Switch computer" }), { key: "3" }));
  expect(switched).toEqual([]);
  expect(useStore.getState().dialog).toEqual({ kind: "computers" });
});

it("ends with adding a remote computer", async () => {
  render(<ComputerSwitcher />);
  fireEvent.click(screen.getByRole("button", { name: /Switch computer/ }));
  const menu = screen.getByRole("dialog", { name: "Switch computer" });
  fireEvent.keyDown(menu, { key: "End" });
  fireEvent.keyDown(menu, { key: "ArrowUp" });
  await act(async () => fireEvent.keyDown(menu, { key: "Enter" }));
  expect(useStore.getState().dialog).toEqual({ kind: "computers", add: true });
});

it("marks a remote shown", () => {
  useStore.setState({ computer: "srv" });
  render(<ComputerSwitcher />);
  expect(screen.getByRole("button", { name: "Computer: Home server. Switch computer" })).toBeTruthy();
  expect(document.querySelector(".computer-switcher.remote")).not.toBeNull();
  // What waits elsewhere is now this computer's, tracked in the background; the remote's is the store's.
  act(() => useComputers.setState((s) => ({ sessions: { ...s.sessions, [LOCAL]: { a: session("a", 4) } } })));
  expect(document.querySelector(".workspace-others .badge")?.textContent).toBe("4");
});
