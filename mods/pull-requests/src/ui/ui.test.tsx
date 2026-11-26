// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "./test/rtl";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import activate from "../ui";
import { useStore } from "./host";
import { useNav } from "./nav";
import { PullSettingsTab } from "./SettingsTab";
import { usePrSettings } from "./settings";
import { fakeCtx, type FakeCtx } from "./test/ctx";
import { resetStores } from "./test/reset";
import { ReviewSidebar } from "./reviews/ReviewSidebar";
import { useReviews } from "./reviews/state";
import { inboxFixture, pullFixture } from "./reviews/fixtures";

vi.mock("./host", () => import("./test/host"));
vi.hoisted(() => {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => values.set(k, v), removeItem: (k: string) => values.delete(k), clear: () => values.clear() } });
});

let fake: FakeCtx;
let deactivate: (() => void) | void;
beforeEach(() => {
  resetStores();
  fake = fakeCtx();
  fake.rpc.mockImplementation(async (method: string) => method === "pulls.list" ? inboxFixture : method === "watches.list" ? [] : true);
  useStore.setState({ dialog: { kind: "none" }, focus: "sidebar" });
});
afterEach(() => { if (deactivate) deactivate(); deactivate = undefined; cleanup(); });

it("fills Aura's slots, registers its commands and loads what it stored", async () => {
  fake.storage.set("pullFilters", ["label:wip"]);
  fake.storage.set("reviews.hidden", true);
  deactivate = activate(fake.api);
  expect(Object.fromEntries(Object.entries(fake.slots).map(([slot, defs]) => [slot, defs.map((d: any) => d.id ?? "renderer")]))).toEqual({
    sidebarSection: ["pulls"], view: ["pull", "history"], dialog: ["review-settings", "review-submit", "pr-watch"],
    inspectorSection: ["watches"], inboxRenderer: ["renderer"], settingsTab: ["pull-requests"],
  });
  expect([...fake.commands.keys()].sort()).toEqual([
    "pull-requests.pr.watch", "pull-requests.pr.watch-check", "pull-requests.pr.watch-stop",
    "pull-requests.reviews.hidden", "pull-requests.reviews.hide", "pull-requests.reviews.history", "pull-requests.reviews.refresh", "pull-requests.reviews.start", "pull-requests.reviews.toggle",
  ]);
  expect(usePrSettings.getState().pullFilters).toEqual(["label:wip"]);
  expect(useReviews.getState().hidden).toBe(true);
  await waitFor(() => expect(useReviews.getState().inbox).toEqual(inboxFixture));
  expect(fake.rpc).toHaveBeenCalledWith("watches.list", {});
});

it("sets the prSelected context key while a PR's page is open, for the PR commands", () => {
  deactivate = activate(fake.api);
  expect(fake.context.get("prSelected")).toBe(false);
  expect(fake.commands.get("pull-requests.reviews.start")?.when).toBe("mod.pull-requests.prSelected");
  act(() => useNav.setState({ pull: pullFixture }));
  expect(fake.context.get("prSelected")).toBe(true);
  expect(fake.context.get("prId")).toBe(pullFixture.id);
  fake.api.commands.run("pull-requests.reviews.start");
  expect(fake.dialogs).toEqual([{ id: "review-settings", props: { pull: pullFixture, config: undefined } }]);
});

it("keeps Aura's turn notification quiet for a session handling review activity", () => {
  deactivate = activate(fake.api);
  fake.emit("follows.started", { session: { id: "s", title: "Feature" } });
  expect(fake.suppressed({ id: "s" })).toBe(true);
  expect(fake.suppressed({ id: "other" })).toBe(false);
});

it("steps through the PR list with j and k while it has focus, and hides with x", async () => {
  deactivate = activate(fake.api);
  const second = { ...pullFixture, id: "acme/widget#43", number: 43, title: "Second" };
  useReviews.setState({ inbox: { ...inboxFixture, pulls: [pullFixture, second] } });
  render(<ReviewSidebar focused />);
  const list = document.querySelector<HTMLElement>(".pr-sidebar-list")!;
  expect(list.hasAttribute("data-keynav")).toBe(true);
  list.focus();
  fireEvent.keyDown(list, { key: "j" });
  expect(fake.view()?.props.pull.id).toBe(pullFixture.id);
  fireEvent.keyDown(list, { key: "j" });
  expect(fake.view()?.props.pull.id).toBe(second.id);
  expect(document.activeElement).toBe(list);
  expect(screen.getByTitle("Second").closest(".pr-sidebar-row")!.className).toContain("selected");
  fireEvent.keyDown(list, { key: "k" });
  expect(fake.view()?.props.pull.id).toBe(pullFixture.id);
  fireEvent.keyDown(list, { key: "x" });
  await waitFor(() => expect(fake.rpc).toHaveBeenCalledWith("pulls.hide", { id: pullFixture.id, account: pullFixture.account }));
  fireEvent.keyDown(list, { key: "Enter" });
  expect(useStore.getState().focus).toBe("main");
});

it("edits the PR settings and keeps them in the mod's storage", () => {
  deactivate = activate(fake.api);
  render(<PullSettingsTab />);
  fireEvent.click(screen.getByRole("checkbox", { name: /New commits/ }));
  expect(fake.storage.get("pullChangesMuted")).toEqual(["commits"]);
  expect(fake.settings).toHaveBeenCalledWith("pullChangesMuted", ["commits"]);
  fireEvent.change(screen.getByLabelText(/Hide pull requests matching/), { target: { value: "author:bot\nnonsense:x" } });
  expect(fake.storage.get("pullFilters")).toEqual(["author:bot", "nonsense:x"]);
  expect(screen.getByText(/Unknown rule "nonsense"/)).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Merge method"), { target: { value: "squash" } });
  expect(fake.storage.get("mergeMethod")).toBe("squash");
  fireEvent.click(screen.getByRole("checkbox", { name: /Delete the branch/ }));
  expect(fake.storage.get("deleteBranchAfterMerge")).toBe(false);
});

it("lets go of everything on deactivate", () => {
  const off = activate(fake.api);
  (off as () => void)();
  expect(Object.values(fake.slots).every((defs) => defs.length === 0)).toBe(true);
  expect(fake.commands.size).toBe(0);
});
