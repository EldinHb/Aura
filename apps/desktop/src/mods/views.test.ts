import { beforeEach, describe, expect, it } from "vitest";
import { useStore } from "../state/store";
import { openModView } from "./views";

const values = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => values.set(k, v), removeItem: (k: string) => values.delete(k), clear: () => values.clear() } });

const st = () => useStore.getState();
const tabs = () => st().tabs.map((t) => [t.key, t.preview]);
const page = (n: number) => ({ key: `https://github.com/acme/api/pull/${n}`, title: `#${n} PR` });

beforeEach(() => {
  localStorage.clear();
  useStore.setState({ sessions: {}, sessionOrder: [], selectedId: null, modView: null, tabs: [], activeTab: null, recentTabs: [], closedTabs: [] });
  st().restoreTabs();
});

describe("openModView", () => {
  it("opens the preview tab by default, which the next preview replaces", () => {
    openModView("pr-status", "pr", page(1));
    openModView("pr-status", "pr", page(2));
    expect(tabs()).toEqual([["m:pr-status:pr:https://github.com/acme/api/pull/2", true]]);
  });

  it("with preview: false opens a tab of its own, and shows that tab again for the same view", () => {
    openModView("pr-status", "pr", page(1), { preview: false });
    openModView("pr-status", "pr", page(2), { preview: false });
    expect(tabs()).toEqual([
      ["m:pr-status:pr:https://github.com/acme/api/pull/1", false],
      ["m:pr-status:pr:https://github.com/acme/api/pull/2", false],
    ]);
    // A later preview does not replace them.
    openModView("pr-status", "other", { key: "x" });
    expect(tabs()).toHaveLength(3);
    openModView("pr-status", "pr", page(1), { preview: false });
    expect(st().activeTab).toBe("m:pr-status:pr:https://github.com/acme/api/pull/1");
    expect(tabs()).toHaveLength(3);
    expect(st().modView).toEqual({ modId: "pr-status", id: "pr", props: page(1) });
  });
});
