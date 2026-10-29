import { expect, it } from "vitest";
import type { Item } from "../gen";
import { auraMessage, isUserMessage } from "./auraMessage";

const message = (text: string, kind: Item["kind"] = "user_message"): Item =>
  ({ id: "m", session_id: "s", turn_id: null, kind, status: "completed", title: null, text, data: {}, parent_id: null, started_at: "", ended_at: null });

it("tells messages from Aura apart by their first line, as the daemon writes it", () => {
  const report = message("[Aura] Worker report. This message comes from Aura, not the user.\n\n### Builder\nDone.");
  expect(auraMessage(report)).toEqual({ title: "Worker report", body: "### Builder\nDone.", report: true, kind: "report" });
  expect(auraMessage(message("[Aura] New review activity on your pull request. This message comes from Aura, not the user.\n"))).toEqual({
    title: "New review activity on your pull request",
    body: "",
    report: false,
    kind: "other",
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

it("reads the user's answers to a feature owner and what became of its suggestions", () => {
  const answer = message("[Aura] Decision from the user. This message comes from Aura, not the user.\nQuestion (`q1`): Which layout?\nAnswer: Tabs\n");
  expect(auraMessage(answer)).toEqual({ title: "Decision from the user", body: "Question (`q1`): Which layout?\nAnswer: Tabs", report: false, kind: "decision" });
  expect(auraMessage(message("[Aura] Checkpoint review from the user. This message comes from Aura, not the user.\nAnswer: Approve"))?.kind).toBe("decision");
  expect(auraMessage(message("[Aura] Specialist suggestion accepted. This message comes from Aura, not the user.\nok"))?.kind).toBe("suggestion");
  expect(auraMessage(message("[Aura] Specialist suggestion dismissed. This message comes from Aura, not the user.\nok"))?.kind).toBe("suggestion");
  expect(isUserMessage(answer)).toBe(false);
});

it("reads a team's meetings and one-on-ones", () => {
  const kind = (title: string) => auraMessage(message(`[Aura] ${title}. This message comes from Aura, not the user.\nbody`))?.kind;
  expect(kind("Meeting")).toBe("meeting");
  expect(kind("Meeting notes")).toBe("meeting");
  expect(kind("Meeting notes, incomplete")).toBe("meeting");
  expect(kind("Live meeting")).toBe("meeting");
  expect(kind("Live meeting notes")).toBe("meeting");
  expect(kind("Question from a teammate")).toBe("team");
  expect(kind("Answer from a teammate")).toBe("team");
  expect(kind("Answer from the feature owner")).toBe("team");
  expect(kind("No answer to your question")).toBe("team");
  expect(kind("Worker report")).toBe("report");
});
