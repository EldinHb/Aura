import { describe, expect, it } from "vitest";
import type { Event, Turn } from "../gen";
import { useStore } from "./store";

const turn = (status: Turn["status"]): Turn => ({ id: "t1", session_id: "s", status, started_at: "", ended_at: null, usage: null, error: null });
const notice = (message: string): Event => ({ type: "notice", session_id: "s", level: "warn", message });
const replay = (events: Event[]) => {
  useStore.setState({ transcripts: {} });
  useStore.getState().loadHistory("s", events.map((event, i) => ({ seq: i + 1, ts: "2026-09-23T00:00:00Z", event })));
  return useStore.getState().transcripts.s.notices.map((n) => n.message);
};

describe("notices", () => {
  it("drops everything before a notices_cleared event, also on replay", () => {
    expect(replay([notice("one"), notice("two"), { type: "notices_cleared", session_id: "s" }, notice("three")])).toEqual(["three"]);
  });

  it("drops API retry warnings once their turn completes, but keeps other warnings", () => {
    const events: Event[] = [
      { type: "turn_started", session_id: "s", turn: turn("running") },
      notice("API retry 1/10: overloaded_error"),
      notice("Permission denied: Bash"),
      { type: "turn_completed", session_id: "s", turn: turn("completed") },
    ];
    expect(replay(events)).toEqual(["Permission denied: Bash"]);
  });

  it("keeps API retry warnings when the turn failed", () => {
    expect(replay([notice("API retry 10/10: overloaded_error"), { type: "turn_completed", session_id: "s", turn: turn("failed") }])).toEqual(["API retry 10/10: overloaded_error"]);
  });
});
