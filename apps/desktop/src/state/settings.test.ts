import { expect, it, vi } from "vitest";

const values = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => values.set(k, v), removeItem: (k: string) => values.delete(k), clear: () => values.clear() } });

it("loads saved settings when the store is created", async () => {
  localStorage.setItem("aura.settings.v1", JSON.stringify({ theme: "light", fontSize: 15 }));
  vi.resetModules();
  const { useStore } = await import("./store");
  expect(useStore.getState().settings).toMatchObject({ theme: "light", fontSize: 15, keymapPreset: "default" });
});
