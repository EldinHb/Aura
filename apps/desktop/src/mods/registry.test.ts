import { afterEach, expect, it, vi } from "vitest";
import { evaluateWhen, type CommandContext } from "../lib/commands";
import { buildBindings } from "../hooks/useKeyboard";
import { clearModContext, modContext, Registry, setModContext } from "./registry";

afterEach(() => {
  clearModContext("test");
  clearModContext("other");
});

it("keeps a slot's entries in order, replaces an entry registered again and removes it on unregister", () => {
  const slot = new Registry<{ name: string }>();
  const changed = vi.fn();
  const unsubscribe = slot.subscribe(changed);
  const keys = () => slot.list().map((e) => e.key);

  const offLate = slot.register("b-mod", "late", { name: "late", order: 200 });
  slot.register("b-mod", "plain", { name: "plain" });
  const offEarly = slot.register("a-mod", "early", { name: "early", order: 10 });
  slot.register("a-mod", "plain", { name: "plain" });
  // By order (100 by default), then by key.
  expect(keys()).toEqual(["a-mod:early", "a-mod:plain", "b-mod:plain", "b-mod:late"]);
  expect(slot.get("a-mod", "early")).toMatchObject({ modId: "a-mod", name: "early", order: 10 });
  expect(changed).toHaveBeenCalledTimes(4);

  // The same id again replaces the entry; the old unregister no longer removes it.
  const offAgain = slot.register("a-mod", "early", { name: "moved", order: 300 });
  expect(keys()).toEqual(["a-mod:plain", "b-mod:plain", "b-mod:late", "a-mod:early"]);
  offEarly();
  expect(slot.get("a-mod", "early")?.name).toBe("moved");
  expect(changed).toHaveBeenCalledTimes(5);

  offLate();
  offAgain();
  expect(keys()).toEqual(["a-mod:plain", "b-mod:plain"]);
  expect(changed).toHaveBeenCalledTimes(7);
  // Unregistering twice changes nothing.
  offLate();
  expect(changed).toHaveBeenCalledTimes(7);

  unsubscribe();
  slot.register("c-mod", "x", { name: "x" });
  expect(changed).toHaveBeenCalledTimes(7);
});

it("evaluates `when` terms on the context mods set", () => {
  const ctx = { focus: "main", hasSelection: true } as unknown as CommandContext;
  expect(evaluateWhen("mod.test.prOpen", ctx)).toBe(false);
  expect(evaluateWhen("!mod.test.prOpen", ctx)).toBe(true);

  setModContext("mod.test.prOpen", true);
  setModContext("mod.test.view", "files");
  setModContext("mod.test.count", 0);
  expect(modContext("mod.test.prOpen")).toBe(true);
  expect(evaluateWhen("mod.test.prOpen", ctx)).toBe(true);
  expect(evaluateWhen("mod.test.prOpen, focus:main", ctx)).toBe(true);
  expect(evaluateWhen("mod.test.prOpen, focus:sidebar", ctx)).toBe(false);
  expect(evaluateWhen("mod.test.view:files|commits", ctx)).toBe(true);
  expect(evaluateWhen("mod.test.view:commits", ctx)).toBe(false);
  // Numbers count as true above zero, as for CommandContext.
  expect(evaluateWhen("mod.test.count", ctx)).toBe(false);
  // Another mod's keys are its own.
  expect(evaluateWhen("mod.other.prOpen", ctx)).toBe(false);

  // false (or null) removes a key; unloading a mod clears all of its keys.
  setModContext("mod.test.prOpen", false);
  expect(evaluateWhen("mod.test.prOpen", ctx)).toBe(false);
  setModContext("mod.other.flag", true);
  clearModContext("test");
  expect(evaluateWhen("mod.test.view:files", ctx)).toBe(false);
  expect(evaluateWhen("mod.other.flag", ctx)).toBe(true);
});

it("adds mods' bindings to the keymap, and a user override still wins over them", () => {
  const extra = [
    { keys: "leader x p", command: "mod.test.openPulls" },
    { keys: "leader x r", command: "mod.test.refresh" },
  ];
  const plain = buildBindings("default", [], extra);
  expect(plain).toEqual(expect.arrayContaining(extra));
  expect(buildBindings("default", [])).not.toEqual(expect.arrayContaining([extra[0]]));

  const overridden = buildBindings("default", [
    { keys: "leader x p", command: "session.new" },
    { keys: "leader x r", command: "" },
  ], extra);
  expect(overridden.filter((b) => b.keys === "leader x p")).toEqual([{ keys: "leader x p", command: "session.new" }]);
  expect(overridden.some((b) => b.keys === "leader x r")).toBe(false);
});
