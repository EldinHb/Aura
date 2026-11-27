import { expect, it, vi } from "vitest";

const values = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => values.set(k, v), removeItem: (k: string) => values.delete(k), clear: () => values.clear() } });

it("loads saved settings when the store is created", async () => {
  localStorage.setItem("aura.settings.v1", JSON.stringify({ theme: "light", fontSize: 15 }));
  vi.resetModules();
  const { useStore } = await import("./store");
  expect(useStore.getState().settings).toMatchObject({ theme: "light", fontSize: 15, keymapPreset: "default" });
});

it("falls back to the default for a saved setting of another type", async () => {
  localStorage.setItem("aura.settings.v1", JSON.stringify({ theme: "light", notifications: "yes", keymapOverrides: null, fontSize: "15" }));
  vi.resetModules();
  const { useStore, defaultSettings } = await import("./store");
  expect(useStore.getState().settings).toEqual({ ...defaultSettings, theme: "light" });
});

it("loads expanded leaders when the store is created, and drops the collapsed orchestrators saved before leaders-only", async () => {
  localStorage.setItem("aura.sidebar-collapsed.v1", JSON.stringify(["o1"]));
  localStorage.setItem("aura.sidebar-expanded.v1", JSON.stringify(["o2"]));
  vi.resetModules();
  const { useStore } = await import("./store");
  expect(useStore.getState().expandedOrchestras).toEqual(["o2"]);
  expect(localStorage.getItem("aura.sidebar-collapsed.v1")).toBeNull();
});

it("comes back to the workspace this window showed last", async () => {
  localStorage.setItem("aura.workspace", "ws-2");
  vi.resetModules();
  const { useStore } = await import("./store");
  expect(useStore.getState().activeWorkspace).toBe("ws-2");
  // Gone since: the first workspace instead.
  useStore.getState().setWorkspaces([{ id: "ws-1", name: "One", created_at: "", position: 0 }]);
  expect(useStore.getState().activeWorkspace).toBe("ws-1");
});
