import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { Item } from "../../gen";
import { emptyTranscript, useStore } from "../../state/store";
import { Transcript } from "../Transcript";
import { ItemRow } from "./ItemRow";
import { isSlashCommand, lastBoundaryIndex } from "./format";

function item(id: string, kind: Item["kind"], text = "", data: Record<string, unknown> = {}, status: Item["status"] = "completed"): Item {
  return { id, session_id: "s", turn_id: null, kind, status, title: null, text, data, parent_id: null, started_at: "", ended_at: null };
}
const noop = () => {};
const row = (it: Item) => render(<ItemRow item={it} cursor={false} expanded={undefined} onToggle={noop} onCursor={noop} showReasoning />);

beforeEach(() => useStore.setState({ transcripts: { s: emptyTranscript() } }));
afterEach(cleanup);

it("shows a clear as a boundary that says the context above is gone", () => {
  row(item("c", "system", "", { boundary: "clear", message: "Context cleared" }));
  const sep = screen.getByRole("separator");
  expect(sep.textContent).toContain("Context cleared");
  expect(sep.textContent).toContain("no longer sees anything above this line");
});

it("shows compaction progress, the result with token counts, and failures", () => {
  const { rerender } = row(item("k", "system", "", { boundary: "compact" }, "in_progress"));
  expect(screen.getByRole("separator").textContent).toContain("Compacting context");
  const done = item("k", "system", "", { boundary: "compact", message: "Context compacted", pre_tokens: 25865, post_tokens: 4470 });
  rerender(<ItemRow item={done} cursor={false} expanded={undefined} onToggle={noop} onCursor={noop} showReasoning />);
  expect(screen.getByRole("separator").textContent).toContain("summary of everything above this line (25.9k → 4.5k tokens)");
  const failed = item("k", "system", "", { boundary: "compact", message: "Compaction failed: Not enough messages to compact." }, "failed");
  rerender(<ItemRow item={failed} cursor={false} expanded={undefined} onToggle={noop} onCursor={noop} showReasoning />);
  expect(screen.getByRole("separator").textContent).toContain("Compaction failed: Not enough messages to compact.");
  expect(screen.getByRole("separator").textContent).toContain("Context unchanged");
});

it("labels local command output with its command instead of showing it as a reply", () => {
  const { container } = row(item("o", "system", "## Context Usage\n\n**Tokens:** 20k", { command: "context" }));
  expect(container.querySelector(".command-output")).toBeTruthy();
  expect(container.querySelector(".agent_message")).toBeNull();
  expect(screen.getByText("/context")).toBeTruthy();
  expect(container.querySelector(".md-h2")?.textContent).toBe("Context Usage");
  cleanup();
  row(item("u", "system", "/status isn't available in this environment.", { command: null }));
  expect(screen.getByText("Command output")).toBeTruthy();
});

it("tells slash commands apart from messages that start with a path", () => {
  expect(isSlashCommand("/clear")).toBe(true);
  expect(isSlashCommand("/compact keep it short")).toBe(true);
  expect(isSlashCommand("/code-review:code-review 12")).toBe(true);
  expect(isSlashCommand("/src/a.ts is broken")).toBe(false);
  expect(isSlashCommand("please /clear")).toBe(false);
  const { container } = row(item("m", "user_message", "/clear"));
  expect(container.querySelector(".user_message.slash")).toBeTruthy();
});

it("dims everything above the latest completed boundary", () => {
  const items = [
    item("a", "user_message", "old question"),
    item("b", "agent_message", "old answer"),
    item("c", "system", "", { boundary: "clear" }),
    item("d", "user_message", "new question"),
    item("e", "system", "", { boundary: "compact" }, "in_progress"),
  ];
  expect(lastBoundaryIndex(items)).toBe(2);
  expect(lastBoundaryIndex(items.slice(0, 2))).toBe(-1);
  const t = emptyTranscript();
  t.order = items.map((i) => i.id);
  t.items = Object.fromEntries(items.map((i) => [i.id, i]));
  t.loading = false;
  act(() => useStore.setState({ transcripts: { s: t } }));
  const { container } = render(<Transcript sessionId="s" />);
  const stale = [...container.querySelectorAll(".item.stale")].map((el) => el.getAttribute("data-item-id"));
  expect(stale).toEqual(["a", "b"]);
});
