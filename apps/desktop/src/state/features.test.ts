import { beforeEach, expect, it } from "vitest";
import type { Feature, Session, SpecialistSuggestion } from "../gen";
import { useStore } from "./store";
import { useFeatures, useRoleSuggestions } from "./features";

const feature = (status: Feature["status"]): Feature => ({ owner_id: "owner", goal: "Goal", status, autonomy: null, meeting_mode: null, team: [], decisions: [], questions: [], checkpoints: [], suggestions: [], meetings: [], one_on_ones: [], report: null, created_at: "", updated_at: "", counters: {} });

beforeEach(() => {
  useFeatures.setState({ features: {} });
  useStore.setState({ sessions: { owner: { id: "owner" } as Session }, sessionOrder: ["owner"], transcripts: {} });
});

it("keeps features current from the daemon's events, outside the transcripts", () => {
  useStore.getState().applyEvent({ type: "feature_updated", session_id: "owner", feature: feature("planning") });
  expect(useFeatures.getState().features.owner.status).toBe("planning");
  useStore.getState().applyEvent({ type: "feature_updated", session_id: "owner", feature: feature("delivered") });
  expect(useFeatures.getState().features.owner.status).toBe("delivered");
  expect(useStore.getState().transcripts.owner).toBeUndefined();
  useStore.getState().applyEvent({ type: "session_removed", session_id: "owner" });
  expect(useFeatures.getState().features.owner).toBeUndefined();
});

it("keeps the specialists Aura suggested current from the daemon's events", () => {
  useStore.getState().applyEvent({ type: "specialist_suggestions_updated", suggestions: [{ id: "r1" } as SpecialistSuggestion] });
  expect(useRoleSuggestions.getState().suggestions.map((s) => s.id)).toEqual(["r1"]);
  expect(useStore.getState().transcripts[""]).toBeUndefined();
});
