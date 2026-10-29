import { beforeEach, expect, it } from "vitest";
import type { Feature, Session } from "../gen";
import { useStore } from "./store";
import { useFeatures } from "./features";

const feature = (status: Feature["status"]): Feature => ({ owner_id: "owner", goal: "Goal", status, autonomy: null, team: [], decisions: [], questions: [], checkpoints: [], suggestions: [], report: null, created_at: "", updated_at: "" });

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
