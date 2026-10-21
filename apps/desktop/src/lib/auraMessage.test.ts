import { expect, it } from "vitest";
import type { Item } from "../gen";
import { auraMessage, isUserMessage } from "./auraMessage";

const message = (text: string, kind: Item["kind"] = "user_message"): Item =>
  ({ id: "m", session_id: "s", turn_id: null, kind, status: "completed", title: null, text, data: {}, parent_id: null, started_at: "", ended_at: null });

it("tells messages from Aura apart by their first line, as the daemon writes it", () => {
  const report = message("[Aura] Worker report. This message comes from Aura, not the user.\n\n### Builder\nDone.");
  expect(auraMessage(report)).toEqual({ title: "Worker report", body: "### Builder\nDone.", report: true });
  expect(auraMessage(message("[Aura] New review activity on your pull request. This message comes from Aura, not the user.\n"))).toEqual({
    title: "New review activity on your pull request",
    body: "",
    report: false,
  });
  expect(isUserMessage(report)).toBe(false);
});

it("leaves the user's own messages alone, also when they mention Aura", () => {
  for (const text of ["[Aura] Worker report, what does it say?", "Look: [Aura] Worker report. This message comes from Aura, not the user.", "hello"]) {
    expect(auraMessage(message(text))).toBeNull();
    expect(isUserMessage(message(text))).toBe(true);
  }
  expect(auraMessage(message("[Aura] Worker report. This message comes from Aura, not the user.", "agent_message"))).toBeNull();
});
